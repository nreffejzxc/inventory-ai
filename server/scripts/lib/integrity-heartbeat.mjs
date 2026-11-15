// Pure half of the hosted integrity heartbeat writer.
//
// The audit remains read-only. This module only turns the monitor's latest.json
// into one small operational document; the writer opens MongoDB and upserts that
// document into `integrity_monitor_heartbeats`. It never imports an inventory,
// ledger, purchase-order or business model.

export const INTEGRITY_HEARTBEAT_COLLECTION = 'integrity_monitor_heartbeats';
export const INTEGRITY_HEARTBEAT_ID = 'production';
export const INTEGRITY_HEARTBEAT_SOURCE = 'windows-task';
export const INTEGRITY_HEARTBEAT_STATUSES = ['UNCHANGED', 'NEW_FINDINGS', 'NOT_CHECKED'];

function valueOf(flag, argv) {
  const prefix = `${flag}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) return { repeated: true, value: values[0] };
  return values.length === 1 ? { repeated: false, value: values[0] } : null;
}

/** Parse the small CLI. Pure, so every refusal is asserted. */
export function parseHeartbeatArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];
  const historyDir = valueOf('--history-dir', args);

  if (historyDir?.repeated) problems.push('--history-dir was given more than once.');
  if (!args.includes('--with-production')) {
    problems.push('the heartbeat writer is production-only; pass --with-production.');
  }

  for (const arg of args) {
    if (arg.startsWith('--database=') || arg === '--database') {
      problems.push('--database is not accepted. The heartbeat always targets production.');
    } else if (
      arg.startsWith('--') &&
      !/^--(help|with-production|history-dir=)/.test(arg)
    ) {
      problems.push(`Unknown argument: ${arg}`);
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      problems.push(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help: args.includes('--help') || args.includes('-h'),
    withProduction: args.includes('--with-production'),
    historyDir: historyDir?.value ?? null,
    problems,
  };
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Build the one document. A NOT CHECKED result is written too: it must make the
 * hosted endpoint return 503 immediately, not leave the previous fresh value in
 * place. Every other status is a completed audit.
 */
export function buildHeartbeat(
  latest,
  { now = new Date(), database = 'inventoryai_prod_db', source = INTEGRITY_HEARTBEAT_SOURCE } = {}
) {
  if (!latest || typeof latest !== 'object') throw new Error('latest.json is not an object');
  const status = latest.status;
  if (!INTEGRITY_HEARTBEAT_STATUSES.includes(status)) {
    throw new Error(`latest.json has an unknown status: ${String(status)}`);
  }
  const checkedAt = new Date(latest.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new Error('latest.json has no valid checkedAt timestamp');
  }
  if (latest.database && latest.database !== database) {
    throw new Error(`latest.json names ${latest.database}, not ${database}`);
  }

  const totals = latest.audit?.totals ?? {};
  return {
    _id: INTEGRITY_HEARTBEAT_ID,
    checkedAt,
    status,
    scannedStockIns: count(latest.audit?.scannedStockIns),
    orphanStockIns: count(totals.orphanStockIns),
    unreceiptedPoStockIns: count(totals.unreceiptedPoStockIns),
    newCount: count(latest.comparison?.newCount),
    resolvedCount: count(latest.comparison?.resolvedCount),
    database,
    source,
    updatedAt: now,
  };
}
