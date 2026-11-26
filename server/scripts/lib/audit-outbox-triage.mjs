// Pure parsing and text output for the read-only FAILED audit-outbox triage.
// This module imports no database driver and performs no writes.

export const AUDIT_TRIAGE_DEFAULT_LIMIT = 100;
export const AUDIT_TRIAGE_MAX_LIMIT = 1_000;
export const AUDIT_TRIAGE_DEFAULT_MIN_AGE_MINUTES = 15;
export const AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS = 3;

export function parseAuditOutboxTriageArgs(argv = process.argv.slice(2)) {
  const args = {
    withProduction: false,
    format: 'text',
    businessId: null,
    minAgeMinutes: AUDIT_TRIAGE_DEFAULT_MIN_AGE_MINUTES,
    minAttempts: AUDIT_TRIAGE_DEFAULT_MIN_ATTEMPTS,
    limit: AUDIT_TRIAGE_DEFAULT_LIMIT,
    help: false,
    problems: [],
  };
  const seen = new Set();
  for (const raw of argv) {
    if (raw === '--with-production') {
      if (seen.has('production')) args.problems.push('--with-production was given more than once.');
      seen.add('production');
      args.withProduction = true;
    } else if (raw === '--help' || raw === '-h') {
      args.help = true;
    } else if (raw.startsWith('--format=')) {
      if (seen.has('format')) args.problems.push('--format was given more than once.');
      seen.add('format');
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json.');
      else args.format = value;
    } else if (raw.startsWith('--business=')) {
      if (seen.has('business')) args.problems.push('--business was given more than once.');
      seen.add('business');
      const value = raw.slice('--business='.length).trim();
      if (!/^[a-f0-9]{24}$/i.test(value)) {
        args.problems.push('--business must be a 24-character hexadecimal id.');
      } else args.businessId = value;
    } else if (raw.startsWith('--min-age-minutes=')) {
      if (seen.has('minAge')) args.problems.push('--min-age-minutes was given more than once.');
      seen.add('minAge');
      const value = Number(raw.slice('--min-age-minutes='.length).trim());
      if (!Number.isInteger(value) || value < 0 || value > 10_080) {
        args.problems.push('--min-age-minutes must be an integer from 0 to 10080.');
      } else args.minAgeMinutes = value;
    } else if (raw.startsWith('--min-attempts=')) {
      if (seen.has('minAttempts')) args.problems.push('--min-attempts was given more than once.');
      seen.add('minAttempts');
      const value = Number(raw.slice('--min-attempts='.length).trim());
      if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
        args.problems.push('--min-attempts must be an integer from 1 to 1000000.');
      } else args.minAttempts = value;
    } else if (raw.startsWith('--limit=')) {
      if (seen.has('limit')) args.problems.push('--limit was given more than once.');
      seen.add('limit');
      const value = Number(raw.slice('--limit='.length).trim());
      if (!Number.isInteger(value) || value < 1 || value > AUDIT_TRIAGE_MAX_LIMIT) {
        args.problems.push(`--limit must be an integer from 1 to ${AUDIT_TRIAGE_MAX_LIMIT}.`);
      } else args.limit = value;
    } else {
      args.problems.push(`unknown argument: ${raw}`);
    }
  }
  return args;
}

function ageText(ms) {
  if (ms == null) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** Human-readable form of the same report; every row is evidence, nothing is changed. */
export function formatAuditOutboxTriageText(report) {
  const lines = [
    `Audit outbox FAILED triage on ${report.database ?? '(database not reported)'} (READ-ONLY)`,
    `Generated: ${report.generatedAt}`,
    `Scope: business=${report.scope?.businessId ?? 'all'} limit=${report.scope?.limit ?? '?'}`,
    `Thresholds: age >= ${ageText(report.thresholds?.minAgeMs)} OR attempts >= ${report.thresholds?.minAttempts ?? '?'}`,
    '',
    `FAILED rows: ${report.counts?.failed ?? 0}; matching: ${report.counts?.matching ?? 0} ` +
      `(returned ${report.counts?.returned ?? 0})`,
  ];

  if (!report.rows?.length) {
    lines.push('  none');
  } else {
    report.rows.forEach((row, index) => {
      lines.push(
        `${index + 1}. ${row.action || '(unknown action)'} ${row.dedupeKey || '(no key)'} — ` +
          `attempts=${row.attempts} age=${ageText(row.ageMs)} error=${row.lastError ?? 'unknown'}`,
      );
      lines.push(
        `   entity: ${row.entityType || 'unknown'} ${row.entityId ?? 'none'} ` +
          `updated: ${row.updatedAt ?? 'unknown'} available: ${row.availableAt ?? 'unknown'}`,
      );
    });
  }

  lines.push('', report.note);
  return lines.join('\n');
}
