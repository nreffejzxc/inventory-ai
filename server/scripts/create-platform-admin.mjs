// Create ONE Platform Operations administrator.
//
//   PLATFORM_ADMIN_CONFIRM=create-platform-admin \
//   PLATFORM_ADMIN_OPERATOR=owner@example.com \
//   PLATFORM_ADMIN_EMAIL=ops@example.com \
//   PLATFORM_ADMIN_NAME='Ops Lead' \
//   PLATFORM_ADMIN_ROLE=SUPERADMIN \
//   PLATFORM_ADMIN_PASSWORD='<at least 16 characters>' \
//     npm run platform-admin:create
//
// PLATFORM_ADMIN_OPERATOR is the human identity recorded on the one
// platform.admin.created audit event. PLATFORM_ADMIN_GRANT_ID is optional and
// records the short-lived grant when the creation was approved through one.
//
// Production additionally requires PLATFORM_ADMIN_PROD_CONFIRM=CREATE-PLATFORM-ADMIN.
//
// THE PASSWORD IS READ FROM THE ENVIRONMENT ONLY. It is never printed, written
// to a file, passed on the command line (shell history) or logged. The script
// prints the new row's id, email and role — never the hash or the password.
//
// THIS IS NOT A ROUTE. Platform administrator creation is a deliberate operator
// action with a confirmation phrase, not a self-service signup. There is no HTTP
// endpoint that creates a PlatformAdmin.

import 'dotenv/config';

import { connectDatabase, disconnectDatabase } from '../src/config/db.ts';
import env from '../src/config/env.ts';
import {
  createPlatformAdminAccount,
  toPublicPlatformAdmin,
} from '../src/services/platformAuth.service.ts';
import { PLATFORM_ROLE_VALUES, PLATFORM_ROLES } from '../src/constants/platformRoles.ts';

const CONFIRM_PHRASE = 'create-platform-admin';
const PRODUCTION_CONFIRM_PHRASE = 'CREATE-PLATFORM-ADMIN';

function fail(message) {
  console.error(`[platform-admin] ${message}`);
  process.exitCode = 1;
}

const confirm = (process.env.PLATFORM_ADMIN_CONFIRM || '').trim();
if (confirm !== CONFIRM_PHRASE) {
  fail(`Refusing to create an administrator. Set PLATFORM_ADMIN_CONFIRM=${CONFIRM_PHRASE}.`);
  process.exit(1);
}

if (env.nodeEnv === 'production') {
  const productionConfirm = (process.env.PLATFORM_ADMIN_PROD_CONFIRM || '').trim();
  if (productionConfirm !== PRODUCTION_CONFIRM_PHRASE) {
    fail(
      `Refusing to create an administrator in production without PLATFORM_ADMIN_PROD_CONFIRM=${PRODUCTION_CONFIRM_PHRASE}.`,
    );
    process.exit(1);
  }
}

const email = process.env.PLATFORM_ADMIN_EMAIL || '';
const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
const operator = (process.env.PLATFORM_ADMIN_OPERATOR || '').trim();
const grantId = (process.env.PLATFORM_ADMIN_GRANT_ID || '').trim() || null;
const role = (process.env.PLATFORM_ADMIN_ROLE || PLATFORM_ROLES.SUPERADMIN).trim();
const name = (process.env.PLATFORM_ADMIN_NAME || email.split('@')[0] || '').trim();

if (!operator) {
  fail('Set PLATFORM_ADMIN_OPERATOR to the human identity creating this administrator.');
  process.exit(1);
}

if (!PLATFORM_ROLE_VALUES.includes(role)) {
  fail(`PLATFORM_ADMIN_ROLE must be one of: ${PLATFORM_ROLE_VALUES.join(', ')}`);
  process.exit(1);
}

let connected = false;
try {
  connected = await connectDatabase();
  if (!connected) {
    fail('MONGODB_URI is not configured; nothing was created.');
    process.exit(1);
  }

  const admin = await createPlatformAdminAccount({
    email,
    name,
    password,
    role,
    audit: { operator, source: 'cli', grantId },
  });
  const dto = toPublicPlatformAdmin(admin);
  console.log(
    `[platform-admin] created ${dto.email} (${dto.role}) with id ${dto.id}. ` +
      'The password was not stored in plaintext and was not printed. ' +
      'One platform.admin.created audit event was recorded.',
  );
} catch (err) {
  // The service's ApiError messages are safe (no password, no hash, no URI).
  fail(err instanceof Error ? err.message : 'creation failed');
  process.exitCode = 1;
} finally {
  if (connected) await disconnectDatabase();
}
