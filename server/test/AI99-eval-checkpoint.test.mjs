// AI-99 — resumable checkpoints for the 10k evaluator.
//
// These are pure file/config cases: no database, no model, no quota. They pin the
// decisions that make a rerun safe: an exact config and dataset match, a completed or
// corrupt checkpoint that is ignored rather than resumed, and atomic replace semantics.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CHECKPOINT_VERSION,
  checkpointConfig,
  checkpointPathFor,
  checkpointRows,
  completedWorkIndices,
  datasetFingerprint,
  readCheckpoint,
  removeCheckpoint,
  sameCheckpointConfig,
  writeCheckpoint,
} from '../scripts/perf/eval-checkpoint.mjs';

const DIR = fs.mkdtempSync(path.join(process.cwd(), '.tmp-checkpoint-test-'));

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const baseConfig = checkpointConfig({
  phase: 'sustained',
  size: 10256,
  seed: 1,
  concurrency: 10,
  requests: 30,
  gapMs: 5000,
  transport: 'http',
  baseUrl: 'http://127.0.0.1:4107',
  primary: 'openai/gpt-oss-20b',
  free: 'nvidia/nemotron-3.5-lightning:free',
});

const baseDataset = {
  products: 10256,
  inventoryRows: 30768,
  restockCount: 5,
  restockNames: ['A', 'B', 'C', 'D', 'E'],
  lowSkus: ['SEEDSKU-5000'],
  stockSamples: [{ sku: 'SEEDSKU-0', name: 'A', expected: 75 }],
  loadSamples: [{ sku: 'SEEDSKU-1', expected: 42 }],
};

test('AI-99: a checkpoint resumes only on an exact config match', () => {
  assert.equal(sameCheckpointConfig(baseConfig, { ...baseConfig }), true);
  assert.equal(sameCheckpointConfig(baseConfig, { ...baseConfig, requests: 31 }), false);
  assert.equal(sameCheckpointConfig(baseConfig, { ...baseConfig, gapMs: 0 }), false);
  assert.equal(
    sameCheckpointConfig(baseConfig, { ...baseConfig, baseUrl: 'http://127.0.0.1:4000' }),
    false,
  );
  assert.equal(sameCheckpointConfig(baseConfig, null), false);
});

test('AI-99: a dataset fingerprint notices a changed sample or restock set', () => {
  const same = datasetFingerprint(baseDataset);
  assert.equal(same, datasetFingerprint({ ...baseDataset }));
  assert.notEqual(
    same,
    datasetFingerprint({
      ...baseDataset,
      stockSamples: [{ sku: 'SEEDSKU-0', name: 'A', expected: 76 }],
    }),
  );
  assert.notEqual(same, datasetFingerprint({ ...baseDataset, restockNames: ['A'] }));
});

test('AI-99: completed work indices ignore duplicates and malformed rows', () => {
  const done = completedWorkIndices([
    { workIndex: 0 },
    { workIndex: 2 },
    { workIndex: 2 },
    { workIndex: -1 },
    { workIndex: '3' },
    { workIndex: 1.5 },
    {},
  ]);
  assert.deepEqual([...done].sort((a, b) => a - b), [0, 2]);
  assert.deepEqual([...completedWorkIndices([])], []);
});

test('AI-99: a running checkpoint round-trips, and completion/corruption is ignored', () => {
  const file = checkpointPathFor(path.join(DIR, 'phase.json'));
  assert.equal(file, path.join(DIR, 'phase.json.checkpoint.json'));
  assert.deepEqual(readCheckpoint(file), { checkpoint: null, reason: null });

  const value = {
    version: CHECKPOINT_VERSION,
    state: 'running',
    config: baseConfig,
    dataset: baseDataset,
    rows: [{ workIndex: 0, check: { ok: true, reasons: [] } }],
  };
  writeCheckpoint(file, value);
  const loaded = readCheckpoint(file);
  assert.deepEqual(loaded.checkpoint, value);
  assert.deepEqual(checkpointRows(loaded.checkpoint), value.rows);

  writeCheckpoint(file, { ...value, state: 'complete' });
  assert.equal(readCheckpoint(file).checkpoint, null);
  assert.match(readCheckpoint(file).reason, /state complete/);

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(readCheckpoint(file).checkpoint, null);
  assert.match(readCheckpoint(file).reason, /invalid JSON/);

  writeCheckpoint(file, { ...value, version: CHECKPOINT_VERSION + 1 });
  assert.equal(readCheckpoint(file).checkpoint, null);
  assert.match(readCheckpoint(file).reason, /version mismatch/);

  assert.equal(removeCheckpoint(file), true);
  assert.equal(removeCheckpoint(file), false);
});
