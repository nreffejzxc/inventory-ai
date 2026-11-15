// Pure half of the scheduled inventory-integrity monitor.
//
// The monitor adds two things the one-shot audit does not have: a baseline of
// findings already reviewed, and a comparison that names only findings that were
// not in that baseline. It is deliberately separate from the audit: the audit
// remains a single read-only report with no state, while the monitor writes its
// own local history and can notify a human about a NEW candidate.
//
// Nothing here connects to MongoDB or writes inventory. The CLI runs the audit
// as a child process; this module only judges the returned JSON.

export const MONITOR_BASELINE_VERSION = 1;
export const MONITOR_ISSUE_TITLE = '[inventory-integrity] New findings detected';

/** Stable identity for one finding. The kind is included so a category change is visible. */
export function keyOfFinding(row) {
  return `${row?.kind ?? 'UNKNOWN'}:${row?.transactionId ?? ''}`;
}

/** Every finding in an audit payload, in one array. */
export function findingsOf(audit) {
  return [
    ...(Array.isArray(audit?.findings?.orphanStockIns) ? audit.findings.orphanStockIns : []),
    ...(Array.isArray(audit?.findings?.unreceiptedPoStockIns) ? audit.findings.unreceiptedPoStockIns : []),
  ];
}

/** Sorted, de-duplicated finding keys. */
export function findingKeys(audit) {
  return [...new Set(findingsOf(audit).map(keyOfFinding))].sort();
}

function countBy(rows, pick) {
  const counts = new Map();
  for (const row of rows) {
    const key = pick(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function shortId(value) {
  const text = String(value ?? '');
  return text.length > 12 ? `${text.slice(0, 12)}…` : text || '—';
}

/** Counts by tenant and by recorded reason, for the report and the baseline. */
export function groupFindings(audit) {
  const rows = findingsOf(audit);
  const byBusiness = [...countBy(rows, (row) => `${row.business?.id ?? ''}|${row.business?.name ?? ''}`)]
    .map(([key, count]) => {
      const [id, name] = key.split('|');
      return { id, name, count };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const byReason = [...countBy(rows, (row) => row.reason || '(none)')]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { byBusiness, byReason };
}

/** A baseline is an explicit acceptance of the findings that exist today. */
export function createBaseline(audit, { acceptedAt = new Date().toISOString(), note = '' } = {}) {
  const groups = groupFindings(audit);
  return {
    version: MONITOR_BASELINE_VERSION,
    acceptedAt,
    database: audit?.database ?? null,
    counts: audit?.totals ?? { orphanStockIns: 0, unreceiptedPoStockIns: 0, total: 0 },
    byBusiness: groups.byBusiness,
    byReason: groups.byReason,
    findingIds: findingKeys(audit),
    note,
  };
}

/** Returns human-readable problems; an empty array means the baseline is usable. */
export function baselineProblems(baseline) {
  const problems = [];
  if (!baseline || typeof baseline !== 'object') {
    return ['the baseline is not a JSON object'];
  }
  if (baseline.version !== MONITOR_BASELINE_VERSION) {
    problems.push(`baseline.version is ${baseline.version}, expected ${MONITOR_BASELINE_VERSION}`);
  }
  if (!Array.isArray(baseline.findingIds) || baseline.findingIds.some((id) => typeof id !== 'string')) {
    problems.push('baseline.findingIds must be an array of strings');
  } else if (new Set(baseline.findingIds).size !== baseline.findingIds.length) {
    problems.push('baseline.findingIds contains duplicates');
  }
  if (!baseline.acceptedAt || Number.isNaN(new Date(baseline.acceptedAt).getTime())) {
    problems.push('baseline.acceptedAt must be an ISO timestamp');
  }
  return problems;
}

/**
 * Compare the current audit with the accepted baseline.
 *
 * A missing baseline makes every current finding NEW. That is intentional: the
 * first run of a monitor without an accepted baseline must not silently bless
 * thousands of findings.
 */
export function compareWithBaseline(audit, baseline) {
  const currentKeys = findingKeys(audit);
  const currentSet = new Set(currentKeys);
  const known = new Set(Array.isArray(baseline?.findingIds) ? baseline.findingIds : []);
  const newKeys = currentKeys.filter((key) => !known.has(key));
  const resolvedKeys = [...known].filter((key) => !currentSet.has(key)).sort();
  const newSet = new Set(newKeys);
  const newFindings = findingsOf(audit).filter((row) => newSet.has(keyOfFinding(row)));
  return {
    knownCount: known.size,
    currentCount: currentKeys.length,
    newCount: newKeys.length,
    resolvedCount: resolvedKeys.length,
    newKeys,
    resolvedKeys,
    newFindings,
  };
}

/** The durable summary written to latest.json and quoted by the issue. */
export function buildMonitorSummary({
  checkedAt = new Date().toISOString(),
  audit,
  baseline = null,
  comparison = null,
  auditExitCode = 1,
  error = null,
} = {}) {
  const groups = audit ? groupFindings(audit) : { byBusiness: [], byReason: [] };
  const compared = comparison ?? compareWithBaseline(audit ?? {}, baseline);
  const status = auditExitCode === 2 || error ? 'NOT_CHECKED' : compared.newCount > 0 ? 'NEW_FINDINGS' : 'UNCHANGED';
  return {
    command: 'audit:integrity:monitor',
    readOnly: true,
    status,
    checkedAt,
    database: audit?.database ?? null,
    audit: {
      exitCode: auditExitCode,
      scannedStockIns: audit?.scannedStockIns ?? null,
      totals: audit?.totals ?? null,
      error,
    },
    baseline: {
      acceptedAt: baseline?.acceptedAt ?? null,
      knownCount: compared.knownCount,
      counts: baseline?.counts ?? null,
    },
    comparison: {
      currentCount: compared.currentCount,
      newCount: compared.newCount,
      resolvedCount: compared.resolvedCount,
      newFindingIds: compared.newKeys,
      resolvedFindingIds: compared.resolvedKeys,
      newFindings: compared.newFindings,
    },
    byBusiness: groups.byBusiness,
    byReason: groups.byReason,
    note:
      'Read-only. A finding is a candidate for review, not proof of intent. ' +
      'The baseline is an acceptance of known findings, not a repair.',
  };
}

/** Should this run touch the alert issue? Pure, so the noise policy is testable. */
export function shouldNotify(previous, summary) {
  if (summary?.status === 'NOT_CHECKED') {
    return previous?.status === 'NOT_CHECKED' ? { action: 'none' } : { action: 'alert' };
  }
  const current = summary?.comparison?.newFindingIds ?? [];
  const prior = previous?.comparison?.newFindingIds ?? [];
  if (current.length > 0) {
    const same = current.length === prior.length && current.every((id) => prior.includes(id));
    return same ? { action: 'none' } : { action: 'alert' };
  }
  if (prior.length > 0) return { action: 'recovery' };
  return { action: 'none' };
}

function describeFinding(row) {
  return (
    `- **${row.kind === 'UNRECEIPTED_PO_RECEIPT' ? 'Unreceipted PO receipt' : 'Orphan STOCK_IN'}** ` +
    `${row.business?.name ?? 'Unknown business'} · ${row.product?.name ?? 'Unknown product'} ` +
    `(${row.product?.sku ?? 'no SKU'}) @ ${row.location?.name ?? 'Unknown location'} · ` +
    `${row.quantity} unit(s) · ${row.createdAt}` +
    `\n  txn \`${row.transactionId}\` · reason ${row.reason || '—'} · reference ${row.reference || '—'}`
  );
}

/** Markdown for the local latest.md and the GitHub issue body. */
export function formatMonitorMarkdown(summary, { maxNewRows = 50 } = {}) {
  const lines = [];
  lines.push('# Inventory integrity monitor');
  lines.push('');
  lines.push(`- **Status:** ${summary.status}`);
  lines.push(`- **Checked:** ${summary.checkedAt}`);
  lines.push(`- **Database:** ${summary.database ?? 'not read'}`);
  lines.push(`- **Read-only:** ${summary.readOnly ? 'yes' : 'no'}`);
  if (summary.status === 'NOT_CHECKED') {
    lines.push(`- **Error:** ${summary.audit.error ?? 'the audit could not run'}`);
    lines.push('');
    lines.push('No conclusion was drawn about inventory integrity.');
    return lines.join('\n');
  }

  lines.push(`- **STOCK_IN rows scanned:** ${grouped(summary.audit.scannedStockIns ?? 0)}`);
  lines.push(
    `- **Current findings:** ${summary.audit.totals?.total ?? summary.comparison.currentCount} ` +
      `(${summary.audit.totals?.orphanStockIns ?? 0} orphan, ${summary.audit.totals?.unreceiptedPoStockIns ?? 0} unreceipted PO)`
  );
  lines.push(`- **Known baseline:** ${summary.baseline.knownCount}`);
  lines.push(`- **New since baseline:** ${summary.comparison.newCount}`);
  lines.push(`- **No longer reported:** ${summary.comparison.resolvedCount}`);
  lines.push('');

  if (summary.comparison.newCount === 0) {
    lines.push('No new findings since the accepted baseline.');
  } else {
    lines.push('## New findings');
    for (const row of summary.comparison.newFindings.slice(0, maxNewRows)) lines.push(describeFinding(row));
    if (summary.comparison.newFindings.length > maxNewRows) {
      lines.push(`\n…and ${summary.comparison.newFindings.length - maxNewRows} more in latest.json.`);
    }
  }

  lines.push('');
  lines.push('## Known findings by tenant');
  if (summary.byBusiness.length === 0) lines.push('None.');
  for (const row of summary.byBusiness) {
    lines.push(`- ${row.name || shortId(row.id)} — ${row.count}`);
  }
  lines.push('');
  lines.push(summary.note);
  return lines.join('\n');
}

function valueOf(flag, argv) {
  const prefix = `${flag}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) return { repeated: true, value: values[0] };
  return values.length === 1 ? { repeated: false, value: values[0] } : null;
}

/** Parse the monitor's command line. Pure, so every refusal is asserted. */
export function parseMonitorArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];
  const baseline = valueOf('--baseline', args);
  const historyDir = valueOf('--history-dir', args);
  const format = valueOf('--format', args);

  for (const [flag, seen] of [
    ['--baseline', baseline],
    ['--history-dir', historyDir],
    ['--format', format],
  ]) {
    if (seen?.repeated) problems.push(`${flag} was given more than once.`);
  }
  if (!args.includes('--with-production')) {
    problems.push('this monitor is production-only; pass --with-production.');
  }
  if (args.includes('--accept-baseline') && args.includes('--notify')) {
    problems.push('--accept-baseline and --notify cannot be combined; accepting a baseline is not an alert.');
  }

  let output = 'text';
  if (format) {
    if (format.value !== 'text' && format.value !== 'json') {
      problems.push('--format must be "text" or "json".');
    } else {
      output = format.value;
    }
  }

  for (const arg of args) {
    if (arg.startsWith('--database=') || arg === '--database') {
      problems.push(
        '--database is not accepted. This monitor reads production when --with-production is passed.'
      );
    } else if (
      arg.startsWith('--') &&
      !/^--(help|with-production|notify|accept-baseline|baseline=|history-dir=|format=)/.test(arg)
    ) {
      problems.push(`Unknown argument: ${arg}`);
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      problems.push(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help: args.includes('--help') || args.includes('-h'),
    withProduction: args.includes('--with-production'),
    notify: args.includes('--notify'),
    acceptBaseline: args.includes('--accept-baseline'),
    baselinePath: baseline?.value ?? null,
    historyDir: historyDir?.value ?? null,
    format: output,
    problems,
  };
}