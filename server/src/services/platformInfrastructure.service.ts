import mongoose from 'mongoose';

import { getDatabaseName, getDatabaseState, isDatabaseReady } from '../config/db.ts';
import { buildInfo, integrationReport } from '../config/deploymentReadiness.ts';
import { isPlatformAuthConfigured } from '../config/platformJwt.ts';
import { isPlatformMfaConfigured } from '../config/platformSecurity.ts';
import { operationalCounters } from '../config/operationalCounters.ts';

type DbStats = {
  available: boolean;
  collections: number | null;
  objects: number | null;
  dataSizeBytes: number | null;
  storageSizeBytes: number | null;
  indexes: number | null;
  indexSizeBytes: number | null;
  avgObjectSizeBytes: number | null;
  pingMs: number | null;
  note: string;
};

type Cache = { at: number; stats: DbStats };
let cache: Cache | null = null;
const CACHE_MS = 30_000;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

async function readDbStats(): Promise<DbStats> {
  if (!isDatabaseReady()) {
    return {
      available: false,
      collections: null,
      objects: null,
      dataSizeBytes: null,
      storageSizeBytes: null,
      indexes: null,
      indexSizeBytes: null,
      avgObjectSizeBytes: null,
      pingMs: null,
      note: 'Database is not connected; storage statistics are unavailable.',
    };
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.stats;
  const started = performance.now();
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db handle');
    const raw = (await db.command({ dbStats: 1, scale: 1 })) as Record<string, unknown>;
    const stats: DbStats = {
      available: true,
      collections: numberOrNull(raw.collections),
      objects: numberOrNull(raw.objects),
      dataSizeBytes: numberOrNull(raw.dataSize),
      storageSizeBytes: numberOrNull(raw.storageSize),
      indexes: numberOrNull(raw.indexes),
      indexSizeBytes: numberOrNull(raw.indexSize),
      avgObjectSizeBytes: numberOrNull(raw.avgObjSize),
      pingMs: Math.max(0, Math.round(performance.now() - started)),
      note: 'Read-only MongoDB dbStats aggregate; cached for 30 seconds.',
    };
    cache = { at: Date.now(), stats };
    return stats;
  } catch {
    const stats: DbStats = {
      available: false,
      collections: null,
      objects: null,
      dataSizeBytes: null,
      storageSizeBytes: null,
      indexes: null,
      indexSizeBytes: null,
      avgObjectSizeBytes: null,
      pingMs: null,
      note: 'The database did not permit a read-only dbStats call for this process.',
    };
    cache = { at: Date.now(), stats };
    return stats;
  }
}

/**
 * PLAT-6 — infrastructure facts that are actually observable from this process.
 *
 * CPU is the process's average CPU time since boot, not host utilisation; memory
 * is the Node process heap/RSS. Backup status, Atlas alerts, query-profile data
 * and per-instance host metrics are not available without an Atlas API key or a
 * shared metrics store, so they are deliberately absent rather than invented.
 */
export async function getPlatformInfrastructure() {
  const stats = await readDbStats();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const uptime = Math.max(1, process.uptime());
  const build = buildInfo();
  const integrations = integrationReport();
  return {
    process: {
      status: 'ok',
      uptimeSeconds: build.uptimeSeconds,
      nodeVersion: process.version,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      cpuPercent: Math.round(((cpu.user + cpu.system) / 1_000_000 / uptime) * 1000) / 10,
      note: 'Process CPU average since boot; not host or container utilisation.',
    },
    database: {
      state: getDatabaseState(),
      name: getDatabaseName(),
      ready: isDatabaseReady(),
      ...stats,
    },
    build: {
      commit: build.commit,
      environment: process.env.NODE_ENV || 'unknown',
    },
    integrations: {
      aiConfigured: integrations.ai,
      aiProvider: integrations.aiProvider || null,
      mailConfigured: integrations.mail,
      mailProvider: integrations.mailProvider || null,
      firebaseConfigured: integrations.firebase,
      emailVerificationConfigured: integrations.emailVerification,
      platformAuthConfigured: isPlatformAuthConfigured(),
      platformMfaConfigured: isPlatformMfaConfigured(),
    },
    counters: operationalCounters(),
    checks: [
      {
        key: 'api',
        label: 'API process',
        status: 'ok',
        detail: 'This response was produced by the API process.',
      },
      {
        key: 'database',
        label: 'MongoDB',
        status: isDatabaseReady() ? 'ok' : 'critical',
        detail: isDatabaseReady() ? 'Connection is ready.' : 'Connection is not ready.',
      },
      {
        key: 'database_stats',
        label: 'Database storage telemetry',
        status: stats.available ? 'ok' : 'warn',
        detail: stats.note,
      },
      {
        key: 'platform_auth',
        label: 'Platform authentication',
        status: isPlatformAuthConfigured() ? 'ok' : 'critical',
        detail: isPlatformAuthConfigured()
          ? 'A separate platform signing secret is configured.'
          : 'PLATFORM_ADMIN_JWT_SECRET is not configured.',
      },
      {
        key: 'platform_mfa',
        label: 'Platform MFA encryption',
        status: isPlatformMfaConfigured() ? 'ok' : 'critical',
        detail: isPlatformMfaConfigured()
          ? 'MFA secrets are encrypted with the platform key.'
          : 'PLATFORM_MFA_ENCRYPTION_KEY is not configured.',
      },
      {
        key: 'ai',
        label: 'AI provider configuration',
        status: integrations.ai ? 'ok' : 'warn',
        detail: integrations.ai
          ? `Provider ${integrations.aiProvider} is configured; live provider health is not probed here.`
          : 'No AI provider is configured.',
      },
      {
        key: 'mail',
        label: 'Transactional mail configuration',
        status: integrations.mail ? 'ok' : 'warn',
        detail: integrations.mail
          ? `Provider ${integrations.mailProvider} is configured; live delivery is not probed here.`
          : 'Mail is not configured; verification and recovery mail are unavailable.',
      },
      {
        key: 'firebase',
        label: 'Firebase Admin configuration',
        status: integrations.firebase ? 'ok' : 'warn',
        detail: integrations.firebase
          ? 'Firebase Admin credentials are configured.'
          : 'Firebase Admin is not configured; email verification is unavailable.',
      },
    ],
    unavailable: [
      'Host CPU utilisation, memory pressure and Atlas cluster metrics require an Atlas/Render metrics credential.',
      'Database backup status and backup verification are not exposed by the current Atlas tier or API.',
      'Mobile crash, install and startup telemetry is not reported by the Android app.',
      'Background job telemetry is unavailable: the application has no durable job/queue store.',
      'Live email, Firebase and AI provider availability is not probed on this read path; only configuration is reported.',
    ],
  };
}

export default { getPlatformInfrastructure };