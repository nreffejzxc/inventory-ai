// Last-resort reset for ONE Platform Operations administrator.
//
// This is for the case where the only administrator has lost the password,
// every TOTP/WebAuthn factor and every recovery code. It is an operator action,
// not a route: it requires the database credential and a deliberate phrase.
//
//   PLATFORM_BREAK_GLASS_CONFIRM=reset-platform-admin \
//   PLATFORM_BREAK_GLASS_DB=inventoryai \
//   PLATFORM_BREAK_GLASS_EMAIL=ops@example.com \
//   PLATFORM_BREAK_GLASS_PASSWORD='<at least 16 characters>' \
//     npm run platform-admin:break-glass
//
// Production additionally requires:
//   PLATFORM_BREAK_GLASS_PROD_CONFIRM=BREAK-GLASS-PLATFORM-ADMIN
//
// The new password is read from the environment only. It is never printed,
// written to a file or passed on the command line. The script prints the target
// administrator's id, email, role and status — never a password or hash.
//
// The reset clears TOTP, WebAuthn keys, recovery codes, lockout counters and
// every existing platform session. The administrator must then enroll MFA again
// and generate a new set of recovery codes before the console unlocks. A
// DISABLED administrator stays disabled; this is not a lifecycle override.

import 'dotenv/config';

import { connectDatabase, disconnectDatabase } from '../src/config/db.ts';
import env from '../src/config/env.ts';
import { breakGlassPlatformAdmin } from '../src/services/platformBreakGlass.service.ts';

const CONFIRM_PHRASE = 'reset-platform-admin';
const PRODUCTION_CONFIRM_PHRASE = 'BREAK-GLASS-PLATFORM-ADMIN';

function fail(message) {
  console.error(`[platform-break-glass] ${message}`);
  process.exitCode = 1;
}

const confirm = (process.env.PLATFORM_BREAK_GLASS_CONFIRM || '').trim();
if (confirm !== CONFIRM_PHRASE) {
  fail(`Refusing to reset an administrator. Set PLATFORM_BREAK_GLASS_CONFIRM=${CONFIRM_PHRASE}.`);
  process.exit(1);
}

if (env.nodeEnv === 'production') {
  const productionConfirm = (process.env.PLATFORM_BREAK_GLASS_PROD_CONFIRM || '').trim();
  if (productionConfirm !== PRODUCTION_CONFIRM_PHRASE) {
    fail(
      `Refusing a production reset without PLATFORM_BREAK_GLASS_PROD_CONFIRM=${PRODUCTION_CONFIRM_PHRASE}.`,
    );
    process.exit(1);
  }
}

// Name the database explicitly. A reset must never happen merely because the
// process inherited a different MONGODB_URI or MONGODB_DB_NAME than intended.
const namedDatabase = (process.env.PLATFORM_BREAK_GLASS_DB || '').trim();
if (!namedDatabase || namedDatabase !== env.mongodbDbName) {
  fail(
    `Refusing to reset without PLATFORM_BREAK_GLASS_DB equal to the resolved database (${env.mongodbDbName}).`,
  );
  process.exit(1);
}

const email = (process.env.PLATFORM_BREAK_GLASS_EMAIL || '').trim();
const newPassword = process.env.PLATFORM_BREAK_GLASS_PASSWORD || '';
const operator = (process.env.PLATFORM_BREAK_GLASS_OPERATOR || 'operator-cli').trim();
if (!email) {
  fail('PLATFORM_BREAK_GLASS_EMAIL is required.');
  process.exit(1);
}
if (!newPassword) {
  fail('PLATFORM_BREAK_GLASS_PASSWORD is required.');
  process.exit(1);
}

let connected = false;
try {
  connected = await connectDatabase();
  if (!connected) {
    fail('MONGODB_URI is not configured; nothing was reset.');
    process.exit(1);
  }

  const result = await breakGlassPlatformAdmin({ email, newPassword, operator });
  console.log(
    `[platform-break-glass] reset ${result.email} (${result.role}, ${result.status}) with id ${result.id}; ` +
      `${result.sessionsRevoked} session(s) revoked. ` +
      'MFA, security keys and recovery codes were cleared; the administrator must enroll again.',
  );
} catch (err) {
  // Service messages are safe: no password, hash or connection URI.
  fail(err instanceof Error ? err.message : 'reset failed');
  process.exitCode = 1;
} finally {
  if (connected) await disconnectDatabase();
}
