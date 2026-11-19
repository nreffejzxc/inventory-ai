#!/usr/bin/env node
/**
 * End-to-end self-test for scripts/check-workflow-invariants.mjs.
 *
 * The guard's own `--self-test` exercises the parsing rules in memory. This test
 * proves the whole program: it builds temporary fixture repositories on disk,
 * runs the real guard against each one with `--root`, and asserts that a clean
 * fixture passes while each protected invariant fails with its named finding:
 *
 *   1. an action that is not pinned to a full commit SHA;
 *   2. a job with no positive `timeout-minutes`;
 *   3. a `mongo:*` service image that differs from `compose.yaml`;
 *   4. an `engines.node` major that differs from `.nvmrc`.
 *
 * Dependency-free: Node built-ins only, no network, and no writes outside the
 * OS temporary directory. Each fixture also asserts exactly one violation, so a
 * case cannot pass for the wrong reason.
 *
 * USAGE
 *   node scripts/test-workflow-invariants.mjs
 *
 * Exit codes: 0 every fixture behaved, 1 an assertion failed.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('./check-workflow-invariants.mjs', import.meta.url));
const PINNED = `actions/checkout@${'a'.repeat(40)}`;

function workflowText({ action = PINNED, timeout = true, mongoImage = null } = {}) {
  return [
    'name: fixture',
    'on: push',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    ...(timeout ? ['    timeout-minutes: 5'] : []),
    ...(mongoImage ? ['    services:', '      mongo:', `        image: ${mongoImage}`] : []),
    '    steps:',
    `      - uses: ${action}`,
    '',
  ].join('\n');
}

function writeFixture(root, testCase) {
  const workflowDir = path.join(root, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(path.join(root, 'server'), { recursive: true });
  mkdirSync(path.join(root, 'mobile'), { recursive: true });

  writeFileSync(path.join(workflowDir, 'ci.yml'), workflowText(testCase.workflow));
  writeFileSync(path.join(root, 'compose.yaml'), 'services:\n  mongo:\n    image: mongo:7.0.48\n');
  writeFileSync(path.join(root, '.nvmrc'), `${testCase.nvm ?? '24'}\n`);
  writeFileSync(
    path.join(root, 'server', 'package.json'),
    JSON.stringify({ engines: { node: testCase.serverEngine ?? '>=24.0.0' } }),
  );
  writeFileSync(
    path.join(root, 'mobile', 'package.json'),
    JSON.stringify({ engines: { node: testCase.mobileEngine ?? '>=24.0.0' } }),
  );
}

const cases = [
  {
    name: 'clean fixture passes',
    expectStatus: 0,
    expect: ['PASS'],
  },
  {
    name: 'unpinned action fails',
    workflow: { action: 'actions/checkout@v4' },
    expectStatus: 1,
    expect: ['action is not pinned to a full commit SHA: actions/checkout@v4'],
  },
  {
    name: 'missing job timeout fails',
    workflow: { timeout: false },
    expectStatus: 1,
    expect: ['job "test" has no positive timeout-minutes'],
  },
  {
    name: 'MongoDB image mismatch fails',
    workflow: { mongoImage: 'mongo:7.0.47' },
    expectStatus: 1,
    expect: ['mongo:7.0.47 does not match compose.yaml (mongo:7.0.48)'],
  },
  {
    name: 'Node.js major mismatch fails',
    serverEngine: '>=22.0.0',
    expectStatus: 1,
    expect: ['engines.node ">=22.0.0" starts at major 22, but .nvmrc is 24'],
  },
];

let failures = 0;

for (const testCase of cases) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-invariants-'));
  try {
    writeFixture(root, testCase);
    const result = spawnSync(process.execPath, [GUARD, `--root=${root}`], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.equal(
      result.status,
      testCase.expectStatus,
      `${testCase.name}: expected exit ${testCase.expectStatus}, got ${result.status}\n${output}`,
    );
    for (const expected of testCase.expect) {
      assert.ok(output.includes(expected), `${testCase.name}: missing "${expected}"\n${output}`);
    }
    if (testCase.expectStatus === 1) {
      assert.ok(
        output.includes('1 violation(s)'),
        `${testCase.name}: expected exactly one finding\n${output}`,
      );
    }

    console.log(`[workflow-invariants-e2e] ok — ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`[workflow-invariants-e2e] FAIL — ${error.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (failures > 0) {
  console.error(`[workflow-invariants-e2e] ${failures} of ${cases.length} fixtures failed`);
  process.exit(1);
}

console.log(`[workflow-invariants-e2e] PASS — ${cases.length} fixture repositories`);
