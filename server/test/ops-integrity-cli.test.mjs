// The operational half of `ops:integrity`: a GitHub failure must be persisted
// and retried, not forgotten because the finding's signature did not change.
//
// These cases drive the real `runOps` path (lock, child result, history and
// notification), with the child and `gh` replaced by deterministic fakes. No
// MongoDB, network or GitHub account is involved.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runOps } from '../scripts/ops-integrity.mjs';
import { readOpsHistory } from '../scripts/lib/ops-integrity.mjs';

const TITLE = '[integrity-ops] Audit-write failures need review';
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-integrity-cli-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
      return true;
    },
    text() {
      return text;
    },
  };
}

function child(status, payload) {
  return {
    status,
    stdout: JSON.stringify(payload),
    stderr: '',
    error: null,
  };
}

function finding() {
  return child(1, {
    database: 'inventoryai_prod_db',
    total: 2,
    byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }],
  });
}

function clean() {
  return child(0, { database: 'inventoryai_prod_db', total: 0, byAction: [] });
}

function fakeGh({ initiallyOpen = false } = {}) {
  const state = {
    open: initiallyOpen,
    number: 7,
    body: '',
    comments: [],
    createCalls: 0,
    commentCalls: 0,
    closeCalls: 0,
    failCreate: false,
    failComment: false,
    failCommentAfterPost: false,
    failClose: false,
    failView: false,
    calls: [],
  };
  function gh(args) {
    state.calls.push(args);
    if (args[0] !== 'issue') throw new Error(`unexpected gh command: ${args.join(' ')}`);
    if (args[1] === 'list') {
      return JSON.stringify(
        state.open
          ? [{ number: state.number, title: TITLE, url: `https://example.test/issues/${state.number}` }]
          : []
      );
    }
    if (args[1] === 'view') {
      if (state.failView) throw new Error('issue view failed');
      return JSON.stringify({ body: state.body, comments: state.comments });
    }
    if (args[1] === 'create') {
      state.createCalls += 1;
      if (state.failCreate) throw new Error('issue creation failed');
      state.open = true;
      const bodyIndex = args.indexOf('--body-file');
      state.body = bodyIndex >= 0 ? readFileSync(args[bodyIndex + 1], 'utf8') : '';
      return `https://example.test/issues/${state.number}`;
    }
    if (args[1] === 'comment') {
      state.commentCalls += 1;
      if (state.failComment) throw new Error('issue comment failed');
      const bodyIndex = args.indexOf('--body-file');
      const body = bodyIndex >= 0 ? readFileSync(args[bodyIndex + 1], 'utf8') : args[args.indexOf('--body') + 1];
      state.comments.push({ body });
      if (state.failCommentAfterPost) throw new Error('issue comment response lost');
      return '';
    }
    if (args[1] === 'close') {
      state.closeCalls += 1;
      if (state.failClose) throw new Error('issue close failed');
      state.open = false;
      return '';
    }
    throw new Error(`unexpected gh command: ${args.join(' ')}`);
  }
  return { gh, state };
}

function run({ historyDir, result, gh, notify = true }) {
  const out = capture();
  const err = capture();
  const argv = [
    '--command=audit:failures',
    '--with-production',
    ...(notify ? ['--notify'] : []),
    '--format=json',
    `--history-dir=${historyDir}`,
    `--lock-dir=${path.join(historyDir, 'locks')}`,
  ];
  const code = runOps({
    argv,
    stdout: out,
    stderr: err,
    runChild: () => result,
    gh,
    now: () => new Date('2026-11-19T00:00:00.000Z'),
  });
  return { code, out: out.text(), err: err.text() };
}

describe('ops:integrity CLI — durable alert delivery', () => {
  it('persists a failed issue creation and retries it on the next unchanged run', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh();
    state.failCreate = true;

    const first = run({ historyDir, result: finding(), gh });
    assert.equal(first.code, 1);
    const failed = readOpsHistory(historyPath);
    assert.equal(failed.notification.action, 'failed');
    assert.equal(failed.notification.undelivered, true);
    assert.equal(failed.notificationPending.intent, 'alert');
    assert.equal(failed.notificationPending.stage, 'create');
    assert.match(failed.notificationPending.error, /issue creation failed/);

    // The finding and its signature are identical; only the undelivered state
    // is allowed to trigger the retry.
    state.failCreate = false;
    const second = run({ historyDir, result: finding(), gh });
    assert.equal(second.code, 1);
    const delivered = readOpsHistory(historyPath);
    assert.equal(delivered.notification.action, 'created');
    assert.equal(delivered.notification.undelivered, false);
    assert.equal(delivered.notificationPending, null);
    assert.equal(state.createCalls, 2, 'the failed create was attempted again');
  });

  it('retries a failed comment on an existing issue', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh({ initiallyOpen: true });
    state.failComment = true;

    const first = run({ historyDir, result: finding(), gh });
    assert.equal(first.code, 1);
    assert.equal(readOpsHistory(historyPath).notificationPending.stage, 'comment');

    state.failComment = false;
    const second = run({ historyDir, result: finding(), gh });
    assert.equal(second.code, 1);
    assert.equal(readOpsHistory(historyPath).notification.action, 'updated');
    assert.equal(state.commentCalls, 2, 'the failed comment was attempted again');
  });

  it('resumes a recovery at close, without posting the recovery comment twice', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh({ initiallyOpen: true });

    // Establish the open issue and its finding.
    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 1);

    // The comment succeeds, then the close fails. Only the close is pending.
    state.failClose = true;
    assert.equal(run({ historyDir, result: clean(), gh }).code, 0);
    const failedClose = readOpsHistory(historyPath);
    assert.equal(failedClose.notification.action, 'failed');
    assert.equal(failedClose.notificationPending.intent, 'recovery');
    assert.equal(failedClose.notificationPending.stage, 'close');
    assert.match(failedClose.notificationPending.error, /issue close failed/);

    // The next clean run retries the close and does not comment again.
    state.failClose = false;
    assert.equal(run({ historyDir, result: clean(), gh }).code, 0);
    const recovered = readOpsHistory(historyPath);
    assert.equal(recovered.notification.action, 'recovered');
    assert.equal(recovered.notificationPending, null);
    assert.equal(
      state.commentCalls,
      2,
      'the finding comment plus the recovery comment were posted once each; the close retry did not add a third'
    );
    assert.equal(state.closeCalls, 2, 'the failed close was retried');
    assert.equal(state.open, false);
  });

  it('does not repost a comment when the first post landed but its answer was lost', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh({ initiallyOpen: true });
    state.failCommentAfterPost = true;

    // The comment reached GitHub, then the process lost the response and stored
    // the operation as pending. A blind retry would post the same alert twice.
    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 1);
    assert.equal(readOpsHistory(historyPath).notificationPending.stage, 'comment');

    state.failCommentAfterPost = false;
    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 1, 'the marker proved the comment already landed');
    assert.equal(state.comments.length, 1);
    assert.equal(readOpsHistory(historyPath).notificationPending, null);
  });

  it('deduplicates one alert across two scheduler hosts with separate histories', () => {
    const firstHost = tempDir();
    const secondHost = tempDir();
    const { gh, state } = fakeGh();

    assert.equal(run({ historyDir: firstHost, result: finding(), gh }).code, 1);
    assert.equal(state.createCalls, 1);
    assert.equal(state.commentCalls, 0);

    // The second host has no local history, but the issue body carries the same
    // marker. It must not add a duplicate comment.
    assert.equal(run({ historyDir: secondHost, result: finding(), gh }).code, 1);
    assert.equal(state.createCalls, 1);
    assert.equal(state.commentCalls, 0);
    assert.equal(readOpsHistory(path.join(secondHost, 'audit-failures.json')).notification.action, 'updated');
  });

  it('deduplicates a recovery comment across hosts when the first close fails', () => {
    const firstHost = tempDir();
    const secondHost = tempDir();
    const { gh, state } = fakeGh();

    // Host 1 opens the issue; host 2 records the finding without commenting
    // because the issue body already carries the alert marker.
    assert.equal(run({ historyDir: firstHost, result: finding(), gh }).code, 1);
    assert.equal(run({ historyDir: secondHost, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 0);

    // Host 1 posts the recovery comment but its close fails, leaving the issue
    // open for host 2 to finish.
    state.failClose = true;
    assert.equal(run({ historyDir: firstHost, result: clean(), gh }).code, 0);
    const recoveryComments = state.comments.filter((comment) =>
      comment.body.includes('no longer reported')
    );
    assert.equal(recoveryComments.length, 1);

    state.failClose = false;
    assert.equal(run({ historyDir: secondHost, result: clean(), gh }).code, 0);
    assert.equal(
      state.comments.filter((comment) => comment.body.includes('no longer reported')).length,
      1,
      'the second host saw the recovery marker and did not comment again'
    );
    assert.equal(state.open, false);
  });

  it('does not resume a recovery close on a replacement issue', () => {
    const historyDir = tempDir();
    const { gh, state } = fakeGh({ initiallyOpen: true });

    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    state.failClose = true;
    assert.equal(run({ historyDir, result: clean(), gh }).code, 0);
    assert.equal(readOpsHistory(path.join(historyDir, 'audit-failures.json')).notificationPending.issueNumber, 7);

    // The original issue was closed by hand and a replacement with the same
    // title now carries the open alert. The pending close belongs to issue 7;
    // closing issue 8 without a recovery comment would hide the recovery.
    state.number = 8;
    state.open = true;
    state.body = '';
    state.comments = [];
    state.failClose = false;
    assert.equal(run({ historyDir, result: clean(), gh }).code, 0);

    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /no longer reported/);
    assert.equal(state.open, false);
  });

  it('keeps the alert pending when the issue comments cannot be read', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh({ initiallyOpen: true });
    state.failView = true;

    // Posting blind is the duplicate this guard exists to prevent. The failure
    // is persisted and retried instead.
    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 0);
    const pending = readOpsHistory(historyPath).notificationPending;
    assert.equal(pending.stage, 'comment');
    assert.match(pending.error, /issue view failed/);

    state.failView = false;
    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(state.commentCalls, 1);
    assert.equal(readOpsHistory(historyPath).notificationPending, null);
  });

  it('does not erase a pending alert when a later run omits --notify', () => {
    const historyDir = tempDir();
    const historyPath = path.join(historyDir, 'audit-failures.json');
    const { gh, state } = fakeGh();
    state.failCreate = true;

    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    const pending = readOpsHistory(historyPath).notificationPending;
    assert.ok(pending);

    state.failCreate = false;
    assert.equal(run({ historyDir, result: finding(), gh, notify: false }).code, 1);
    const carried = readOpsHistory(historyPath);
    assert.deepEqual(carried.notificationPending, pending, 'the no-notify run preserved the debt');

    assert.equal(run({ historyDir, result: finding(), gh }).code, 1);
    assert.equal(readOpsHistory(historyPath).notification.action, 'created');
    assert.equal(state.createCalls, 2);
  });
});
