// Phase AUTH-01 — Firebase verification foundation.
//
// The phase changes HOW a Firebase ID token is verified, and how a verification
// FAILURE is classified. It adds no route and changes no session/JWT behaviour.
//
// The properties this suite pins:
//
//   * REVOCATION CHECKING IS ON, AND CANNOT SILENTLY TURN OFF. The real verifier
//     must call `verifyIdToken(idToken, true)`. A source guard asserts the literal,
//     because the alternative — a test that reaches Google — is not available here.
//     A companion guard proves no `revokeRefreshTokens()` was introduced.
//
//   * TRANSIENT ≠ TERMINAL. A failure to COMPLETE verification must never be
//     reported as a rejected credential. The classifier is asserted directly
//     against the code vocabulary derived from the installed firebase-admin
//     14.5.1, including the overloaded `auth/argument-error` (which is also what a
//     JWKS fetch failure looks like) and unknown/future codes.
//
//   * THE THREE ERRORS STAY DISJOINT. `FIREBASE_TOKEN_INVALID` (terminal),
//     `FIREBASE_UNAVAILABLE` (transient), `FIREBASE_NOT_CONFIGURED` (operator) are
//     distinct codes with distinct statuses, and an AUTHENTICATED route must not
//     rewrite the transient 503 into its terminal 400.
//
//   * ENVIRONMENT AND SHAPE ARE DEFENCE-IN-DEPTH. `aud`/`iss` must name this
//     project; a structurally malformed value is rejected terminally by us, before
//     the SDK is even initialized.
//
// Version coupling: the classification is derived from firebase-admin 14.5.1, and
// a guard fails if the installed version differs — a bump requires re-deriving the
// code lists rather than assuming they still hold.
//
// Registered MIXED in run-tests.mjs: the classifier/guard cases run without a
// database; the HTTP cases need MongoDB (an authenticated route needs a session).

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { createTracker, uniqueEmail, uniqueName, issueSessionToken } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';

import { createApp } from '../src/app.ts';
import Business from '../src/models/business.model.ts';
import User from '../src/models/user.model.ts';
import {
  verifyFirebaseIdToken,
  setFirebaseIdTokenVerifier,
  resetFirebaseIdTokenVerifier,
  isStructurallyJwtShaped,
  assertFirebaseTokenEnvironment,
} from '../src/services/firebase/tokenVerifier.ts';
import {
  FirebaseNotConfigured,
  FirebaseTokenError,
  FirebaseUnavailableError,
  FIREBASE_NOT_CONFIGURED,
  FIREBASE_TOKEN_INVALID,
  FIREBASE_UNAVAILABLE,
  TERMINAL_FIREBASE_AUTH_CODES,
  NOT_CONFIGURED_FIREBASE_AUTH_CODES,
  TRANSIENT_FIREBASE_AUTH_CODES,
  classifyFirebaseErrorCode,
  isFirebaseError,
} from '../src/services/firebase/firebaseErrors.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(SERVER_ROOT, 'src');

const EXCHANGE = '/api/auth/firebase/exchange';
const LINK = '/api/auth/firebase/link';
const ME = '/api/auth/me';

/** A JWT-SHAPED placeholder. Never a real token; the seam replaces verification. */
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoLTAxIn0.c2lnbmF0dXJl'; // secret-guard:allow (deliberate fixture)

/** The version the classifier was derived from; a bump must re-derive it. */
const VERIFIED_FIREBASE_ADMIN_VERSION = '14.5.1';

// ===========================================================================
// Unit — the classifier
// ===========================================================================

unitSuite('AUTH-01 — Firebase failure classification (no database)', () => {
  it('classifies exactly the four terminal codes as terminal', () => {
    for (const code of [
      'auth/id-token-expired',
      'auth/id-token-revoked',
      'auth/user-disabled',
      'auth/user-not-found',
    ]) {
      assert.equal(classifyFirebaseErrorCode(code), 'terminal', `${code} must be terminal`);
    }
    // The list is short ON PURPOSE; a widened list is a regression, not a fix.
    assert.deepEqual(
      [...TERMINAL_FIREBASE_AUTH_CODES].sort(),
      [
        'auth/id-token-expired',
        'auth/id-token-revoked',
        'auth/user-disabled',
        'auth/user-not-found',
      ].sort()
    );
  });

  it('★ treats auth/argument-error as TRANSIENT, not terminal', () => {
    // ★ THE POINT OF THE PHASE'S CLASSIFICATION. firebase-admin 14.5.1 emits
    //   `auth/argument-error` for a JWKS/public-key fetch failure (KEY_FETCH_ERROR)
    //   as well as for a genuinely malformed token, so it cannot be trusted as a
    //   terminal signal. A malformed token is caught terminally by the structural
    //   guard instead; what reaches the classifier as argument-error is the
    //   ambiguous remainder, and ambiguity must not destroy a valid session.
    assert.equal(classifyFirebaseErrorCode('auth/argument-error'), 'unavailable');
    assert.equal(
      (TRANSIENT_FIREBASE_AUTH_CODES).includes('auth/argument-error'),
      true,
      'argument-error belongs in the documented transient list'
    );
  });

  it('classifies service/transport/internal codes as transient', () => {
    for (const code of [
      'auth/internal-error',
      'app/network-error',
      'app/network-timeout',
      'app/internal-error',
      'auth/quota-exceeded',
      'auth/insufficient-permission',
      'auth/project-not-found',
      'auth/configuration-not-found',
      'auth/billing-not-enabled',
    ]) {
      assert.equal(classifyFirebaseErrorCode(code), 'unavailable', `${code} must be transient`);
    }
  });

  it('classifies unknown, future, missing and non-string codes as transient (fail open to retry)', () => {
    // §19: an unknown failure must not be treated as terminal. Failing open to
    // "retry later" grants nothing; failing closed would sign a user out over an
    // outage we do not understand.
    for (const code of [
      'auth/some-future-code',
      'app/some-future-code',
      'totally-made-up',
      '',
      undefined,
      null,
      42,
      { code: 'auth/id-token-expired' },
    ]) {
      assert.equal(
        classifyFirebaseErrorCode(code),
        'unavailable',
        `${JSON.stringify(code)} must default to transient`
      );
    }
  });

  it('keeps auth/invalid-credential DISTINCT — it is an operator fault, not an outage', () => {
    // Not terminal (the caller's token was never judged) and not generic
    // unavailability (retrying will not fix a misconfigured SDK).
    assert.equal(classifyFirebaseErrorCode('auth/invalid-credential'), 'not-configured');
    assert.deepEqual([...NOT_CONFIGURED_FIREBASE_AUTH_CODES], ['auth/invalid-credential']);
    // And the two are disjoint.
    assert.equal(
      (TRANSIENT_FIREBASE_AUTH_CODES).includes('auth/invalid-credential'),
      false,
      'invalid-credential must not be lumped in with transient service codes'
    );
  });
});

// ===========================================================================
// Unit — structural pre-check and environment assertion
// ===========================================================================

unitSuite('AUTH-01 — token shape and environment (no database)', () => {
  it('accepts only three non-empty dot-separated segments', () => {
    const good = 'aaa.bbb.ccc';
    assert.equal(isStructurallyJwtShaped(good), true);
    assert.equal(isStructurallyJwtShaped(`  ${good}  `), true, 'surrounding whitespace is trimmed');

    for (const bad of [
      'not-a-jwt',
      '',
      '   ',
      'aaa.bbb',
      'aaa.bbb.ccc.ddd',
      'aaa..ccc',
      '.bbb.ccc',
      'aaa.bbb.',
      42,
      null,
      undefined,
      {},
      [],
    ]) {
      assert.equal(
        isStructurallyJwtShaped(bad),
        false,
        `${JSON.stringify(bad)} must not read as a JWT`
      );
    }
  });

  it('★ rejects a structurally malformed value TERMINALLY on the real path, before any SDK work', async () => {
    resetFirebaseIdTokenVerifier();
    // No Firebase environment is needed and no network is touched: the structural
    // guard runs before the Admin app is ever initialized.
    await assert.rejects(
      () => verifyFirebaseIdToken('not-a-jwt'),
      (err) => err instanceof FirebaseTokenError && err.reason === 'malformed-token',
      'a non-JWT value must be a terminal token error'
    );
  });

  it('accepts a matching aud + iss', () => {
    assertFirebaseTokenEnvironment(
      { aud: 'my-project', iss: 'https://securetoken.google.com/my-project' },
      'my-project'
    );
  });

  it('rejects a wrong aud, a wrong iss, a missing pair, or a missing project id', () => {
    const expected = { aud: 'my-project', iss: 'https://securetoken.google.com/my-project' };
    const cases = [
      { ...expected, aud: 'someone-elses-project' },
      { ...expected, iss: 'https://securetoken.google.com/someone-elses-project' },
      { iss: expected.iss },
      { aud: expected.aud },
      {},
      null,
      undefined,
    ];
    for (const decoded of cases) {
      assert.throws(
        () => assertFirebaseTokenEnvironment(decoded, 'my-project'),
        (err) =>
          err instanceof FirebaseTokenError && err.reason === 'token-environment-mismatch',
        `expected a terminal mismatch for ${JSON.stringify(decoded)}`
      );
    }
    // An empty configured project id can never match, so it fails closed.
    assert.throws(
      () => assertFirebaseTokenEnvironment(expected, ''),
      (err) => err instanceof FirebaseTokenError
    );
  });

  it('the mismatch reason is a safe label and never carries the token', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    try {
      assertFirebaseTokenEnvironment({ aud: jwt, iss: jwt }, 'my-project');
      assert.fail('an assertion should have thrown');
    } catch (err) {
      assert.ok(err instanceof FirebaseTokenError);
      assert.equal(err.reason, 'token-environment-mismatch');
      assert.ok(!JSON.stringify(err).includes(jwt), 'the token must not appear in the error');
    }
  });
});

// ===========================================================================
// Unit — the error namespace
// ===========================================================================

unitSuite('AUTH-01 — the three Firebase error codes stay disjoint', () => {
  it('recognises FirebaseUnavailableError as a Firebase error', () => {
    assert.equal(isFirebaseError(new FirebaseUnavailableError('app/network-error')), true);
    assert.equal(isFirebaseError(new FirebaseNotConfigured()), true);
    assert.equal(isFirebaseError(new FirebaseTokenError('auth/id-token-expired')), true);
    assert.equal(isFirebaseError(new Error('nope')), false);
    assert.equal(isFirebaseError(null), false);
  });

  it('FIREBASE_UNAVAILABLE is namespaced and is not a session-loss code', () => {
    assert.equal(FIREBASE_UNAVAILABLE, 'FIREBASE_UNAVAILABLE');
    for (const code of [FIREBASE_UNAVAILABLE, FIREBASE_TOKEN_INVALID, FIREBASE_NOT_CONFIGURED]) {
      assert.ok(
        !['AUTH_REQUIRED', 'INVALID_TOKEN', 'SESSION_REVOKED', 'SESSION_INVALIDATED'].includes(code),
        `${code} must never be mistakable for a session code`
      );
    }
    // The three are distinct from one another.
    assert.equal(new Set([FIREBASE_UNAVAILABLE, FIREBASE_TOKEN_INVALID, FIREBASE_NOT_CONFIGURED]).size, 3);
  });

  it('carries a code and reason, and NO HTTP status (the controller owns the status)', () => {
    const err = new FirebaseUnavailableError('app/network-error');
    assert.equal(err.status, undefined);
    assert.equal(err.code, FIREBASE_UNAVAILABLE);
    assert.equal(err.reason, 'app/network-error');
  });
});

// ===========================================================================
// Unit — source guards (the properties that must not silently regress)
// ===========================================================================

unitSuite('AUTH-01 — source guards', () => {
  const tokenVerifierSource = fs.readFileSync(
    path.join(SRC_DIR, 'services/firebase/tokenVerifier.ts'),
    'utf8'
  );

  it('★ calls verifyIdToken with checkRevoked TRUE, and never false', () => {
    assert.ok(
      tokenVerifierSource.includes('verifyIdToken(idToken, /* checkRevoked */ true)'),
      'the real verifier must enable revocation checking'
    );
    assert.ok(
      !/verifyIdToken\([^)]*\/\*\s*checkRevoked\s*\*\/\s*false/.test(tokenVerifierSource),
      'checkRevoked must not have returned to false'
    );
  });

  it('★ runs the structural guard BEFORE initializing the Admin app', () => {
    const guardAt = tokenVerifierSource.indexOf('isStructurallyJwtShaped(idToken)');
    const appAt = tokenVerifierSource.indexOf('getFirebaseAdminApp()');
    assert.ok(guardAt !== -1, 'the structural guard must be present');
    assert.ok(appAt !== -1, 'the Admin app build must be present');
    assert.ok(guardAt < appAt, 'a malformed value must be rejected before any credential is built');
  });

  it('★ allows revokeRefreshTokens() at exactly ONE site, and no other', () => {
    // THE RULE, RESTATED RATHER THAN WEAKENED (AUTH-06, 2026-10-20).
    //
    // It used to say "nowhere in server/src", because the approved password-change flow of
    // the time did not need it and an appearance would have been an unapproved change. The
    // risk it was guarding is specific: calling `revokeRefreshTokens()` as a way to CHECK
    // whether a credential is still good, which would revoke every valid session on every
    // request. AUTH-01 answered that with `checkRevoked: true` instead, and that answer stands
    // — nothing in the verification path may call this.
    //
    // AUTH-06 introduces the one case where revoking is the POINT: after a password reset the
    // server has already ended every Inventory AI session, and a Firebase refresh token that
    // survived would mint a fresh ID token which the exchange would turn back into a session,
    // undoing the reset. So the call is permitted in exactly one file — the Admin bridge — and
    // this assertion is a one-element ALLOW-LIST rather than a ban: a second site, a call in
    // the verifier, or the same call moved into a route fails here.
    const ALLOWED = ['src\\services\\firebase\\passwordUpdater.ts'];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js)$/.test(entry.name)) {
          if (fs.readFileSync(full, 'utf8').includes('revokeRefreshTokens')) {
            offenders.push(path.relative(SERVER_ROOT, full));
          }
        }
      }
    };
    walk(SRC_DIR);
    assert.deepEqual(
      offenders.map((file) => file.split(path.sep).join('/')),
      ALLOWED.map((file) => file.split('\\').join('/')),
      'revokeRefreshTokens() is permitted at exactly one site — the Admin credential bridge — ' +
        'and nowhere else; a second site needs its own argument here'
    );
  });

  it('★ the installed firebase-admin version matches the classifier assumption', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SERVER_ROOT, 'node_modules/firebase-admin/package.json'), 'utf8')
    );
    assert.equal(
      pkg.version,
      VERIFIED_FIREBASE_ADMIN_VERSION,
      `the error classifier was derived from firebase-admin ${VERIFIED_FIREBASE_ADMIN_VERSION}; ` +
        `installed is ${pkg.version}. Re-derive the code lists before trusting the classification.`
    );
  });
});

// ===========================================================================
// DB-backed — the HTTP contract
// ===========================================================================

const dbOk = await ensureDb();

/** Limiters opened wide so no case can trip one. */
const UNCAPPED = {
  firebaseExchangeMax: 100000,
  firebaseRegisterMax: 100000,
  registerMax: 100000,
  loginMax: 100000,
  loginIpMax: 100000,
};

/** Starts the app on an ephemeral port and returns a fetch wrapper + closer. */
async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    api: async (method, path, { token, body } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Installs a verifier that throws `error`, simulating a real-path outcome. */
function installThrowingVerifier(error) {
  setFirebaseIdTokenVerifier(async () => {
    throw error;
  });
}

dbSuite('AUTH-01 — the Firebase failure contract over HTTP', dbOk, () => {
  const tracker = createTracker(dbOk);
  let app = null;

  before(async () => {
    app = await listen(createApp({ requestLogging: false, authLimits: UNCAPPED }));
  });

  after(async () => {
    resetFirebaseIdTokenVerifier();
    if (app) await app.close();
    await tracker.cleanup();
    await disconnectDb();
  });

  async function makeCaller() {
    const business = await Business.create({ name: uniqueName('BizAuth01') });
    tracker.trackBusiness(String(business._id));
    const user = await User.create({
      businessId: business._id,
      name: uniqueName('UAuth01'),
      email: uniqueEmail('uauth01'),
      role: 'OWNER',
      status: 'ACTIVE',
    });
    tracker.trackUser(String(user._id));
    const token = await issueSessionToken(user._id);
    return { business, user, token };
  }

  // -- public exchange -------------------------------------------------------

  it('a transient verification failure answers 503 FIREBASE_UNAVAILABLE', async () => {
    installThrowingVerifier(new FirebaseUnavailableError('app/network-error'));
    const res = await app.api('POST', EXCHANGE, { body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(res.json.code, FIREBASE_UNAVAILABLE);
  });

  it('★ an unknown-code transient failure ALSO answers 503 (not a rejected credential)', async () => {
    installThrowingVerifier(new FirebaseUnavailableError('some-future-code'));
    const res = await app.api('POST', EXCHANGE, { body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 503);
    assert.equal(res.json.code, FIREBASE_UNAVAILABLE);
  });

  it('a terminal token failure still answers 401 FIREBASE_TOKEN_INVALID', async () => {
    installThrowingVerifier(new FirebaseTokenError('auth/id-token-expired'));
    const res = await app.api('POST', EXCHANGE, { body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, FIREBASE_TOKEN_INVALID);
  });

  it('an operator configuration failure answers 503 FIREBASE_NOT_CONFIGURED (distinct code)', async () => {
    installThrowingVerifier(new FirebaseNotConfigured());
    const res = await app.api('POST', EXCHANGE, { body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 503);
    assert.equal(res.json.code, FIREBASE_NOT_CONFIGURED);
    assert.notEqual(res.json.code, FIREBASE_UNAVAILABLE);
  });

  // -- authenticated route ---------------------------------------------------

  it('★ an authenticated route does NOT rewrite the transient 503 into its 400 token mapping', async () => {
    const { token } = await makeCaller();
    installThrowingVerifier(new FirebaseUnavailableError('auth/argument-error'));

    const res = await app.api('POST', LINK, { token, body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 503, `expected 503, got ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.code, FIREBASE_UNAVAILABLE);

    // §19/§35: the caller's session survives the outage.
    const me = await app.api('GET', ME, { token });
    assert.equal(me.status, 200, 'a transient Firebase failure must not end the application session');
  });

  it('an authenticated route still answers 400 for a terminal token failure', async () => {
    const { token } = await makeCaller();
    installThrowingVerifier(new FirebaseTokenError('auth/id-token-revoked'));
    const res = await app.api('POST', LINK, { token, body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, FIREBASE_TOKEN_INVALID);
  });
});
