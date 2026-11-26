// `npm run backup:db` — write a recoverable copy of a database to a directory.
//
// READ-ONLY on the database side: this command creates files and never changes,
// drops or indexes a document. That is why it is allowed to point at production
// while `restore:db` is not — see scripts/backup/lib.mjs for the whole rationale.
//
// Usage:
//   BACKUP_DIR=/somewhere/outside/the/repo CONFIRM=backup-db npm run backup:db
//
// Optional:
//   --out=<dir>   same as BACKUP_DIR
//   --db=<name>   only for a dry look at what the script resolved; the connection
//                 target always comes from config/env.ts, never from argv
//
// A failure deletes the half-written directory, so the only directories that survive
// are ones with a complete manifest.
import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import env from '../src/config/env.ts';
import {
  BACKUP_CONFIRM_PHRASE,
  BackupSafetyError,
  assertBackupDir,
  assertConfirm,
  backupDirectoryName,
  createBackup,
  formatBytes,
  removePartialBackup,
} from './backup/lib.mjs';

const COMMAND = 'backup:db';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

function argValue(prefix) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function fail(message) {
  console.error(`[${COMMAND}] ${message}`);
  process.exit(1);
}

async function main() {
  const outDir = argValue('--out=') || process.env.BACKUP_DIR || '';
  const target = assertBackupDir(outDir, { repoRoot });
  assertConfirm(process.env.CONFIRM, BACKUP_CONFIRM_PHRASE);

  const databaseName = env.mongodbDbName;
  const destination = path.join(target, backupDirectoryName(databaseName));

  console.log(`[${COMMAND}] database : ${databaseName}`);
  console.log(`[${COMMAND}] writing  : ${destination}`);

  await mongoose.connect(env.mongodbUri, { dbName: databaseName });

  // The connection is the authority on which database is being read, exactly as the
  // cleanup tools treat it: a URI whose path segment disagreed with `dbName` must fail
  // here rather than produce a confidently mislabelled backup.
  const liveName = mongoose.connection.name;
  if (liveName !== databaseName) {
    await mongoose.disconnect();
    fail(`the live connection is "${liveName}" but "${databaseName}" was resolved — nothing was written.`);
  }

  try {
    const manifest = await createBackup({
      db: mongoose.connection.db,
      outDir: destination,
      databaseName: liveName,
      onCollection: (entry) => {
        console.log(
          `[${COMMAND}]   ${entry.name.padEnd(24)} ${String(entry.count).padStart(8)} docs  ${formatBytes(entry.bytes).padStart(9)}`
        );
      },
    });

    console.log(
      `[${COMMAND}] OK — ${manifest.totals.collections} collection(s), ` +
        `${manifest.totals.documents} document(s), ${formatBytes(manifest.totals.bytes)} on disk ` +
        `(${formatBytes(manifest.totals.uncompressedBytes)} to restore).`
    );
    console.log(`[${COMMAND}] restore with: CONFIRM=restore-db npm run restore:db -- --from=${destination}`);
    await mongoose.disconnect();
  } catch (error) {
    await mongoose.disconnect().catch(() => {});
    await removePartialBackup(destination).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  if (error instanceof BackupSafetyError) fail(error.message);
  fail(error && error.message ? error.message : String(error));
});
