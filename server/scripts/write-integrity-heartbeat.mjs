// `node scripts/write-integrity-heartbeat.mjs --with-production`
//
// Publish the monitor's latest local result to the one operational heartbeat
// document read by `/api/health/integrity`. This is the hosted half of the
// freshness check: UptimeRobot polls that endpoint and alerts when the laptop
// stops reporting.
//
// WHAT IS WRITTEN. Exactly one document in `integrity_monitor_heartbeats`, with
// the timestamp, audit status and aggregate counts. No inventory, ledger,
// purchase-order, product, location, user or baseline row is touched.
//
// WHY THE WRITER IS SEPARATE. The audit and the monitor remain read-only. This
// script is the only component allowed to write, it has no repair path, and it
// writes only the collection named above.

// Loaded from this script's own location, not process.cwd(): the scheduled
// wrapper runs from the repository root, where there is no `.env`.
import './lib/load-server-env.mjs';
import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';

import env, { DATABASE_NAMES } from '../src/config/env.ts';
import { databasesToCheck } from './seed/lib.mjs';
import {
  INTEGRITY_HEARTBEAT_COLLECTION,
  buildHeartbeat,
  parseHeartbeatArgs,
} from './lib/integrity-heartbeat.mjs';

class NotChecked extends Error {}

const USAGE = `Publish the latest read-only inventory-integrity result to the hosted heartbeat.

Usage:
  node scripts/write-integrity-heartbeat.mjs --with-production [options]

Options:
  --with-production       write the production heartbeat (required)
  --history-dir=<path>    directory holding latest.json (default under LOCALAPPDATA or ~/.local/state)
  --help                  this text

The only write is one document in integrity_monitor_heartbeats. No inventory,
ledger, purchase order, product, location, user or baseline row is touched.
`;

function defaultHistoryDir() {
  const base = process.env.LOCALAPPDATA || `${process.env.HOME || ''}/.local/state`;
  return `${base}/InventoryAI/integrity-audit`;
}

async function main() {
  const args = parseHeartbeatArgs();
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.problems.length > 0) {
    throw new NotChecked(`invalid arguments:\n  ${args.problems.join('\n  ')}`);
  }
  if (!env.mongodbUri) {
    throw new NotChecked('MONGODB_URI is not set. NOT CHECKED (exit 2). Nothing was written.');
  }
  if (env.mongodbDbName === DATABASE_NAMES.test) {
    throw new NotChecked(
      'this shell resolves the TEST database. Point MONGODB_DB_NAME away from test before writing the heartbeat.'
    );
  }

  const [database] = databasesToCheck({
    withProduction: true,
    databaseNames: DATABASE_NAMES,
  });
  const historyDir = args.historyDir || defaultHistoryDir();
  const latestPath = `${historyDir}/latest.json`;
  const latest = JSON.parse(await readFile(latestPath, 'utf8'));
  const heartbeat = buildHeartbeat(latest, { database });
  const { _id, ...fields } = heartbeat;

  await mongoose.connect(env.mongodbUri, {
    dbName: database,
    autoIndex: false,
    autoCreate: false,
  });
  try {
    await mongoose.connection.collection(INTEGRITY_HEARTBEAT_COLLECTION).updateOne(
      { _id },
      { $set: fields },
      { upsert: true }
    );
  } finally {
    await mongoose.disconnect();
  }

  console.log(
    `[integrity-heartbeat] ${database} ${heartbeat.status} checkedAt=${heartbeat.checkedAt.toISOString()} ` +
      `new=${heartbeat.newCount} resolved=${heartbeat.resolvedCount}`
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof NotChecked) {
    console.error(`[integrity-heartbeat] NOT CHECKED (exit 2) — ${err.message}`);
  } else {
    console.error(`[integrity-heartbeat] NOT CHECKED (exit 2) — ${err?.message ?? err}`);
  }
  process.exitCode = 2;
}
