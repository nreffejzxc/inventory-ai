// `npm run audit:indexes` — compare every DECLARED index against the indexes that
// actually EXIST in the connected database.
//
// WHY THIS EXISTS. Four increments shipped performance or lifecycle behaviour whose
// entire payoff rests on a database index: Phase 20G/20H (the list-sort keys),
// Phase 22/AI-3 (the inventory page sort `{ businessId, updatedAt: -1, _id: -1 }`),
// and the session/reset/challenge TTL keys (which are what actually expire rows).
// Each of those is guarded by a suite — but those suites read the MODEL SOURCE, so
// they can only prove an index is DECLARED. They cannot fail if the database never
// built it, and the build path is Mongoose's default `autoIndex`, which runs in the
// background at connect time and is asserted nowhere:
// `grep -rn "autoIndex\|syncIndexes\|createIndexes" src/ scripts/` finds nothing.
//
// This is the missing half: it asks the DATABASE. A declared index that is absent is
// a defect no unit suite, no typecheck and no green CI run would ever surface — the
// application keeps working and simply pays for it — which is exactly how both a
// performance regression and an unbounded-collection leak hide.
//
// READ-ONLY. It never creates, drops or modifies anything, and it deliberately does
// NOT call `syncIndexes()`: that can DROP indexes it does not recognise, including
// one an operator added on purpose to a shared database. Drift is reported for an
// operator to resolve.
//
// Coverage is by construction: the model list is `src/models/index.ts`'s own `models`
// array, so a newly added model is audited without touching this file.
//
// EXIT CODES, AND THE THREE OUTCOMES THEY MUST KEEP APART — this is the file's
// contract, because it is meant to gate a check without anyone parsing output:
//
//   0  the audit ran and every declaration matches the database
//   1  the audit ran to COMPLETION and found a declaration/database disagreement
//   2  NOT VERIFIED — the audit could not complete, so NOTHING was checked
//
// Exit 1 is a claim about the database, so it may only ever be the second of those.
// It used to be the third as well, because the catch-all handler below exited 1 for
// an unreachable database — and that is the worst false report THIS tool can make,
// since the remedy a reader then reaches for is `syncIndexes()`, which the paragraph
// above explains can destroy an index an operator added on purpose. Reproduced for
// real on 2026-10-14: a `connect ETIMEDOUT` exited 1, reading exactly like drift.
//

import 'dotenv/config';
import mongoose from 'mongoose';

import env from '../src/config/env.ts';
import models from '../src/models/index.ts';

/** Mongoose's own implicit index on `_id`, present on every collection. */
const isImplicit = (key) =>
  Object.keys(key).length === 1 && Object.prototype.hasOwnProperty.call(key, '_id');

/**
 * A comparable form of an index key.
 *
 * ORDER-SENSITIVE, deliberately, and this function is where that matters most: `{a:1,b:1}`
 * and `{b:1,a:1}` are DIFFERENT indexes. A compound index can only serve a query whose
 * sort and equality keys are a prefix of its own key order, so treating the two as equal
 * would let this audit report `ok` for an index that cannot answer the query it was added
 * for — a false green in the one tool whose entire purpose is catching exactly that.
 * (The first draft of this file sorted the fields and did precisely that: it reported the
 * AI-3 inventory page index as present while displaying the older, differently-ordered key.
 * The field order is the part that carries the meaning, so it is preserved.)
 */
function normalizeKey(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}:${typeof direction === 'number' ? direction : String(direction)}`)
    .join(',');
}

/**
 * A stable form of a partial filter. Key order in the filter is not semantic, so
 * sorting makes `{a:1,b:2}` and `{b:2,a:1}` compare equal; the filter itself is
 * compared because a key with the same fields but no filter is a DIFFERENT index
 * (and a unique index over an optional field would reject ordinary rows).
 */
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

/** The differences that matter between a declared index and the one in the database. */
function differences(declared, actual) {
  const out = [];
  const declaredPartial = normalizePartialFilter(declared?.partialFilterExpression);
  const actualPartial = normalizePartialFilter(actual?.partialFilterExpression);
  if (declaredPartial !== actualPartial) {
    out.push(
      `partialFilter declared=${declaredPartial ?? 'none'} database=${actualPartial ?? 'none'}`,
    );
  }
  if (Boolean(declared?.unique) !== Boolean(actual.unique)) {
    out.push(`unique declared=${Boolean(declared?.unique)} database=${Boolean(actual.unique)}`);
  }
  if (Boolean(declared?.sparse) !== Boolean(actual.sparse)) {
    out.push(`sparse declared=${Boolean(declared?.sparse)} database=${Boolean(actual.sparse)}`);
  }
  const declaredTtl = declared?.expireAfterSeconds;
  const actualTtl = actual.expireAfterSeconds;
  if (declaredTtl !== undefined || actualTtl !== undefined) {
    if (declaredTtl !== actualTtl) out.push(`TTL declared=${declaredTtl ?? 'none'} database=${actualTtl ?? 'none'}`);
  }
  return out;
}

async function main() {
  await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });
  console.log(`[indexes] database: ${env.mongodbDbName}`);

  let drift = 0;
  let checked = 0;
  let collections = 0;

  for (const model of models) {
    const label = `${model.modelName} (${model.collection.collectionName})`;
    collections += 1;

    const declared = new Map();
    for (const [key, options] of model.schema.indexes()) {
      if (isImplicit(key)) continue;
      declared.set(normalizeKey(key), { key, options });
    }

    let actual;
    try {
      actual = await model.collection.indexes();
    } catch (err) {
      // A collection that has never been written has no indexes — not drift.
      if (err?.codeName !== 'NamespaceNotFound') throw err;
      actual = [];
    }

    const present = new Map();
    for (const index of actual) {
      if (index.name === '_id_') continue;
      const key = index.key ?? {};
      present.set(normalizeKey(key), { key, name: index.name, ...index });
    }

    const rows = [];
    for (const [normalized, entry] of declared) {
      checked += 1;
      const found = present.get(normalized);
      if (!found) {
        drift += 1;
        rows.push(`    MISSING   ${normalized}    declared, but NOT in the database`);
        continue;
      }
      const diffs = differences(entry.options, found);
      if (diffs.length > 0) {
        drift += 1;
        rows.push(`    MISMATCH  ${normalized}    ${diffs.join('; ')}   (${found.name})`);
      } else {
        const ttl = entry.options?.expireAfterSeconds;
        const notes = [
          entry.options?.unique ? 'unique' : null,
          entry.options?.sparse ? 'sparse' : null,
          ttl !== undefined ? `ttl ${ttl}s` : null,
        ].filter(Boolean);
        rows.push(`    ok        ${normalized}${notes.length ? `    [${notes.join(', ')}]` : ''}`);
      }
    }
    for (const [normalized, found] of present) {
      if (!declared.has(normalized)) {
        // An undeclared index is usually harmless (a leftover, or one an operator
        // added on purpose) but it is worth seeing: it is also what a renamed or
        // removed index looks like from here.
        rows.push(`    UNDECLARED ${normalized}   (${found.name}) in the database, not declared by the model`);
      }
    }

    if (rows.length > 0) {
      console.log(`[indexes] ${label}`);
      for (const row of rows) console.log(row);
    }
  }

  console.log('');
  console.log(`[indexes] ${checked} declared indexes across ${collections} collections`);
  console.log(`[indexes] declaration/database disagreements: ${drift}`);

  await mongoose.disconnect();
  if (drift > 0) {
    console.log('[indexes] DRIFT — the declarations and the database disagree.');
    process.exit(1);
  }
  console.log('[indexes] every declared index matches the database.');
}

/**
 * ANY failure on the way to a verdict exits 2 — never 1.
 *
 * A connection that could not be opened, a collection that could not be listed and a
 * fault inside this script are all NOTHING-WAS-CHECKED, because `main()` reaches its
 * `process.exit(1)` only after every read has succeeded and the drift summary has
 * been printed. So the only way to exit 1 from here would be to claim a finding this
 * run never made.
 *
 * Exit 2 is the convention this repository already uses for exactly this state:
 * `verify:demo` exits 2 for "NOT VERIFIED — the database could not be reached" and
 * states outright that "this is not a data violation", and `audit-access.mjs` exits 2
 * as well. Guide 6 documents that reading. This script was the one check that did not
 * follow it, and the message below is deliberately the same shape so an operator who
 * has seen one has seen both.
 */
main().catch(async (err) => {
  console.error(`[indexes] NOT VERIFIED (exit 2) — ${err?.message ?? err}`);
  console.error('[indexes] nothing was checked, so this says nothing about the database.');
  try {
    await mongoose.disconnect();
  } catch {
    // Nothing useful to add; the audit is already failing.
  }
  process.exit(2);
});
