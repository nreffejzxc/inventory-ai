#!/usr/bin/env node
/**
 * Workflow invariant guard.
 *
 * Four small facts are easy to break in review and expensive to notice later:
 *   * every remote action is pinned to a full 40-character commit SHA;
 *   * every job in every workflow declares a positive `timeout-minutes`;
 *   * every `image: mongo:*` in a workflow matches `compose.yaml`;
 *   * the major in `.nvmrc` matches the first major in each declared `engines.node`.
 *
 * WHY THIS EXISTS. SHA pinning is a repository policy, but a new action can be added
 * with a tag; a new job can omit its timeout; Dependabot updates only `compose.yaml`;
 * and the Node major is written in two places. Each is a one-line review miss that a
 * small, local check catches on every pull request.
 *
 * SCOPE. This reads the workflow YAML as text. It does not import a YAML parser and
 * does not try to be a general YAML validator. The files it checks are the four
 * workflows in this repository, which use consistent two-/four-space job structure.
 * A workflow that changes that structure will produce a finding rather than a silent
 * pass, which is the intended failure mode.
 *
 * USAGE
 *   node scripts/check-workflow-invariants.mjs
 *   node scripts/check-workflow-invariants.mjs --self-test
 *
 * The self-test runs first on every invocation, so a rule that stopped matching
 * cannot report a clean tree. Exit codes: 0 clean, 1 finding or failed self-test,
 * 2 could not read or parse an input.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const FULL_SHA = /^[0-9a-f]{40}$/i;
const JOB_LINE = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/;
const TIMEOUT_LINE = /^    timeout-minutes:\s*(\d+)\s*(?:#.*)?$/;
const TOP_LEVEL = /^\S/;

function read(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => path.join('.github', 'workflows', name));
}

/** Return every remote `uses:` reference and its line number. Local actions are exempt. */
function actionRefs(text) {
  const refs = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match) return;
    const ref = match[1].replace(/^["']|["']$/g, '');
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;
    refs.push({ ref, line: index + 1 });
  });
  return refs;
}

/** Every job ID, its line and its declared timeout. */
function jobs(text) {
  const found = [];
  let inJobs = false;
  let current = null;

  text.split(/\r?\n/).forEach((line, index) => {
    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      inJobs = true;
      current = null;
      return;
    }
    if (!inJobs) return;
    if (TOP_LEVEL.test(line)) {
      inJobs = false;
      current = null;
      return;
    }

    const job = line.match(JOB_LINE);
    if (job) {
      current = { id: job[1], line: index + 1, timeout: null };
      found.push(current);
      return;
    }
    if (!current) return;

    const timeout = line.match(TIMEOUT_LINE);
    if (timeout) current.timeout = Number(timeout[1]);
  });

  return found;
}

/** The image for the `mongo` service in compose.yaml, if it can be read. */
function composeMongoImage(text) {
  let inServices = false;
  let inMongo = false;

  for (const line of text.split(/\r?\n/)) {
    if (!inServices) {
      if (/^services:\s*(?:#.*)?$/.test(line)) inServices = true;
      continue;
    }
    if (TOP_LEVEL.test(line)) break;
    const service = line.match(JOB_LINE);
    if (service) {
      inMongo = service[1] === 'mongo';
      continue;
    }
    if (!inMongo) continue;
    const image = line.match(/^    image:\s*["']?([^"'\s#]+)/);
    if (image) return image[1];
  }
  return null;
}

/** Every Mongo image literal in a workflow, with its line. */
function workflowMongoImages(text) {
  const images = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*image:\s*["']?(mongo:[^"'\s#]+)/);
    if (match) images.push({ image: match[1], line: index + 1 });
  });
  return images;
}

function firstMajor(value) {
  const match = String(value).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function expect(condition, label) {
  if (!condition) throw new Error(label);
}

/** Positive and negative controls for every rule; runs before the real scan. */
function selfTest() {
  let controls = 0;
  const check = (condition, label) => {
    expect(condition, label);
    controls += 1;
  };

  const pinned = actionRefs('      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v1');
  check(pinned.length === 1 && FULL_SHA.test(pinned[0].ref.split('@').at(-1)), 'full SHA accepted');
  const unpinned = actionRefs('      - uses: actions/checkout@v4');
  check(unpinned.length === 1 && !FULL_SHA.test(unpinned[0].ref.split('@').at(-1)), 'tag rejected');
  check(actionRefs('      - uses: ./local-action').length === 0, 'local action exempt');

  const missingTimeout = jobs('jobs:\n  test:\n    runs-on: ubuntu-latest\n');
  check(missingTimeout.length === 1 && missingTimeout[0].timeout === null, 'missing timeout found');
  const timed = jobs('jobs:\n  test:\n    timeout-minutes: 7\n    runs-on: ubuntu-latest\n');
  check(timed.length === 1 && timed[0].timeout === 7, 'timeout parsed');

  check(
    composeMongoImage('services:\n  mongo:\n    image: mongo:7.0.48\nvolumes:\n  data:\n') === 'mongo:7.0.48',
    'compose image parsed',
  );
  check(
    workflowMongoImages('services:\n  mongo:\n    image: mongo:7.0.47\n').length === 1,
    'workflow image found',
  );
  check(firstMajor('>=24.0.0') === 24, 'engine major parsed');
  check(firstMajor('24') === 24, 'nvm major parsed');

  return controls;
}

function run() {
  const findings = [];
  const files = workflowFiles();
  if (files.length === 0) findings.push('.github/workflows: no workflow files found');

  const composeImage = composeMongoImage(read('compose.yaml'));
  if (!composeImage) findings.push('compose.yaml: could not read the mongo service image');

  let actionCount = 0;
  let jobCount = 0;
  let mongoCount = 0;

  for (const file of files) {
    const text = read(file);

    for (const action of actionRefs(text)) {
      actionCount += 1;
      const ref = action.ref;
      const sha = ref.includes('@') ? ref.slice(ref.lastIndexOf('@') + 1) : '';
      if (!FULL_SHA.test(sha)) {
        findings.push(`${file}:${action.line}: action is not pinned to a full commit SHA: ${ref}`);
      }
    }

    const workflowJobs = jobs(text);
    if (workflowJobs.length === 0) findings.push(`${file}: no jobs found`);
    for (const job of workflowJobs) {
      jobCount += 1;
      if (job.timeout === null || job.timeout <= 0) {
        findings.push(`${file}:${job.line}: job "${job.id}" has no positive timeout-minutes`);
      }
    }

    for (const image of workflowMongoImages(text)) {
      mongoCount += 1;
      if (composeImage && image.image !== composeImage) {
        findings.push(
          `${file}:${image.line}: ${image.image} does not match compose.yaml (${composeImage})`,
        );
      }
    }
  }

  if (mongoCount === 0) {
    console.log('[workflow-invariants] note: no workflow Mongo image refs; parity check skipped');
  }

  const nvmMajor = firstMajor(read('.nvmrc').trim());
  if (nvmMajor === null) findings.push('.nvmrc: could not read a Node major');

  let engineCount = 0;
  for (const packagePath of ['server/package.json', 'mobile/package.json']) {
    const pkg = JSON.parse(read(packagePath));
    const range = pkg.engines?.node;
    if (!range) continue;
    engineCount += 1;
    const major = firstMajor(range);
    if (major === null) {
      findings.push(`${packagePath}: could not read the first major from engines.node "${range}"`);
    } else if (nvmMajor !== null && major !== nvmMajor) {
      findings.push(
        `${packagePath}: engines.node "${range}" starts at major ${major}, but .nvmrc is ${nvmMajor}`,
      );
    }
  }
  if (engineCount === 0) findings.push('no package.json declares engines.node; parity check has no coverage');

  if (findings.length > 0) {
    for (const finding of findings) console.error(`  FAIL  ${finding}`);
    console.error(`[workflow-invariants] ${findings.length} violation(s)`);
    return 1;
  }

  console.log(
    `[workflow-invariants] PASS — ${files.length} workflows, ${actionCount} action refs, ` +
      `${jobCount} jobs, ${mongoCount} Mongo image refs; Node ${nvmMajor}`,
  );
  return 0;
}

try {
  const controls = selfTest();
  console.log(`[workflow-invariants] self-test: ${controls} controls passed`);
  if (process.argv.includes('--self-test')) process.exit(0);
} catch (error) {
  console.error(`[workflow-invariants] self-test failed: ${error.message}`);
  process.exit(1);
}

try {
  process.exit(run());
} catch (error) {
  console.error(`[workflow-invariants] could not run: ${error.message}`);
  process.exit(2);
}
