// `npm run access:check` — report whether each service the project uses can be reached.
//
// WHY THIS EXISTS. Configuration drift is invisible until something breaks: a rotated key, an expired
// CLI session, a renamed project. Every check here is READ-ONLY and prints a STATUS, never a value —
// no key, token, password, connection string or MFA code ever reaches the output, a log or the shell
// history. It is safe to paste its output into an issue.
//
// WHERE CREDENTIALS LIVE. Never in this repository, never in chat. `server/.env` (untracked) holds the
// service keys the server already reads, and each CLI keeps its own session in the operating system
// keyring. See docs/AGENT_ACCESS.md for the full matrix.
//
// EXIT CODES
//   0  every configured service answered
//   1  a configured service failed (its line says which and why, safely)
//   2  nothing was configured to check
import { createPrivateKey, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, '..', 'server');
const requireFromServer = createRequire(join(serverDir, 'package.json'));

// Load server/.env without exporting anything to the parent shell.
try {
  requireFromServer('dotenv').config({ path: join(serverDir, '.env'), quiet: true });
} catch {
  // dotenv is a server dependency; if it is absent the environment may still supply the values.
}

const results = [];
const record = (service, status, detail) => results.push({ service, status, detail });

/** A configured value is present when the variable is set to something. Never printed. */
const has = (name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

async function checkCli(service, command, args, okDetail) {
  try {
    // Windows installs global CLIs as .cmd shims that execFile cannot launch without a shell. The
    // command and arguments here are fixed string literals, never assembled from input.
    const { stdout } = await run([command, ...args].join(' '), {
      timeout: 20_000,
      windowsHide: true,
      shell: true,
    });
    const first = String(stdout).trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
    record(service, 'OK', okDetail(first));
  } catch (error) {
    const hint = error?.code === 'ENOENT' ? 'CLI not installed' : 'CLI not authenticated';
    record(service, 'FAIL', hint);
  }
}

async function main() {
  /* ---- CLIs that keep their own session ---- */
  await checkCli('GitHub', 'gh', ['auth', 'status'], (line) => {
    const account = line.match(/account\s+([^\s(]+)/)?.[1];
    return account ? `gh CLI session for ${account}` : 'gh CLI session';
  });
  await checkCli('Render', 'render', ['whoami'], (line) => {
    const name = line.match(/^Name:\s*(.+)$/)?.[1]?.trim();
    return name ? `render CLI session for ${name}` : 'render CLI session';
  });
  await checkCli('Expo / EAS', 'eas', ['whoami'], (line) =>
    line ? `eas CLI session for ${line.trim()}` : 'eas CLI session',
  );

  /* ---- MongoDB Atlas (read-only ping through the server's own driver) ---- */
  if (!has('MONGODB_URI')) {
    record('MongoDB Atlas', 'SKIP', 'MONGODB_URI is not set in server/.env');
  } else {
    try {
      const { MongoClient } = requireFromServer('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
      await client.connect();
      const dbName = process.env.MONGODB_DB_NAME || client.db().databaseName;
      const info = await client.db(dbName).command({ ping: 1 });
      await client.close();
      record('MongoDB Atlas', info?.ok === 1 ? 'OK' : 'FAIL', `connected to database "${dbName}" (read-only ping)`);
    } catch {
      record('MongoDB Atlas', 'FAIL', 'connection refused — check MONGODB_URI and the Atlas IP allowlist');
    }
  }

  /* ---- OpenRouter (read-only key lookup; spends nothing) ---- */
  if (!has('OPENROUTER_API_KEY')) {
    record('OpenRouter', 'SKIP', 'OPENROUTER_API_KEY is not set in server/.env');
  } else {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      const free = body?.data?.is_free_tier;
      record('OpenRouter', 'OK', `key accepted${free === true ? ' (free tier)' : free === false ? ' (paid credits)' : ''} — read-only lookup`);
    } catch (error) {
      const status = String(error?.message ?? '');
      record('OpenRouter', 'FAIL', status === '401' ? 'key rejected (401)' : 'request failed');
    }
  }

  /* ---- Brevo (read-only account read; sends nothing) ---- */
  if (!has('BREVO_API_KEY')) {
    record('Brevo', 'SKIP', 'BREVO_API_KEY is not set in server/.env');
  } else {
    try {
      const response = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      const plan = Array.isArray(body?.plan) ? body.plan.map((p) => p?.type).filter(Boolean).join('+') : '';
      record('Brevo', 'OK', `account read succeeded${plan ? ` (plan ${plan})` : ''} — no mail sent`);
    } catch (error) {
      const status = String(error?.message ?? '');
      record('Brevo', 'FAIL', status === '401' ? 'key rejected (401)' : 'request failed');
    }
  }

  /* ---- Firebase (one RS256 assertion to Google's token endpoint — no Admin SDK, no quota) ---- */
  if (!has('FIREBASE_SERVICE_ACCOUNT_JSON') && !(has('FIREBASE_PROJECT_ID') && has('FIREBASE_CLIENT_EMAIL') && has('FIREBASE_PRIVATE_KEY'))) {
    record('Firebase', 'SKIP', 'no service account in server/.env (FIREBASE_SERVICE_ACCOUNT_JSON or the three FIREBASE_* variables)');
  } else {
    try {
      const account = has('FIREBASE_SERVICE_ACCOUNT_JSON')
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        : {
            project_id: process.env.FIREBASE_PROJECT_ID,
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            private_key: process.env.FIREBASE_PRIVATE_KEY,
          };
      // server/src/config/firebase.ts accepts the JSON verbatim or with escaped newlines.
      const privateKey = String(account.private_key ?? '').replace(/\\n/g, '\n');
      const b64u = (value) => Buffer.from(value).toString('base64url');
      const iat = Math.floor(Date.now() / 1000);
      const signingInput = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(
        JSON.stringify({
          iss: account.client_email,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          aud: 'https://oauth2.googleapis.com/token',
          iat,
          exp: iat + 3600,
        }),
      )}`;
      const assertion = `${signingInput}.${b64u(
        sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey({ key: privateKey })),
      )}`;
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.access_token) {
        record('Firebase', 'OK', `Google issued a token for project "${account.project_id}" — credential is live`);
      } else if (body.error === 'invalid_grant') {
        record('Firebase', 'FAIL', 'Google rejected the key (invalid_grant) — deleted, revoked, or from another account');
      } else {
        record('Firebase', 'FAIL', `token endpoint answered ${response.status} ${body.error || ''}`.trim());
      }
    } catch {
      record('Firebase', 'FAIL', 'the private key is not a usable PEM, or Google was unreachable');
    }
  }

  /* ---- UptimeRobot (read-only account details) ---- */
  if (!has('UPTIMEROBOT_API_KEY')) {
    record('UptimeRobot', 'SKIP', 'UPTIMEROBOT_API_KEY is not set — add it to server/.env (read-only monitor key)');
  } else {
    try {
      const response = await fetch('https://api.uptimerobot.com/v2/getAccountDetails', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_key: process.env.UPTIMEROBOT_API_KEY, format: 'json' }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      if (body?.stat !== 'ok') throw new Error('refused');
      record('UptimeRobot', 'OK', `monitor account read (${body?.account?.monitor_limit ?? '?'} monitor limit)`);
    } catch {
      record('UptimeRobot', 'FAIL', 'key rejected — use a read-only monitor key');
    }
  }

  /* ---- Gmail (presence only: an IMAP password must never be sent to a model or a log) ---- */
  const gmailNames = Object.keys(process.env).filter((name) => /^GMAIL_[A-Z0-9_]+$/.test(name));
  if (gmailNames.length === 0) {
    record('Gmail (monitoring)', 'SKIP', 'no GMAIL_* variables — add one app password per mailbox to server/.env');
  } else {
    record('Gmail (monitoring)', 'OK', `${gmailNames.length} GMAIL_* credential name(s) present; mail is read by the owner's tooling only`);
  }

  /* ---- Report ---- */
  const width = Math.max(...results.map((r) => r.service.length));
  for (const { service, status, detail } of results) {
    console.log(`${service.padEnd(width)}  ${status.padEnd(4)}  ${detail}`);
  }
  const configured = results.filter((r) => r.status !== 'SKIP');
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n${configured.length - failed.length}/${configured.length} configured services answered; ${results.length - configured.length} not configured.`);
  process.exit(failed.length > 0 ? 1 : configured.length === 0 ? 2 : 0);
}

main().catch(() => {
  console.error('access:check could not run');
  process.exit(2);
});
