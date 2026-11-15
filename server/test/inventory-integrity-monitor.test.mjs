// The scheduled inventory-integrity monitor's pure half.
//
// The monitor is deliberately small: it runs the already-tested audit, compares
// the returned findings with an accepted baseline, records a local history and
// alerts once per new set. These tests pin the comparison (including a missing
// baseline and resolved rows), the baseline schema, the issue-noise policy, and
// the source property that the monitor never opens a database itself.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MONITOR_BASELINE_VERSION,
  baselineProblems,
  buildMonitorSummary,
  compareWithBaseline,
  createBaseline,
  findingKeys,
  formatMonitorMarkdown,
  parseMonitorArgs,
  shouldNotify,
} from '../scripts/lib/inventory-integrity-monitor.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative) => readFileSync(path.join(serverRoot, relative), 'utf8');
const cliSource = readSource('scripts/monitor-inventory-integrity.mjs');
const libSource = readSource('scripts/lib/inventory-integrity-monitor.mjs');

function row(id, { kind = 'ORPHAN_STOCK_IN', business = 'biz-1', name = 'Demo tenant', reason = 'Seeded movement' } = {}) {
  return {
    kind,
    transactionId: id,
    business: { id: business, name },
    product: { id: `p-${id}`, name: `Product ${id}`, sku: `SKU-${id}` },
    location: { id: `l-${id}`, name: 'Shop Front' },
    quantity: 3,
    reason,
    reference: `SEED-${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

function auditWith({ orphan = [], unreceipted = [], scanned = 10 } = {}) {
  return {
    database: 'inventoryai_prod_db',
    scannedStockIns: scanned,
    totals: {
      orphanStockIns: orphan.length,
      unreceiptedPoStockIns: unreceipted.length,
      total: orphan.length + unreceipted.length,
    },
    findings: { orphanStockIns: orphan, unreceiptedPoStockIns: unreceipted },
  };
}

describe('audit:integrity:monitor — arguments', () => {
  it('accepts the production monitor shape', () => {
    assert.deepEqual(parseMonitorArgs(['--with-production', '--notify']), {
      help: false,
      withProduction: true,
      notify: true,
      acceptBaseline: false,
      baselinePath: null,
      historyDir: null,
      format: 'text',
      problems: [],
    });
  });

  it('refuses to run without production, and refuses a free-form database', () => {
    assert.match(parseMonitorArgs([]).problems.join(' '), /production-only/);
    assert.match(
      parseMonitorArgs(['--with-production', '--database=inventoryai_dev_db']).problems.join(' '),
      /--database is not accepted/
    );
  });

  it('does not combine accepting a baseline with notifying about it', () => {
    assert.match(
      parseMonitorArgs(['--with-production', '--accept-baseline', '--notify']).problems.join(' '),
      /cannot be combined/
    );
  });

  it('parses paths and format, and refuses duplicates or an unknown flag', () => {
    const args = parseMonitorArgs([
      '--with-production',
      '--baseline=docs/base.json',
      '--history-dir=C:/temp/history',
      '--format=json',
    ]);
    assert.equal(args.baselinePath, 'docs/base.json');
    assert.equal(args.historyDir, 'C:/temp/history');
    assert.equal(args.format, 'json');
    assert.match(parseMonitorArgs(['--with-production', '--format=xml']).problems.join(' '), /--format/);
    assert.match(parseMonitorArgs(['--with-production', '--baseline=a', '--baseline=b']).problems.join(' '), /more than once/);
    assert.match(parseMonitorArgs(['--with-production', '--fix-integrity']).problems.join(' '), /Unknown argument/);
  });

  it('states the read-only and exit-code contract in the usage text', () => {
    const usage = cliSource.match(/const USAGE = `([\s\S]*?)`;/)?.[1] ?? '';
    assert.match(usage, /READ-ONLY/);
    assert.match(usage, /EXIT CODES/);
    assert.match(usage, /0 {2}no finding outside/);
    assert.match(usage, /1 {2}at least one new finding/);
    assert.match(usage, /2 {2}NOT CHECKED/);
  });
});

describe('audit:integrity:monitor — baseline and comparison', () => {
  it('records a sorted, de-duplicated identity for every finding', () => {
    const audit = auditWith({ orphan: [row('a'), row('a'), row('b')], unreceipted: [row('c', { kind: 'UNRECEIPTED_PO_RECEIPT' })] });
    assert.deepEqual(findingKeys(audit), [
      'ORPHAN_STOCK_IN:a',
      'ORPHAN_STOCK_IN:b',
      'UNRECEIPTED_PO_RECEIPT:c',
    ]);
  });

  it('creates a baseline that validates and carries the counts and groups', () => {
    const audit = auditWith({ orphan: [row('a'), row('b', { business: 'biz-2', name: 'Other' })] });
    const baseline = createBaseline(audit, { acceptedAt: '2026-11-15T00:00:00.000Z', note: 'reviewed' });
    assert.equal(baseline.version, MONITOR_BASELINE_VERSION);
    assert.equal(baseline.findingIds.length, 2);
    assert.equal(baseline.counts.total, 2);
    assert.deepEqual(baseline.byBusiness.map((b) => b.id), ['biz-1', 'biz-2']);
    assert.deepEqual(baselineProblems(baseline), []);
  });

  it('rejects a malformed baseline instead of treating it as empty', () => {
    assert.match(baselineProblems(null).join(' '), /not a JSON object/);
    assert.match(baselineProblems({ version: 99 }).join(' '), /version/);
    assert.match(
      baselineProblems({ version: 1, acceptedAt: 'not-a-date', findingIds: ['a', 'a'] }).join(' '),
      /duplicates/
    );
    assert.doesNotThrow(() => baselineProblems({ version: 1, acceptedAt: '2026-11-15T00:00:00Z', findingIds: {} }));
    assert.match(
      baselineProblems({ version: 1, acceptedAt: '2026-11-15T00:00:00Z', findingIds: {} }).join(' '),
      /array of strings/
    );
  });

  it('separates new findings from resolved ones', () => {
    const baseline = { findingIds: ['ORPHAN_STOCK_IN:a', 'ORPHAN_STOCK_IN:b'] };
    const current = auditWith({ orphan: [row('a'), row('c')] });
    const compared = compareWithBaseline(current, baseline);
    assert.equal(compared.knownCount, 2);
    assert.equal(compared.currentCount, 2);
    assert.deepEqual(compared.newKeys, ['ORPHAN_STOCK_IN:c']);
    assert.deepEqual(compared.resolvedKeys, ['ORPHAN_STOCK_IN:b']);
    assert.equal(compared.newFindings[0].transactionId, 'c');
  });

  it('treats every finding as new when no baseline has been accepted', () => {
    const compared = compareWithBaseline(auditWith({ orphan: [row('a')] }), null);
    assert.equal(compared.knownCount, 0);
    assert.equal(compared.newCount, 1);
    assert.deepEqual(compared.resolvedKeys, []);
  });

  it('builds a report that names the new row but not the thousands of known rows', () => {
    const audit = auditWith({ orphan: [row('a'), row('b')], scanned: 100 });
    const baseline = createBaseline(audit, { acceptedAt: '2026-11-15T00:00:00.000Z' });
    const current = auditWith({ orphan: [row('a'), row('b'), row('c')], scanned: 101 });
    const summary = buildMonitorSummary({
      checkedAt: '2026-11-15T01:00:00.000Z',
      audit: current,
      baseline,
      comparison: compareWithBaseline(current, baseline),
      auditExitCode: 1,
    });
    assert.equal(summary.status, 'NEW_FINDINGS');
    assert.equal(summary.comparison.newCount, 1);
    const markdown = formatMonitorMarkdown(summary);
    assert.match(markdown, /Product c/);
    assert.match(markdown, /New since baseline:\*\* 1/);
    assert.doesNotMatch(markdown, /Product a/);
  });

  it('builds a NOT CHECKED report without pretending the inventory is clean', () => {
    const summary = buildMonitorSummary({
      checkedAt: '2026-11-15T01:00:00.000Z',
      auditExitCode: 2,
      error: 'database unreachable',
    });
    assert.equal(summary.status, 'NOT_CHECKED');
    assert.match(formatMonitorMarkdown(summary), /database unreachable/);
    assert.match(formatMonitorMarkdown(summary), /No conclusion was drawn/);
  });
});

describe('audit:integrity:monitor — issue noise policy', () => {
  const summary = (newIds, status = newIds.length ? 'NEW_FINDINGS' : 'UNCHANGED') => ({
    status,
    comparison: { newFindingIds: newIds },
  });

  it('alerts once for a new set and stays quiet while that set is unchanged', () => {
    assert.deepEqual(shouldNotify(null, summary(['a'])), { action: 'alert' });
    assert.deepEqual(shouldNotify(summary(['a']), summary(['a'])), { action: 'none' });
    assert.deepEqual(shouldNotify(summary(['a']), summary(['a', 'b'])), { action: 'alert' });
  });

  it('alerts on recovery and not on a routine clean run', () => {
    assert.deepEqual(shouldNotify(summary(['a']), summary([])), { action: 'recovery' });
    assert.deepEqual(shouldNotify(summary([]), summary([])), { action: 'none' });
  });

  it('alerts when the audit stops being able to check, once per failure streak', () => {
    assert.deepEqual(shouldNotify(null, summary([], 'NOT_CHECKED')), { action: 'alert' });
    assert.deepEqual(shouldNotify(summary([], 'NOT_CHECKED'), summary([], 'NOT_CHECKED')), { action: 'none' });
  });
});

describe('audit:integrity:monitor — source guards', () => {
  it('never opens a database itself; the audit child is the only reader', () => {
    assert.match(cliSource, /audit-inventory-integrity\.mjs/);
    assert.match(cliSource, /spawnSync/);
    for (const source of [cliSource, libSource]) {
      assert.doesNotMatch(source, /from ['"]mongoose['"]/);
      assert.doesNotMatch(source, /\b(InventoryTransaction|Inventory|PurchaseOrder)\.(delete|update|insert|save|create)/);
      assert.doesNotMatch(source, /\b(deleteMany|updateMany|bulkWrite|insertMany|autoIndex\s*:\s*true)\b/);
    }
  });
});