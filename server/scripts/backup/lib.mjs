// OPS-1 — the backup and restore core.
//
// WHY THIS EXISTS. On 2026-10-18 the deployed cluster was an Atlas M0 (512 MB) and
// MongoDB's own documentation is unambiguous: "Atlas backups are not available for
// Free clusters… you may use mongodump to back up your Free cluster data". Nothing
// in this repository provided that dump, so the production database had NO recoverable
// copy of any kind — not a stale one, none. This module is the recoverable copy.
//
// It is deliberately NOT a mock of Atlas snapshots. It writes one gzipped
// Extended-JSON file per collection plus a manifest carrying each file's SHA-256, so
// a restore can prove it is reading the bytes that were written rather than trusting
// a filename. That matters because the failure mode of a backup is silent: a dump
// truncated by a dropped connection still looks like a backup until the day it is
// needed.
//
// Three rules shape everything below:
//
//   1. A BACKUP IS READ-ONLY. `createBackup` only reads; it cannot modify, drop or
//      index anything. That is why it is allowed to point at production while the
//      restore path is not.
//   2. A RESTORE IS DESTRUCTIVE, SO IT IS FAIL-CLOSED. It may only target the
//      databases this repository already treats as disposable (`test`, `dev` — the
//      same allowlist `cleanup/lib.mjs` owns, imported rather than copied so the two
//      cannot drift), it verifies EVERY file's hash before it drops ANY collection,
//      and it requires an explicit confirmation phrase.
//   3. A BACKUP NEVER LIVES IN THE REPOSITORY. A dump is a copy of real customer data;
//      written under the repo it is one `git add -A` away from being committed, so the
//      path is checked against the project root and refused.
//
// The functions here take an already-connected database handle, which is what makes
// them testable without spawning a CLI or touching the network policy: the round-trip
// suite passes `mongoose.connection.db`.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import mongoose from 'mongoose';

import { MONGODB_CLEANUP_TARGETS } from '../cleanup/lib.mjs';
import { uriDatabaseMismatch } from '../lib/mongo-uri.mjs';

/** Canonical Extended JSON — the only serialization that round-trips ObjectId/Date/Decimal128. */
const { EJSON } = mongoose.mongo.BSON;

/** Stamped into every manifest; a reader refuses a format it does not know. */
export const BACKUP_FORMAT = 'inventory-ai-backup/1';

/** Always written inside the backup directory, next to the collection files. */
export const MANIFEST_NAME = 'manifest.json';

/** Confirmation phrases, one per command, mirroring `cleanup/lib.mjs`'s style. */
export const BACKUP_CONFIRM_PHRASE = 'backup-db';
export const RESTORE_CONFIRM_PHRASE = 'restore-db';

/**
 * The databases a restore may overwrite. Deliberately the repository's existing
 * disposable set and nothing else: a restore drops collections, so pointing it at
 * production would be the single most destructive command in the project. This list
 * is taken FROM the cleanup allowlist, not re-typed, so adding a database there
 * cannot quietly widen what a restore may erase.
 */
export const RESTORE_ALLOWED_DATABASES = Object.freeze([
  MONGODB_CLEANUP_TARGETS.test,
  MONGODB_CLEANUP_TARGETS.dev,
]);

/** Raised by every guard below; carries names and hashes, never a connection string. */
export class BackupSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupSafetyError';
  }
}

/** Raised when the bytes on disk are not the bytes the manifest recorded. */
export class BackupIntegrityError extends BackupSafetyError {
  constructor(message) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

/** `512 B`, `11.3 KB`, `525.7 MB` — the CLI lines report sizes in these three units. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True for MongoDB's own bookkeeping collections, which are never dumped. */
export function isSystemCollection(name) {
  return String(name ?? '').startsWith('system.');
}

function looksProduction(name) {
  const value = String(name ?? '').trim().toLowerCase();
  return value.includes('prod') || value.includes('live');
}

/**
 * Guard — a restore target must be one of `RESTORE_ALLOWED_DATABASES`, exactly, and the
 * connection string must not name a different database.
 *
 * Exact match, not a prefix or a case-insensitive comparison: MongoDB database names
 * are case-sensitive, so `InventoryAI_Test_DB` is a different database and is refused.
 * The production check runs first so the refusal explains the real reason rather than
 * merely "not in the list".
 *
 * `mongodbUri` is REQUIRED. The connection uses `{ dbName }`, so a URI ending
 * `/inventoryai_prod_db` beside a target of `inventoryai_test_db` would still restore into
 * the test database — and that is why it must stop: the shell was configured for the wrong
 * place. Making the argument optional would let a caller skip the check and look guarded.
 */
export function assertRestoreTarget(databaseName, { mongodbUri } = {}) {
  const value = String(databaseName ?? '').trim();
  if (!value) {
    throw new BackupSafetyError(
      'Refusing to restore: the target database name is empty — without it the target cannot be proved.'
    );
  }
  if (looksProduction(value)) {
    throw new BackupSafetyError(
      `Refusing to restore: "${value}" looks like a production database. A restore drops and rewrites ` +
        'collections, so it must never run against production.'
    );
  }
  if (!RESTORE_ALLOWED_DATABASES.includes(value)) {
    throw new BackupSafetyError(
      `Refusing to restore: "${value}" is not an approved restore target. ` +
        `Allowed: ${RESTORE_ALLOWED_DATABASES.join(', ')}.`
    );
  }
  if (!String(mongodbUri ?? '').trim()) {
    throw new BackupSafetyError(
      `Refusing to restore: MONGODB_URI is not set, so the connection string cannot be checked ` +
        `against "${value}". Nothing was restored.`
    );
  }
  const uriDatabase = uriDatabaseMismatch(mongodbUri, value);
  if (uriDatabase) {
    throw new BackupSafetyError(
      `MONGODB_URI names the database "${uriDatabase}", but this run targets "${value}". ` +
        'The connection string and the target were configured for different databases; fix one ' +
        'of them. Nothing was restored.'
    );
  }
  return value;
}

/**
 * Guard — the operator typed the command's own name.
 *
 * This runs LAST in both CLIs, after the target and path guards, so a wrong phrase can
 * never be the only thing standing between a mistake and a destructive call.
 */
export function assertConfirm(provided, phrase) {
  if (String(provided ?? '').trim() !== phrase) {
    throw new BackupSafetyError(
      `Refusing to continue: confirmation phrase did not match. Re-run with CONFIRM=${phrase}.`
    );
  }
  return true;
}

/**
 * Guard — a backup must not be written inside the project.
 *
 * `repoRoot` is passed in rather than discovered here so the rule is testable with two
 * temporary directories and no knowledge of how this file was started.
 */
export function assertBackupDir(outDir, { repoRoot } = {}) {
  const raw = String(outDir ?? '').trim();
  if (!raw) {
    throw new BackupSafetyError(
      'Refusing to back up: no output directory was given. Set BACKUP_DIR to a path OUTSIDE the ' +
        'repository — a dump is a copy of real data and must never be committable.'
    );
  }
  const resolved = path.resolve(raw);
  if (repoRoot) {
    const root = path.resolve(repoRoot);
    if (resolved === root) {
      throw new BackupSafetyError(
        'Refusing to back up: the output directory is the repository root itself. Choose a path outside it.'
      );
    }
    const relative = path.relative(root, resolved);
    // `relative` is '' for the root (handled above), starts with '..' when outside, and
    // is absolute when the two paths share no root (e.g. another Windows drive) — which
    // is also outside, so only the non-'..' relative form is inside.
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      throw new BackupSafetyError(
        `Refusing to back up: "${resolved}" is inside the repository (${root}). ` +
          'A dump holds real data and must be written outside the project.'
      );
    }
  }
  return resolved;
}

/** `inventoryai_prod_db-20261018T142530Z` — sortable, filesystem-safe, no colons. */
export function backupDirectoryName(databaseName, now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${String(databaseName ?? 'database')}-${stamp}`;
}

/** SHA-256 of a file's bytes, streamed so a large collection does not enter memory. */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Dump ONE collection to `filePath` as gzipped canonical Extended JSON, one document
 * per line.
 *
 * `flags: 'wx'` is deliberate: an existing file is an error rather than an overwrite,
 * so a re-run into a populated directory cannot leave a manifest describing one file
 * and a half-written other.
 */
export async function dumpCollection(db, collectionName, filePath) {
  let count = 0;
  let uncompressedBytes = 0;
  const serializer = new Transform({
    writableObjectMode: true,
    transform(doc, _encoding, callback) {
      const line = `${EJSON.stringify(doc, { relaxed: false })}\n`;
      count += 1;
      uncompressedBytes += Buffer.byteLength(line);
      callback(null, line);
    },
  });

  const cursor = db.collection(collectionName).find({});
  await pipeline(
    cursor.stream(),
    serializer,
    createGzip({ level: 9 }),
    createWriteStream(filePath, { flags: 'wx' }),
  );

  return {
    name: collectionName,
    file: path.basename(filePath),
    count,
    bytes: (await stat(filePath)).size,
    // The size a RESTORE has to find room for, not the size on disk. Measured on the
    // 2026-10-18 drill: the free Atlas tier refused the restore of a 525 750-document
    // development database partway through with "over your space quota, using 520 MB of
    // 512 MB", and nothing before that point had told the operator how much room the
    // copy needed. The gzipped size is ~11 MB and would have read as harmless.
    uncompressedBytes,
    sha256: await sha256File(filePath),
  };
}

/**
 * Restore ONE collection file.
 *
 * Line-delimited rather than one JSON array, because a single array has to be parsed
 * whole: a 200 000-document collection would be assembled in memory before the first
 * insert. Lines keep memory at `batchSize × concurrency` documents regardless of
 * collection size. Chunk splitting is done by hand instead of via `readline` so that a
 * corrupt gzip rejects this promise instead of leaving the `for await` waiting on a
 * stream that already died.
 *
 * SIZED AND PIPELINED FROM MEASUREMENT, NOT TASTE. The first version inserted 500
 * documents per round trip, one batch at a time, and a real restore of the development
 * database (525 750 documents to a throttled Atlas M0 over a high-latency link) managed
 * roughly 250 documents per second: a 560 s window ended with `inventory` holding
 * 140 000 of its 223 227 rows. A restore that cannot finish is not a restore point, so
 * batches are larger and up to `concurrency` of them are in flight — the cost per batch
 * is dominated by the round trip, not by the documents inside it.
 *
 * `ordered: false` is safe HERE and only here: the caller has already dropped the
 * collection, so there is no existing document for an insert to conflict with, and a
 * conflict can only mean a corrupt or hand-edited dump — which the caller's
 * count-versus-manifest check then fails on. The first error is remembered and thrown
 * once the in-flight batches settle.
 */
export async function restoreCollection(
  db,
  collectionName,
  filePath,
  { batchSize = 2000, concurrency = 4, onProgress } = {}
) {
  const collection = db.collection(collectionName);
  const inFlight = new Set();
  let inserted = 0;
  let firstError = null;
  let batch = [];
  let pending = '';

  const launch = (documents) => {
    const promise = collection
      .insertMany(documents, { ordered: false })
      .then((result) => {
        inserted += typeof result?.insertedCount === 'number' ? result.insertedCount : documents.length;
        if (onProgress) onProgress(inserted);
      })
      .catch((error) => {
        if (!firstError) firstError = error;
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  };

  /** Wait for a free slot, then surface a failure before starting more work. */
  const waitForSlot = async () => {
    while (inFlight.size >= concurrency) await Promise.race(inFlight);
    if (firstError) throw firstError;
  };

  const stream = createReadStream(filePath).pipe(createGunzip());
  for await (const chunk of stream) {
    pending += chunk.toString('utf8');
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) {
        batch.push(EJSON.parse(line, { relaxed: false }));
        if (batch.length >= batchSize) {
          await waitForSlot();
          launch(batch);
          batch = [];
        }
      }
      newline = pending.indexOf('\n');
    }
  }
  if (pending.trim()) batch.push(EJSON.parse(pending, { relaxed: false }));
  if (batch.length) {
    await waitForSlot();
    launch(batch);
  }

  await Promise.all(inFlight);
  if (firstError) throw firstError;

  return inserted;
}

/** Write the manifest LAST, so its presence means every file before it completed. */
export async function writeManifest(dir, manifest) {
  const target = path.join(dir, MANIFEST_NAME);
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return target;
}

/** Read and shape-check a manifest. A missing or foreign file is refused, never guessed. */
export async function readManifest(dir) {
  const target = path.join(dir, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    throw new BackupSafetyError(
      `Refusing to continue: no ${MANIFEST_NAME} in "${dir}" — this is not a backup directory.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupSafetyError(`Refusing to continue: ${MANIFEST_NAME} in "${dir}" is not valid JSON.`);
  }
  if (!parsed || parsed.format !== BACKUP_FORMAT) {
    throw new BackupSafetyError(
      `Refusing to continue: ${MANIFEST_NAME} in "${dir}" is not a ${BACKUP_FORMAT} manifest.`
    );
  }
  if (!Array.isArray(parsed.collections) || parsed.collections.length === 0) {
    throw new BackupSafetyError(
      `Refusing to continue: ${MANIFEST_NAME} in "${dir}" lists no collections — an empty backup is ` +
        'not a restore point.'
    );
  }
  return parsed;
}

/**
 * Prove EVERY file matches the manifest before anything is overwritten.
 *
 * Returns the verified entries. A mismatch throws `BackupIntegrityError` naming the
 * file and both hashes; the restore CLI calls this before its first drop, which is the
 * whole point — a corrupt backup must fail with the database untouched.
 */
export async function verifyBackup(dir, manifest) {
  const verified = [];
  for (const entry of manifest.collections) {
    const filePath = path.join(dir, entry.file);
    let actual;
    try {
      actual = await sha256File(filePath);
    } catch {
      throw new BackupIntegrityError(
        `Backup is incomplete: "${entry.file}" is in the manifest but not on disk. Nothing was restored.`
      );
    }
    if (actual !== entry.sha256) {
      throw new BackupIntegrityError(
        `Backup is corrupt: "${entry.file}" has SHA-256 ${actual}, the manifest recorded ${entry.sha256}. ` +
          'Nothing was restored.'
      );
    }
    verified.push({ ...entry, bytes: (await stat(filePath)).size });
  }
  return verified;
}

/**
 * Dump every collection of `db` into `outDir` and write the manifest.
 *
 * `outDir` must already exist and be empty (the caller creates it via
 * `backupDirectoryName`), because the per-file `wx` flag plus the manifest's `wx` flag
 * together make "this directory is a new backup" a fact rather than an assumption.
 */
export async function createBackup({ db, outDir, databaseName, now = new Date(), onCollection }) {
  await mkdir(outDir, { recursive: true });

  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = listed
    .map((entry) => entry.name)
    .filter((name) => !isSystemCollection(name))
    .sort();

  if (names.length === 0) {
    throw new BackupSafetyError(
      `Refusing to finish: database "${databaseName}" has no collections to back up — an empty dump is ` +
        'not a restore point.'
    );
  }

  const startedAt = new Date(now).toISOString();
  const collections = [];
  for (const name of names) {
    const entry = await dumpCollection(db, name, path.join(outDir, `${name}.jsonl.gz`));
    collections.push(entry);
    if (onCollection) onCollection(entry);
  }

  const manifest = {
    format: BACKUP_FORMAT,
    database: databaseName,
    startedAt,
    finishedAt: new Date().toISOString(),
    databaseVersion: typeof db.admin === 'function' ? await readServerVersion(db) : '',
    collections,
    totals: {
      collections: collections.length,
      documents: collections.reduce((sum, entry) => sum + entry.count, 0),
      bytes: collections.reduce((sum, entry) => sum + entry.bytes, 0),
      uncompressedBytes: collections.reduce((sum, entry) => sum + entry.uncompressedBytes, 0),
    },
  };

  await writeManifest(outDir, manifest);
  return manifest;
}

/** Best-effort server version for the manifest; never fails a backup over diagnostics. */
async function readServerVersion(db) {
  try {
    const info = await db.admin().serverInfo();
    return String(info?.version ?? '');
  } catch {
    return '';
  }
}

/**
 * Restore a backup directory into `db`.
 *
 * Order is the safety property: read the manifest, verify every hash, and only then
 * drop and insert. `dryRun` stops after verification and reports what would happen.
 * Each collection is dropped first so a restore into a half-used database reproduces
 * the backup exactly instead of merging with whatever was there.
 */
export async function restoreBackup({ db, dir, dryRun = false, onCollection, onProgress }) {
  const manifest = await readManifest(dir);
  const verified = await verifyBackup(dir, manifest);

  let insertedTotal = 0;
  for (const entry of verified) {
    if (dryRun) {
      if (onCollection) onCollection({ ...entry, inserted: 0, dropped: false });
      continue;
    }
    try {
      await db.collection(entry.name).drop();
    } catch (error) {
      // A collection that does not exist yet is the normal first-restore case; anything
      // else must surface rather than be swallowed into "restored anyway".
      if (error?.codeName !== 'NamespaceNotFound' && error?.code !== 26) throw error;
    }

    const startedAt = Date.now();
    const inserted = await restoreCollection(db, entry.name, path.join(dir, entry.file), {
      // A collection is the unit the operator watches: the running total is reported
      // against THIS collection's expected count, so "is it stuck" has an answer even
      // while a 200 000-document collection is mid-flight.
      onProgress: onProgress
        ? (insertedSoFar) => onProgress({ name: entry.name, inserted: insertedSoFar, expected: entry.count })
        : undefined,
    });
    const elapsedMs = Date.now() - startedAt;

    if (inserted !== entry.count) {
      throw new BackupIntegrityError(
        `Restore of "${entry.name}" inserted ${inserted} document(s) but the manifest recorded ` +
          `${entry.count}. The database is now in an incomplete state — restore again from a verified copy.`
      );
    }
    insertedTotal += inserted;
    if (onCollection) onCollection({ ...entry, inserted, dropped: true, elapsedMs });
  }

  return { manifest, verified, insertedTotal, dryRun };
}

/** Remove a partially written backup directory (used when a dump fails mid-way). */
export async function removePartialBackup(dir) {
  await rm(dir, { recursive: true, force: true });
}

export default {
  BACKUP_FORMAT,
  MANIFEST_NAME,
  BACKUP_CONFIRM_PHRASE,
  RESTORE_CONFIRM_PHRASE,
  RESTORE_ALLOWED_DATABASES,
  BackupSafetyError,
  BackupIntegrityError,
  isSystemCollection,
  formatBytes,
  assertRestoreTarget,
  assertConfirm,
  assertBackupDir,
  backupDirectoryName,
  sha256File,
  dumpCollection,
  restoreCollection,
  writeManifest,
  readManifest,
  verifyBackup,
  createBackup,
  restoreBackup,
  removePartialBackup,
};
