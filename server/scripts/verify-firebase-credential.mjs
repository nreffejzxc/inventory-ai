// `npm run verify:firebase` — will Google accept the service-account credential this environment holds?
//
// WHY THIS EXISTS. On 2026-11-07 production sign-in answered
//   503 FIREBASE_UNAVAILABLE — "We could not verify your sign-in right now."
// for every real user while `/api/health` stayed green and a malformed-token probe still answered 401.
// The credential parsed, so the boot check passed; it was simply not a key Google recognised, and
// nothing asked Google before a user did. This is that one question, asked cheaply.
//
// WHAT IT DOES. Builds the same RS256 assertion the Admin SDK builds — the service account asserting
// its own identity to Google's token endpoint — and sends exactly ONE request. No user, no database,
// no Firebase user lookup, no quota spent.
//
// EXIT CODES — kept apart so a pipeline cannot read "could not check" as "checked and fine":
//
//   0  VERIFIED      Google issued an access token: the credential is live
//   1  FAILED        Google rejected it (invalid_grant): deleted, revoked, or not this account's key
//   2  NOT VERIFIED  not configured here, or Google could not be reached — nothing was proven
//
// It never prints the key. Only the source form, project id, client email, key length and Google's own
// error code/description are shown; those name the credential without containing it.

import 'dotenv/config';

import { createPrivateKey, sign } from 'node:crypto';

import { firebaseConfig, serviceAccountProblems } from '../src/config/firebase.ts';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TIMEOUT_MS = 15000;

function line(label, value) {
  console.log(`[firebase:verify] ${label.padEnd(11)}: ${value}`);
}

const problems = serviceAccountProblems();
const config = firebaseConfig();

if (problems.length > 0) {
  line('config', `INVALID — ${problems.map((problem) => problem.variable).join(', ')}`);
  console.error('[firebase:verify] NOT VERIFIED — fix the variable(s) above; nothing was sent to Google.');
  process.exit(2);
}

if (config.source === 'none') {
  line('config', 'not configured in this environment');
  console.error('[firebase:verify] NOT VERIFIED — there is no credential to check.');
  process.exit(2);
}

line('source', config.source);
line('project', config.projectId);
line('client', config.clientEmail);
line('key length', `${config.privateKey.length} characters`);

const b64u = (value) => Buffer.from(value).toString('base64url');
const issuedAt = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT' };
const claims = {
  iss: config.clientEmail,
  scope: SCOPE,
  aud: TOKEN_URI,
  iat: issuedAt,
  exp: issuedAt + 3600,
};
const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;

let assertion;
try {
  const key = createPrivateKey({ key: config.privateKey });
  assertion = `${signingInput}.${b64u(sign('RSA-SHA256', Buffer.from(signingInput), key))}`;
} catch {
  // The underlying error can quote the material it rejected, so it is not relayed.
  console.error(
    '[firebase:verify] FAILED — the private key is not a usable PEM (BEGIN/END lines and body required).'
  );
  process.exit(1);
}

let response;
try {
  response = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (error) {
  console.error(
    `[firebase:verify] NOT VERIFIED — Google could not be reached (${error.name}); nothing was proven.`
  );
  process.exit(2);
}

const body = await response.json().catch(() => ({}));

if (response.ok && typeof body.access_token === 'string' && body.access_token.length > 0) {
  console.log('[firebase:verify] VERIFIED — Google issued an access token, so this credential is live.');
  process.exit(0);
}

if (body.error === 'invalid_grant') {
  line(
    'google',
    `${response.status} ${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
  );
  console.error('[firebase:verify] FAILED — Google rejected this key. Create a new key and replace the value.');
  process.exit(1);
}

line('google', `${response.status} ${body.error || 'unexpected response'}`);
console.error('[firebase:verify] NOT VERIFIED — the credential was neither accepted nor clearly rejected.');
process.exit(2);
