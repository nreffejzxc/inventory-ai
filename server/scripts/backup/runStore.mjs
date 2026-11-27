// Durable run records for the backup runner, written best-effort.
//
// The backup's job is to produce an archive. A database that is unreachable, or
// a platform console that is not running, must never stop that. So every write
// here is wrapped: a failure is reported on stderr and the run continues.
//
// The connection is opened lazily on the first record and closed by
// `closeRunStore()`, so a run that never reaches the database costs nothing.
import mongoose from 'mongoose';
import 'dotenv/config';

import { resolveDatabaseName, databaseNameInputs } from '../../src/config/env.ts';
import {
  finishBackupRunRecord,
  startBackupRunRecord,
} from '../../src/services/backupRuns.service.ts';

let connecting = null;
let connected = false;

function warn(message) {
  console.warn(`[backup:run-record] ${message}`);
}

async function ensureConnected() {
  if (connected) return true;
  if (!connecting) {
    connecting = (async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is not configured');
      const dbName = resolveDatabaseName(databaseNameInputs());
      await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 8_000 });
      connected = true;
      return true;
    })().catch((error) => {
      connecting = null;
      throw error;
    });
  }
  try {
    await connecting;
    return true;
  } catch (error) {
    warn(`run history unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// BOTH WRITERS REPORT WHETHER THE ROW LANDED. They still never throw — producing the
// archive outranks recording it — but the boolean is what lets the runner distinguish
// "the evidence was written" from "the database was unreachable". The outbound heartbeat
// depends on that distinction: a signal sent after a lost record would claim evidence that
// does not exist.
export async function openRunRecord(input) {
  if (!(await ensureConnected())) return false;
  try {
    await startBackupRunRecord(input);
    return true;
  } catch (error) {
    warn(`could not record the run start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function closeRunRecord(input) {
  if (!(await ensureConnected())) return false;
  try {
    await finishBackupRunRecord(input);
    return true;
  } catch (error) {
    warn(`could not record the run result: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function closeRunStore() {
  connecting = null;
  if (!connected) return;
  connected = false;
  await mongoose.disconnect().catch(() => {});
}

/**
 * The shared connection, for the alert path.
 *
 * Returns false when the database is unreachable: the history cannot be read, so
 * no alert can be derived from it, and the caller stays silent rather than
 * inventing one.
 */
export async function ensureRunStore() {
  return ensureConnected();
}
