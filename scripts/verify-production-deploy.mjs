#!/usr/bin/env node
/**
 * POST-DEPLOY — read-only verification that Render is serving the merged main SHA
 * and that the process is actually ready.
 *
 * A deploy can report success while the old process is still answering, or while
 * the new process is listening but cannot reach MongoDB / its required ledger
 * index. This script polls the PUBLIC `/api/health` endpoint until its `commit`
 * matches the expected SHA, then checks `/api/health/ready` and
 * `/api/health/live`. It never authenticates, writes, deploys or reads a secret.
 *
 * The expected SHA is normally `github.sha` on a push to main. A full 40-character
 * SHA is recommended; a 7–40 character prefix is accepted for manual checks.
 *
 * Exit codes:
 *   0 verified
 *   1 timeout, SHA mismatch or readiness/liveness failure
 *   2 invalid configuration
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://ai-inventory-l1mi.onrender.com';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 10 * 1000;

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function baseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error('base URL must be an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('base URL must be an http(s) URL');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('base URL must be an origin without a path, query or fragment');
  }
  return parsed.origin;
}

function expectedSha(value) {
  const sha = String(value ?? '').trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('expected SHA must be 7–40 hexadecimal characters');
  }
  return sha.toLowerCase();
}

function integer(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected an integer from ${minimum} to ${maximum}, got ${value}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shaMatches(seen, expected) {
  if (typeof seen !== 'string' || !SHA_PATTERN.test(seen)) return false;
  const normalized = seen.toLowerCase();
  return expected.length === 40 ? normalized === expected : normalized.startsWith(expected);
}

function summarize(reading) {
  if (!reading) return null;
  const body = reading.json && typeof reading.json === 'object' && !Array.isArray(reading.json)
    ? reading.json
    : null;
  return {
    statusCode: reading.statusCode,
    ...(reading.error ? { error: reading.error } : {}),
    ...(body && typeof body.status === 'string' ? { status: body.status } : {}),
    ...(body && typeof body.db === 'string' ? { db: body.db } : {}),
    ...(body && typeof body.commit === 'string' ? { commit: body.commit } : {}),
    ...(body && typeof body.reason === 'string' ? { reason: body.reason } : {}),
  };
}

async function readJson(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // A non-JSON response is still a response; the verifier reports its status.
    }
    return { statusCode: response.status, json };
  } catch (error) {
    return {
      statusCode: 0,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Poll until the deployed commit matches, then verify readiness and liveness.
 * Exported so the unit suite can exercise the real decision logic against a local
 * server without touching production.
 */
export async function verifyProductionDeploy(options = {}) {
  const sha = expectedSha(options.sha);
  const origin = baseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = integer(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 30 * 60 * 1000);
  const intervalMs = integer(options.intervalMs, DEFAULT_INTERVAL_MS, 0, 60_000);
  const requestTimeoutMs = integer(options.requestTimeoutMs, 10_000, 1_000, 60_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();

  let attempts = 0;
  let lastHealth = null;
  let lastReady = null;
  let lastLive = null;
  let lastSeenCommit = null;
  let sawExpectedSha = false;
  let sawMismatch = false;

  const base = {
    expectedSha: sha,
    baseUrl: origin,
  };

  while (true) {
    attempts += 1;
    // A failed result describes the LAST attempt: never carry a previous
    // attempt's readiness/liveness response into the failure report.
    lastReady = null;
    lastLive = null;
    lastHealth = await readJson(fetchImpl, `${origin}/api/health`, requestTimeoutMs);
    const healthBody = lastHealth.json && typeof lastHealth.json === 'object' ? lastHealth.json : null;
    lastSeenCommit = healthBody && typeof healthBody.commit === 'string' ? healthBody.commit : null;
    const healthOk = lastHealth.statusCode === 200 && healthBody?.status === 'ok';
    const dbConnected = healthBody?.db === 'connected';
    const commitMatches = shaMatches(lastSeenCommit, sha);
    if (commitMatches) sawExpectedSha = true;

    if (healthOk && dbConnected && commitMatches) {
      [lastReady, lastLive] = await Promise.all([
        readJson(fetchImpl, `${origin}/api/health/ready`, requestTimeoutMs),
        readJson(fetchImpl, `${origin}/api/health/live`, requestTimeoutMs),
      ]);
      const readyBody = lastReady.json && typeof lastReady.json === 'object' ? lastReady.json : null;
      const liveBody = lastLive.json && typeof lastLive.json === 'object' ? lastLive.json : null;
      if (
        lastReady.statusCode === 200 &&
        readyBody?.status === 'ready' &&
        readyBody?.db === 'connected' &&
        lastLive.statusCode === 200 &&
        liveBody?.status === 'live'
      ) {
        return {
          ...base,
          verified: true,
          attempts,
          elapsedMs: Date.now() - startedAt,
          health: summarize(lastHealth),
          readiness: summarize(lastReady),
          liveness: summarize(lastLive),
        };
      }
    } else if (lastSeenCommit && !commitMatches) {
      sawMismatch = true;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return {
        ...base,
        verified: false,
        attempts,
        elapsedMs: elapsed,
        reason: sawExpectedSha ? 'health_check_failed' : sawMismatch ? 'sha_mismatch' : 'timeout',
        lastSeenCommit,
        health: summarize(lastHealth),
        readiness: summarize(lastReady),
        liveness: summarize(lastLive),
      };
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

function parseArgs(argv) {
  const values = {};
  const allowed = new Set([
    'sha',
    'base-url',
    'timeout-ms',
    'interval-ms',
    'request-timeout-ms',
    'json',
    'help',
  ]);
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      values.help = true;
      continue;
    }
    if (arg === '--json') {
      values.json = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`unknown argument: ${arg}`);
    }
    values[match[1]] = match[2];
  }
  return values;
}

function usage() {
  return [
    'Usage: node scripts/verify-production-deploy.mjs --sha=<expected> [options]',
    '',
    '  --sha=HASH              expected merged main SHA (7–40 hex characters, required)',
    '  --base-url=URL          deployment origin (default: production)',
    '  --timeout-ms=N          total polling budget (default: 600000)',
    '  --interval-ms=N         wait between polls (default: 10000)',
    '  --request-timeout-ms=N  per-request timeout (default: 10000)',
    '  --json                  print the result as one JSON object',
    '',
    'Exit 0 verified, 1 timeout/mismatch/health failure, 2 invalid configuration.',
  ].join('\n');
}

function humanResult(result) {
  if (result.verified) {
    return [
      `VERIFIED ${result.expectedSha} after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
      `  health=${result.health.statusCode} ready=${result.readiness.statusCode} live=${result.liveness.statusCode} db=${result.readiness.db}`,
    ].join('\n');
  }
  const readiness = result.readiness
    ? `ready=${result.readiness.statusCode}${result.readiness.reason ? ` (${result.readiness.reason})` : ''}`
    : 'ready=not checked';
  return [
    `FAIL: ${result.reason} after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
    `  expected SHA: ${result.expectedSha}`,
    `  last commit:  ${result.lastSeenCommit ?? 'none reported'}`,
    `  health=${result.health?.statusCode ?? 'not checked'} ${readiness} live=${result.liveness?.statusCode ?? 'not checked'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  try {
    const result = await verifyProductionDeploy({
      sha: args.sha,
      baseUrl: args['base-url'],
      timeoutMs: args['timeout-ms'],
      intervalMs: args['interval-ms'],
      requestTimeoutMs: args['request-timeout-ms'],
    });
    console.log(args.json ? JSON.stringify(result) : humanResult(result));
    return result.verified ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
