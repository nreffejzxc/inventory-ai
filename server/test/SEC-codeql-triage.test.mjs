// CodeQL triage — the four requested categories, pinned as properties rather than suppressed.
//
// WHY THIS EXISTS. CodeQL reported clear-text logging (4), HTTP-to-file access (8), incomplete URL
// substring sanitization (6) and insufficient password hashing (4). Reading each site showed they
// are not four vulnerabilities but four MISTAKES OF THE QUERY about this codebase: it logs an
// action NAME and calls it sensitive data, it writes a developer's eval report and calls it
// attacker-controlled, it matches a URL substring inside a TEST ASSERTION, and it sees an HMAC of a
// reset code behind a parameter called `password`. Suppressing the alerts would hide the next real
// finding in the same rule; deleting the assertions would weaken the suites that caught real bugs.
//
// So each alert becomes a property this file holds. If a future change makes one of them false —
// a credential reaching a log line, production code writing a response body to disk, a token
// rendered unescaped, a user password hashed with a fast digest — the suite fails and the alert
// stops being a false positive. That is the difference between triage and a clean dashboard.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unitSuite } from './testEnv.mjs';
import { INVITATION_TOKEN_LENGTH } from '../src/constants/invitations.ts';
import { isInvitationToken, renderInvitationLinkPage } from '../src/pages/invitationLink.ts';
import { generateResetCode, hashResetCode } from '../src/services/passwordResetCode/code.ts';
import { hashVerificationCode } from '../src/services/emailVerification/code.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const read = (relative) => readFileSync(path.resolve(serverRoot, relative), 'utf8');

/** Every `console.*` call's full argument text, including a multi-line call. */
function logCalls(source) {
  const calls = [];
  const pattern = /console\.(?:error|warn|log|info)\(([\s\S]*?)\);/g;
  let match;
  while ((match = pattern.exec(source)) !== null) calls.push(match[1]);
      return calls;
}


// ---------------------------------------------------------------------------
// 1. js/clear-text-logging — the logs carry a NAME, never the value
// ---------------------------------------------------------------------------

unitSuite('CodeQL triage — clear-text logging is an action name, not a secret', () => {
  it('logs the audit ACTION in its failure path and nothing from the event body', () => {
    // platformAudit.service.ts:110 interpolates `input.action` — a constant such as
    // PASSWORD_CHANGED — while the row it failed to write holds the email, IP and metadata.
    const calls = logCalls(read('src/services/platformAudit.service.ts'));
    const auditFailure = calls.find((call) => call.includes('[platform-audit] append failed'));
    assert.ok(auditFailure, 'the audit failure log line still exists');
    assert.match(auditFailure, /input\.action/);
    for (const forbidden of ['metadata', 'actorEmail', 'actor.email', 'context.ip', 'userAgent']) {
      assert.ok(
        !auditFailure.includes(forbidden),
        `the audit failure log must not interpolate ${forbidden}`,
      );
    }
  });

  it('logs the reset ACTION in its failure path and never the token, code or password', () => {
    // passwordReset.service.ts:240 logs `${action}`; the reset credential is not in scope there.
    const source = read('src/services/passwordReset.service.ts');
    const failure = logCalls(source).find((call) =>
      call.includes('[password-reset] audit record failed'),
    );
    assert.ok(failure, 'the password-reset audit failure log line still exists');
    assert.match(failure, /action/);
    // The literal tag `[password-reset]` is a label, not a value, so the check is on the
    // INTERPOLATED expressions rather than on any occurrence of the word.
    const interpolated = [...failure.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(interpolated.length > 0, 'the line interpolates something');
    for (const expression of interpolated) {
      for (const forbidden of ['rawToken', 'token', 'password', 'hash', 'pepper', 'metadata']) {
        assert.ok(
          !expression.includes(forbidden),
          `the reset audit failure log must not interpolate ${forbidden} (found: ${expression})`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. js/http-to-file-access — the writes live in developer tooling, not the server
// ---------------------------------------------------------------------------

unitSuite('CodeQL triage — response bodies are written only by dev tooling', () => {
  it('has no runtime module importing the scripts that write eval output', () => {
    // The eight alerts are all `scripts/*.mjs` writing an eval report to a path the OPERATOR
    // chose (--out / env), from a body the script itself requested. None of it is reachable from
    // the server: `src/` must never import from `scripts/`.
    const offenders = [];
    const walk = (dir) => {
      // The entry's own type, from the directory read — not a separate `stat` whose answer could
      // describe a different file by the time it is used.
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        if (/from\s+['"][^'"]*scripts\//.test(source) || /require\(['"][^'"]*scripts\//.test(source)) {
          offenders.push(path.relative(serverRoot, full));
        }
      }
    };
    walk(path.resolve(serverRoot, 'src'));
    assert.deepEqual(offenders, [], 'no runtime module may import a scripts/ helper');
  });

  it('writes eval output to an operator-chosen path, never to a path taken from the response', () => {
    // A fixed destination is what makes the alert context-dependent rather than dangerous: the
    // response can only decide the CONTENT of a report a developer reads.
    const source = read('scripts/perf/deployed-gate.mjs');
    // Every write goes through one helper, and every call site passes one of the script's own path
    // constants — never a value parsed out of a response.
    // (`?<!function ` skips the helper's own `writeJson(file, value)` declaration.)
    const destinations = [...source.matchAll(/(?<!function )writeJson\(\s*([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    assert.ok(destinations.length > 0, 'the script still writes its report');
    for (const destination of destinations) {
      assert.ok(
        ['OUT', 'BACKUP'].includes(destination),
        `the destination must be a constant path, not response data (found ${destination})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. js/incomplete-url-substring-sanitization — the token alphabet cannot carry markup
// ---------------------------------------------------------------------------

unitSuite('CodeQL triage — an invitation token cannot reflect markup', () => {
  it('accepts lowercase hex only, so no quoting or tag can survive validation', () => {
    for (const hostile of [
      '"><script>alert(1)</script>',
      '<script>',
      'abc"onmouseover=1',
      "token'",
      'A'.repeat(INVITATION_TOKEN_LENGTH), // uppercase is not in the alphabet
      'g'.repeat(INVITATION_TOKEN_LENGTH), // outside hex at full length
      '"'.repeat(INVITATION_TOKEN_LENGTH), // a full-length quote run is still refused
      '<'.repeat(INVITATION_TOKEN_LENGTH),
      'a'.repeat(INVITATION_TOKEN_LENGTH - 1),
      'a'.repeat(INVITATION_TOKEN_LENGTH + 1),
    ]) {
      assert.equal(isInvitationToken(hostile), false, `must reject ${JSON.stringify(hostile)}`);
    }
    const valid = '0123456789abcdef'.repeat(INVITATION_TOKEN_LENGTH / 16);
    assert.equal(isInvitationToken(valid), true, 'a well-formed token still opens the page');
  });

  it('renders a valid token into the page with no angle bracket or quote from it', () => {
    const token = '0123456789abcdef'.repeat(INVITATION_TOKEN_LENGTH / 16);
    assert.equal(isInvitationToken(token), true);
    const html = renderInvitationLinkPage(token);
    assert.ok(html.includes(token), 'the token reaches the app link');
    assert.equal(html.split(token).length - 1, 1, 'the token is written exactly once');
    // Substituting a different VALID token leaves every other byte of the page identical, which is
    // what "the token cannot alter the markup" means. (An assertion that merely strips the token
    // and looks for it again can never fail.)
    const other = renderInvitationLinkPage('f'.repeat(INVITATION_TOKEN_LENGTH));
    assert.equal(
      html.replace(token, '<token>'),
      other.replace('f'.repeat(INVITATION_TOKEN_LENGTH), '<token>'),
      'the token is substituted into a fixed template, never into markup',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. js/insufficient-password-hash — a code digest is not a password hash
// ---------------------------------------------------------------------------

unitSuite('CodeQL triage — short codes are keyed, and passwords use bcrypt', () => {
  it('persists a keyed digest of a reset code, never the code and never an unkeyed digest', () => {
    const code = generateResetCode();
    const pepper = 'pepper-a';
    const digest = hashResetCode(pepper, code);

    assert.match(digest, /^[a-f0-9]{64}$/, 'SHA-256 hex');
    assert.notEqual(digest, code, 'the code itself is never stored');
    // Unkeyed would make a 10^6 space a lookup table; the key is what removes that.
    assert.notEqual(digest, hashResetCode('pepper-b', code), 'a different pepper yields a different digest');
    // The same code under the same key is stable, so lookups still work.
    assert.equal(digest, hashResetCode(pepper, code));
    // The verification flow uses its own domain label, so a digest is not interchangeable.
    assert.notEqual(digest, hashVerificationCode(pepper, code));
  });

  it('stores user passwords with bcrypt at the project cost, not a fast digest', () => {
    const source = read('src/services/auth.service.ts');
    assert.match(source, /const BCRYPT_ROUNDS = (\d+);/);
    const rounds = Number(/const BCRYPT_ROUNDS = (\d+);/.exec(source)[1]);
    assert.ok(rounds >= 10, `bcrypt cost ${rounds} is below the accepted floor of 10`);
    assert.match(source, /bcrypt\.hash\(password, BCRYPT_ROUNDS\)/);
    assert.match(source, /bcrypt\.compare\(/);
    // A fast digest must never be what a user password is stored with.
    assert.ok(
      !/createHash\(['"]sha(?:256|1|512)['"]\)[^\n]*password/i.test(source),
      'user passwords must not be hashed with a fast digest',
    );
  });
});
