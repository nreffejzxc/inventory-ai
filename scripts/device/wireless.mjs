#!/usr/bin/env node
/**
 * Start a complete wireless Inventory AI session with one command.
 *
 * It does the six things that were previously six terminal steps:
 *
 *   1. find (or discover) the wireless adb device,
 *   2. recreate the Metro and backend reverse tunnels,
 *   3. start the backend if it is not already healthy,
 *   4. start Metro if it is not already serving,
 *   5. open the installed development client on Metro,
 *   6. start scrcpy and stay attached to it.
 *
 * It is deliberately idempotent. A healthy backend/Metro is reused, and an existing scrcpy window
 * is left alone. It never installs or builds an app. If it starts the backend or Metro, it stops
 * them again when the mirror closes; services that were already running are never stopped.
 *
 * USAGE
 *
 *   node scripts/device/wireless.mjs
 *   node scripts/device/wireless.mjs --serial=192.168.1.2:5555
 *   node scripts/device/wireless.mjs --check
 *   node scripts/device/wireless.mjs --help
 *
 * `--check` is read-only: it reports the wireless device, tunnels, backend, Metro, foreground app
 * and mirror, and exits 1 if any layer is missing. It does not create a tunnel or start a service.
 *
 * Wireless adb must already be enabled (Guide 15, Part A). If adb stops responding at startup, the
 * helper restarts the local adb server once. If exactly one `_adb._tcp` service is visible, it will
 * run `adb connect` for it; if that is unavailable, connect the phone or repeat the USB setup once.
 * The helper cannot enable USB debugging or TCP mode by itself.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { adb, foregroundActivity, openDevClient } from './adb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SERVER_DIR = join(ROOT, 'server');
const MOBILE_DIR = join(ROOT, 'mobile');
const EXPO_CLI = join(MOBILE_DIR, 'node_modules', 'expo', 'bin', 'cli');

const APP = 'com.inventoryai.app';
const BACKEND_PORT = 4000;
const METRO_PORT = 8081;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const METRO_URL = `http://127.0.0.1:${METRO_PORT}`;
const DEV_SERVER_URL = `http://localhost:${METRO_PORT}`;
const SESSION_FILE = join(tmpdir(), 'inventoryai-wireless-session.json');

const USAGE = `Usage: node scripts/device/wireless.mjs [options]

Starts the backend, Metro, the Inventory AI development client and scrcpy over wireless adb.
No Expo build is created. If adb stops responding at startup, the helper restarts the local adb
server once.

Options:
  --serial=<host:port>  Target one wireless device (default: auto-detect one)
  --check               Check the current session without changing it
  --stop                Stop the session this helper started, from another terminal
  --self-test           Simulate ADB recovery, failure, and stop; no phone needed
  --help, -h            Show this help

Examples:
  node scripts/device/wireless.mjs
  node scripts/device/wireless.mjs --serial=192.168.1.2:5555
  node scripts/device/wireless.mjs --check
  node scripts/device/wireless.mjs --stop
  node scripts/device/wireless.mjs --self-test

Logs for services this helper starts are written to a new folder under the OS temp directory.
Keep the terminal open while the mirror is open. Ctrl+C stops the backend, Metro and scrcpy that
this helper started; services that were already running are left alone. --stop does the same
from a second terminal and leaves manually started services untouched.`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let ownedChildren = [];
let mirrorChild = null;
let stopWatch = null;
let shuttingDown = false;
let ownsSessionFile = false;

function log(message) {
  console.log(`[wireless] ${message}`);
}

function readSessionFile() {
  try {
    const state = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function writeSessionFile(state) {
  try {
    writeFileSync(SESSION_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    log(`could not write session state: ${error.message}`);
  }
}

function clearSessionFile() {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    // A stale state file is harmless; --stop reports it if it cannot read one.
  }
}

function clearOwnedSessionFile() {
  if (!ownsSessionFile) return;
  ownsSessionFile = false;
  clearSessionFile();
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopStopWatch() {
  if (stopWatch) {
    clearInterval(stopWatch);
    stopWatch = null;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null) {
      done(true);
      return;
    }

    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      done(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
    child.once('exit', onExit);
  });
}

async function closeMirror() {
  const child = mirrorChild;
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }

  if (!(await waitForExit(child, 1500))) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await waitForExit(child, 1000);
  }
}

async function requestShutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopStopWatch();
  log('stopping session...');
  await closeMirror();
  stopOwned();
  mirrorChild = null;
  clearOwnedSessionFile();
  process.exit(code);
}

function startStopWatch(session) {
  stopStopWatch();
  stopWatch = setInterval(() => {
    const state = readSessionFile();
    if (state?.helperPid === session.helperPid && state.stopRequested) {
      void requestShutdown(0);
    }
  }, 500);
}

async function runStopHandshake({
  readState = readSessionFile,
  writeState = writeSessionFile,
  clearState = clearSessionFile,
  isAlive = processAlive,
  wait = sleep,
  now = Date.now,
  timeoutMs = 15_000,
  report = log,
  reportError = (message) => console.error(message),
} = {}) {
  const state = readState();
  if (!state) {
    report('no managed wireless session is running.');
    return { status: 'none' };
  }

  if (!isAlive(state.helperPid)) {
    clearState();
    report('managed wireless session is no longer running; removed its stale state.');
    return { status: 'stale' };
  }

  writeState({ ...state, stopRequested: true, stopRequestedAt: new Date().toISOString() });
  report(`stop requested for helper PID ${state.helperPid}; waiting for the session to close...`);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const current = readState();
    if (!current || !isAlive(state.helperPid)) {
      clearState();
      report('managed session stopped.');
      return { status: 'stopped' };
    }
    await wait(250);
  }

  reportError(`[wireless] helper PID ${state.helperPid} did not stop within 15 seconds.`);
  reportError('Close its mirror window or terminal, then run --stop again.');
  return { status: 'timeout' };
}

async function stopSession() {
  const result = await runStopHandshake();
  if (result.status === 'timeout') process.exitCode = 1;
}

function stopOwned() {
  for (const child of ownedChildren) {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        // Already gone; nothing useful to add.
      }
    }
  }
  ownedChildren = [];
}

function installCleanup() {
  const stop = (signal) => {
    log(`${signal} received; stopping session...`);
    void requestShutdown(signal === 'SIGTERM' ? 143 : 130);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

function parseArgs(argv) {
  const options = {
    check: false,
    help: false,
    selfTest: false,
    stop: false,
    serial: process.env.WIRELESS_SERIAL ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--stop') {
      options.stop = true;
    } else if (arg === '--self-test') {
      options.selfTest = true;
    } else if (arg === '--serial') {
      const value = argv[index + 1];
      if (!value) throw new Error('--serial needs a host:port value');
      options.serial = value;
      index += 1;
    } else if (arg.startsWith('--serial=')) {
      options.serial = arg.slice('--serial='.length);
      if (!options.serial) throw new Error('--serial needs a host:port value');
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return options;
}

function isWirelessSerial(serial) {
  return /:\d+$/.test(serial) && !serial.startsWith('emulator-');
}

function listDevices({ timeout = 30_000 } = {}) {
  return adb(['devices', '-l'], { timeout })
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state, line };
    })
    .filter((device) => device.serial && device.state);
}

function wirelessDevices(devices = listDevices()) {
  return devices.filter((device) => isWirelessSerial(device.serial));
}

function discoverMdns() {
  try {
    return adb(['mdns', 'services'])
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).filter(Boolean))
      .filter((parts) => parts[1] === '_adb._tcp' && parts[2])
      .map((parts) => parts[2]);
  } catch {
    return [];
  }
}

function isAdbTimeout(error) {
  return error?.code === 'ETIMEDOUT' || /ETIMEDOUT|timed out/i.test(error?.message ?? '');
}

async function withAdbRecovery({ recover = true, list, retry, restart, reconnect }) {
  try {
    return await list();
  } catch (error) {
    if (!recover || !isAdbTimeout(error)) throw error;
    await restart();
    await reconnect();
    return retry();
  }
}

const ADB_RESTART_FAILED = 'ADB_RESTART_FAILED';

function adbRestartFailure(error) {
  const failure = new Error(
    `adb could not be restarted: ${error.message}\n` +
      'End the local adb process (adb.exe on Windows), run `adb start-server`, then try the helper again.',
  );
  failure.code = ADB_RESTART_FAILED;
  return failure;
}

function normalizeAdbRecoveryError(error, recoverAdb) {
  if (error?.code === ADB_RESTART_FAILED) return error;
  if (isAdbTimeout(error) && recoverAdb) {
    return new Error(
      'adb is still not responding after the local server was restarted.\n' +
        'End adb.exe, run `adb start-server`, then try the helper again.',
    );
  }
  return error;
}

async function reconnectAfterAdbRestart(serial) {
  if (!serial) return;
  log(`reconnecting ${serial} after the ADB server restart...`);
  try {
    adb(['connect', serial], { timeout: 15_000 });
  } catch (error) {
    throw new Error(`adb restarted, but reconnecting to ${serial} failed: ${error.message}`);
  }
  await sleep(700);
}

function forceStopAdb() {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/IM', 'adb.exe'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    });
    return;
  }
  execFileSync('pkill', ['-x', 'adb'], { stdio: 'ignore', timeout: 5_000 });
}

async function restartAdbServer({
  run = adb,
  forceStop = forceStopAdb,
  wait = sleep,
  report = log,
} = {}) {
  report('adb is not responding; restarting the local adb server...');

  try {
    run(['kill-server'], { timeout: 3_000 });
  } catch {
    // A hung server will not answer kill-server either; force it below.
  }

  try {
    forceStop();
  } catch {
    // The process may already be gone, or force-stop may not be available.
  }

  await wait(300);
  try {
    run(['start-server'], { timeout: 15_000 });
  } catch (error) {
    throw adbRestartFailure(error);
  }

  report('adb server restarted.');
}

async function ensureWireless(requested, { allowConnect = true, recoverAdb = true } = {}) {
  if (requested && !isWirelessSerial(requested)) {
    throw new Error(
      `--serial must be a wireless host:port such as 192.168.1.2:5555, not "${requested}"`,
    );
  }

  let serial = requested;
  let devices;
  try {
    devices = await withAdbRecovery({
      recover: recoverAdb,
      list: () => listDevices({ timeout: 8_000 }),
      retry: () => listDevices({ timeout: 30_000 }),
      restart: restartAdbServer,
      reconnect: () => reconnectAfterAdbRestart(serial),
    });
  } catch (error) {
    throw normalizeAdbRecoveryError(error, recoverAdb);
  }

  if (!serial) {
    const wireless = wirelessDevices(devices);
    if (wireless.length === 1) {
      serial = wireless[0].serial;
    } else if (wireless.length > 1) {
      throw new Error(
        `more than one wireless device is attached:\n${wireless
          .map((device) => `  ${device.serial}`)
          .join('\n')}\nChoose one with --serial=<host:port>.`,
      );
    } else if (allowConnect) {
      const discovered = discoverMdns();
      if (discovered.length === 1) {
        serial = discovered[0];
        log(`wireless adb found over mDNS: ${serial}`);
        try {
          adb(['connect', serial]);
        } catch (error) {
          throw new Error(
            `could not connect to ${serial}: ${error.message}\n` +
              'Connect the phone over USB and repeat Guide 15 Part A.',
          );
        }
        await sleep(700);
        devices = listDevices();
      } else if (discovered.length > 1) {
        throw new Error(
          `more than one wireless adb service was discovered:\n${discovered
            .map((address) => `  ${address}`)
            .join('\n')}\nChoose one with --serial=<host:port>.`,
        );
      }
    }
  }

  if (!serial) {
    throw new Error(
      'no wireless adb device is attached.\n' +
        'Connect once with: adb connect <phone-ip>:5555\n' +
        'If that is refused, follow Guide 15 Part A (USB setup) once.',
    );
  }

  let device = devices.find((entry) => entry.serial === serial);

  if (!device && allowConnect) {
    log(`wireless adb is not attached; trying ${serial}`);
    try {
      adb(['connect', serial]);
    } catch (error) {
      throw new Error(
        `could not connect to ${serial}: ${error.message}\n` +
          'Check that the phone is awake, on the same Wi-Fi, and still in adb TCP mode.',
      );
    }
    await sleep(700);
    devices = listDevices();
    device = devices.find((entry) => entry.serial === serial);
  }

  if (!device) {
    throw new Error(
      `${serial} is not attached.\n` +
        'Check `adb devices -l`; if the phone rebooted, repeat Guide 15 Part A with USB.',
    );
  }
  if (device.state !== 'device') {
    throw new Error(
      `${serial} is ${device.state}, not ready.\n` +
        'Unlock the phone and accept the USB debugging prompt, or reconnect with `adb connect`.',
    );
  }

  const model = adb(['-s', serial, 'shell', 'getprop', 'ro.product.model']).trim() || 'Android';
  const physicalSerial =
    adb(['-s', serial, 'shell', 'getprop', 'ro.serialno']).trim() || 'unknown serial';
  log(`phone: ${serial} (${model}, ${physicalSerial})`);

  const power = adb(['-s', serial, 'shell', 'dumpsys', 'power']);
  if (!/mWakefulness=Awake/.test(power)) {
    log('phone is asleep; waking it');
    adb(['-s', serial, 'shell', 'input', 'keyevent', '224']);
    await sleep(500);
  }

  return serial;
}

function reverseTunnels(serial) {
  return adb(['-s', serial, 'reverse', '--list'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function ensureReverseTunnels(serial) {
  for (const port of [METRO_PORT, BACKEND_PORT]) {
    adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }

  const tunnels = reverseTunnels(serial);
  const missing = [METRO_PORT, BACKEND_PORT].filter(
    (port) => !tunnels.some((line) => line.includes(`tcp:${port} tcp:${port}`)),
  );
  if (missing.length) {
    throw new Error(
      `reverse tunnel${missing.length === 1 ? '' : 's'} missing for ${missing.join(', ')}; ` +
        'run `adb -s <host:port> reverse --list`.',
    );
  }

  log(`reverse tunnels: ${METRO_PORT} and ${BACKEND_PORT}`);
  return tunnels;
}

async function httpStatus(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'inventory-ai-wireless/1.0' },
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isPortOpen(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let finished = false;
    const finish = (open) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      done(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(700, () => finish(false));
  });
}

async function waitFor(check, { label, timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not ready';
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
      last = 'not ready';
    } catch (error) {
      last = error.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)}s (${last})`);
}

function tail(path, lines = 30) {
  try {
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(log unavailable)';
  }
}

function spawnLogged(logDir, name, command, args, cwd) {
  const logPath = join(logDir, `${name}.log`);
  const stream = createWriteStream(logPath, { flags: 'a' });
  stream.write(`$ ${command} ${args.join(' ')}\n\n`);

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  child.once('exit', (code, signal) => {
    stream.write(`\n[${name}] exited code=${code} signal=${signal}\n`);
    stream.end();
  });
  child.once('error', (error) => {
    stream.write(`\n[${name}] spawn error: ${error.message}\n`);
    stream.end();
  });

  ownedChildren.push(child);
  return { child, logPath };
}

async function ensureBackend(logDir) {
  const health = await httpStatus(`${BACKEND_URL}/api/health/ready`);
  if (health?.status === 200) {
    log(`backend: reusing ${BACKEND_URL}`);
    return;
  }

  if (await isPortOpen(BACKEND_PORT)) {
    throw new Error(
      `port ${BACKEND_PORT} is in use but /api/health/ready is not healthy.\n` +
        'Stop the old backend, then run this helper again.',
    );
  }

  if (!existsSync(join(SERVER_DIR, 'node_modules'))) {
    throw new Error('server/node_modules is missing; run `npm install` in server/ first.');
  }

  const { child, logPath } = spawnLogged(
    logDir,
    'backend',
    process.execPath,
    ['src/index.ts'],
    SERVER_DIR,
  );
  log(`backend: starting (log: ${logPath})`);

  try {
    await waitFor(async () => (await httpStatus(`${BACKEND_URL}/api/health/ready`))?.status === 200, {
      label: 'backend',
      timeoutMs: 30_000,
    });
  } catch (error) {
    stopChild(child);
    throw new Error(`${error.message}\n--- backend log ---\n${tail(logPath)}`);
  }
  log('backend: ready');
}

async function ensureMetro(logDir) {
  const status = await httpStatus(`${METRO_URL}/status`);
  if (status?.status === 200 && status.text.includes('packager-status:running')) {
    log(`Metro: reusing ${METRO_URL}`);
    return;
  }

  if (await isPortOpen(METRO_PORT)) {
    throw new Error(
      `port ${METRO_PORT} is in use but Metro is not serving ` +
        '`packager-status:running`.\nStop the old process, then run this helper again.',
    );
  }

  if (!existsSync(EXPO_CLI)) {
    throw new Error('mobile/node_modules/expo is missing; run `npm install` in mobile/ first.');
  }

  const { child, logPath } = spawnLogged(
    logDir,
    'metro',
    process.execPath,
    [EXPO_CLI, 'start', '--dev-client', '--localhost', '--port', String(METRO_PORT), '--clear'],
    MOBILE_DIR,
  );
  log(`Metro: starting (log: ${logPath})`);

  try {
    await waitFor(
      async () => {
        const response = await httpStatus(`${METRO_URL}/status`);
        return response?.status === 200 && response.text.includes('packager-status:running');
      },
      { label: 'Metro', timeoutMs: 120_000 },
    );
  } catch (error) {
    stopChild(child);
    throw new Error(`${error.message}\n--- Metro log ---\n${tail(logPath)}`);
  }
  log('Metro: ready');
}

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  ownedChildren = ownedChildren.filter((entry) => entry !== child);
}

async function ensureApp(serial) {
  openDevClient({ serial, devServerUrl: DEV_SERVER_URL });
  await waitFor(
    () => foregroundActivity({ serial }).includes(APP),
    { label: 'Inventory AI foreground activity', timeoutMs: 30_000 },
  );
  log(`app: ${APP} is in the foreground`);
}

function scrcpyRunning() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq scrcpy.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true },
      );
      return /scrcpy\.exe/i.test(output);
    }
    execFileSync('pgrep', ['-x', 'scrcpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startMirror(serial) {
  const child = spawn(
    'scrcpy',
    ['-s', serial, '-m', '1024', '--window-title', 'Inventory AI', '--no-audio'],
    { stdio: 'inherit', windowsHide: false },
  );
  mirrorChild = child;
  ownedChildren.push(child);
  log('mirror: scrcpy starting; keep this terminal open (Ctrl+C stops this session)');

  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

async function checkSession(options) {
  const serial = await ensureWireless(options.serial, { allowConnect: false, recoverAdb: false });
  const tunnels = reverseTunnels(serial);
  const backend = await httpStatus(`${BACKEND_URL}/api/health/ready`);
  const metro = await httpStatus(`${METRO_URL}/status`);
  const activity = foregroundActivity({ serial });
  const mirror = scrcpyRunning();

  const checks = [
    ['wireless adb', true, serial],
    [
      'reverse tunnels',
      [METRO_PORT, BACKEND_PORT].every((port) =>
        tunnels.some((line) => line.includes(`tcp:${port} tcp:${port}`)),
      ),
      tunnels.join(', ') || 'none',
    ],
    ['backend', backend?.status === 200, backend ? `HTTP ${backend.status}` : 'not running'],
    [
      'Metro',
      metro?.status === 200 && metro.text.includes('packager-status:running'),
      metro ? `HTTP ${metro.status}` : 'not running',
    ],
    ['app foreground', activity.includes(APP), activity || 'not available'],
    ['mirror', mirror, mirror ? 'scrcpy running' : 'not running'],
  ];

  for (const [name, pass, detail] of checks) {
    console.log(`[wireless] ${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  }

  if (checks.some(([, pass]) => !pass)) {
    process.exitCode = 1;
    console.error('[wireless] check failed; nothing was changed.');
  } else {
    log('check passed; nothing was changed.');
  }
}

async function runSession(options) {
  installCleanup();
  const logDir = mkdtempSync(join(tmpdir(), 'inventoryai-wireless-'));
  log(`logs: ${logDir}`);

  const serial = await ensureWireless(options.serial);
  ensureReverseTunnels(serial);

  const previous = readSessionFile();
  if (previous && previous.helperPid !== process.pid) {
    if (processAlive(previous.helperPid)) {
      throw new Error(
        `another wireless helper (PID ${previous.helperPid}) is already managing a session.\n` +
          'Run `node scripts/device/wireless.mjs --stop` first, or --check to inspect it.',
      );
    }
    clearSessionFile();
  }

  // An existing scrcpy belongs to the user, not to this helper. Reuse it only when the services
  // behind it are already healthy; never start orphaned services just to exit immediately.
  if (scrcpyRunning()) {
    const backend = await httpStatus(`${BACKEND_URL}/api/health/ready`);
    const metro = await httpStatus(`${METRO_URL}/status`);
    if (backend?.status !== 200 || !metro?.text.includes('packager-status:running')) {
      throw new Error(
        'a scrcpy window is already running, but the backend or Metro is not healthy.\n' +
          'Close the old mirror and run this helper again so it can manage a fresh session.',
      );
    }
    await ensureApp(serial);
    log('mirror: scrcpy is already running; left it untouched.');
    log('session is ready.');
    return;
  }

  const session = {
    version: 1,
    helperPid: process.pid,
    serial,
    logDir,
    startedAt: new Date().toISOString(),
    stopRequested: false,
  };
  writeSessionFile(session);
  ownsSessionFile = true;
  startStopWatch(session);
  log('stop: run `node scripts/device/wireless.mjs --stop` from another terminal');

  await ensureBackend(logDir);
  await ensureMetro(logDir);
  await ensureApp(serial);

  let result;
  try {
    result = await startMirror(serial);
  } catch (error) {
    stopOwned();
    throw new Error(`could not start scrcpy: ${error.message}`);
  }

  stopStopWatch();
  mirrorChild = null;
  stopOwned();
  clearOwnedSessionFile();
  if (result.code !== 0 && result.code !== null) {
    throw new Error(`scrcpy exited with code ${result.code}`);
  }
  log('session ended; services started by this helper were stopped.');
}

function adbTimeoutError() {
  const error = new Error('spawnSync adb ETIMEDOUT');
  error.code = 'ETIMEDOUT';
  return error;
}

async function selfTest() {
  const problems = [];
  const device = { serial: '192.168.1.2:5555', state: 'device' };

  const sequence = [];
  let restarts = 0;
  let reconnects = 0;
  try {
    const recovered = await withAdbRecovery({
      list: async () => {
        sequence.push('list');
        throw adbTimeoutError();
      },
      restart: async () => {
        sequence.push('restart');
        restarts += 1;
      },
      reconnect: async () => {
        sequence.push('reconnect');
        reconnects += 1;
      },
      retry: async () => {
        sequence.push('retry');
        return [device];
      },
    });

    if (sequence.join(',') !== 'list,restart,reconnect,retry') {
      problems.push(`unexpected recovery sequence: ${sequence.join(',')}`);
    }
    if (restarts !== 1) problems.push(`expected 1 restart, got ${restarts}`);
    if (reconnects !== 1) problems.push(`expected 1 reconnect, got ${reconnects}`);
    if (recovered?.[0]?.serial !== device.serial) {
      problems.push('recovery did not return the retried device list');
    }
  } catch (error) {
    problems.push(`a timeout was not recovered: ${error.message}`);
  }

  let directRestarts = 0;
  let directReconnects = 0;
  try {
    const direct = await withAdbRecovery({
      list: async () => [device],
      restart: async () => {
        directRestarts += 1;
      },
      reconnect: async () => {
        directReconnects += 1;
      },
      retry: async () => {
        problems.push('retry ran even though adb did not time out');
        return [];
      },
    });
    if (directRestarts !== 0) problems.push(`a healthy list restarted adb ${directRestarts} time(s)`);
    if (directReconnects !== 0) problems.push(`a healthy list reconnected ${directReconnects} time(s)`);
    if (direct?.[0]?.serial !== device.serial) problems.push('a healthy list did not continue');
  } catch (error) {
    problems.push(`a healthy list failed: ${error.message}`);
  }

  const failure = new Error('adb: permission denied');
  let failureRestarts = 0;
  try {
    await withAdbRecovery({
      list: async () => {
        throw failure;
      },
      restart: async () => {
        failureRestarts += 1;
      },
      reconnect: async () => {},
      retry: async () => [device],
    });
    problems.push('a non-timeout adb error was retried');
  } catch (error) {
    if (error !== failure) problems.push('a non-timeout adb error was replaced');
    if (failureRestarts !== 0) problems.push('a non-timeout adb error restarted the server');
  }

  let checkRestarts = 0;
  try {
    await withAdbRecovery({
      recover: false,
      list: async () => {
        throw adbTimeoutError();
      },
      restart: async () => {
        checkRestarts += 1;
      },
      reconnect: async () => {},
      retry: async () => [device],
    });
    problems.push('recover:false still recovered a timeout');
  } catch (error) {
    if (!isAdbTimeout(error)) problems.push('recover:false changed the timeout error');
    if (checkRestarts !== 0) problems.push('recover:false restarted the server');
  }

  let failedRestarts = 0;
  let failedReconnects = 0;
  try {
    await withAdbRecovery({
      list: async () => {
        throw adbTimeoutError();
      },
      restart: async () => {
        failedRestarts += 1;
      },
      reconnect: async () => {
        failedReconnects += 1;
      },
      retry: async () => {
        throw adbTimeoutError();
      },
    });
    problems.push('a second timeout was reported as recovered');
  } catch (error) {
    if (!isAdbTimeout(error)) problems.push('a second timeout changed shape');
    if (failedRestarts !== 1) problems.push(`a second timeout restarted ${failedRestarts} times`);
    if (failedReconnects !== 1) problems.push(`a second timeout reconnected ${failedReconnects} times`);
  }

  problems.push(...(await selfTestFailedAdbRestart()));
  problems.push(...(await selfTestStopHandshake()));
  return problems;
}

async function selfTestFailedAdbRestart() {
  const problems = [];
  const ignore = () => {};
  const commands = [];
  let forceStops = 0;
  let waits = 0;
  const cause = new Error('spawnSync adb ETIMEDOUT');

  try {
    await restartAdbServer({
      run: (args) => {
        commands.push(args[0]);
        if (args[0] === 'start-server') throw cause;
        return '';
      },
      forceStop: () => {
        forceStops += 1;
      },
      wait: async () => {
        waits += 1;
      },
      report: ignore,
    });
    problems.push('a failed adb restart did not throw');
  } catch (error) {
    if (commands.filter((command) => command === 'kill-server').length !== 1) {
      problems.push('failed restart did not try kill-server exactly once');
    }
    if (commands.filter((command) => command === 'start-server').length !== 1) {
      problems.push('failed restart did not try start-server exactly once');
    }
    if (forceStops !== 1) problems.push(`failed restart force-stopped ${forceStops} time(s)`);
    if (waits !== 1) problems.push(`failed restart waited ${waits} time(s)`);
    if (error.code !== ADB_RESTART_FAILED) {
      problems.push(`failed restart used error code ${String(error.code)}`);
    }

    for (const fragment of [
      'adb could not be restarted',
      cause.message,
      'adb start-server',
      'local adb process',
    ]) {
      if (!String(error.message).includes(fragment)) {
        problems.push(`failed restart message is missing "${fragment}"`);
      }
    }

    if (normalizeAdbRecoveryError(error, true) !== error) {
      problems.push('the actionable restart failure was replaced by the generic timeout message');
    }
  }

  return problems;
}

async function selfTestStopHandshake() {
  const problems = [];
  const ignore = () => {};

  let noSessionWrites = 0;
  let noSessionClears = 0;
  let noSessionWaits = 0;
  const none = await runStopHandshake({
    readState: () => null,
    writeState: () => {
      noSessionWrites += 1;
    },
    clearState: () => {
      noSessionClears += 1;
    },
    isAlive: () => true,
    wait: async () => {
      noSessionWaits += 1;
    },
    report: ignore,
    reportError: ignore,
  });
  if (none.status !== 'none') problems.push(`no-session stop returned ${none.status}`);
  if (noSessionWrites || noSessionClears || noSessionWaits) {
    problems.push('no-session stop changed state or waited');
  }

  const staleState = { helperPid: 123, serial: '192.168.1.2:5555', stopRequested: false };
  let staleWrites = 0;
  let staleClears = 0;
  const stale = await runStopHandshake({
    readState: () => staleState,
    writeState: () => {
      staleWrites += 1;
    },
    clearState: () => {
      staleClears += 1;
    },
    isAlive: () => false,
    wait: async () => {
      problems.push('stale stop waited for a session');
    },
    report: ignore,
    reportError: ignore,
  });
  if (stale.status !== 'stale') problems.push(`stale stop returned ${stale.status}`);
  if (staleWrites !== 0) problems.push('stale stop wrote a stop request');
  if (staleClears !== 1) problems.push(`stale stop cleared state ${staleClears} time(s)`);

  let activeState = { helperPid: 456, serial: '192.168.1.2:5555', stopRequested: false };
  let activeWrites = 0;
  let activeClears = 0;
  let activeWaits = 0;
  let writtenState = null;
  const active = await runStopHandshake({
    readState: () => activeState,
    writeState: (next) => {
      activeState = next;
      writtenState = next;
      activeWrites += 1;
    },
    clearState: () => {
      activeState = null;
      activeClears += 1;
    },
    isAlive: () => true,
    wait: async () => {
      activeWaits += 1;
      if (activeWaits === 2) activeState = null;
    },
    now: () => 0,
    report: ignore,
    reportError: ignore,
  });
  if (active.status !== 'stopped') problems.push(`active stop returned ${active.status}`);
  if (!writtenState?.stopRequested) problems.push('active stop did not write stopRequested');
  if (activeWrites !== 1) problems.push(`active stop wrote ${activeWrites} stop request(s)`);
  if (activeClears !== 1) problems.push(`active stop cleared state ${activeClears} time(s)`);
  if (activeWaits !== 2) problems.push(`active stop waited ${activeWaits} time(s), expected 2`);

  let clock = 0;
  let timeoutWrites = 0;
  let timeoutClears = 0;
  let timeoutWaits = 0;
  let timeoutErrors = 0;
  const timeout = await runStopHandshake({
    readState: () => ({ helperPid: 789, serial: '192.168.1.2:5555' }),
    writeState: () => {
      timeoutWrites += 1;
    },
    clearState: () => {
      timeoutClears += 1;
    },
    isAlive: () => true,
    wait: async () => {
      timeoutWaits += 1;
      clock += 1_000;
    },
    now: () => clock,
    timeoutMs: 1_500,
    report: ignore,
    reportError: () => {
      timeoutErrors += 1;
    },
  });
  if (timeout.status !== 'timeout') problems.push(`timeout stop returned ${timeout.status}`);
  if (timeoutWrites !== 1) problems.push(`timeout stop wrote ${timeoutWrites} stop request(s)`);
  if (timeoutClears !== 0) problems.push('timeout stop cleared a live session');
  if (timeoutWaits !== 2) problems.push(`timeout stop waited ${timeoutWaits} time(s), expected 2`);
  if (timeoutErrors !== 2) problems.push(`timeout stop reported ${timeoutErrors} error line(s), expected 2`);

  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.selfTest) {
    const problems = await selfTest();
    if (problems.length) {
      console.error('✖ wireless recovery self-test failed:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log('✔ wireless self-test: ADB recovery, restart failure, and stop handshake pass');
    }
    return;
  }
  if (options.stop && options.check) {
    throw new Error('--stop and --check cannot be combined');
  }
  if (options.stop) {
    await stopSession();
    return;
  }
  if (options.check) {
    await checkSession(options);
    return;
  }
  await runSession(options);
}

main().catch((error) => {
  stopStopWatch();
  stopOwned();
  mirrorChild = null;
  clearOwnedSessionFile();
  console.error(`\n[wireless] ${error.message}`);
  process.exitCode = 1;
});
