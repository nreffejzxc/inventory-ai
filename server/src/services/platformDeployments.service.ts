import mongoose from 'mongoose';

import { buildInfo } from '../config/deploymentReadiness.ts';
import PlatformDeployment from '../models/platformDeployment.model.ts';

const RETENTION_DAYS = 365;

/** Record this process boot once. Best-effort: monitoring cannot affect serving. */
export async function recordPlatformDeployment(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  const build = buildInfo();
  const uptimeMs = Math.max(0, build.uptimeSeconds * 1000);
  const startedAt = new Date(Date.now() - uptimeMs);
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await PlatformDeployment.updateOne(
      { commit: build.commit, startedAt },
      {
        $setOnInsert: {
          commit: build.commit,
          environment: process.env.NODE_ENV || 'unknown',
          nodeVersion: process.version,
          startedAt,
          recordedAt: new Date(),
          expiresAt,
        },
      },
      { upsert: true },
    );
    return true;
  } catch (err) {
    console.error(
      `[platform-deployments] could not record this boot: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    );
    return false;
  }
}

export async function listPlatformDeployments(limit = 25) {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await PlatformDeployment.find({})
    .sort({ startedAt: -1, _id: -1 })
    .limit(bounded)
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    commit: String(row.commit),
    environment: String(row.environment),
    nodeVersion: String(row.nodeVersion),
    startedAt: row.startedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  }));
}

export default { recordPlatformDeployment, listPlatformDeployments };