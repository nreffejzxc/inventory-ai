// OPS-1 — the backup is a restore point, or it is nothing.
//
// WHY THIS EXISTS. On 2026-10-18 the deployed cluster was an Atlas M0 and MongoDB's
// documentation says plainly that Free clusters have no backups; `mongodump` is the
// documented answer for exactly this tier. So `backup:db` exists to be the thing that is
// still there on the day it is needed — which makes the interesting tests the ones about
// what happens when it is WRONG, not when it works:
//
//   * a round trip that proves the dump reproduces documents exactly, including the BSON
//     types a plain JSON dump silently degrades (ObjectId, Date, Decimal128, null);
//   * a corrupted byte that must fail the restore with the database UNTOUCHED — the order
//     in `restoreBackup` (verify every file, then drop) is the property, so the test
//     asserts the pre-existing row survived the refusal;
//   * the guards: a production and an unknown restore target, a dump directory inside the
//     repository, a wrong confirmation phrase, a missing file, an empty manifest.
//
// IT RUNS AGAINST ITS OWN SCRATCH DATABASE, and that is not tidiness either. `node --test`
// runs test FILES in parallel, so a suite that dumps and restores the whole test database
// would drop collections other suites are using at that moment — the first version of this
// file did exactly that before the listing assertion exposed it. The scratch database lives
// on the same connection (no second cluster, no second credential), is dropped by this
// suite's `after`, and gives `createBackup` the real whole-database path to exercise rather
// than a test-only subset parameter that production would never use.
//
// The comparisons use a small `canonical()` rather than `deepStrictEqual` on purpose: the
// property is BYTE-equality of the canonical Extended JSON form, which is what a restore
// actually reproduces. It carries its own negative control below, because an equality
// helper that always returned true would make every assertion in this file vacuous.
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { dbSuite } from './testEnv.mjs';
import { DATABASE_NAMES } from '../src/config/env.ts';
import {
  BACKUP_CONFIRM_PHRASE,
  BACKUP_FORMAT,
  MANIFEST_NAME,
  RESTORE_ALLOWED_DATABASES,
  RESTORE_CONFIRM_PHRASE,
  BackupIntegrityError,
  BackupSafetyError,
  assertBackupDir,
  assertConfirm,
  assertRestoreTarget,
  backupDirectoryName,
  createBackup,
  readManifest,
  restoreBackup,
  verifyBackup,
} from '../scripts/backup/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../..');

/** A URI whose path names the same database the restore targets. */
const uriFor = (dbName) => `mongodb://127.0.0.1:27017/${dbName}`;

/** A database of this suite's own, on the connection `helpers.mjs` already proved. */
const SCRATCH_DB = 'inventoryai_ops1_scratch_db';
const A = 'ops1_backup_a';
const C = 'ops1_backup_c';
const B = 'ops1_backup_b';

const dbOk = await ensureDb();

/** Canonical Extended JSON string — the exact form a backup stores and a restore rebuilds. */
function canonical(doc) {
  return JSON.stringify(mongoose.mongo.BSON.EJSON.stringify(doc, { relaxed: false }));
}

function ejsonEqual(left, right) {
  return canonical(left) === canonical(right);
}

/** The documents a JSON dump would flatten and we must not. */
function fixtures() {
  const { ObjectId, Decimal128 } = mongoose.mongo;
  return [
    { _id: new ObjectId(), sku: 'SKU-1', quantity: 12, seen: new Date('2026-10-18T08:15:30.250Z') },
    {
      _id: new ObjectId(),
      sku: 'SKU-2',
      quantity: 0,
      unit: Decimal128.fromString('3.25'),
      nested: { tags: ['a', 'b'], meta: null, flag: true },
    },
    { _id: new ObjectId(), label: 'unicode: ñ 需要 Поднебесье 🧾', maybe: null },
  ];
}

let tmpDir = '';
let scratch = null;

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'inventory-ai-ops1-'));
  if (dbOk) scratch = mongoose.connection.getClient().db(SCRATCH_DB);
});

after(async () => {
  if (scratch) await scratch.dropDatabase().catch(() => {});
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await disconnectDb();
});

/** A fresh directory per case, so no case can read another's manifest. */
function caseDir(label) {
  return path.join(tmpDir, `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
}

dbSuite('OPS-1 — backup and restore', dbOk, () => {
  it('round-trips documents exactly, including ObjectId, Date and Decimal128', async () => {
    const docs = fixtures();
    // Two collections: one would not prove the listing covers more than its first entry.
    await scratch.collection(A).drop().catch(() => {});
    await scratch.collection(B).drop().catch(() => {});
    await scratch.collection(A).insertMany(docs);
    await scratch.collection(B).insertMany([{ _id: new mongoose.mongo.ObjectId(), note: 'second collection' }]);

    const outDir = caseDir('roundtrip');
    const manifest = await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });

    assert.equal(manifest.format, BACKUP_FORMAT);
    assert.equal(manifest.database, SCRATCH_DB);
    const names = manifest.collections.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort(), 'collections are listed in sorted order, deterministically');
    assert.ok(names.includes(A) && names.includes(B), 'both seeded collections are in the dump');
    const entryA = manifest.collections.find((entry) => entry.name === A);
    assert.equal(entryA.count, docs.length);
    assert.match(entryA.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.totals.documents, docs.length + 1);

    // Destroy the originals — a restore tested against rows that are already there proves nothing.
    await scratch.collection(A).drop();
    await scratch.collection(B).drop();

    const result = await restoreBackup({ db: scratch, dir: outDir });
    assert.equal(result.insertedTotal, manifest.totals.documents);

    const restored = await scratch.collection(A).find({}).toArray();
    assert.equal(restored.length, docs.length);
    for (const original of docs) {
      const match = restored.find((doc) => String(doc._id) === String(original._id));
      assert.ok(match, `document ${String(original._id)} came back`);
      assert.ok(ejsonEqual(original, match), 'the restored document is byte-identical in canonical form');
    }
    assert.equal(restored[1].unit.constructor.name, 'Decimal128', 'Decimal128 survives as Decimal128');
    assert.ok(restored[0].seen instanceof Date, 'a Date survives as a Date');
  });

  // THE HALF A DOCUMENT-ONLY BACKUP LOST. A checksum proves the bytes; it cannot prove the
  // rules the bytes were written under. These three properties are the ones whose absence is
  // silent until it matters: a unique guard (duplicate SKUs after a restore), a TTL (tokens
  // that never expire), and a validator (documents that no longer match their schema).
  it('restores index definitions and collection options — unique, TTL and validator', async () => {
    await scratch.collection(C).drop().catch(() => {});
    const validator = {
      $jsonSchema: {
        bsonType: 'object',
        required: ['sku'],
        properties: { sku: { bsonType: 'string' }, expiresAt: { bsonType: 'date' } },
      },
    };
    await scratch.createCollection(C, { validator, validationLevel: 'strict' });
    await scratch.collection(C).insertMany([
      { sku: 'SKU-A', expiresAt: new Date('2030-01-01T00:00:00Z') },
      { sku: 'SKU-B', expiresAt: new Date('2030-01-01T00:00:00Z') },
    ]);
    await scratch.collection(C).createIndex({ sku: 1 }, { name: 'sku_unique', unique: true });
    // An hour of TTL headroom so the documents cannot be reaped while this test runs.
    await scratch.collection(C).createIndex({ expiresAt: 1 }, { name: 'ttl_expiry', expireAfterSeconds: 3600 });

    const outDir = caseDir('shape');
    const manifest = await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });
    const entry = manifest.collections.find((item) => item.name === C);
    assert.ok(entry, 'the shaped collection is in the manifest');
    assert.ok(entry.options && Object.keys(entry.options).length > 0, 'collection options were captured');
    assert.ok(Array.isArray(entry.indexes) && entry.indexes.length >= 2, 'index definitions were captured');
    assert.ok(!entry.indexes.some((spec) => spec.name === '_id_'), '_id_ is never carried');
    assert.equal(manifest.totals.indexes >= 2, true, 'the totals count the captured indexes');

    await scratch.collection(C).drop();
    const result = await restoreBackup({ db: scratch, dir: outDir });
    assert.equal(result.indexesCreated >= 2, true);
    assert.equal(result.optionsRestored >= 1, true);

    const restoredIndexes = await scratch.collection(C).indexes();
    const unique = restoredIndexes.find((spec) => spec.name === 'sku_unique');
    const ttl = restoredIndexes.find((spec) => spec.name === 'ttl_expiry');
    assert.ok(unique, 'the unique index came back under its own name');
    assert.equal(unique.unique, true, 'and it is still unique');
    assert.ok(ttl, 'the TTL index came back');
    assert.equal(ttl.expireAfterSeconds, 3600, 'with its expiry intact');

    const [info] = await scratch.listCollections({ name: C }, { nameOnly: false }).toArray();
    assert.ok(info?.options?.validator, 'the validator came back on the collection');

    // The properties are ENFORCED, not merely present: that is the difference this test exists for.
    await assert.rejects(
      () => scratch.collection(C).insertOne({ sku: 'SKU-A', expiresAt: new Date() }),
      'a duplicate of a unique key is refused after the restore'
    );
    await assert.rejects(
      () => scratch.collection(C).insertOne({ notSku: true }),
      'a document that violates the restored validator is refused'
    );
  });

  it('still restores a v1 archive, which never carried structures', async () => {
    // Start from an EMPTY scratch database so the manifest describes exactly one collection.
    // The previous case leaves the shaped collection behind, and a whole-database dump would
    // otherwise carry it too — which is correct behaviour but makes the arithmetic here lie.
    for (const info of await scratch.listCollections({}, { nameOnly: true }).toArray()) {
      await scratch.collection(info.name).drop().catch(() => {});
    }
    await scratch.collection(A).insertMany(fixtures());

    const outDir = caseDir('legacy');
    const manifest = await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });

    // Rewrite the manifest as the format written before 2026-11-27: no options, no indexes.
    const legacy = {
      ...manifest,
      format: 'inventory-ai-backup/1',
      collections: manifest.collections.map((entry) => {
        const legacyEntry = { ...entry };
        delete legacyEntry.options;
        delete legacyEntry.indexes;
        return legacyEntry;
      }),
    };
    delete legacy.totals.indexes;
    await writeFile(path.join(outDir, MANIFEST_NAME), JSON.stringify(legacy));

    const read = await readManifest(outDir);
    assert.equal(read.format, 'inventory-ai-backup/1', 'a v1 manifest is still accepted');

    await scratch.collection(A).drop();
    const result = await restoreBackup({ db: scratch, dir: outDir });
    const recorded = read.collections.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(result.insertedTotal, recorded, 'every document the v1 manifest records is restored');
    assert.equal(result.indexesCreated, 0, 'a v1 archive restores documents and claims no structures');
    assert.equal(result.optionsRestored, 0, 'and no collection options it never carried');
    assert.equal((await scratch.collection(A).find({}).toArray()).length, 3);
  });

  it('the comparison helper can fail — otherwise every comparison above is vacuous', () => {
    const [first, second] = fixtures();
    assert.ok(ejsonEqual(first, { ...first }), 'control: equal documents compare equal');
    assert.ok(!ejsonEqual(first, second), 'control: different documents compare different');
    assert.ok(
      !ejsonEqual(first, { ...first, quantity: first.quantity + 1 }),
      'control: a changed field is detected'
    );
  });

  it('a corrupted file is refused BEFORE anything is dropped', async () => {
    await scratch.collection(A).drop().catch(() => {});
    await scratch.collection(B).drop().catch(() => {});
    await scratch.collection(A).insertMany(fixtures());
    const outDir = caseDir('corrupt');
    await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });

    // Flip one byte inside the gzip stream: the file still exists and still has the right
    // name, which is exactly the corruption a filename-based check misses.
    const target = path.join(outDir, `${A}.jsonl.gz`);
    const bytes = await readFile(target);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(target, bytes);

    const sentinel = { _id: new mongoose.mongo.ObjectId(), note: 'live row that must survive' };
    await scratch.collection(A).insertOne(sentinel);

    await assert.rejects(
      () => restoreBackup({ db: scratch, dir: outDir }),
      (error) => {
        assert.ok(error instanceof BackupIntegrityError, `expected an integrity error, got ${error?.name}`);
        assert.match(error.message, /SHA-256/);
        assert.match(error.message, /Nothing was restored/);
        return true;
      }
    );

    const after = await scratch.collection(A).find({}).toArray();
    assert.ok(
      after.some((doc) => String(doc._id) === String(sentinel._id)),
      'the refusal happened before the drop — the live row is still there'
    );
  });

  it('a file missing from disk is refused, and an empty manifest is not a restore point', async () => {
    const outDir = caseDir('missing');
    const manifest = await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });

    await rm(path.join(outDir, `${A}.jsonl.gz`));
    await assert.rejects(
      () => verifyBackup(outDir, manifest),
      (error) => error instanceof BackupIntegrityError && /not on disk/.test(error.message),
      'a manifest entry with no file fails verification'
    );

    const emptyDir = caseDir('empty-manifest');
    await createBackup({ db: scratch, outDir: path.join(emptyDir, 'inner'), databaseName: SCRATCH_DB });
    await writeFile(path.join(emptyDir, MANIFEST_NAME), JSON.stringify({ ...manifest, collections: [] }));
    await assert.rejects(
      () => readManifest(emptyDir),
      (error) => error instanceof BackupSafetyError && /lists no collections/.test(error.message),
      'an empty backup is refused as a restore source'
    );
  });

  it('a dry run verifies without writing', async () => {
    await scratch.collection(A).drop().catch(() => {});
    await scratch.collection(B).drop().catch(() => {});
    await scratch.collection(A).insertMany(fixtures());
    const outDir = caseDir('dry');
    await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });
    await scratch.collection(A).drop();

    const result = await restoreBackup({ db: scratch, dir: outDir, dryRun: true });
    assert.ok(result.verified.length >= 1, 'every file was verified in the dry run');
    assert.equal(result.insertedTotal, 0);

    const stillGone = await scratch.listCollections({ name: A }, { nameOnly: true }).toArray();
    assert.equal(stillGone.length, 0, 'a dry run writes nothing at all');
  });

  it('writes a manifest a reader can trust: format, hashes, totals', async () => {
    // Each case seeds what it needs: the dry-run case above deliberately leaves the
    // scratch database empty, and `createBackup` refusing an empty database is itself a
    // property under test (below). Depending on a sibling's leftovers would make this
    // case's result depend on test order.
    await scratch.collection(A).drop().catch(() => {});
    await scratch.collection(A).insertMany(fixtures());
    const outDir = caseDir('manifest');
    const manifest = await createBackup({ db: scratch, outDir, databaseName: SCRATCH_DB });

    const onDisk = JSON.parse(await readFile(path.join(outDir, MANIFEST_NAME), 'utf8'));
    assert.deepEqual(onDisk, manifest, 'the file on disk is the manifest that was returned');
    assert.equal(onDisk.totals.collections, onDisk.collections.length);
    assert.equal(
      onDisk.totals.documents,
      onDisk.collections.reduce((sum, entry) => sum + entry.count, 0)
    );
    assert.equal((await verifyBackup(outDir, onDisk)).length, onDisk.collections.length);
  });

  it('refuses to produce a backup of an empty database', async () => {
    const emptyDb = mongoose.connection.getClient().db('inventoryai_ops1_empty_db');
    await emptyDb.dropDatabase().catch(() => {});
    try {
      await assert.rejects(
        () => createBackup({ db: emptyDb, outDir: caseDir('empty-db'), databaseName: 'inventoryai_ops1_empty_db' }),
        (error) => error instanceof BackupSafetyError && /no collections to back up/.test(error.message),
        'an empty dump is refused rather than written as a restore point'
      );
    } finally {
      await emptyDb.dropDatabase().catch(() => {});
    }
  });

  it('a backup directory is named for the database and is refused inside the repository', () => {
    assert.equal(backupDirectoryName('inventoryai_prod_db', new Date('2026-10-18T14:25:30.000Z')), 'inventoryai_prod_db-20261018T142530Z');
    assert.equal(backupDirectoryName('db', new Date('2026-01-02T03:04:05.006Z')), 'db-20260102T030405Z');

    assert.throws(
      () => assertBackupDir(path.join(REPO_ROOT, 'backups'), { repoRoot: REPO_ROOT }),
      (error) => error instanceof BackupSafetyError && /inside the repository/.test(error.message)
    );
    assert.throws(
      () => assertBackupDir(REPO_ROOT, { repoRoot: REPO_ROOT }),
      (error) => error instanceof BackupSafetyError && /repository root/.test(error.message)
    );
    assert.throws(
      () => assertBackupDir('', { repoRoot: REPO_ROOT }),
      (error) => error instanceof BackupSafetyError && /no output directory/.test(error.message)
    );
    assert.equal(assertBackupDir(tmpDir, { repoRoot: REPO_ROOT }), path.resolve(tmpDir));

    assert.equal(assertConfirm(BACKUP_CONFIRM_PHRASE, BACKUP_CONFIRM_PHRASE), true);
    assert.equal(assertConfirm(RESTORE_CONFIRM_PHRASE, RESTORE_CONFIRM_PHRASE), true);
    assert.throws(
      () => assertConfirm('', RESTORE_CONFIRM_PHRASE),
      (error) => error instanceof BackupSafetyError && /confirmation phrase/.test(error.message)
    );
    assert.throws(
      () => assertConfirm(BACKUP_CONFIRM_PHRASE, RESTORE_CONFIRM_PHRASE),
      'the two commands do not accept each other’s phrase'
    );
  });

  it('a restore may only ever target a disposable database', () => {
    for (const allowed of RESTORE_ALLOWED_DATABASES) {
      assert.equal(assertRestoreTarget(allowed, { mongodbUri: uriFor(allowed) }), allowed);
    }
    assert.deepEqual(
      [...RESTORE_ALLOWED_DATABASES].sort(),
      [DATABASE_NAMES.test, DATABASE_NAMES.development].sort(),
      'the restore allowlist is exactly the disposable set the cleanup tools own'
    );
    for (const forbidden of [
      DATABASE_NAMES.production,
      'inventoryai_live_db',
      'inventoryai_test_db_backup',
      '',
      'InventoryAI_Test_DB',
    ]) {
      assert.throws(
        () => assertRestoreTarget(forbidden, { mongodbUri: uriFor(forbidden) }),
        (error) => error instanceof BackupSafetyError,
        `"${forbidden}" must be refused`
      );
    }
    assert.throws(
      () => assertRestoreTarget(DATABASE_NAMES.production, { mongodbUri: uriFor(DATABASE_NAMES.production) }),
      (error) => /production database/.test(error.message),
      'a production target is refused for the real reason, not merely as an unknown name'
    );
  });

  it('a restore refuses a connection string that names a different database', () => {
    // `{ dbName }` makes this restore actually target the test database, which is why the
    // mismatch has to stop it: the shell was prepared for development.
    assert.throws(
      () =>
        assertRestoreTarget(DATABASE_NAMES.test, {
          mongodbUri: uriFor(DATABASE_NAMES.development),
        }),
      (error) =>
        error instanceof BackupSafetyError &&
        /MONGODB_URI names the database "inventoryai_dev_db", but this run targets "inventoryai_test_db"/.test(
          error.message
        ),
      'a URI naming another database must be refused even when the target name is allowed'
    );
  });

  it('a restore refuses to skip the URI check when no connection string is supplied', () => {
    assert.throws(
      () => assertRestoreTarget(DATABASE_NAMES.test),
      (error) => error instanceof BackupSafetyError && /MONGODB_URI is not set/.test(error.message),
      'the guard must fail closed rather than silently omitting the comparison'
    );
  });
});
