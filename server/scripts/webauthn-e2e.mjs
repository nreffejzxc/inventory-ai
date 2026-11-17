console.error("deliberate branch-protection verification failure");
process.exit(1);
#!/usr/bin/env node
/**
 * PLAT-4 — browser WebAuthn end-to-end check for the platform console.
 *
 * A real browser and a virtual authenticator are the only way to exercise the
 * path the server tests cannot: navigator.credentials.create/get, the browser's
 * clientDataJSON/origin binding, and the server's one-time challenge consumption.
 *
 * WHAT THIS PROVES
 *   * TOTP enrollment completes in the actual console;
 *   * a security key registers through the console against the real API;
 *   * password + virtual authenticator opens a console session;
 *   * the exact assertion and authentication token from that login cannot be
 *     replayed (the challenge is consumed atomically);
 *   * a tampered assertion is refused and leaves no session.
 *
 * REQUIREMENTS
 *   * MongoDB reachable through the repository's normal test configuration;
 *   * Google Chrome or Microsoft Edge installed (or CHROME_PATH set);
 *   * unused API, console and Chrome DevTools ports (WEBAUTHN_E2E_API_PORT,
 *     PLATFORM_CONSOLE_PORT, WEBAUTHN_E2E_CDP_PORT; defaults 4400, 4100, 9333).
 *
 * The script creates one unique SUPERADMIN in the TEST database and removes the
 * administrator, its sessions and its audit rows afterwards. It never prints the
 * password, a TOTP secret or a session token. It does not run as part of
 * `npm test`; the CI `webauthn-e2e` job runs it explicitly with a browser, and
 * the same command is the local fallback:
 *
 *   cd server && npm run test:webauthn-e2e
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentTotpCounter, generateTotp } from '../src/services/platformMfa/totp.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.WEBAUTHN_E2E_API_PORT || 4400);
const CONSOLE_PORT = Number(process.env.PLATFORM_CONSOLE_PORT || 4100);
const CDP_PORT = Number(process.env.WEBAUTHN_E2E_CDP_PORT || 9333);
const API_ORIGIN = `http://localhost:${API_PORT}`;
const CONSOLE_ORIGIN = `http://localhost:${CONSOLE_PORT}`;
const STARTED_AT = new Date();
const RUN_ID = `${STARTED_AT.getTime()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `webauthn-e2e-${RUN_ID}@example.test`;
const PASSWORD = crypto.randomBytes(24).toString('base64url');
const PLATFORM_JWT_SECRET = crypto.randomBytes(48).toString('base64url');
const MFA_ENCRYPTION_KEY = crypto.randomBytes(48).toString('base64url');

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('[webauthn-e2e] No Chrome/Edge binary found. Set CHROME_PATH.');
  process.exit(2);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  MONGODB_DB_NAME: 'inventoryai_test_db',
  PORT: String(API_PORT),
  LOG_REQUESTS: '0',
  PLATFORM_CONSOLE_PORT: String(CONSOLE_PORT),
  PLATFORM_CONSOLE_ORIGIN: CONSOLE_ORIGIN,
  PLATFORM_API_ORIGIN: API_ORIGIN,
  PLATFORM_WEBAUTHN_ORIGIN: CONSOLE_ORIGIN,
  PLATFORM_WEBAUTHN_RP_ID: 'localhost',
  PLATFORM_WEBAUTHN_RP_NAME: 'Inventory AI Platform E2E',
  PLATFORM_ADMIN_JWT_SECRET: PLATFORM_JWT_SECRET,
  PLATFORM_MFA_ENCRYPTION_KEY: MFA_ENCRYPTION_KEY,
};

const children = [];
let chrome;
let chromeErr = '';
let profileDir;
let adminId;
let failed = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[webauthn-e2e] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function startChild(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    env: options.env || env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ label, child });
  let tail = '';
  const capture = (chunk) => {
    tail = `${tail}${String(chunk)}`.slice(-6000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.tail = () => tail;
  child.label = label;
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitHttp(url, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `${response.status} ${response.statusText}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  fail(`${label} did not answer at ${url} (${last})`);
}

async function createAdmin() {
  const result = spawnSync(process.execPath, ['scripts/create-platform-admin.mjs'], {
    cwd: serverRoot,
    env: {
      ...env,
      PLATFORM_ADMIN_CONFIRM: 'create-platform-admin',
      PLATFORM_ADMIN_EMAIL: EMAIL,
      PLATFORM_ADMIN_NAME: 'WebAuthn E2E',
      PLATFORM_ADMIN_ROLE: 'SUPERADMIN',
      PLATFORM_ADMIN_PASSWORD: PASSWORD,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) {
    fail(`administrator creation failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const match = /with id ([a-f0-9]{24})\./i.exec(result.stdout || '');
  assert(match, 'administrator creation did not print its id');
  adminId = match[1];
  log(`created the disposable test administrator (${adminId})`);
}

async function cleanupAdmin() {
  const code = `
    import 'dotenv/config';
    import mongoose from 'mongoose';
    import PlatformAdmin from './src/models/platformAdmin.model.ts';
    import PlatformAdminSession from './src/models/platformAdminSession.model.ts';
    import { connectDatabase, disconnectDatabase } from './src/config/db.ts';
    const ok = await connectDatabase();
    if (!ok) process.exit(2);
    const admin = await PlatformAdmin.findOne({ email: process.env.E2E_EMAIL }).select('_id').lean();
    const parsedStart = new Date(process.env.E2E_STARTED_AT || '');
    const startedAt = Number.isNaN(parsedStart.getTime()) ? new Date() : parsedStart;
    const auditFilters = [
      { actorEmail: process.env.E2E_EMAIL },
      // Replay and tampered-assertion refusals have no resolvable actor; clear
      // every platform audit row this run created, including those.
      { createdAt: { $gte: startedAt }, route: { $regex: '^/api/platform/' } },
    ];
    if (admin) auditFilters.push({ actorAdminId: admin._id });
    await mongoose.connection.collection('platform_audit_events').deleteMany({ $or: auditFilters });
    if (admin) {
      await PlatformAdminSession.deleteMany({ adminId: admin._id });
      await PlatformAdmin.deleteOne({ _id: admin._id });
    }
    const admins = await PlatformAdmin.countDocuments({ email: process.env.E2E_EMAIL });
    const sessions = admin ? await PlatformAdminSession.countDocuments({ adminId: admin._id }) : 0;
    const audits = await mongoose.connection.collection('platform_audit_events').countDocuments({ $or: auditFilters });
    await disconnectDatabase();
    console.log('[webauthn-e2e] cleanup: admins=' + admins + ' sessions=' + sessions + ' audits=' + audits);
    if (admins || sessions || audits) process.exit(3);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: serverRoot,
    env: { ...env, E2E_EMAIL: EMAIL, E2E_STARTED_AT: STARTED_AT.toISOString() },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error || result.status !== 0) {
    console.error(
      `[webauthn-e2e] cleanup failed: ${(result.error?.message || result.stderr || result.stdout || '').trim()}`,
    );
    return false;
  }
  return true;
}

class Cdp {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.events.get(message.method) || []) listener(message.params);
    });
  }

  async connect() {
    await this.ready;
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.events.get(method) || [];
    list.push(listener);
    this.events.set(method, list);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function waitFor(label, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  fail(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}

async function main() {
  log(`browser: ${chromePath}`);
  try {
    await createAdmin();
    startChild('api', process.execPath, ['src/index.ts']);
    startChild('console', process.execPath, ['platform-console/server.ts']);

    await waitHttp(`${API_ORIGIN}/api/health`, 'platform API');
    await waitHttp(`${CONSOLE_ORIGIN}/`, 'platform console');
    log('API and console are answering');

    profileDir = mkdtempSync(path.join(tmpdir(), 'inventory-webauthn-e2e-'));
    chrome = spawn(
      chromePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        ...(process.env.CI ? ['--no-sandbox'] : []),
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    chrome.stderr.on('data', (chunk) => {
      chromeErr = `${chromeErr}${String(chunk)}`.slice(-4000);
    });

    const targets = await waitFor(
      'the Chrome DevTools endpoint',
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
          if (!response.ok) return false;
          const list = await response.json();
          return list.find((target) => target.type === 'page') || false;
        } catch {
          return false;
        }
      },
      20000,
    );

    const cdp = await new Cdp(targets.webSocketDebuggerUrl).connect();
    try {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('WebAuthn.enable');
      const virtual = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      assert(virtual.authenticatorId, 'Chrome did not create a virtual authenticator');
      log(`virtual authenticator ${virtual.authenticatorId}`);

      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          window.__e2eErrors = [];
          window.__e2eCalls = [];
          window.__e2eVerifyErrors = [];
          window.addEventListener('error', (event) => window.__e2eErrors.push(String(event.message)));
          window.addEventListener('unhandledrejection', (event) => window.__e2eErrors.push(String(event.reason)));
          const __e2eFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            const entry = { url, method: (init && init.method) || 'GET', status: null };
            if (url.includes('/api/platform/')) window.__e2eCalls.push(entry);
            const response = await __e2eFetch(input, init);
            entry.status = response.status;
            if (url.endsWith('/auth/login')) {
              response.clone().json().then((data) => {
                window.__e2eLogin = {
                  status: response.status,
                  mfaToken: Boolean(data.mfaToken),
                  mfaRequired: Boolean(data.mfaRequired),
                  enrollmentRequired: Boolean(data.mfaEnrollmentRequired),
                };
              }).catch(() => {});
            }
            if (
              url.includes('/api/platform/') &&
              (url.includes('/mfa/webauthn/verify') || url.includes('/mfa/webauthn/options')) &&
              response.status >= 400
            ) {
              try {
                window.__e2eVerifyErrors.push({ url, status: response.status, body: await response.clone().json() });
              } catch {
                window.__e2eVerifyErrors.push({ url, status: response.status, unreadable: true });
              }
            }
            return response;
          };
        `,
      });

      const evaluate = async (expression, userGesture = false) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture,
        });
        if (result.exceptionDetails) {
          const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
          fail(`page evaluation failed: ${text}`);
        }
        return result.result.value;
      };

      const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
      const setValue = async (id, value) => {
        await evaluate(
          `(() => {
            const el = ${byId(id)};
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return el.value;
          })()`,
          true,
        );
      };
      const click = async (id) => {
        await evaluate(`${byId(id)}.click()`, true);
      };
      const textOf = async (id) => evaluate(`${byId(id)}.textContent || ''`);
      const shown = async (id) => evaluate(`!${byId(id)}.hidden`);
      const loginCallCount = () =>
        evaluate(`window.__e2eCalls.filter((call) => call.url.endsWith('/auth/login')).length`);
      const waitForPasswordResponse = (since) =>
        waitFor(
          'the password response',
          async () => {
            const calls = await evaluate(
              `window.__e2eCalls.filter((call) => call.url.endsWith('/auth/login'))`,
            );
            return calls.length > since && calls[calls.length - 1].status !== null;
          },
          20000,
        );
      const submitLogin = async () => {
        const before = await loginCallCount();
        await evaluate('window.__e2eLogin = null');
        await evaluate(`${byId('login-form')}.requestSubmit()`, true);
        await waitForPasswordResponse(before);
        await waitFor(
          'the parsed password response',
          async () => (await evaluate('window.__e2eLogin')) || false,
          20000,
        );
      };

      await cdp.send('Page.navigate', { url: `${CONSOLE_ORIGIN}/` });
      await waitFor('the console login form', async () => shown('login-view'), 20000);

      const errorText = async () => {
        for (const id of [
          'login-error',
          'mfa-error',
          'enroll-error',
          'webauthn-error',
          'recovery-setup-error',
          'recovery-setup-continue-error',
        ]) {
          const text = (await textOf(id)).trim();
          if (text) throw new Error(`${id}: ${text}`);
        }
      };

      // 1. Password -> mandatory TOTP enrollment -> console session.
      await setValue('email', EMAIL);
      await setValue('password', PASSWORD);
      await submitLogin();
      await waitFor(
        'the TOTP enrollment view',
        async () => {
          await errorText();
          return shown('enroll-view');
        },
        20000,
      );
      const secret = await waitFor(
        'the base32 TOTP secret',
        async () => {
          await errorText();
          const value = (await textOf('enroll-secret')).trim();
          return /^[A-Z2-7]+$/.test(value) ? value : false;
        },
        20000,
      );
      await setValue('enroll-code', generateTotp(secret, currentTotpCounter()));
      await evaluate(`${byId('enroll-form')}.requestSubmit()`, true);
      await waitFor(
        'the required recovery-code ceremony after TOTP enrollment',
        async () => {
          await errorText();
          return shown('recovery-setup-view');
        },
        20000,
      );
      await setValue('recovery-setup-password', PASSWORD);
      await evaluate(`${byId('recovery-setup-form')}.requestSubmit()`, true);
      const recoveryCodes = await waitFor(
        'the generated recovery codes',
        async () => {
          await errorText();
          const value = (await textOf('recovery-setup-codes')).trim();
          return value.split(/\s+/).filter(Boolean).length === 10 ? value : false;
        },
        20000,
      );
      assert(recoveryCodes.length > 0, 'recovery codes were empty');
      await evaluate(`${byId('recovery-setup-saved')}.click()`, true);
      await click('recovery-setup-continue');
      await waitFor(
        'the dashboard after saving recovery codes',
        async () => {
          await errorText();
          return shown('dashboard-view');
        },
        20000,
      );
      assert((await textOf('security-mfa')).includes('enrolled'), 'TOTP was not recorded as enrolled');
      log('TOTP enrollment and the recovery-code ceremony completed in the browser');

      // 2. Register the virtual authenticator through the console UI.
      await evaluate(`document.querySelector('[data-view="security"]').click()`, true);
      await waitFor('the security view', async () => shown('view-security'), 10000);
      await waitFor(
        'the security-key registration button',
        async () => !(await evaluate(`${byId('webauthn-register-button')}.disabled`)),
        10000,
      );
      await setValue('key-label', 'E2E virtual authenticator');
      await click('webauthn-register-button');
      const registered = await waitFor(
        'security-key registration',
        async () => {
          await errorText();
          const status = (await textOf('webauthn-status')).trim();
          return status.includes('Registered') ? status : false;
        },
        20000,
      );
      assert(registered.includes('E2E virtual authenticator'), registered);
      assert((await textOf('security-keys')).includes('1 registered'), 'the console did not count the key');
      log('security-key registration completed in the browser');

      // Capture the next assertion and the server's one-time login challenge so
      // the exact successful login can be replayed deliberately.
      await evaluate(
        `(() => {
          window.__webauthnProbe = { assertion: null, authenticationToken: null };
          const originalGet = navigator.credentials.get.bind(navigator.credentials);
          const toB64url = (value) => {
            const bytes = new Uint8Array(value);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
            return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
          };
          navigator.credentials.get = async (options) => {
            const credential = await originalGet(options);
            const response = credential.response;
            window.__webauthnProbe.assertion = {
              id: credential.id,
              rawId: toB64url(credential.rawId),
              type: credential.type,
              response: {
                clientDataJSON: toB64url(response.clientDataJSON),
                authenticatorData: toB64url(response.authenticatorData),
                signature: toB64url(response.signature),
                userHandle: response.userHandle ? toB64url(response.userHandle) : null
              },
              clientExtensionResults: credential.getClientExtensionResults()
            };
            return credential;
          };
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            const url = typeof input === 'string' ? input : input.url;
            if (url.includes('/api/platform/auth/mfa/webauthn/options')) {
              response.clone().json().then((data) => {
                window.__webauthnProbe.authenticationToken = data.authenticationToken;
              }).catch(() => {});
            }
            return response;
          };
        })()`,
        true,
      );

      // 3. Sign out, then sign in with password + virtual authenticator.
      await click('logout-button');
      await waitFor('the login view after sign-out', async () => shown('login-view'), 10000);
      await setValue('email', EMAIL);
      await setValue('password', PASSWORD);
      await submitLogin();
      await waitFor(
        'the WebAuthn option',
        async () => {
          await errorText();
          return shown('mfa-view') && !(await evaluate(`${byId('webauthn-login-button')}.hidden`));
        },
        20000,
      );
      await click('webauthn-login-button');
      await waitFor(
        'the dashboard after WebAuthn sign-in',
        async () => {
          await errorText();
          return shown('dashboard-view');
        },
        20000,
      );
      await waitFor(
        'the captured WebAuthn authentication challenge',
        async () => (await evaluate('window.__webauthnProbe.authenticationToken')) || false,
        5000,
      );
      const probe = await evaluate('window.__webauthnProbe');
      assert(probe?.assertion?.id, 'the browser did not return an assertion');
      assert(probe.authenticationToken, 'the browser did not capture the authentication challenge');
      log('WebAuthn sign-in completed in the browser');

      // 4. Replay the exact token + assertion: the challenge was consumed, so
      // this must fail even though the JWT is still within its five-minute life.
      const replay = await evaluate(
        `(async () => {
          const response = await fetch(${JSON.stringify(`${API_ORIGIN}/api/platform/auth/mfa/webauthn/verify`)}, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              authenticationToken: window.__webauthnProbe.authenticationToken,
              response: window.__webauthnProbe.assertion,
              deviceLabel: 'replay'
            })
          });
          return { status: response.status, body: await response.json() };
        })()`,
        true,
      );
      assert(
        replay.status === 401 && replay.body.code === 'PLATFORM_WEBAUTHN_INVALID',
        `replay was not refused: ${replay.status} ${JSON.stringify(replay.body)}`,
      );
      log('replayed assertion refused (PLATFORM_WEBAUTHN_INVALID)');

      // 5. Sign out, then tamper with a fresh assertion before the console sends
      // it. The server must refuse it and must not create a dashboard session.
      await click('logout-button');
      await waitFor(
        'the login view before the invalid attempt',
        async () => shown('login-view') && !(await shown('mfa-view')),
        10000,
      );
      await setValue('email', EMAIL);
      await setValue('password', PASSWORD);
      await submitLogin();
      await waitFor(
        'the WebAuthn option before the invalid attempt',
        async () => {
          await errorText();
          return shown('mfa-view') && !(await evaluate(`${byId('webauthn-login-button')}.hidden`));
        },
        20000,
      );
      await evaluate(
        `(() => {
          const originalGet = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = async (options) => {
            const credential = await originalGet(options);
            const response = credential.response;
            const signature = new Uint8Array(response.signature);
            signature[0] ^= 1;
            return {
              id: credential.id,
              rawId: credential.rawId,
              type: credential.type,
              response: {
                clientDataJSON: response.clientDataJSON,
                authenticatorData: response.authenticatorData,
                signature,
                userHandle: response.userHandle
              },
              getClientExtensionResults: () => credential.getClientExtensionResults()
            };
          };
        })()`,
        true,
      );
      await click('webauthn-login-button');
      const invalidMessage = await waitFor(
        'the invalid-assertion refusal',
        async () => {
          const message = (await textOf('mfa-error')).trim();
          return message || false;
        },
        20000,
      );
      const invalidDebug = await evaluate('({ calls: window.__e2eCalls, errors: window.__e2eVerifyErrors })');
      assert(
        /invalid security key/i.test(invalidMessage),
        `unexpected invalid-attempt error: ${invalidMessage}; network=${JSON.stringify(invalidDebug)}`,
      );
      assert(!(await shown('dashboard-view')), 'a tampered assertion opened the dashboard');
      const signedOut = await evaluate(
        `(async () => {
          const response = await fetch(${JSON.stringify(`${API_ORIGIN}/api/platform/auth/me`)}, { credentials: 'include' });
          return response.status;
        })()`,
        true,
      );
      assert(signedOut === 401, `a tampered assertion left a session (me=${signedOut})`);
      log('tampered assertion refused with no session');

      const pageErrors = await evaluate('window.__e2eErrors');
      assert(
        !Array.isArray(pageErrors) || pageErrors.length === 0,
        `browser page errors: ${JSON.stringify(pageErrors)}`,
      );

      console.log('\n[webauthn-e2e] PASS — TOTP enrollment, WebAuthn registration, WebAuthn login, replay refusal and tampered-assertion refusal all verified in Chrome.');
    } finally {
      cdp.close();
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const entry of [...children].reverse()) stopChild(entry.child);
    if (chrome) stopChild(chrome);
    await sleep(500);
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a file; the OS temp cleaner can remove it */
      }
    }
    const cleaned = await cleanupAdmin();
    if (!cleaned) {
      failed = true;
      process.exitCode = 1;
    }
    if (failed) {
      for (const entry of children) {
        console.error(`[webauthn-e2e] ${entry.label} log tail:\n${entry.child.tail()}`);
      }
      if (chromeErr) console.error(`[webauthn-e2e] Chrome log tail:\n${chromeErr}`);
    }
  }
}

main().catch((error) => {
  console.error(`[webauthn-e2e] FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
