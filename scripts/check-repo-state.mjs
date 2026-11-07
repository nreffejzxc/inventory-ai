#!/usr/bin/env node
/**
 * Session close-out check.
 *
 * The repository is the delivery, not the folder on this computer. Run this on
 * `main` after the pull request is merged:
 *
 *   node scripts/check-repo-state.mjs
 *
 * It fetches `origin/main`, then fails when the worktree is dirty, when `main`
 * is ahead of or behind the remote, or when the checkout is not on `main`.
 * Exit code 1 means the local repository is not in a finished state; exit code
 * 2 means the remote could not be read, so synchronization was not verified.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message, code = 1) {
  console.error(`[repo] ${message}`);
  process.exitCode = code;
}

try {
  git(['fetch', '--quiet', 'origin', 'main']);
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  fail(`could not fetch origin/main; synchronization not verified: ${detail}`, 2);
  process.exit();
}

const branch = git(['branch', '--show-current']);
const status = git(['status', '--porcelain', '--untracked-files=all']);
const head = git(['rev-parse', 'HEAD']);
const remote = git(['rev-parse', 'origin/main']);
const [ahead, behind] = git(['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
  .split(/\s+/)
  .map(Number);

const problems = [];
if (branch !== 'main') {
  problems.push(`current branch is ${branch || '(detached)'}; finish on main`);
}
if (status) {
  problems.push(`working tree is not clean:\n${status.split('\n').map((line) => `  ${line}`).join('\n')}`);
}
if (Number.isNaN(ahead) || Number.isNaN(behind)) {
  problems.push('could not compare HEAD with origin/main');
} else {
  if (ahead > 0) problems.push(`main is ${ahead} commit(s) ahead of origin/main`);
  if (behind > 0) problems.push(`main is ${behind} commit(s) behind origin/main`);
}

if (problems.length > 0) {
  fail(problems.join('\n'));
  process.exit();
}

console.log(`[repo] clean main at ${head.slice(0, 7)}; level with origin/main (${remote.slice(0, 7)}).`);
