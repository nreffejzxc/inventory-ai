/**
 * Is a run's `SCHEDULED` claim actually a scheduled GitHub execution?
 *
 * WHY THIS EXISTS. `trigger` is a caller-supplied string. On 2026-11-27 the production
 * history contained a row (`e546b5a7`) that claimed `SCHEDULED` while its `host` was
 * `win32` and its archive lived under `C:\Users\jeffe\…`; `gh run list --event schedule`
 * showed no scheduled execution of `backup-daily` had ever happened. Two routes produced
 * that: `--trigger`/`BACKUP_TRIGGER` on a laptop, and the workflow's own
 * `BACKUP_TRIGGER: SCHEDULED` line, which applied to `workflow_dispatch` too.
 *
 * THE RULE LIVES HERE, NOT IN THE RUNNER. The runner records what the platform says about
 * itself; the verdict is a read-path decision, so the policy can be tightened later and
 * applies to rows already written. That is why this module only reads a stored record.
 *
 * IT IS DELIBERATELY STRICTER THAN "the field looks plausible". A scheduled backup is
 * evidence for a recovery plan, so the claim has to be pinned to this repository, this
 * workflow FILE, and this branch: a fork, a renamed workflow, a feature branch or a copied
 * workflow cannot satisfy it.
 */

/** The one workflow file allowed to claim a scheduled backup. */
export const SCHEDULED_WORKFLOW_FILE = '.github/workflows/backup-daily.yml';

/** The branch a scheduled run must come from. */
export const SCHEDULED_WORKFLOW_REF = 'refs/heads/main';

const RUN_ID_PATTERN = /^\d{6,}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `owner/repo/.github/workflows/backup-daily.yml@refs/heads/main` — exactly.
 * `GITHUB_WORKFLOW_REF` is what GitHub sets, and it names the repository AND the ref, so
 * one pattern rules out a fork, a branch build and a different workflow file at once.
 */
export const SCHEDULED_WORKFLOW_REF_PATTERN = new RegExp(
  `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/${escapeRegExp(SCHEDULED_WORKFLOW_FILE)}@${escapeRegExp(SCHEDULED_WORKFLOW_REF)}$`,
);

export type BackupRunProvenance = {
  source: 'github-actions' | 'local' | null;
  event: string | null;
  runId: string | null;
  runAttempt: number | null;
  repository: string | null;
  workflowRef: string | null;
  ref: string | null;
  sha: string | null;
  actor: string | null;
  runner: { name: string | null; os: string | null; arch: string | null } | null;
  host: string | null;
  platform: string | null;
};

export type ScheduledAttestation = {
  attested: boolean;
  reason: string | null;
};

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

/**
 * Normalise a provenance payload to exactly the stored shape.
 *
 * Every field is clipped and every absent value becomes `null`: no placeholder, no default.
 * A fabricated `runId` would defeat the entire mechanism, so `null` is the only honest
 * answer for "this runtime did not tell me".
 */
export function normaliseProvenance(input: unknown): BackupRunProvenance | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const source = raw.source === 'github-actions' || raw.source === 'local' ? raw.source : null;
  const runnerRaw = raw.runner && typeof raw.runner === 'object' ? (raw.runner as Record<string, unknown>) : null;
  return {
    source,
    event: clip(raw.event, 40),
    runId: clip(raw.runId, 40),
    runAttempt: positiveInt(raw.runAttempt),
    repository: clip(raw.repository, 120),
    workflowRef: clip(raw.workflowRef, 240),
    ref: clip(raw.ref, 120),
    sha: clip(raw.sha, 40),
    actor: clip(raw.actor, 120),
    runner: runnerRaw
      ? {
          name: clip(runnerRaw.name, 120),
          os: clip(runnerRaw.os, 40),
          arch: clip(runnerRaw.arch, 40),
        }
      : null,
    host: clip(raw.host, 120),
    platform: clip(raw.platform, 40),
  };
}

/**
 * The verdict for one stored run.
 *
 * Order matters: each check answers a DIFFERENT question, so the first failure names the
 * most useful thing an operator can act on. A row with no provenance at all (every row
 * written before this change) is reported as unproved rather than guessed at.
 */
export function attestScheduledRun(input: {
  trigger?: string | null;
  provenance?: BackupRunProvenance | null;
  host?: string | null;
}): ScheduledAttestation {
  const trigger = String(input.trigger ?? 'UNKNOWN').toUpperCase();
  if (trigger !== 'SCHEDULED') {
    return { attested: false, reason: `the run does not claim a scheduled execution (trigger ${trigger})` };
  }

  const provenance = input.provenance ?? null;
  if (!provenance) {
    return {
      attested: false,
      reason:
        'no provenance was recorded for this run — the SCHEDULED label is unproved (written before provenance was captured, or by a caller that could not state its origin)',
    };
  }
  if (provenance.source !== 'github-actions') {
    const where = provenance.platform ?? input.host ?? 'an unidentified host';
    return {
      attested: false,
      reason: `the run was not started by GitHub Actions (source ${provenance.source ?? 'unknown'}, platform ${where})`,
    };
  }
  if (provenance.event !== 'schedule') {
    return {
      attested: false,
      reason: `GitHub recorded the event as ${provenance.event ?? 'unknown'}, not schedule`,
    };
  }
  if (!RUN_ID_PATTERN.test(provenance.runId ?? '')) {
    return { attested: false, reason: 'the GitHub run id is missing or malformed' };
  }
  if (!SHA_PATTERN.test((provenance.sha ?? '').toLowerCase())) {
    return { attested: false, reason: 'the commit SHA is missing or malformed' };
  }
  if (!SCHEDULED_WORKFLOW_REF_PATTERN.test(provenance.workflowRef ?? '')) {
    return {
      attested: false,
      reason: `the workflow reference does not name ${SCHEDULED_WORKFLOW_FILE} on ${SCHEDULED_WORKFLOW_REF}`,
    };
  }
  if (provenance.platform && provenance.platform !== 'linux') {
    return {
      attested: false,
      reason: `the platform was ${provenance.platform}; a GitHub-hosted runner is linux`,
    };
  }
  return { attested: true, reason: null };
}

export default {
  SCHEDULED_WORKFLOW_FILE,
  SCHEDULED_WORKFLOW_REF,
  SCHEDULED_WORKFLOW_REF_PATTERN,
  attestScheduledRun,
  normaliseProvenance,
};
