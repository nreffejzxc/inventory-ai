// Resumable checkpoints for `eval-simple-inventory-scale.mjs`.
//
// WHY THIS EXISTS. A host timeout can kill the evaluator between two requests. Its
// `finally` cleanup then never runs, so the seed tenant survives, and the partial rows
// only live in the artifact that is rewritten after each request. The next run used to
// seed a second tenant and start from question one. This module keeps the small,
// serialisable half of that state beside the artifact: the tenant-independent dataset
// fingerprint, the run configuration, and the rows already completed. The evaluator
// reseeds (after removing the orphan) and skips the completed work indices.
//
// ATOMICS. `writeCheckpoint` writes a sibling temp file and renames it, so a kill during
// a write leaves the previous checkpoint intact instead of half a JSON document.

import fs from 'node:fs';
import path from 'node:path';

/** Bump when the checkpoint shape or its matching rules change. */
export const CHECKPOINT_VERSION = 1;

/** The checkpoint lives beside the artifact it belongs to. */
export function checkpointPathFor(outPath) {
  return `${outPath}.checkpoint.json`;
}

/**
 * The fields that must agree before old rows are reused.
 *
 * `warmupMs` is deliberately absent: it changes pacing, not the questions or their
 * answers, so a rerun with a different warm-up can still resume.
 */
export function checkpointConfig({
  phase,
  size,
  seed,
  concurrency,
  requests,
  gapMs,
  transport,
  baseUrl,
  primary,
  free,
}) {
  return {
    phase,
    size,
    seed,
    concurrency,
    requests,
    gapMs,
    transport,
    baseUrl: transport === 'http' ? baseUrl : null,
    primary,
    free,
  };
}

/** Exact configuration match, field by field, so a partial object cannot resume. */
export function sameCheckpointConfig(left, right) {
  if (!left || !right) return false;
  return (
    left.phase === right.phase &&
    left.size === right.size &&
    left.seed === right.seed &&
    left.concurrency === right.concurrency &&
    left.requests === right.requests &&
    left.gapMs === right.gapMs &&
    left.transport === right.transport &&
    left.baseUrl === right.baseUrl &&
    left.primary === right.primary &&
    left.free === right.free
  );
}

/** Rows in a checkpoint, or an empty list when the file did not carry any. */
export function checkpointRows(checkpoint) {
  return Array.isArray(checkpoint?.rows) ? checkpoint.rows : [];
}

/** Work indices already completed, ignoring duplicates and malformed values. */
export function completedWorkIndices(rows) {
  const done = new Set();
  for (const row of rows ?? []) {
    if (Number.isInteger(row?.workIndex) && row.workIndex >= 0) done.add(row.workIndex);
  }
  return done;
}

/**
 * A stable description of the seeded data.
 *
 * Product ids are deliberately omitted: reseeding creates new ObjectIds, while the
 * questions and their expected answers are keyed by SKU and name. If any of those
 * observable facts changed, the old rows are not evidence about this dataset.
 */
export function datasetFingerprint(dataset) {
  return JSON.stringify({
    products: dataset?.products,
    inventoryRows: dataset?.inventoryRows,
    restockCount: dataset?.restockCount,
    restockNames: dataset?.restockNames,
    lowSkus: dataset?.lowSkus,
    stockSamples: dataset?.stockSamples,
    loadSamples: dataset?.loadSamples,
  });
}

/**
 * Read a checkpoint this version can resume.
 *
 * Missing is not an error (`reason: null`). A corrupt file, an older version, or a
 * checkpoint from a finished/failed run is reported and ignored; it must never be
 * turned into a silent empty resume.
 */
export function readCheckpoint(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { checkpoint: null, reason: null };
    return { checkpoint: null, reason: `unreadable (${error?.message ?? error})` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { checkpoint: null, reason: `invalid JSON (${error?.message ?? error})` };
  }

  if (!parsed || typeof parsed !== 'object' || parsed.version !== CHECKPOINT_VERSION) {
    return { checkpoint: null, reason: 'version mismatch' };
  }
  if (parsed.state !== 'running') {
    return { checkpoint: null, reason: `state ${parsed.state ?? 'unknown'}` };
  }
  if (!Array.isArray(parsed.rows)) {
    return { checkpoint: null, reason: 'rows missing' };
  }
  return { checkpoint: parsed, reason: null };
}

/** Atomically replace a checkpoint; a kill mid-write leaves the previous one intact. */
export function writeCheckpoint(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/** Remove a completed checkpoint; absence is not a failure. */
export function removeCheckpoint(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
