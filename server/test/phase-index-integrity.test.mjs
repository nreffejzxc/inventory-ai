// Index integrity — the DECLARATIONS actually reach the DATABASE.
//
// THE GAP THIS CLOSES. Four increments rest on a database index for their entire
// payoff: Phase 20G/20H (the list-sort keys), Phase 22/AI-3 (the inventory page
// sort `{ businessId: 1, updatedAt: -1, _id: -1 }`, worth ~6.3 s per page at
// 10 000 products), and the TTL keys on sessions / password-reset tokens /
// verification challenges (which are what actually expire rows). Each already has a
// suite — but every one of those suites reads the MODEL SOURCE, so they can only
// prove an index is DECLARED. **Not one of them can fail if the database never built
// it**, and the build path is Mongoose's default `autoIndex`, asserted nowhere:
// `grep -rn "autoIndex\|syncIndexes\|createIndexes" src/ scripts/` finds nothing.
//
// A missing index is therefore the perfect silent regression: the application keeps
// working, every test stays green, and the only symptom is that a query is slow or a
// collection grows without bound.
//
// WHY IT IS SAFE TO ASSERT HERE. The suite clears data with `deleteMany` (never
// `dropDatabase`), so indexes persist between runs; and `Model.init()` is AWAITED
// before the comparison, so a fresh CI database cannot race a background index
// build. `init()` rejecting is itself a real failure worth surfacing — a unique
// index that cannot be built because the data violates it.
//
// ORDER MATTERS AND IS COMPARED. `{ a: 1, b: 1 }` and `{ b: 1, a: 1 }` are different
// indexes: a compound index only serves a query whose equality/sort keys are a
// PREFIX of its own key order. Comparing the field set instead of the sequence would
// report `ok` for an index that cannot answer the query it was added for, which is
// exactly the failure this file exists to catch. (The standalone `audit:indexes`
// tool shipped with this increment had that defect in its first draft: it sorted the
// fields and printed the AI-3 key as `_id:-1,businessId:1,updatedAt:-1` while the
// declaration read `businessId:1,updatedAt:-1,_id:-1`.)
//
// Extras are NOT asserted absent: an index the database carries but the model does
// not declare is usually harmless, and failing on one would make this suite break
// for a reason that is not a defect.
//
// DB-backed; fails loudly when MongoDB is unreachable (Phase 07F / M9).
// Registered as PURE_DB in run-tests.mjs.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startServer, disconnectDb } from './support.mjs';
import { dbSuite } from './testEnv.mjs';
import models from '../src/models/index.ts';

const { dbOk, server } = await startServer();

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mongoose's own implicit index on `_id`, present on every collection. */
const isImplicit = (key) =>
  Object.keys(key).length === 1 && Object.prototype.hasOwnProperty.call(key, '_id');

/** Comparable form of a key, ORDER-PRESERVING (see the header). */
function normalizeKey(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}:${typeof direction === 'number' ? direction : String(direction)}`)
    .join(',');
}

/** Stable form of a partial filter; a missing filter differs from an empty one. */
function normalizePartialFilter(filter) {
  if (filter == null) return null;
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
    }
    return value;
  };
  return JSON.stringify(sortValue(filter));
}

/** Every non-implicit index the model declares, keyed by its ordered key. */
function declaredIndexes(model) {
  const out = new Map();
  for (const [key, options] of model.schema.indexes()) {
    if (isImplicit(key)) continue;
    out.set(normalizeKey(key), options ?? {});
  }
  return out;
}

/** Every non-implicit index the database actually carries, keyed by its ordered key. */
async function actualIndexes(model) {
  const out = new Map();
  for (const index of await model.collection.indexes()) {
    if (index.name === '_id_') continue;
    out.set(normalizeKey(index.key ?? {}), index);
  }
  return out;
}

/** Read a source file relative to the server root (for the mechanism guards). */
const readSource = (relative) => fs.readFileSync(path.join(serverRoot, relative), 'utf8');

dbSuite('Index integrity — declared indexes exist in the database', dbOk, () => {
  it('★ every declared index exists, in the declared order, for every model', async () => {
    assert.ok(models.length > 0, 'the model barrel must export the models this suite audits');

    const report = [];
    for (const model of models) {
      // Waits for the background index build, so a fresh database cannot race it —
      // and rejects loudly if a unique index cannot be built over the data present.
      await model.init();

      const declared = declaredIndexes(model);
      const actual = await actualIndexes(model);

      for (const [key, options] of declared) {
        const found = actual.get(key);
        if (!found) {
          report.push(
            `${model.modelName}: declared ${key} is NOT in ${model.collection.collectionName} ` +
              `(present: ${[...actual.keys()].join(' | ') || 'none'})`,
          );
          continue;
        }
        if (Boolean(options.unique) !== Boolean(found.unique)) {
          report.push(`${model.modelName}: ${key} unique declared=${Boolean(options.unique)} database=${Boolean(found.unique)}`);
        }
        if (Boolean(options.sparse) !== Boolean(found.sparse)) {
          report.push(`${model.modelName}: ${key} sparse declared=${Boolean(options.sparse)} database=${Boolean(found.sparse)}`);
        }
        const declaredPartial = normalizePartialFilter(options.partialFilterExpression);
        const actualPartial = normalizePartialFilter(found.partialFilterExpression);
        if (declaredPartial !== actualPartial) {
          report.push(
            `${model.modelName}: ${key} partialFilter declared=${declaredPartial ?? 'none'} ` +
              `database=${actualPartial ?? 'none'}`,
          );
        }
        if (options.expireAfterSeconds !== found.expireAfterSeconds) {
          report.push(
            `${model.modelName}: ${key} TTL declared=${options.expireAfterSeconds ?? 'none'} ` +
              `database=${found.expireAfterSeconds ?? 'none'}`,
          );
        }
      }
    }

    assert.deepEqual(report, [], `declaration/database disagreements:\n  - ${report.join('\n  - ')}`);
  });

  it('★ the AI-3 inventory page index is DECLARED and EXISTS in the database', async () => {
    // Both halves, because each alone is satisfiable while the fix is broken, and
    // this is the key with a measured price on it: without it the inventory page
    // sort is not index-provided and the window cannot be read off the index, which
    // cost 6.3 s per 25-row page at 10 000 products before AI-3.
    //
    // The DECLARATION half is new, and it closes a real gap rather than restating an
    // existing guard: `grep -rln "updatedAt: -1" test/` matched no suite before this
    // file, so deleting that one line from `inventory.model.ts` left the entire suite
    // green while the sort silently lost its index.
    //
    // The DATABASE half is what no declaration guard can see: the index can be
    // declared and never built. Note the honest limit of that half — `init()` above
    // creates a missing index, so on a long-lived database a leftover from an earlier
    // boot can satisfy it. It is a verification that the mechanism produced the
    // declared indexes (and a loud failure on a fresh database with the build path
    // disabled), not proof that nobody dropped one yesterday.
    const Inventory = models.find((model) => model.modelName === 'Inventory');
    assert.ok(Inventory, 'the Inventory model must be exported by the barrel');

    const key = 'businessId:1,updatedAt:-1,_id:-1';
    const declared = declaredIndexes(Inventory);
    assert.ok(
      declared.has(key),
      `inventory.model.ts no longer DECLARES the page-sort index ${key} — the AI-3 page window ` +
        `would stop being index-provided (declared: ${[...declared.keys()].join(' | ') || 'none'})`,
    );

    await Inventory.init();
    const actual = await actualIndexes(Inventory);
    assert.ok(
      actual.has(key),
      `the inventory page-sort index ${key} is missing from ${Inventory.collection.collectionName} ` +
        `(present: ${[...actual.keys()].join(' | ')})`,
    );
  });

  it('★ the location-filtered inventory page index is DECLARED and EXISTS (§27DG)', async () => {
    // The companion to the AI-3 key above, for the request that names ONE location. The
    // measured failure it exists for: at 523 918 inventory rows the location-filtered page
    // took 2 395 ms with a blocking `SORT` winning plan and 2 052 ms of planner time,
    // because neither `{ businessId, locationId }` (no sort key) nor
    // `{ businessId, updatedAt, _id }` (no locationId) could supply equality PLUS order.
    //
    // Both halves are asserted for the same reason as its neighbour: the declaration can
    // be deleted while every other suite stays green — nothing in the tree named this key
    // before this file did — and a declaration alone cannot prove the database built it.
    const Inventory = models.find((model) => model.modelName === 'Inventory');
    assert.ok(Inventory, 'the Inventory model must be exported by the barrel');

    const key = 'businessId:1,locationId:1,updatedAt:-1,_id:-1';
    assert.ok(
      declaredIndexes(Inventory).has(key),
      `inventory.model.ts no longer DECLARES the location-filtered page index ${key} — the ` +
        `location page would fall back to a plan the planner may answer with a blocking sort ` +
        `(declared: ${[...declaredIndexes(Inventory).keys()].join(' | ') || 'none'})`,
    );

    await Inventory.init();
    const actual = await actualIndexes(Inventory);
    assert.ok(
      actual.has(key),
      `the location-filtered inventory page index ${key} is missing from ` +
        `${Inventory.collection.collectionName} (present: ${[...actual.keys()].join(' | ')})`,
    );
  });

  it('★ the TTL keys are declared AND exist — what actually expires sessions and one-time tokens', async () => {
    // A TTL index that is declared but absent means the collection grows forever:
    // AUTH-02 bounds a session's LIFETIME in code, but only the TTL key removes the
    // row, so this is the difference between "expired" and "gone". Asserted on both
    // sides for the same reason as the index above.
    const expected = [
      ['Session', 'expiresAt:1'],
      ['PasswordResetToken', 'expiresAt:1'],
      ['EmailVerificationChallenge', 'expiresAt:1'],
    ];

    for (const [modelName, key] of expected) {
      const model = models.find((m) => m.modelName === modelName);
      assert.ok(model, `${modelName} must be exported by the barrel`);

      assert.ok(
        declaredIndexes(model).has(key),
        `${modelName} no longer declares its TTL key ${key} — the rows would accumulate forever`,
      );

      await model.init();
      const actual = await actualIndexes(model);
      const found = actual.get(key);
      assert.ok(
        found,
        `${modelName} is missing its TTL index ${key} (present: ${[...actual.keys()].join(' | ')})`,
      );
      assert.equal(
        typeof found.expireAfterSeconds,
        'number',
        `${modelName}.${key} exists but the database does not treat it as a TTL index ` +
          `(expireAfterSeconds=${found.expireAfterSeconds ?? 'none'})`,
      );
    }
  });

  it('★ nothing in the server disables automatic index building', () => {
    // The mechanism guard. Every check above depends on `autoIndex` being on, and one
    // line — `mongoose.set('autoIndex', false)` or an `autoIndex: false` option —
    // would silently unbuild ALL of them at once while every other suite stayed
    // green. Pinned as a source guard because the failure is a configuration fact,
    // not a runtime behaviour any assertion here could observe.
    const sources = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) sources.push(full);
      }
    };
    walk(path.join(serverRoot, 'src'));

    const offenders = sources.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return /autoIndex\s*:\s*false|set\(\s*['"]autoIndex['"]\s*,\s*false/.test(text);
    });

    assert.deepEqual(
      offenders.map((file) => path.relative(serverRoot, file)),
      [],
      'automatic index building was disabled — every declared index would stop being created',
    );
  });

  it('★ the connection does not pass an autoIndex override', () => {
    // The second half of the mechanism guard, at the one call site that matters. A
    // whole-module grep cannot see an option injected through a spread or a typed
    // helper, so this asserts directly on the connect options object in the source.
    const dbSource = readSource('src/config/db.ts');
    const connectAt = dbSource.indexOf('mongoose.connect(');
    assert.ok(connectAt > -1, 'src/config/db.ts must still call mongoose.connect');

    // The connect options literal is everything between the call and its closing
    // `}`; an `autoIndex` key anywhere in the file is the thing being refused, since
    // this module exists solely to connect and has no other reason to name it.
    assert.ok(
      !/autoIndex/.test(dbSource),
      'src/config/db.ts mentions autoIndex — the default must not be overridden at the connect site',
    );
    assert.ok(
      /dbName:\s*env\.mongodbDbName/.test(dbSource),
      'the connect options no longer name the database explicitly — re-read this guard before trusting it',
    );
  });

  it('every model is exported by the barrel, so this suite cannot silently skip one', () => {
    // Coverage by construction: the sweep above iterates the barrel, so a model
    // that never made it into the barrel is a model this file does not audit. The
    // count is compared rather than the names, because a filename and a `modelName`
    // do not always correspond (`emailVerificationChallenge.model.ts` is exported as
    // `EmailVerificationChallenge`), and a name-guessing rule would be a rule that
    // breaks on the next model. Every model is still asserted to be a real Mongoose
    // model with a distinct collection, so a duplicate registration is caught.
    const dir = path.join(serverRoot, 'src', 'models');
    const modelFiles = fs.readdirSync(dir).filter((name) => name.endsWith('.model.ts'));

    assert.equal(
      models.length,
      modelFiles.length,
      `the models barrel exports ${models.length} models but the directory holds ${modelFiles.length} — ` +
        'one of them is not audited by this suite',
    );

    const collections = models.map((model) => model.collection.collectionName);
    assert.equal(new Set(collections).size, collections.length, 'two models share a collection name');
    for (const model of models) {
      assert.equal(typeof model.init, 'function', `${model.modelName} is not a Mongoose model`);
    }
  });

  it('the connection is the one this suite audited', () => {
    assert.equal(mongoose.connection.readyState, 1, 'the suite must run against a connected database');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  describe('the audit tool and this suite agree on the comparison rule', () => {
    it('orders key fields instead of sorting them', () => {
      // A regression guard for the defect found while building the audit tool: a
      // sorted comparison reports an index as present while displaying a different
      // order, i.e. a false green in the tool whose purpose is catching that.
      assert.equal(normalizeKey({ businessId: 1, updatedAt: -1, _id: -1 }), 'businessId:1,updatedAt:-1,_id:-1');
      assert.notEqual(
        normalizeKey({ businessId: 1, updatedAt: -1, _id: -1 }),
        normalizeKey({ _id: -1, businessId: 1, updatedAt: -1 }),
        'these are different indexes and must not compare equal',
      );

      const auditSource = readSource('scripts/audit-indexes.mjs');
      assert.ok(
        !/\.sort\(\)/.test(auditSource.split('function normalizeKey')[1].split('}')[0]),
        'audit:indexes must not sort the key fields — order is part of an index identity',
      );
    });
  });

  describe('the audit tool tells a FINDING apart from a FAILURE TO CHECK', () => {
    /**
     * `audit:indexes` exists to gate a check on its exit code alone, and its documented
     * contract is that 1 means "the declarations and the database DISAGREE". A connection
     * timeout must therefore never exit 1: that states a finding the run never made, and
     * the remedy a reader then reaches for is `syncIndexes()`, which the script's own
     * header explains can DROP an index an operator added on purpose — so the wrong code
     * here can point at the destructive repair. It exits 2 instead, which is the
     * convention `verify:demo` and `audit-access.mjs` already use for "nothing was
     * checked".
     *
     * Reproduced before the fix, on 2026-10-14: a `connect ETIMEDOUT` exited 1, which is
     * indistinguishable from drift to anything reading the code rather than the output.
     */
    const auditSource = readSource('scripts/audit-indexes.mjs');

    /** The top-level failure handler's own source, or `null` when it cannot be found. */
    const failureHandler = () => {
      const at = auditSource.indexOf('main().catch');
      return at === -1 ? null : auditSource.slice(at);
    };

    /**
     * The source with comment-only lines removed, so PROSE about an exit code cannot be
     * counted as one.
     *
     * This filter is not a nicety, and it was added after the first version of the
     * assertion below FAILED on its own documentation: `audit-indexes.mjs` explains its
     * exit codes in comments, and the sentence "`main()` reaches its `process.exit(1)`"
     * matched the pattern, so the guard reported two exit-1 calls where there is one. A
     * scan that reads text rather than intent has to say which text it means.
     */
    const codeLines = () =>
      auditSource.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      });

    it('★ the scan is live — both things it looks for are actually in the file', () => {
      // The positive control. Without it, a rename that made either extraction return
      // nothing would turn the assertions below into statements about an empty string,
      // and they would pass for the wrong reason.
      assert.ok(failureHandler(), 'the top-level failure handler must exist');
      assert.ok(
        auditSource.includes('declaration/database disagreements'),
        'the drift summary must exist, because the exit-1 assertion is anchored to it',
      );
      assert.ok(
        codeLines().some((line) => /process\.exit\(\d\)/.test(line)),
        'at least one real exit call must survive the comment filter, or the scan is vacuous',
      );
    });

    it('★ exits 2, and never 1, when it could not check anything', () => {
      const handler = failureHandler();
      assert.ok(handler, 'the top-level failure handler must exist');
      assert.match(handler, /process\.exit\(2\)/, 'an uncompleted audit must exit 2 (NOT VERIFIED)');
      assert.doesNotMatch(
        handler,
        /process\.exit\(1\)/,
        'a failure to check must never be reported as a declaration/database disagreement',
      );
    });

    it('★ exits 1 from exactly one place, and that place is the drift verdict', () => {
      // Exactly two exits, in this order: the drift verdict inside `main()`, then the
      // NOT VERIFIED handler. A third would be a new outcome and must be a decision
      // rather than an accident, so this fails and says so.
      const exits = codeLines().flatMap((line) =>
        [...line.matchAll(/process\.exit\((\d)\)/g)].map((hit) => hit[1]),
      );
      assert.deepEqual(exits, ['1', '2'], 'expected the drift verdict and the NOT VERIFIED handler only');

      const code = codeLines().join('\n');
      const driftAt = code.indexOf('process.exit(1)');
      const countAt = code.indexOf('declaration/database disagreements');
      assert.ok(
        countAt !== -1 && driftAt > countAt,
        'exit 1 must come AFTER the disagreement count is printed, so it can only report a completed audit',
      );
    });

    it('and the header states all three codes where a reader will meet them', () => {
      assert.match(auditSource, /2\s+NOT VERIFIED/, 'the exit contract must be documented in the header');
    });
  });
});
