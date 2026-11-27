// WHO started this backup run, and can it be proved?
//
// WHY THIS EXISTS. `trigger` used to be the only statement of origin, and it is a
// caller-supplied string: `--trigger=SCHEDULED`, or the workflow's own
// `BACKUP_TRIGGER: SCHEDULED` env line, writes it. On 2026-11-27 the production history
// held a row that claimed `SCHEDULED` while its `host` was `win32` and its archive path
// was `C:\Users\jeffe\...` — a laptop run wearing a scheduled label. `gh run list
// --event schedule` showed no scheduled execution had ever happened. A label anyone can
// type is not evidence; the platform's own identifiers are.
//
// THIS MODULE READS, IT DOES NOT DECIDE POLICY. It captures what the runtime states about
// itself, plus `null` where the runtime says nothing. Whether a given combination counts as
// a scheduled run is decided in the server (`src/services/backupProvenance.service.ts`) so
// the rule can be changed without re-issuing archives.
import os from 'node:os';

// ONE SOURCE OF TRUTH. The workflow file and branch a scheduled run must come from are
// policy, and the policy is enforced by `attestScheduledRun` in the service — so the
// constants live there and are re-exported here rather than copied. Two literals meant a
// renamed workflow file could satisfy one half of the check while the other half kept
// accepting the old name; a re-export cannot drift.
import {
  SCHEDULED_WORKFLOW_FILE,
  SCHEDULED_WORKFLOW_REF,
} from '../../src/services/backupProvenance.service.ts';

export { SCHEDULED_WORKFLOW_FILE, SCHEDULED_WORKFLOW_REF };

const TRIGGERS = new Set(['SCHEDULED', 'MANUAL', 'CONSOLE', 'UNKNOWN']);

function text(value, max = 200) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function number(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

/**
 * The provenance of the CURRENT process.
 *
 * `source` is derived from `GITHUB_ACTIONS === 'true'`, which only GitHub sets. Everything
 * else is read verbatim and stored as `null` when absent: an absent run id must never
 * become a placeholder that later reads as evidence.
 *
 * `host` and `platform` are kept apart on purpose. `platform` is what the row's legacy
 * `host` field has always held (`win32`/`linux`), so old rows remain comparable; `host` is
 * the machine's name, which is what actually identifies a laptop.
 */
export function readProvenance(env = process.env) {
  const underGithub = String(env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true';

  let hostname;
  try {
    hostname = text(os.hostname(), 120);
  } catch {
    // A hostname is a nice-to-have: refusing to record a run because it is unavailable
    // would trade evidence for tidiness. The field is then null, like every absent value.
    hostname = null;
  }

  return {
    source: underGithub ? 'github-actions' : 'local',
    event: text(env.GITHUB_EVENT_NAME, 40),
    runId: text(env.GITHUB_RUN_ID, 40),
    runAttempt: number(env.GITHUB_RUN_ATTEMPT),
    repository: text(env.GITHUB_REPOSITORY, 120),
    workflowRef: text(env.GITHUB_WORKFLOW_REF, 240),
    ref: text(env.GITHUB_REF, 120),
    sha: text(env.GITHUB_SHA, 40),
    actor: text(env.GITHUB_ACTOR, 120),
    runner: {
      name: text(env.RUNNER_NAME, 120),
      os: text(env.RUNNER_OS, 40),
      arch: text(env.RUNNER_ARCH, 40),
    },
    host: hostname,
    platform: text(process.platform, 40),
  };
}

/**
 * The `trigger` this execution may claim.
 *
 * Under GitHub Actions the EVENT is authoritative: a `workflow_dispatch` is a manual run
 * however the workflow's environment is written, and only `schedule` may say SCHEDULED.
 * That closes the second route to a false claim — the workflow used to set
 * `BACKUP_TRIGGER: SCHEDULED` in the same step for both triggers.
 *
 * Everywhere else `SCHEDULED` is REFUSED, not merely unproved. Attestation requires the
 * GitHub run id, event, workflow reference and main ref, so no local process can ever
 * satisfy it: honouring `--trigger=SCHEDULED` or `BACKUP_TRIGGER=SCHEDULED` there would
 * only write a row that every reader has to reject. The run is recorded as `MANUAL` —
 * the same label a hand-started run gets — and the refusal is logged, so the outcome is
 * visible rather than silent. The backup itself is unaffected.
 */
export function deriveTrigger({ provenance, requested }) {
  if (provenance?.source === 'github-actions') {
    return provenance.event === 'schedule' ? 'SCHEDULED' : 'MANUAL';
  }
  const wanted = String(requested ?? 'UNKNOWN').toUpperCase();
  // The one trigger a local execution may not claim, whatever it asks for.
  if (wanted === 'SCHEDULED') return 'MANUAL';
  return TRIGGERS.has(wanted) ? wanted : 'UNKNOWN';
}

/** A stored trigger's human meaning, for a log line or an API reason. */
export function describeTrigger(trigger) {
  switch (trigger) {
    case 'SCHEDULED':
      return 'scheduled';
    case 'MANUAL':
      return 'manual';
    case 'CONSOLE':
      return 'console';
    default:
      return 'unknown';
  }
}

export default { SCHEDULED_WORKFLOW_FILE, SCHEDULED_WORKFLOW_REF, readProvenance, deriveTrigger, describeTrigger };
