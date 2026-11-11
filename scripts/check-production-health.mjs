#!/usr/bin/env node
/**
 * OPS-4 — the external production health probe.
 *
 * This script only READS two public endpoints. It is run by
 * `.github/workflows/production-health-watch.yml` from GitHub's infrastructure, so it
 * keeps working when the Render service, this laptop and the repository's CI are all
 * unavailable. It never prints a response body and never needs a credential.
 *
 * Healthy means BOTH:
 *   - `/api/health/ready` answered 200, and
 *   - `/api/health` answered 200 with `status: "ok"` and `db: "connected"`.
 *
 * A single failed attempt is not enough to alert: the workflow asks for two consecutive
 * failures, which is the deployment-watch guidance in Guide 6. The script always prints
 * one compact JSON object with status codes and the public commit only.
 */

import { pathToFileURL } from 'node:url';

export const DEFAULT_READY_URL = 'https://ai-inventory-l1mi.onrender.com/api/health/ready';
export const DEFAULT_HEALTH_URL = 'https://ai-inventory-l1mi.onrender.com/api/health';

function integer(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function httpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  return parsed.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'cache-control': 'no-cache' },
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // A non-JSON response is still a response; the probe reports its status.
    }
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function publicReading(reading) {
  const body = reading.json && typeof reading.json === 'object' && !Array.isArray(reading.json)
    ? reading.json
    : null;
  return {
    statusCode: reading.status,
    ...(reading.error ? { error: reading.error } : {}),
    ...(body && typeof body.status === 'string' ? { status: body.status } : {}),
    ...(body && typeof body.db === 'string' ? { db: body.db } : {}),
    ...(body && typeof body.commit === 'string' ? { commit: body.commit } : {}),
  };
}

/**
 * Probe both endpoints up to `attempts` times, waiting `delayMs` between failures.
 * Exported so the unit suite can exercise the real decision logic against a local server.
 */
export async function checkProductionHealth(options = {}) {
  const readyUrl = httpUrl(options.readyUrl ?? DEFAULT_READY_URL, 'readyUrl');
  const healthUrl = httpUrl(options.healthUrl ?? DEFAULT_HEALTH_URL, 'healthUrl');
  const attempts = Math.min(Math.max(integer(options.attempts, 2, 1), 1), 5);
  const delayMs = integer(options.delayMs, 20_000, 0);
  const timeoutMs = Math.min(Math.max(integer(options.timeoutMs, 20_000, 1_000), 1_000), 60_000);

  const checks = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [ready, health] = await Promise.all([
      probe(readyUrl, timeoutMs),
      probe(healthUrl, timeoutMs),
    ]);
    const healthStatus = health.json && typeof health.json.status === 'string' ? health.json.status : null;
    const healthDb = health.json && typeof health.json.db === 'string' ? health.json.db : null;
    const healthy = ready.status === 200 && health.status === 200 && healthStatus === 'ok' && healthDb === 'connected';
    checks.push({
      attempt,
      healthy,
      ready: publicReading(ready),
      health: publicReading(health),
    });
    if (healthy) {
      return { healthy: true, attempts, checks };
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { healthy: false, attempts, checks };
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      if (arg === '--help' || arg === '-h') values.help = true;
      continue;
    }
    values[match[1]] = match[2];
  }
  return values;
}

function usage() {
  return [
    'Usage: node scripts/check-production-health.mjs [options]',
    '',
    '  --ready-url=URL     readiness endpoint (default: production)',
    '  --health-url=URL    health endpoint (default: production)',
    '  --attempts=N        consecutive failed probes before exit 1 (default: 2)',
    '  --delay-ms=N        wait between failed probes (default: 20000)',
    '  --timeout-ms=N      per-request timeout (default: 20000)',
    '',
    'Exit 0 healthy, 1 unhealthy, 2 invalid configuration.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  try {
    const result = await checkProductionHealth({
      readyUrl: args['ready-url'],
      healthUrl: args['health-url'],
      attempts: args.attempts,
      delayMs: args['delay-ms'],
      timeoutMs: args['timeout-ms'],
    });
    console.log(JSON.stringify(result, null, 2));
    return result.healthy ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ healthy: false, error: error instanceof Error ? error.message : String(error) }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
