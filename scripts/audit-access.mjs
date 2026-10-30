#!/usr/bin/env node
/**
 * Access audit — checks the public repository's protection and access surface.
 *
 * WHY THIS EXISTS
 * The intended policy is: this repository is **public** by the owner's decision, the
 * default branch is **protected**, and only trusted accounts have write access. Branch
 * protection now gates `main`, but nothing watches the visibility, the collaborator list,
 * the deploy keys or the webhooks between manual runs. So this script IS that check: a
 * credential that can read the `Administration`-level endpoints is required, which is why
 * it runs against the owner's own authenticated `gh` session instead of in CI, where
 * `GITHUB_TOKEN` answers 403 for them. Run it by hand — ideally before and after anything
 * that touches repository settings, and whenever access is on your mind.
 *
 * WHAT IT ASSERTS (exit 1 on any violation)
 *   * the repository is public
 *   * the default branch is protected by the four required checks, strict up-to-date
 *     enforcement, admin enforcement, a pull request, and blocked force pushes/deletions
 *   * secret scanning and push protection are enabled
 *   * private vulnerability reporting is enabled
 *   * only the owner and explicitly trusted collaborators have access
 *   * there are no pending invitations
 *   * there are no deploy keys
 *   * there are no webhooks
 *
 * WHAT IT ONLY REPORTS (never fails)
 * Things that are legitimate but worth seeing: forks (expected on a public repository),
 * Actions secrets, environments, the Actions policy, rulesets and the sharing level.
 * Secret VALUES are never read or printed; only names.
 *
 * WHAT IT CANNOT DO
 * It cannot see GitHub Apps with repository access (`GET /user/installations`
 * needs a token authorised to an App, and the repository installation endpoint
 * needs an App JWT), it cannot list SSH/GPG keys or classic personal access tokens
 * without extra OAuth scopes, and it cannot see account 2FA state. Those are
 * owner-side checks in docs/SOURCE_PROTECTION.md.
 *
 * USAGE
 *   node scripts/audit-access.mjs            # audit the origin remote's repository
 *   node scripts/audit-access.mjs owner/repo # audit an explicit repository
 *
 * It is NOT wired into CI on purpose: in CI every administration-level endpoint answers
 * 403, so it could only report "not verified", which is worse than an honest manual run.
 *
 * Exit codes: 0 clean, 1 violation, 2 could not run.
 */

import { execFileSync } from 'node:child_process';

const violations = [];
const notes = [];

function gh(args) {
  try {
    const out = execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 200, data: out.trim() === '' ? null : JSON.parse(out) };
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/command not found|ENOENT/.test(String(error.message))) {
      console.error('Could not run: the GitHub CLI (`gh`) is not available.');
      process.exit(2);
    }
    const match = /HTTP (\d{3})/.exec(text);
    if (/auth login|not logged in|authentication/i.test(text) && !match) {
      console.error('Could not run: `gh` is not authenticated. Run `gh auth login` first.');
      process.exit(2);
    }
    return { status: match ? Number(match[1]) : 0, data: null };
  }
}

function repositorySlug() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const match = /github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/.exec(remote);
    if (match) return match[1];
  } catch {
    /* fall through to the error below */
  }
  console.error('Could not determine the repository. Pass it explicitly: node scripts/audit-access.mjs owner/repo');
  process.exit(2);
}

const repo = repositorySlug();
const owner = repo.split('/')[0];

/** Accounts other than the owner that the owner has deliberately retained. */
const TRUSTED_COLLABORATORS = new Set(['nreffejzxc']);

function pass(label, detail) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail) {
  violations.push(label);
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function info(label, detail) {
  console.log(`  INFO  ${label}${detail ? ` — ${detail}` : ''}`);
}
function notVerifiable(label, status) {
  notes.push(label);
  console.log(`  ????  ${label} — not verifiable here (HTTP ${status || 'request failed'})`);
}

console.log(`\nAccess audit · ${repo}\n`);

// --- Visibility and copies (the surface CI can also see) ---------------------

console.log('Visibility and copies');

const meta = gh([`repos/${repo}`]);
if (meta.status !== 200 || !meta.data) {
  console.error(`Could not read the repository (HTTP ${meta.status}).`);
  process.exit(2);
}

if (meta.data.private === false) {
  pass('repository is public', `visibility=${meta.data.visibility}`);
} else {
  fail(
    'repository is NOT public',
    `visibility=${meta.data.visibility} — branch protection is unavailable on a private repository at this plan`,
  );
}

const forks = meta.data.forks_count ?? 0;
const network = meta.data.network_count ?? 0;
info('forks', `forks_count=${forks}, network_count=${network} — a fork is outside this repository's controls`);
if (forks > 0) {
  info('forks exist', 'expected on a public repository; not a policy violation');
}

if (meta.data.allow_forking === true) {
  info('allow_forking is on', 'public visibility permits forking');
}
if (meta.data.owner?.type === 'Organization') {
  info('owned by an organization', meta.data.owner.login);
}

// --- Humans with access ------------------------------------------------------

console.log('\nHuman access');

const collaborators = gh([`repos/${repo}/collaborators?affiliation=all&per_page=100`]);
if (collaborators.status === 200 && Array.isArray(collaborators.data)) {
  const trusted = new Set([owner, ...TRUSTED_COLLABORATORS]);
  const others = collaborators.data.filter((entry) => !trusted.has(entry.login));
  const ownerEntry = collaborators.data.find((entry) => entry.login === owner);
  const names = collaborators.data.map((entry) => `${entry.login} (${entry.role_name ?? 'unknown'})`);
  if (ownerEntry?.permissions?.admin !== true) {
    fail('the owner does not have admin', names.join(', '));
  } else if (others.length === 0) {
    pass('only the owner and trusted collaborators have access', names.join(', '));
  } else {
    fail('an untrusted account has access', others.map((entry) => `${entry.login} (${entry.role_name})`).join(', '));
  }
} else {
  notVerifiable('collaborators', collaborators.status);
}

const invitations = gh([`repos/${repo}/invitations?per_page=100`]);
if (invitations.status === 200 && Array.isArray(invitations.data)) {
  if (invitations.data.length === 0) {
    pass('no pending invitations');
  } else {
    fail('pending invitations exist', invitations.data.map((entry) => entry.invitee?.login).join(', '));
  }
} else {
  notVerifiable('pending invitations', invitations.status);
}

const twoFactor = gh([`users/${owner}`]);
if (twoFactor.status === 200 && twoFactor.data) {
  if (twoFactor.data.two_factor_authentication === true) {
    pass('account 2FA is enabled');
  } else {
    notes.push('Account 2FA could not be confirmed over the API — check https://github.com/settings/security');
    info(
      'account 2FA is not confirmable over the API',
      'the field is null for this token; verify it in Settings → Password and authentication',
    );
  }
}

// --- Machine access ----------------------------------------------------------

console.log('\nMachine access');

for (const [label, path] of [
  ['deploy keys', `repos/${repo}/keys?per_page=100`],
  ['webhooks', `repos/${repo}/hooks?per_page=100`],
]) {
  const result = gh([path]);
  if (result.status === 200 && Array.isArray(result.data)) {
    if (result.data.length === 0) {
      pass(`no ${label}`);
    } else {
      fail(`${label} exist`, result.data.map((entry) => entry.title ?? entry.config?.url ?? entry.id).join(', '));
    }
  } else {
    notVerifiable(label, result.status);
  }
}

const secrets = gh([`repos/${repo}/actions/secrets?per_page=100`]);
if (secrets.status === 200 && Array.isArray(secrets.data?.secrets)) {
  info(
    'Actions secrets',
    secrets.data.secrets.length === 0
      ? 'none (no credential exists in this repository)'
      : secrets.data.secrets.map((entry) => entry.name).join(', '),
  );
} else {
  notVerifiable('Actions secrets', secrets.status);
}

const environments = gh([`repos/${repo}/environments?per_page=100`]);
if (environments.status === 200 && Array.isArray(environments.data?.environments)) {
  info(
    'deployment environments',
    environments.data.environments.length === 0
      ? 'none'
      : environments.data.environments.map((entry) => entry.name).join(', '),
  );
} else {
  notVerifiable('deployment environments', environments.status);
}

// --- Workflow trust surface --------------------------------------------------

console.log('\nWorkflow trust surface');

const actionsPolicy = gh([`repos/${repo}/actions/permissions`]);
if (actionsPolicy.status === 200 && actionsPolicy.data) {
  info(
    'allowed actions',
    `${actionsPolicy.data.allowed_actions}, sha_pinning_required=${actionsPolicy.data.sha_pinning_required}`,
  );
} else {
  notVerifiable('Actions policy', actionsPolicy.status);
}

const workflowDefault = gh([`repos/${repo}/actions/permissions/workflow`]);
if (workflowDefault.status === 200 && workflowDefault.data) {
  info(
    'default GITHUB_TOKEN permissions',
    `${workflowDefault.data.default_workflow_permissions}, can_approve_pull_request_reviews=${workflowDefault.data.can_approve_pull_request_reviews}`,
  );
} else {
  notVerifiable('workflow token default', workflowDefault.status);
}

const sharing = gh([`repos/${repo}/actions/permissions/access`]);
if (sharing.status === 200 && sharing.data) {
  info('actions shared with other repositories', sharing.data.access_level);
} else if (sharing.status === 422) {
  info('Actions access scope', 'not applicable to a public repository');
} else {
  notVerifiable('Actions access scope', sharing.status);
}

// --- Branch protection and scanning ------------------------------------------

console.log('\nBranch protection and scanning (measured, not assumed)');

const EXPECTED_CHECKS = ['server', 'secret-guard', 'attribution-guard', 'mobile'].sort();
const protection = gh([`repos/${repo}/branches/${meta.data.default_branch}/protection`]);

if (protection.status === 200 && protection.data) {
  const checks = [...(protection.data.required_status_checks?.contexts ?? [])].sort();
  const missing = EXPECTED_CHECKS.filter((check) => !checks.includes(check));
  const extra = checks.filter((check) => !EXPECTED_CHECKS.includes(check));

  if (protection.data.required_status_checks?.strict !== true) {
    fail('required checks are not strict', 'a branch can merge without being up to date');
  } else if (missing.length > 0 || extra.length > 0) {
    fail('required checks do not match', `expected ${EXPECTED_CHECKS.join(', ')}; got ${checks.join(', ') || 'none'}`);
  } else {
    pass('required checks', checks.join(', '));
  }

  if (protection.data.enforce_admins?.enabled === true) {
    pass('administrators are enforced');
  } else {
    fail('administrators can bypass the rule', 'enforce_admins is off');
  }

  if (protection.data.required_pull_request_reviews) {
    pass(
      'a pull request is required',
      `${protection.data.required_pull_request_reviews.required_approving_review_count ?? 0} required approval(s)`,
    );
  } else {
    fail('no pull request is required', 'direct pushes are still possible');
  }

  for (const [label, enabled] of [
    ['force pushes are blocked', protection.data.allow_force_pushes?.enabled],
    ['branch deletion is blocked', protection.data.allow_deletions?.enabled],
  ]) {
    if (enabled === true) {
      fail(label.replace(' are blocked', ' are allowed').replace(' is blocked', ' is allowed'));
    } else {
      pass(label);
    }
  }

  if (protection.data.required_conversation_resolution?.enabled === true) {
    pass('conversation resolution is required');
  } else {
    info('conversation resolution is not required');
  }
} else if (protection.status === 404) {
  fail('the default branch has no protection', `GET branches/${meta.data.default_branch}/protection -> 404`);
} else {
  notVerifiable('branch protection', protection.status);
}

const rulesets = gh([`repos/${repo}/rulesets`]);
if (rulesets.status === 200 && Array.isArray(rulesets.data)) {
  info('repository rulesets', `${rulesets.data.length} configured`);
} else if (rulesets.status === 404) {
  info('repository rulesets', 'none');
} else {
  notVerifiable('repository rulesets', rulesets.status);
}

const scanning = meta.data.security_and_analysis ?? {};
const secretScanning = scanning.secret_scanning?.status;
const pushProtection = scanning.secret_scanning_push_protection?.status;

if (secretScanning === 'enabled') {
  pass('secret scanning is enabled');
} else {
  fail('secret scanning is not enabled', secretScanning ?? 'absent');
}

if (pushProtection === 'enabled') {
  pass('secret scanning push protection is enabled');
} else {
  fail('secret scanning push protection is not enabled', pushProtection ?? 'absent');
}

const pvr = gh([`repos/${repo}/private-vulnerability-reporting`]);
if (pvr.status === 200 && pvr.data?.enabled === true) {
  pass('private vulnerability reporting is enabled');
} else if (pvr.status === 404) {
  fail('private vulnerability reporting is unavailable');
} else {
  notVerifiable('private vulnerability reporting', pvr.status);
}

// --- Verdict -----------------------------------------------------------------

const summary = [];
summary.push(violations.length === 0 ? 'No policy violations found.' : `${violations.length} violation(s):`);
for (const violation of violations) summary.push(`  - ${violation}`);
if (notes.length > 0) {
  summary.push('Unverified or unavailable (not a pass):');
  for (const note of notes) summary.push(`  - ${note}`);
}
console.log(`\n${summary.join('\n')}\n`);

process.exit(violations.length === 0 ? 0 : 1);
