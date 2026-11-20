// AUTH-03 — Inventory session renewal.
//
// THE PHASE'S LOAD-BEARING PROPERTIES, and why each has a test here:
//
//   * The renewed JWT names the EXISTING session. Same `_id`, same `jti`,
//     byte-identical `expiresAt`, no new row, no audit row. This is what makes
//     "renew the token" different from "renew the session", and it is asserted on
//     the document rather than inferred from a 200.
//   * The 14-day ABSOLUTE cap is not extended. Enforcement is structural: a
//     session past its cap is already dead at requireAuth, so renewal is
//     unreachable — asserted with a past-dated session.
//   * Firebase ID-token verification still uses the AUTH-01 boundary with
//     `checkRevoked: true`. Asserted as a source guard, and the renewal service
//     is shown to reach that boundary.
//   * Firebase UID is the ONLY identity match. A mismatched uid is refused with
//     409 FIREBASE_IDENTITY_CONFLICT; the email is never consulted.
//   * Email verification is required at renewal. An unverified claim is refused
//     with 400 EMAIL_NOT_VERIFIED and no new token.
//   * The new token's `exp` is strictly later than the old token's, and the
//     session cap is independent and unchanged.
//   * The response carries `expiresIn` (retained), `tokenExpiresAt` (exact new
//     `exp`) and `sessionExpiresAt` (the authoritative cap).
//   * The limiter answers 429 SESSION_RENEW_RATE_LIMITED with a Retry-After.
//   * The JWT claims are exactly sub/jti/iat/exp/iss/aud — no role, businessId or
//     permission — and no custom refresh token or new durable state exists.
//
// Registered MIXED in run-tests.mjs: the source guards run without a database and
// the behavioural cases need MongoDB. The verifier is the Phase 32B fake installed
// through the REAL seam, so the narrowing runs exactly as in production; no case
// reaches the network and no Firebase project exists.

import 'dotenv/config';

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

import { ensureDb, disconnectDb } from './helpers.mjs';
import { createTracker, uniqueEmail, uniqueName } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';

import { createApp } from '../src/app.ts';
import Business from '../src/models/business.model.ts';
import User from '../src/models/user.model.ts';
import Session from '../src/models/session.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import env from '../src/config/env.ts';
import { decodeAccessToken } from '../src/config/jwt.ts';
import { newSessionId, SESSION_ABSOLUTE_CAP_MS } from '../src/services/session.service.ts';
import {
  registerFakeFirebaseVerifier,
  deregisterFakeFirebaseVerifier,
  setFakeFirebaseToken,
} from './fakes/firebaseVerifier.mjs';

const RENEW = '/api/auth/renew';
const ID_TOKEN = 'auth03.fake.id-token-that-the-seam-replaces';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const readSrc = (relative) => readFileSync(join(SRC, relative), 'utf8');

/** Starts an app on an ephemeral port and returns a closer + a fetch wrapper. */
async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
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
      return { status: res.status, json, headers: res.headers };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Limiters opened wide, so the behavioural cases cannot trip one. */
const UNCAPPED = {
  renewMax: 100000,
  firebaseExchangeMax: 100000,
  firebaseRegisterMax: 100000,
  registerMax: 100000,
  loginMax: 100000,
  loginIpMax: 100000,
};

/**
 * A token signed with the REAL contract but a SHORTER lifetime, so its `exp` is
 * deterministically earlier than a renewal's. Needed because `signAccessToken`
 * would mint the fixture and the renewal in the same wall-clock second, giving
 * identical `iat`/`exp` and making "strictly later" untestable.
 */
function signOlderToken(userId, jti, seconds = 1800) {
  return jwt.sign({ sub: String(userId), jti }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: seconds,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  });
}

// ===========================================================================
// DB-free: the structural invariants and security guards
// ===========================================================================

unitSuite('AUTH-03 — renewal structure and guards (no database)', () => {
  const renewSrc = readSrc('services/sessionRenew.service.ts');
  const exchangeSrc = readSrc('services/firebaseAuth.service.ts');
  const verifierSrc = readSrc('services/firebase/tokenVerifier.ts');
  const middlewareSrc = readSrc('middlewares/authenticate.ts');
  const routesSrc = readSrc('routes/auth.routes.ts');

  it('★ the renewal service never creates a session, a jti, or an audit row', () => {
    // These are the three calls that would turn "renew the token" into "renew the
    // session". Their absence is the invariant.
    assert.equal(
      renewSrc.includes('createSessionForToken('),
      false,
      'renewal must not create a session row'
    );
    assert.equal(renewSrc.includes('newSessionId('), false, 'renewal must not mint a jti');
    assert.equal(renewSrc.includes('recordAudit('), false, 'renewal must not write an audit row');
  });

  it('★ the renewal service never writes session.expiresAt', () => {
    // The cap is anchored at creation. No update, $set, or field write to the
    // session may exist on this path.
    assert.equal(/expiresAt\s*[:=]/.test(renewSrc), false, 'expiresAt is never assigned here');
    assert.equal(renewSrc.includes('updateOne('), false, 'no session update exists here');
    assert.equal(renewSrc.includes('updateMany('), false, 'no session update exists here');
  });

  it('★ renewal signs with the EXISTING jti (same-jti session)', () => {
    // The primitive that makes the JWT name the same session: signAccessToken is
    // called with the caller-supplied `jti` argument, not a freshly minted one.
    assert.ok(
      /signAccessToken\(user\._id,\s*jti\)/.test(renewSrc),
      'signAccessToken must receive the passed-in jti'
    );
    assert.ok(
      renewSrc.includes('findActiveSessionByJti(jti)'),
      'the authoritative session is looked up by the authenticated jti'
    );
  });

  it('★ Firebase verification still uses the AUTH-01 boundary (checkRevoked)', () => {
    assert.ok(
      renewSrc.includes('verifyFirebaseIdToken'),
      'renewal reaches the single verify boundary'
    );
    assert.ok(
      /verifyIdToken\(\s*idToken\s*,\s*\/\*\s*checkRevoked\s*\*\/\s*true\s*\)/.test(verifierSrc),
      'checkRevoked remains true (AUTH-01 — do not change)'
    );
  });

  it('★ the identity match is UID-only, and the FULL predicate is pinned — the email is never a join key', () => {
    // The WHOLE predicate, disjunct included — not just its comparison half.
    // `!user.firebaseUid` is the "this account carries no Firebase authority at all"
    // half, and it is the input the DB suite now exercises (case 8b). An assertion on
    // `user.firebaseUid !== identity.uid` alone still passes when that disjunct is
    // deleted, which is exactly how this guard used to be written.
    assert.ok(
      renewSrc.includes('!user.firebaseUid || user.firebaseUid !== identity.uid'),
      'the full identity predicate is not pinned'
    );
    // WHY the equality half happens to refuse an absent uid today, stated so the
    // disjunct is not mistaken for the only defence: the AUTH-01 verifier REJECTS a
    // token whose uid is missing or empty, so `identity.uid` is always a non-empty
    // string by the time this predicate runs.
    assert.ok(
      verifierSrc.includes('if (!uid) {') &&
        verifierSrc.includes("throw new FirebaseTokenError('missing-uid')"),
      'a token with no usable uid must be rejected before the renewal predicate runs'
    );
    // The exchange could not be reached by email even if someone tried: the
    // renewal service never queries by email.
    assert.equal(renewSrc.includes('findOne({ email'), false, 'no lookup by email exists');
  });

  it('★ the exchange carries the verification gate and the locked code', () => {
    const exchangeStart = exchangeSrc.indexOf('export async function exchangeFirebaseSession');
    const exchangeBody = exchangeSrc.slice(exchangeStart);
    assert.ok(
      exchangeBody.includes('identity.emailVerified !== true'),
      'the exchange enforces verification (AUTH-03 decision 10)'
    );
    assert.ok(exchangeBody.includes('EMAIL_NOT_VERIFIED'), 'the locked code is used');
  });

  it('★ requireAuth is untouched — no verification branch (AUTH-03 decision 13)', () => {
    assert.equal(
      /emailVerified/.test(middlewareSrc),
      false,
      'a live session is never retroactively terminated by the claim'
    );
  });

  it('★ the route is renewal-authentication → limiter → controller', () => {
    const line = routesSrc.split('\n').find((l) => l.includes("'/renew'"));
    assert.ok(line, 'the /renew route is mounted');
    assert.ok(
      /requireAuthForRenewal,\s*createSessionRenewLimiter\(limits\),\s*renew/.test(line),
      `unexpected /renew middleware order: ${line}`
    );
  });

  /**
   * THE DEFECT THIS PINS (found and fixed 2026-10-22).
   *
   * `/renew` used to be behind plain `requireAuth`. The client calls renewal in two
   * situations — proactively, while the token is still valid, and as RECOVERY, with the
   * token that was just refused `SESSION_EXPIRED`. The second call was refused by the
   * same middleware before the handler ran, so recovery could never succeed and a live
   * 14-day session whose ~1h token had expired demanded a fresh sign-in. That was
   * measured on a phone, not inferred.
   */
  it('★ /renew relaxes EXPIRY only, and no other route may use that middleware', () => {
    const renewalRoutes = routesSrc
      .split('\n')
      .filter((line) => /router\.(get|post|patch|put|delete)\(/.test(line))
      .filter((line) => line.includes('requireAuthForRenewal'));

    assert.equal(renewalRoutes.length, 1, 'the expiry-relaxing middleware is mounted once');
    assert.ok(renewalRoutes[0].includes("'/renew'"), 'it is the /renew route');
    assert.ok(
      !/requireAuth,\s*createSessionRenewLimiter/.test(renewalRoutes[0]),
      'plain requireAuth would refuse the token renewal exists to replace'
    );

    // A source guard that cannot fail is decoration: putting plain `requireAuth` back on
    // the route (the defect) must trip the assertion that rejects it.
    const revertedRoute = renewalRoutes[0].replace('requireAuthForRenewal', 'requireAuth');
    assert.ok(
      /requireAuth,\s*createSessionRenewLimiter/.test(revertedRoute),
      'control: the reverted middleware is what the assertion above refuses'
    );

    const body = middlewareSrc.slice(
      middlewareSrc.indexOf('async function authenticate('),
      middlewareSrc.indexOf('export default requireAuth;'),
    );
    // The one relaxation, stated positively…
    assert.match(
      body,
      /options\.allowExpired \? verifyAccessTokenIgnoringExpiry\(token\) : verifyAccessToken\(token\)/,
      'expiry is the only thing relaxed, and only when asked for'
    );
    // …and the checks that must survive it, named so a refactor cannot drop one quietly.
    for (const check of [
      "typeof jti !== 'string'",
      'findActiveSessionByJti(jti)',
      'passwordChangedAt',
      "user.status !== 'ACTIVE'",
      'assertActiveBusiness(user.businessId)',
    ]) {
      assert.ok(body.includes(check), `the shared body still enforces ${check}`);
    }
  });

  it('★ no custom refresh token or new durable auth state is introduced', () => {
    assert.equal(
      /refreshToken/i.test(renewSrc),
      false,
      'the service references no refresh token'
    );
  });

  it('★ the guards themselves can fail (mutation sensitivity)', () => {
    // A guard that cannot be shown to fail is not a guard. Each assertion above is
    // re-run here against a deliberately mutated copy, so sensitivity is proven
    // rather than assumed.
    const mutated = renewSrc.replace('signAccessToken(user._id, jti)', 'signAccessToken(user._id, newSessionId())');
    assert.ok(
      !/signAccessToken\(user\._id,\s*jti\)/.test(mutated),
      'the same-jti guard is sensitive to a mutated signing call'
    );
    const withAudit = renewSrc + '\nawait recordAudit({});\n';
    assert.equal(
      withAudit.includes('recordAudit('),
      true,
      'the no-audit guard is sensitive to an injected audit write'
    );

    // The identity predicate, mutated the way it could actually regress. Removing the
    // `!user.firebaseUid` disjunct ALONE leaves a service whose equality half still
    // refuses an absent uid (see the verifier narrowing asserted above), so the mutant
    // is behaviourally equivalent — but the substring-only guard this suite used to
    // carry passed on it, while the full-predicate guard does not. That is the whole
    // reason the disjunct is pinned.
    const withoutNullDisjunct = renewSrc.replace('!user.firebaseUid || ', '');
    assert.equal(
      withoutNullDisjunct.includes('!user.firebaseUid || user.firebaseUid !== identity.uid'),
      false,
      'the full-predicate guard is sensitive to a removed null disjunct'
    );
    assert.ok(
      withoutNullDisjunct.includes('user.firebaseUid !== identity.uid'),
      'the mutant still contains the comparison, so only the full predicate catches it'
    );

    // And the mutant that neuters the null REFUSAL instead of deleting the disjunct —
    // the behavioural mutation DB case 8b observes, where an account with no Firebase
    // authority would be renewed rather than refused. It fails the same assertion.
    const neutered = renewSrc.replace(
      '!user.firebaseUid || user.firebaseUid !== identity.uid',
      'user.firebaseUid && user.firebaseUid !== identity.uid'
    );
    assert.equal(
      neutered.includes('!user.firebaseUid || user.firebaseUid !== identity.uid'),
      false,
      'the full-predicate guard is sensitive to a neutered null refusal'
    );
  });
});

// ===========================================================================
// DB-backed: the behaviour over HTTP
// ===========================================================================

const dbOk = await ensureDb();

dbSuite('AUTH-03 — session renewal over HTTP', dbOk, () => {
  const tracker = createTracker(dbOk);
  let app = null;
  let tightApp = null;

  const uid = (prefix = 'a03') => uniqueName(prefix);

  async function makeBusiness({ status = 'ACTIVE' } = {}) {
    const business = await Business.create({ name: uniqueName('BizA03'), status });
    tracker.trackBusiness(String(business._id));
    return business;
  }

  async function makeUser({
    business,
    role = 'MANAGER',
    status = 'ACTIVE',
    firebaseUid = null,
    email = null,
    emailVerified = true,
  } = {}) {
    const biz = business ?? (await makeBusiness());
    const user = await User.create({
      businessId: biz._id,
      name: uniqueName('U03'),
      email: email ?? uniqueEmail('u03'),
      ...(firebaseUid ? { firebaseUid } : {}),
      emailVerified,
      role,
      status,
    });
    tracker.trackUser(String(user._id));
    return user;
  }

  /**
   * A live session for `user`, plus a token naming it. `expiresAt` is
   * overridable so the near-cap and past-cap cases can be expressed directly.
   */
  async function sessionFor(user, { ttlSeconds = 1800, capMs = SESSION_ABSOLUTE_CAP_MS } = {}) {
    const jti = newSessionId();
    const token = signOlderToken(user._id, jti, ttlSeconds);
    const expiresAt = new Date(Date.now() + capMs);
    const session = await Session.create({ userId: user._id, jti, expiresAt });
    return { token, jti, session };
  }

  const renew = (token) => app.api('POST', RENEW, { token, body: { idToken: ID_TOKEN } });

  before(async () => {
    registerFakeFirebaseVerifier();
    app = await listen(createApp({ requestLogging: false, authLimits: UNCAPPED }));
    // A second app whose renewal limiter is one attempt per minute, so the 429
    // case is deterministic without affecting the other cases.
    tightApp = await listen(
      createApp({
        requestLogging: false,
        authLimits: { ...UNCAPPED, renewMax: 1, renewWindowMs: 60_000 },
      })
    );
  });

  after(async () => {
    deregisterFakeFirebaseVerifier();
    if (app) await app.close();
    if (tightApp) await tightApp.close();
    await tracker.cleanup();
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  // The happy path and the same-session invariant
  // -------------------------------------------------------------------------

  it('1. ★★ renewal re-issues a token for the SAME session: same _id, same jti, byte-identical expiresAt', async () => {
    const user = await makeUser({ firebaseUid: uid('happy') });
    const { token, jti, session } = await sessionFor(user);
    const expiresBefore = session.expiresAt.toISOString();

    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });
    const res = await renew(token);

    assert.equal(res.status, 200, JSON.stringify(res.json));

    const claims = decodeAccessToken(res.json.token);
    assert.equal(claims.jti, jti, 'the new token names the SAME jti');
    assert.equal(claims.sub, String(user._id));

    const after = await Session.findById(session._id);
    assert.ok(after, 'the same session row still exists');
    assert.equal(String(after._id), String(session._id), 'same _id');
    assert.equal(after.jti, jti, 'same jti on the row');
    assert.equal(after.expiresAt.toISOString(), expiresBefore, 'expiresAt is byte-identical');
    assert.equal(await Session.countDocuments({ userId: user._id }), 1, 'no session was created');
  });

  it('2. ★ no audit row is written for a renewal', async () => {
    const user = await makeUser({ firebaseUid: uid('audit') });
    const { token } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const before = await AuditLog.countDocuments({ userId: user._id });
    const res = await renew(token);
    const after = await AuditLog.countDocuments({ userId: user._id });

    assert.equal(res.status, 200);
    assert.equal(after, before, 'renewal wrote no audit row');
  });

  it('3. ★ the expiry contract: expiresIn retained, exact tokenExpiresAt, authoritative sessionExpiresAt', async () => {
    const user = await makeUser({ firebaseUid: uid('expiry') });
    const { token, session } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);

    assert.equal(res.status, 200);
    assert.equal(res.json.expiresIn, env.jwtExpiresIn, 'expiresIn is retained unchanged');
    const claims = decodeAccessToken(res.json.token);
    assert.equal(
      res.json.tokenExpiresAt,
      new Date(claims.exp * 1000).toISOString(),
      'tokenExpiresAt is the exact exp of the new token'
    );
    assert.equal(
      new Date(res.json.sessionExpiresAt).toISOString(),
      session.expiresAt.toISOString(),
      'sessionExpiresAt is the authoritative session cap'
    );
  });

  it('4. ★ the new token exp is STRICTLY later than the old, and the cap is unchanged', async () => {
    const user = await makeUser({ firebaseUid: uid('later') });
    const { token, session } = await sessionFor(user);
    const capBefore = session.expiresAt.toISOString();
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);

    const oldExp = decodeAccessToken(token).exp;
    const newExp = decodeAccessToken(res.json.token).exp;
    assert.ok(newExp > oldExp, `new exp ${newExp} must be strictly later than ${oldExp}`);

    const after = await Session.findById(session._id);
    assert.equal(after.expiresAt.toISOString(), capBefore, 'the session cap did not move');
  });

  it('5. ★ the JWT claims are exactly sub/jti/iat/exp/iss/aud', async () => {
    const user = await makeUser({ firebaseUid: uid('claims') });
    const { token } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);
    const claims = Object.keys(decodeAccessToken(res.json.token)).sort();

    assert.deepEqual(claims, ['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    assert.equal(res.json.refreshToken, undefined, 'no refresh token is returned');
  });

  it('6. ★ near-cap renewal: session still active, same jti/_id, cap unmoved, token may outlive it', async () => {
    // The 14-day boundary is the interesting case: the session is about to die, so
    // renewal must still succeed while it is live, must NOT extend the cap, and the
    // freshly issued ~1h token legitimately outlives the session. The client's
    // horizon is the MINIMUM of the two, which is why the response states both.
    const user = await makeUser({ firebaseUid: uid('nearcap') });
    const { token, jti, session } = await sessionFor(user, { capMs: 2 * 60 * 1000 });
    const capBefore = session.expiresAt.toISOString();
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);

    assert.equal(res.status, 200, 'renewal succeeds while the session is still active');
    assert.equal(decodeAccessToken(res.json.token).jti, jti, 'same jti');

    const after = await Session.findById(session._id);
    assert.equal(String(after._id), String(session._id), 'same _id');
    assert.equal(after.expiresAt.toISOString(), capBefore, 'the near cap was NOT extended');
    assert.equal(
      new Date(res.json.sessionExpiresAt).toISOString(),
      capBefore,
      'the response reports the unmoved cap'
    );

    const tokenExp = new Date(res.json.tokenExpiresAt).getTime();
    const sessionExp = new Date(res.json.sessionExpiresAt).getTime();
    assert.ok(tokenExp > sessionExp, 'the new token outlives the near cap, so the horizon is the cap');
  });

  // -------------------------------------------------------------------------
  // The refusals
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // THE RECOVERY CASE (fixed 2026-10-22)
  // -------------------------------------------------------------------------

  /**
   * The client's second chance, exactly as `lib/client.ts` makes it: after a request is
   * refused `SESSION_EXPIRED`, renewal is called WITH THE EXPIRED TOKEN, once. Until
   * this fix the route sat behind plain `requireAuth` and answered the same refusal, so
   * the retry could never succeed and an idle app demanded a sign-in.
   */
  it('6a. ★★ an EXPIRED token for a LIVE session renews: the client\'s recovery path works', async () => {
    const user = await makeUser({ firebaseUid: uid('recover') });
    // exp is 90 seconds in the PAST — a token `requireAuth` would refuse.
    const { token, jti, session } = await sessionFor(user, { ttlSeconds: -90 });
    const capBefore = session.expiresAt.toISOString();
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);

    assert.equal(res.status, 200, JSON.stringify(res.json));
    const claims = decodeAccessToken(res.json.token);
    assert.equal(claims.jti, jti, 'the same session is named by the new token');
    assert.equal(claims.sub, String(user._id));
    assert.ok((claims.exp ?? 0) * 1000 > Date.now(), 'the new token is in the future');

    const after = await Session.findById(session._id);
    assert.equal(after.expiresAt.toISOString(), capBefore, 'the 14-day cap did not move');
    assert.equal(after.revokedAt, null);
    assert.equal(await Session.countDocuments({ userId: user._id }), 1, 'no session was created');
  });

  it('6b. ★ expired-but-live is NOT a general amnesty: every other rule still refuses', async () => {
    // (i) a REVOKED session, named by an expired token, is terminal.
    const revokedUser = await makeUser({ firebaseUid: uid('revoked') });
    const revoked = await sessionFor(revokedUser, { ttlSeconds: -90 });
    await Session.updateOne({ _id: revoked.session._id }, { revokedAt: new Date() });
    setFakeFirebaseToken({ uid: revokedUser.firebaseUid, email: revokedUser.email, email_verified: true });
    const revokedRes = await renew(revoked.token);
    assert.equal(revokedRes.status, 401);
    assert.equal(revokedRes.json.code, 'SESSION_REVOKED', 'session liveness is still required');

    // (ii) a token with a BAD SIGNATURE is not "expired" — only expiry was relaxed.
    const forgedUser = await makeUser({ firebaseUid: uid('forged') });
    const forged = await sessionFor(forgedUser, { ttlSeconds: -90 });
    const forgedToken = jwt.sign({ sub: String(forgedUser._id), jti: forged.jti }, 'not-the-secret', {
      algorithm: 'HS256',
      expiresIn: -90,
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    });
    setFakeFirebaseToken({ uid: forgedUser.firebaseUid, email: forgedUser.email, email_verified: true });
    const forgedRes = await renew(forgedToken);
    assert.equal(forgedRes.status, 401);
    assert.equal(forgedRes.json.code, 'INVALID_TOKEN');

    // (iii) the password-change rule still invalidates a token issued before the change.
    const changedUser = await makeUser({ firebaseUid: uid('changed') });
    const changed = await sessionFor(changedUser, { ttlSeconds: -90 });
    await User.updateOne(
      { _id: changedUser._id },
      { passwordChangedAt: new Date(Date.now() + 60_000) }
    );
    setFakeFirebaseToken({ uid: changedUser.firebaseUid, email: changedUser.email, email_verified: true });
    const changedRes = await renew(changed.token);
    assert.equal(changedRes.status, 401);
    assert.equal(changedRes.json.code, 'SESSION_INVALIDATED');
  });

  it('7. ★ a session past its 14-day cap cannot renew (structural enforcement)', async () => {
    const user = await makeUser({ firebaseUid: uid('capped') });
    const { token, session } = await sessionFor(user);
    // Expire the row AFTER it exists, so this case still starts from a real
    // session and the TTL monitor's later sweep is the only thing that can
    // remove it. `requireAuth` must refuse before the handler runs.
    await Session.updateOne(
      { _id: session._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const res = await renew(token);

    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'SESSION_REVOKED');
    // This row is intentionally past its cap and therefore TTL-eligible: a
    // re-read here is a race the full suite lost once. Case 6 already proves a
    // refused renewal cannot move a live cap. Remove the fixture explicitly so
    // it cannot leak into a later case, then assert the cleanup itself.
    await Session.deleteOne({ _id: session._id });
    assert.equal(await Session.countDocuments({ _id: session._id }), 0);
  });

  it('8. ★ a Firebase UID mismatch is refused with 409 FIREBASE_IDENTITY_CONFLICT', async () => {
    const user = await makeUser({ firebaseUid: uid('owneruid') });
    const { token, session } = await sessionFor(user);
    setFakeFirebaseToken({ uid: uid('intruder'), email: user.email, email_verified: true });

    const res = await renew(token);

    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'FIREBASE_IDENTITY_CONFLICT');
    // Nothing changed, and the email was never an input to the match.
    const after = await Session.findById(session._id);
    assert.equal(after.expiresAt.toISOString(), session.expiresAt.toISOString());
  });

  it('8b. ★ an account carrying NO Firebase identity takes the same refusal', async () => {
    // The `!user.firebaseUid` half of the renewal predicate — the one input this suite
    // did not exercise. `makeUser` omits the field entirely when no uid is given, so
    // this account carries no Firebase authority at all: it cannot satisfy "renew
    // through THIS Firebase identity", and it must be refused exactly as a mismatch is.
    // Modelled on case 8 above and on the N-4 bridge's case 3b.
    const user = await makeUser(); // legacy account: no firebaseUid at all
    const { token, session } = await sessionFor(user);

    // The presented identity's address IS this account's address, so a match on the
    // email could not rescue it — the email is not a join key here either.
    setFakeFirebaseToken({ uid: uid('nobody'), email: user.email, email_verified: true });
    const res = await renew(token);

    assert.equal(res.status, 409, 'refused at the identity boundary, not a session failure');
    assert.equal(res.json.code, 'FIREBASE_IDENTITY_CONFLICT');
    assert.equal(res.json.token, undefined, 'no token is issued');

    const after = await Session.findById(session._id);
    assert.equal(after.expiresAt.toISOString(), session.expiresAt.toISOString());
    assert.equal(after.revokedAt, null, 'the account keeps its live session');
    assert.equal(await Session.countDocuments({ userId: user._id }), 1, 'no session was created');

    // The identity boundary is reached BEFORE the verification gate: the same account is
    // answered the same way when the presented identity is UNVERIFIED. That is the
    // service's documented order (uid, then `emailVerified`) and it is what a predicate
    // that admitted an account with no Firebase authority would break.
    setFakeFirebaseToken({ uid: uid('nobody2'), email: user.email, email_verified: false });
    const unverified = await renew(token);

    assert.equal(unverified.status, 409, 'the identity check precedes the verification gate');
    assert.equal(unverified.json.code, 'FIREBASE_IDENTITY_CONFLICT');
    assert.notEqual(unverified.json.code, 'EMAIL_NOT_VERIFIED');
  });

  it('9. ★ an UNVERIFIED email is refused with 400 EMAIL_NOT_VERIFIED', async () => {
    const user = await makeUser({ firebaseUid: uid('unverified'), emailVerified: false });
    const { token } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: false });

    const res = await renew(token);

    assert.equal(res.status, 400, 'a 4xx that is NOT the client session-loss 401/403');
    assert.equal(res.json.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(res.json.token, undefined, 'no token was issued');
  });

  it('10. ★ a rejected Firebase token is a 400, not a 401 (no accidental sign-out)', async () => {
    const user = await makeUser({ firebaseUid: uid('badtoken') });
    const { token } = await sessionFor(user);
    // The fake throws FirebaseTokenError for any token.
    const { setFakeFirebaseFailure } = await import('./fakes/firebaseVerifier.mjs');
    setFakeFirebaseFailure('auth/id-token-expired');

    const res = await renew(token);

    assert.equal(res.status, 400, 'a bad Firebase credential must not read as session loss');
    assert.equal(res.json.code, 'FIREBASE_TOKEN_INVALID');

    // Restore the happy path for any later case in this file.
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });
  });

  it('11. an unauthenticated request is refused 401 before any Firebase work', async () => {
    const res = await app.api('POST', RENEW, { body: { idToken: ID_TOKEN } });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'AUTH_REQUIRED');
  });

  it('12. a body with no idToken is a 400 VALIDATION_ERROR', async () => {
    const user = await makeUser({ firebaseUid: uid('nobody') });
    const { token } = await sessionFor(user);

    const res = await app.api('POST', RENEW, { token, body: {} });

    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // The limiter
  // -------------------------------------------------------------------------

  it('13. ★★ the second renewal in-window is 429 SESSION_RENEW_RATE_LIMITED with a Retry-After', async () => {
    const user = await makeUser({ firebaseUid: uid('limited') });
    const { token } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    const first = await tightApp.api('POST', RENEW, { token, body: { idToken: ID_TOKEN } });
    const second = await tightApp.api('POST', RENEW, { token, body: { idToken: ID_TOKEN } });

    assert.equal(first.status, 200, 'the first attempt is admitted');
    assert.equal(second.status, 429, 'the limit is one per window on this app');
    assert.equal(second.json.code, 'SESSION_RENEW_RATE_LIMITED');
    assert.ok(second.headers.get('retry-after'), 'Retry-After is present');
  });

  it('14. ★ a 429 is not a 401/403, so the client must treat it as transient', async () => {
    // Asserted from the response itself: the status is 429 and the code is the
    // renewal-specific one, so no session-loss rule keyed on 401/403 can fire.
    const user = await makeUser({ firebaseUid: uid('transient') });
    const { token } = await sessionFor(user);
    setFakeFirebaseToken({ uid: user.firebaseUid, email: user.email, email_verified: true });

    await tightApp.api('POST', RENEW, { token, body: { idToken: ID_TOKEN } });
    const res = await tightApp.api('POST', RENEW, { token, body: { idToken: ID_TOKEN } });

    assert.equal(res.status, 429);
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
  });
});
