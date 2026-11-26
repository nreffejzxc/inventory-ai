#!/usr/bin/env node
/**
 * A loopback HTTP proxy that records each request before forwarding it.
 *
 * The Draft PO restart proof needs a kill that lands AFTER the request has been fully received but
 * BEFORE the app can see the response. `--kill-package` makes that ordering explicit: the request
 * line (including `Idempotency-Key` and the parsed body) is flushed, the app is force-stopped, and
 * only then is the request forwarded. A delay or a polling watcher cannot make that guarantee.
 *
 * Local evidence only. It binds to a loopback address, forwards to a loopback target, and refuses a
 * non-loopback target unless the caller explicitly accepts it.
 *
 *   node scripts/device/logging-proxy.mjs \
 *     --listen=4001 --target=http://127.0.0.1:4000 --log=/tmp/proxy.jsonl \
 *     --kill-package=com.inventoryai.app --serial=emulator-5554 \
 *     --kill-path=/api/purchase-orders/from-restock
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function parseArgs(argv) {
  const args = {
    listen: 4001,
    target: 'http://127.0.0.1:4000',
    log: null,
    killPackage: null,
    killPath: null,
    serial: null,
    adb: 'adb',
    allowRemote: false,
  };
  for (const raw of argv) {
    const [flag, ...rest] = raw.replace(/^--/, '').split('=');
    const value = rest.join('=');
    switch (flag) {
      case 'listen':
        args.listen = Number(value);
        break;
      case 'target':
        args.target = value;
        break;
      case 'log':
        args.log = value;
        break;
      case 'kill-package':
        args.killPackage = value;
        break;
      case 'kill-path':
        args.killPath = value;
        break;
      case 'serial':
        args.serial = value;
        break;
      case 'adb':
        args.adb = value;
        break;
      case 'allow-remote':
        args.allowRemote = true;
        break;
      default:
        throw new Error(`unknown option: ${raw}`);
    }
  }
  if (!args.log) throw new Error('--log is required');
  if (!Number.isInteger(args.listen) || args.listen <= 0) throw new Error('--listen must be a port');
  // A kill without a serial lets adb choose the only/first device — the exact
  // mistake that force-stopped the production phone during an earlier run.
  if ((args.killPackage || args.killPath) && !args.serial) {
    throw new Error(
      '--serial is required with --kill-package/--kill-path; automatic device selection is refused',
    );
  }
  return args;
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function writeLine(log, value) {
  appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|token|secret|authorization|credential/i.test(key) ? '[REDACTED]' : redact(item),
    ]),
  );
}

function parseBody(buffer, contentType) {
  if (!buffer.length || !/json/i.test(contentType ?? '')) return null;
  try {
    return redact(JSON.parse(buffer.toString('utf8')));
  } catch {
    return null;
  }
}

const killedKeys = new Set();

function forceStop(args, url, key) {
  if (!args.killPackage || !args.killPath || url !== args.killPath) return false;
  // Kill ONE attempt per operation key. The resumed submit is the same key and must reach the
  // server, otherwise the proxy would keep killing the proof at the moment it proves recovery.
  const killKey = key ?? '(no key)';
  if (killedKeys.has(killKey)) {
    writeLine(args.log, { event: 'force-stop-skipped', package: args.killPackage, key, reason: 'repeat-key' });
    return false;
  }
  writeLine(args.log, { event: 'force-stop-before-forward', package: args.killPackage, key });
  const target = ['-s', args.serial];
  execFileSync(
    args.adb,
    [...target, 'shell', 'am', 'force-stop', args.killPackage],
    { timeout: 20_000, stdio: 'ignore' },
  );
  killedKeys.add(killKey);
  return true;
}

const args = parseArgs(process.argv.slice(2));
const target = new URL(args.target);
if (!isLoopbackHost(target.hostname) && !args.allowRemote) {
  throw new Error('refusing a non-loopback --target without --allow-remote');
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const key = req.headers['idempotency-key'] ?? null;
    const url = req.url ?? '/';

    writeLine(args.log, {
      event: 'request',
      method: req.method,
      url,
      key,
      body: parseBody(body, req.headers['content-type']),
    });

    // Fully received, logged, and the client is gone before the server can answer. An adb failure
    // is recorded instead of crashing the proxy: the request must still reach the server, and the
    // device step will fail because the app is still running.
    try {
      forceStop(args, url, key);
    } catch (err) {
      writeLine(args.log, {
        event: 'force-stop-error',
        package: args.killPackage,
        key,
        message: err.message,
      });
    }

    const upstream = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const forwarded = upstream(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: url,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        writeLine(args.log, {
          event: 'response',
          method: req.method,
          url,
          key,
          status: upstreamRes.statusCode,
        });
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    forwarded.on('error', (err) => {
      writeLine(args.log, {
        event: 'upstream-error',
        method: req.method,
        url,
        key,
        message: err.message,
      });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Proxy target failed' } }));
    });

    forwarded.end(body);
  });
});

server.listen(args.listen, '127.0.0.1', () => {
  writeLine(args.log, {
    event: 'listening',
    listen: args.listen,
    target: args.target,
    killPackage: args.killPackage,
    killPath: args.killPath,
  });
  console.log(`[proxy] 127.0.0.1:${args.listen} -> ${args.target}; log ${args.log}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
