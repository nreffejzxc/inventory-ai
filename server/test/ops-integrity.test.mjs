// The scheduled integrity-operations runner's pure policy.
//
// The three commands own their checks and exit codes. These tests pin what the
// scheduler adds: NOT CHECKED is never a data finding, recovery's attention rows
// count even on exit 0, a duplicate command run is suppressed, and an alert is
// emitted only when the result or its signature changes.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPS_COMMANDS,
  OPS_STATUS,
  acquireRunLock,
  buildOpsSummary,
  classifyOpsResult,
  formatOpsMarkdown,
  issueHasMarker,
  opsAlertMarker,
  opsIssueBody,
  opsRecoveryMarker,
  parseChildJson,
  parseOpsArgs,
  readOpsHistory,
  sanitizeOpsDetail,
  shouldNotifyOps,
  writeOpsHistory,
} from '../scripts/lib/ops-integrity.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = readFileSync(path.join(serverRoot, 'scripts/ops-integrity.mjs'), 'utf8');
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-integrity-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('ops:integrity — arguments', () => {
  it('accepts a production command with notify, and a development preflight', () => {
    const production = parseOpsArgs([
      '--command=audit:failures',
      '--with-production',
      '--notify',
      '--format=json',
    ]);
    assert.deepEqual(production.problems, []);
    assert.equal(production.command, 'audit:failures');
    assert.equal(production.withProduction, true);
    assert.equal(production.notify, true);
    assert.equal(production.format, 'json');

    const development = parseOpsArgs(['--command=recover:integrity']);
    assert.deepEqual(development.problems, []);
    assert.equal(development.timeoutMs, 600_000);
  });

  it('refuses a missing/unknown command, notify without production, and malformed values', () => {
    assert.match(parseOpsArgs([]).problems.join(' '), /--command is required/);
    assert.match(parseOpsArgs(['--command=audit:everything']).problems.join(' '), /unknown command/);
    assert.match(
      parseOpsArgs(['--command=audit:failures', '--notify']).problems.join(' '),
      /requires --with-production/
    );
    assert.match(
      parseOpsArgs(['--command=audit:failures', '--timeout-ms=1']).problems.join(' '),
      /timeout-ms/
    );
    assert.match(
      parseOpsArgs(['--command=audit:failures', '--fix']).problems.join(' '),
      /Unknown argument/
    );
  });
});

describe('ops:integrity — result classification', () => {
  it('keeps clean, finding, unexpected and unreadable results distinct', () => {
    const clean = classifyOpsResult({
      command: 'audit:failures',
      exitCode: 0,
      payload: { total: 0, byAction: [] },
    });
    assert.equal(clean.status, OPS_STATUS.OK);

    const finding = classifyOpsResult({
      command: 'audit:failures',
      exitCode: 1,
      payload: { total: 2, byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }] },
    });
    assert.equal(finding.status, OPS_STATUS.FINDINGS);
    assert.equal(finding.problemCount, 2);

    const unexpected = classifyOpsResult({ command: 'audit:failures', exitCode: 3 });
    assert.equal(unexpected.status, OPS_STATUS.ERROR);

    const unreadable = classifyOpsResult({ command: 'audit:failures', exitCode: 0, payload: null });
    assert.equal(unreadable.status, OPS_STATUS.ERROR);
  });

  it('treats exit 2 as NOT CHECKED and never as a data finding', () => {
    const result = classifyOpsResult({
      command: 'audit:price-quality',
      exitCode: 2,
      stderr: '[price-quality] NOT CHECKED (exit 2) — could not reach mongodb://user:secret@host/db',
    });
    assert.equal(result.status, OPS_STATUS.NOT_CHECKED);
    assert.doesNotMatch(result.detail, /secret/);
    assert.match(result.detail, /mongodb:\/\/\[redacted\]/);
  });

  it('counts recovery attention rows even when the command exits 0', () => {
    const result = classifyOpsResult({
      command: 'recover:integrity',
      exitCode: 0,
      payload: {
        transfers: { scanned: 2, flagged: 1, failed: 0 },
        claims: { scanned: 1, flagged: 0, failed: 0 },
      },
    });
    assert.equal(result.status, OPS_STATUS.FINDINGS);
    assert.equal(result.problemCount, 1);
  });

  it('does not alert when recovery was skipped because another pass held the lease', () => {
    const result = classifyOpsResult({
      command: 'recover:integrity',
      exitCode: 0,
      payload: { transfers: null, claims: null, skipped: 'lease-held' },
    });
    assert.equal(result.status, OPS_STATUS.OK);
    assert.match(result.detail, /lease/);
  });

  it('refuses to call a timed-out child clean', () => {
    const result = classifyOpsResult({ command: 'audit:failures', exitCode: null, timedOut: true });
    assert.equal(result.status, OPS_STATUS.NOT_CHECKED);
    assert.match(result.detail, /timed out/);
  });
});

describe('ops:integrity — alert noise policy', () => {
  function summary(command, status, counts = {}) {
    return buildOpsSummary({
      command,
      checkedAt: '2026-11-19T00:00:00.000Z',
      database: 'inventoryai_prod_db',
      result: {
        status,
        detail: status,
        counts,
        problemCount: counts.total ?? 0,
      },
    });
  }

  it('alerts once per finding signature and closes on recovery', () => {
    const first = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 2,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }],
    });
    assert.deepEqual(shouldNotifyOps(null, first), { action: 'alert' });
    assert.deepEqual(shouldNotifyOps(first, first), { action: 'none' });

    const changed = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 3,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 3 }],
    });
    assert.deepEqual(shouldNotifyOps(first, changed), { action: 'alert' });
    assert.deepEqual(
      shouldNotifyOps(changed, summary('audit:failures', OPS_STATUS.OK)),
      { action: 'recovery' }
    );
    assert.deepEqual(
      shouldNotifyOps(summary('audit:failures', OPS_STATUS.OK), summary('audit:failures', OPS_STATUS.OK)),
      { action: 'none' }
    );
  });

  it('alerts once per NOT CHECKED streak and never treats it as recovery', () => {
    const failure = summary('audit:price-quality', OPS_STATUS.NOT_CHECKED);
    assert.deepEqual(shouldNotifyOps(null, failure), { action: 'alert' });
    assert.deepEqual(shouldNotifyOps(failure, failure), { action: 'none' });
    assert.deepEqual(
      shouldNotifyOps(failure, summary('audit:price-quality', OPS_STATUS.OK)),
      { action: 'recovery' }
    );
  });

  it('retries an undelivered alert even when the signature is unchanged', () => {
    const current = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 2,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }],
    });
    const failed = {
      ...current,
      notification: {
        requested: true,
        action: 'failed',
        undelivered: true,
        intent: 'alert',
        stage: 'create',
        error: 'gh unavailable',
      },
    };
    assert.deepEqual(shouldNotifyOps(failed, current), { action: 'alert' });

    // A failed recovery is retried on the next clean result. The explicit
    // pending record is the durable form; `action: failed` covers old history.
    const clean = summary('audit:failures', OPS_STATUS.OK);
    const oldFailedRecovery = {
      ...clean,
      notification: { requested: true, action: 'failed', error: 'close failed' },
    };
    assert.deepEqual(shouldNotifyOps(oldFailedRecovery, clean), { action: 'recovery' });
  });

  it('uses a stable hidden marker for each alert and finds it in the issue evidence', () => {
    const first = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 2,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }],
    });
    const same = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 2,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 2 }],
    });
    const changed = summary('audit:failures', OPS_STATUS.FINDINGS, {
      total: 3,
      byAction: [{ action: 'INVENTORY_TRANSFERRED', count: 3 }],
    });

    assert.equal(opsAlertMarker(first), opsAlertMarker(same));
    assert.notEqual(opsAlertMarker(first), opsAlertMarker(changed));
    assert.match(opsIssueBody(first), /<!-- integrity-ops-alert:/);
    assert.equal(issueHasMarker({ body: opsIssueBody(first) }, opsAlertMarker(first)), true);
    assert.equal(
      issueHasMarker({ comments: [{ body: opsAlertMarker(first) }] }, opsAlertMarker(first)),
      true,
    );
    assert.equal(issueHasMarker({ body: '', comments: [] }, opsAlertMarker(first)), false);
    assert.match(opsRecoveryMarker('audit:failures'), /integrity-ops-recovery:audit:failures/);
  });

  it('marks a duplicate run as silent', () => {
    const skipped = summary('recover:integrity', OPS_STATUS.SKIPPED_RUNNING);
    assert.deepEqual(shouldNotifyOps(null, skipped), { action: 'none' });
  });

  it('formats a NOT CHECKED report without claiming the data is clean', () => {
    const markdown = formatOpsMarkdown(summary('audit:failures', OPS_STATUS.NOT_CHECKED));
    assert.match(markdown, /No conclusion was drawn/);
    assert.match(markdown, /not evidence of a clean inventory/);
  });
});

describe('ops:integrity — lock, history and child parsing', () => {
  it('suppresses a concurrent owner and lets a stale lock be taken over', () => {
    const dir = tempDir();
    const lockPath = path.join(dir, 'audit-failures.lock');
    const base = Date.now();
    const first = acquireRunLock(lockPath, { token: 'first', now: base });
    assert.equal(first.acquired, true);
    assert.equal(acquireRunLock(lockPath, { token: 'second', now: base + 2_000 }).acquired, false);

    const stale = acquireRunLock(lockPath, {
      token: 'second',
      now: base + 31 * 60_000,
      staleMs: 30 * 60_000,
    });
    assert.equal(stale.acquired, true);
    first.release();
    assert.equal(readFileSync(lockPath, 'utf8').includes('second'), true);
    stale.release();
    assert.equal(acquireRunLock(lockPath, { token: 'third', now: base + 31 * 60_000 }).acquired, true);
  });

  it('writes latest state atomically and appends one history line', () => {
    const dir = tempDir();
    const historyPath = path.join(dir, 'audit-failures.json');
    const summary = buildOpsSummary({
      command: 'audit:failures',
      checkedAt: '2026-11-19T00:00:00.000Z',
      database: 'inventoryai_prod_db',
      result: { status: OPS_STATUS.OK, detail: 'none', counts: { total: 0 }, problemCount: 0 },
    });
    writeOpsHistory(historyPath, summary);
    assert.equal(readOpsHistory(historyPath).status, OPS_STATUS.OK);
    const lines = readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).signature, 'ok');
  });

  it('reads JSON from a child that also wrote log lines', () => {
    assert.deepEqual(parseChildJson('[db] connected\n{"total":0}\n'), { total: 0 });
    assert.equal(parseChildJson('[db] connected only\n'), null);
  });
});

describe('ops:integrity — source guards', () => {
  it('runs the existing commands as children and owns one lock per command', () => {
    assert.match(cliSource, /spawnSync/);
    assert.match(cliSource, /OPS_COMMANDS\[args\.command\]/);
    assert.match(cliSource, /acquireRunLock/);
    assert.doesNotMatch(cliSource, /from ['"]mongoose['"]/);
    for (const meta of Object.values(OPS_COMMANDS)) {
      assert.match(cliSource, /path\.join\(serverRoot, 'scripts', meta\.script\)/);
      assert.ok(meta.issueTitle.startsWith('[integrity-ops]'));
    }
    assert.match(sanitizeOpsDetail('token=secret\nnext'), /token=\[redacted\]/);
  });
});
