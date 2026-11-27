import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AuditOutbox from '../models/auditOutbox.model.ts';
import {
  INDEX_INSPECTION_TIMEOUT_MS,
  REQUIRED_INDEX_SPECS,
  readRequiredIndexes,
  type RequiredIndexesReadiness,
  type RequiredIndexSpec,
} from '../config/indexReadiness.ts';
import {
  INTEGRITY_HEARTBEAT_MAX_AGE_MS,
  readIntegrityHeartbeat,
  type IntegrityHeartbeatView,
} from './integrityHeartbeat.service.ts';

/**
 * Read-only operational signals: the integrity monitor, the required-index
 * readiness verdict and the audit outbox backlog.
 *
 * Every function here only reads. Nothing retries an outbox row, creates an
 * index, migrates a collection or writes a monitor file — those are separate,
 * deliberate operations with their own scripts.
 *
 * The split between host-local and server-side data is explicit in the payload:
 * the monitor's run files live in %LOCALAPPDATA% on the machine that runs the
 * task, while the heartbeat document and the outbox live in the database. A host
 * that cannot see the files reports them unavailable instead of "no runs".
 */

const HISTORY_TAIL = 14;
const MARKDOWN_PREVIEW = 6_000;

export type IntegrityRun = {
  checkedAt: string | null;
  status: string | null;
  newCount: number | null;
  resolvedCount: number | null;
  total: number | null;
  scannedStockIns: number | null;
  database: string | null;
  notification: string | null;
  source: 'history' | 'latest';
};

export type IntegrityReport = {
  asOf: string;
  heartbeat: {
    available: boolean;
    view: IntegrityHeartbeatView | null;
    source: 'database';
    error: string | null;
  };
  host: {
    available: boolean;
    historyDir: string;
    latestJson: string | null;
    latestMarkdown: string | null;
    historyFile: string | null;
    note: string;
  };
  latest: {
    checkedAt: string | null;
    status: string | null;
    database: string | null;
    ageSeconds: number | null;
    stale: boolean | null;
    scannedStockIns: number | null;
    totals: { orphanStockIns: number | null; unreceiptedPoStockIns: number | null; total: number | null };
    baseline: { knownCount: number | null; acceptedAt: string | null };
    comparison: {
      currentCount: number | null;
      newCount: number | null;
      resolvedCount: number | null;
      newFindingIds: string[];
    };
    notification: string | null;
  } | null;
  markdown: string | null;
  history: IntegrityRun[];
  warnings: string[];
};

/** The monitor's history directory, matching monitor-inventory-integrity.mjs. */
export function integrityHistoryDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
    return path.join(base, 'InventoryAI', 'integrity-audit');
  }
  return path.join(os.homedir(), '.local', 'state', 'inventoryai', 'integrity-audit');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isoDate(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function readJsonFile(file: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(file)) {
    warnings.push(`No monitor run file at ${file}.`);
    return null;
  }
  try {
    const parsed = asRecord(JSON.parse(readFileSync(file, 'utf8'))) as unknown;
    if (!parsed) {
      warnings.push(`The monitor run file at ${file} is not an object.`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    warnings.push(`The monitor run file at ${file} could not be read: ${(error as Error).message}`);
    return null;
  }
}

function historyEntry(raw: unknown): IntegrityRun | null {
  const row = asRecord(raw);
  if (!row) return null;
  const audit = asRecord(row.audit);
  const totals = audit ? asRecord(audit.totals) : null;
  const comparison = asRecord(row.comparison);
  const notification = asRecord(row.notification);
  const checkedAt = isoDate(row.checkedAt);
  return {
    checkedAt,
    status: str(row.status),
    newCount: count(comparison?.newCount),
    resolvedCount: count(comparison?.resolvedCount),
    total: totals ? count(totals.total) : count(row.currentCount),
    scannedStockIns: audit ? count(audit.scannedStockIns) : null,
    database: str(row.database),
    notification: notification ? str(notification.action) : null,
    source: 'history',
  };
}

/** The integrity monitor, as the monitor itself recorded it, plus the heartbeat. */
export async function getIntegrityReport(): Promise<IntegrityReport> {
  const warnings: string[] = [];
  const dir = integrityHistoryDir();

  let heartbeat: IntegrityReport['heartbeat'];
  try {
    heartbeat = { available: true, view: await readIntegrityHeartbeat(), source: 'database', error: null };
  } catch (error) {
    heartbeat = {
      available: false,
      view: null,
      source: 'database',
      error: `The heartbeat could not be read from ${'integrity_monitor_heartbeats'}: ${(error as Error).message}`,
    };
    warnings.push(heartbeat.error!);
  }

  const latestJsonPath = path.join(dir, 'latest.json');
  const latestMarkdownPath = path.join(dir, 'latest.md');
  const historyPath = path.join(dir, 'history.jsonl');
  const hostAvailable = existsSync(latestJsonPath) || existsSync(historyPath);

  let markdown: string | null = null;
  if (existsSync(latestMarkdownPath)) {
    try {
      const raw = readFileSync(latestMarkdownPath, 'utf8');
      markdown = raw.length > MARKDOWN_PREVIEW ? `${raw.slice(0, MARKDOWN_PREVIEW)}\n…` : raw;
    } catch (error) {
      warnings.push(`latest.md could not be read: ${(error as Error).message}`);
    }
  } else {
    warnings.push(`No latest.md at ${latestMarkdownPath}.`);
  }

  const rawLatest = readJsonFile(latestJsonPath, warnings);
  let latest: IntegrityReport['latest'] = null;
  if (rawLatest) {
    const audit = asRecord(rawLatest.audit);
    const totals = audit ? asRecord(audit.totals) : null;
    const baseline = asRecord(rawLatest.baseline);
    const comparison = asRecord(rawLatest.comparison);
    const notification = asRecord(rawLatest.notification);
    const checkedAt = isoDate(rawLatest.checkedAt);
    const ageSeconds = checkedAt ? Math.max(0, Math.round((Date.now() - new Date(checkedAt).getTime()) / 1000)) : null;
    latest = {
      checkedAt,
      status: str(rawLatest.status),
      database: str(rawLatest.database),
      ageSeconds,
      stale: ageSeconds == null ? null : ageSeconds * 1000 > INTEGRITY_HEARTBEAT_MAX_AGE_MS,
      scannedStockIns: audit ? count(audit.scannedStockIns) : null,
      totals: {
        orphanStockIns: totals ? count(totals.orphanStockIns) : null,
        unreceiptedPoStockIns: totals ? count(totals.unreceiptedPoStockIns) : null,
        total: totals ? count(totals.total) : null,
      },
      baseline: {
        knownCount: baseline ? count(baseline.knownCount) : null,
        acceptedAt: baseline ? isoDate(baseline.acceptedAt) : null,
      },
      comparison: {
        currentCount: comparison ? count(comparison.currentCount) : null,
        newCount: comparison ? count(comparison.newCount) : null,
        resolvedCount: comparison ? count(comparison.resolvedCount) : null,
        newFindingIds: Array.isArray(comparison?.newFindingIds)
          ? (comparison!.newFindingIds as unknown[]).slice(0, 50).map((id) => String(id))
          : [],
      },
      notification: notification ? str(notification.action) : null,
    };
  }

  const history: IntegrityRun[] = [];
  if (existsSync(historyPath)) {
    try {
      const lines = readFileSync(historyPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
      for (const line of lines.slice(-HISTORY_TAIL)) {
        try {
          const entry = historyEntry(JSON.parse(line));
          if (entry) history.push(entry);
        } catch {
          warnings.push('One history.jsonl line could not be parsed and was skipped.');
        }
      }
      history.reverse();
    } catch (error) {
      warnings.push(`history.jsonl could not be read: ${(error as Error).message}`);
    }
  } else {
    warnings.push(`No history.jsonl at ${historyPath}.`);
  }

  return {
    asOf: new Date().toISOString(),
    heartbeat,
    host: {
      available: hostAvailable,
      historyDir: dir,
      latestJson: existsSync(latestJsonPath) ? latestJsonPath : null,
      latestMarkdown: existsSync(latestMarkdownPath) ? latestMarkdownPath : null,
      historyFile: existsSync(historyPath) ? historyPath : null,
      note: hostAvailable
        ? 'Run files are read from the machine that runs the integrity monitor.'
        : 'This API host cannot see the monitor run directory. The heartbeat below is the database record, not proof that no run has happened.',
    },
    latest,
    markdown,
    history,
    warnings,
  };
}

export type RequiredIndexRow = {
  name: string;
  key: Record<string, number>;
  unique: boolean;
  expireAfterSeconds: number | null;
  partial: boolean;
  ready: boolean;
  reason: string | null;
};

export type ReadinessReport = {
  asOf: string;
  ready: boolean;
  verdict: 'pass' | 'fail';
  rows: RequiredIndexRow[];
  failures: Array<{ name: string; reason: string }>;
  note: string;
  inspectionTimeoutMs: number;
  error: string | null;
};

function specRow(spec: RequiredIndexSpec, ready: boolean, reason: string | null): RequiredIndexRow {
  return {
    name: spec.name,
    key: { ...spec.key },
    unique: spec.unique === true,
    expireAfterSeconds: spec.expireAfterSeconds ?? null,
    partial: Boolean(spec.partialFilterExpression),
    ready,
    reason,
  };
}

/**
 * The six required indexes, with the verdict `/ready` uses.
 *
 * `readRequiredIndexes()` is the same cached inspection the readiness endpoint
 * answers from, so this panel cannot disagree with a 503. A named failure is one
 * index that failed in the same pass; the rest passed it.
 */
export async function getReadinessReport(
  options: { check?: () => Promise<RequiredIndexesReadiness> } = {},
): Promise<ReadinessReport> {
  try {
    // The `check` seam is the one `readRequiredIndexes` already exposes; it exists
    // so the failure rendering can be exercised without dropping a real index.
    const verdict = await readRequiredIndexes(options.check ? { check: options.check } : {});
    const failures = verdict.failures.map((failure) => ({ name: failure.name, reason: failure.reason }));
    const failing = new Map(failures.map((failure) => [failure.name, failure.reason]));
    const unnamedFailure = !verdict.ready && failures.length === 0;
    const rows = REQUIRED_INDEX_SPECS.map((spec) =>
      specRow(
        spec,
        verdict.ready || (!unnamedFailure && !failing.has(spec.name)),
        failing.get(spec.name) ?? null,
      ),
    );
    return {
      asOf: new Date().toISOString(),
      ready: verdict.ready,
      verdict: verdict.ready ? 'pass' : 'fail',
      rows,
      failures,
      note: verdict.ready
        ? 'All six required indexes are present with the expected key, uniqueness and TTL.'
        : unnamedFailure
          ? 'The readiness verdict is failing but named no index; the inspection itself did not complete.'
          : `${failures.length} required index(es) are missing or have the wrong shape. /ready answers 503 until every one of them passes.`,
      inspectionTimeoutMs: INDEX_INSPECTION_TIMEOUT_MS,
      error: null,
    };
  } catch (error) {
    return {
      asOf: new Date().toISOString(),
      ready: false,
      verdict: 'fail',
      rows: REQUIRED_INDEX_SPECS.map((spec) => specRow(spec, false, 'the index inspection could not run')),
      failures: [],
      note: 'The readiness inspection could not run, so no index status is known. This is not a report that the indexes are absent.',
      inspectionTimeoutMs: INDEX_INSPECTION_TIMEOUT_MS,
      error: (error as Error).message,
    };
  }
}

export type OutboxReport = {
  asOf: string;
  available: boolean;
  counts: { pending: number | null; sending: number | null; failed: number | null; delivered: number | null };
  oldestPending: { createdAt: string | null; ageSeconds: number | null } | null;
  error: string | null;
  note: string;
};

const OUTBOX_QUERY_TIMEOUT_MS = 5_000;

type OutboxStatus = 'PENDING' | 'SENDING' | 'FAILED' | 'DELIVERED';

async function countStatus(status: OutboxStatus): Promise<number> {
  return AuditOutbox.countDocuments({ status }).maxTimeMS(OUTBOX_QUERY_TIMEOUT_MS);
}

/**
 * The audit outbox backlog, read-only.
 *
 * Counts use the existing `status` index (a covered count, not a collection
 * scan) and the oldest PENDING row is one bounded, indexed-by-status query. A
 * timeout is reported as "unavailable", never as a zero backlog: an empty queue
 * and an unreadable queue must not look the same.
 */
export async function getAuditOutboxReport(): Promise<OutboxReport> {
  const counts: OutboxReport['counts'] = { pending: null, sending: null, failed: null, delivered: null };
  let oldestPending: OutboxReport['oldestPending'] = null;
  let error: string | null = null;
  try {
    const [pending, sending, failed, delivered] = await Promise.all([
      countStatus('PENDING'),
      countStatus('SENDING'),
      countStatus('FAILED'),
      countStatus('DELIVERED'),
    ]);
    counts.pending = pending;
    counts.sending = sending;
    counts.failed = failed;
    counts.delivered = delivered;

    if (pending > 0) {
      const oldest = await AuditOutbox.findOne({ status: 'PENDING' })
        .select('createdAt')
        .sort({ createdAt: 1 })
        .maxTimeMS(OUTBOX_QUERY_TIMEOUT_MS)
        .lean();
      const createdAt = oldest && (oldest as { createdAt?: Date }).createdAt ? new Date((oldest as { createdAt: Date }).createdAt) : null;
      oldestPending = createdAt && Number.isFinite(createdAt.getTime())
        ? {
            createdAt: createdAt.toISOString(),
            ageSeconds: Math.max(0, Math.round((Date.now() - createdAt.getTime()) / 1000)),
          }
        : null;
    }
  } catch (queryError) {
    error = `The audit outbox could not be read: ${(queryError as Error).message}`;
  }

  return {
    asOf: new Date().toISOString(),
    available: error === null,
    counts,
    oldestPending,
    error,
    note: error
      ? 'No count is reported. An unreadable outbox is not an empty one; the delivery worker owns the retry.'
      : 'Counts are read from audit_outbox; nothing here retries, edits or deletes a row.',
  };
}
