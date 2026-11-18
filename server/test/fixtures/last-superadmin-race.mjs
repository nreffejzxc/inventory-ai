// PLAT-8 fixture — runs in its own process against a DISPOSABLE database.
//
// The shared test database holds SUPERADMINs created by other test files running
// in parallel, so "the last active SUPERADMIN" can never be reproduced there.
// This fixture creates only its own two SUPERADMINs in a uniquely named database,
// races the real lifecycle service, and drops the database when it is done.
//
// It prints one JSON line and never any credential or admin email.

import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import PlatformAdmin from '../../src/models/platformAdmin.model.ts';
import PlatformAdminGuard from '../../src/models/platformAdminGuard.model.ts';
import { PLATFORM_ROLES } from '../../src/constants/platformRoles.ts';
import { createPlatformAdminAccount } from '../../src/services/platformAuth.service.ts';
import {
  deletePlatformAdmin,
  setPlatformAdminStatus,
} from '../../src/services/platformAdminLifecycle.service.ts';

const DB_NAME = String(process.env.RACE_DB_NAME || '').trim();
const PASSWORD = 'PlatRaceGuard123!';
const DISABLE_ROUNDS = 10;

function fail(message) {
  throw new Error(`[plat8] ${message}`);
}

if (!/^inventoryai_race_[0-9]+_[a-z0-9]+$/.test(DB_NAME)) {
  fail('RACE_DB_NAME is missing or is not a disposable inventoryai_race_* name.');
}
const uri = String(process.env.MONGODB_URI || '').trim();
if (!/^mongodb(\+srv)?:\/\//i.test(uri)) fail('MONGODB_URI is missing.');

await mongoose.connect(uri, {
  dbName: DB_NAME,
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
});

let completed = false;
try {
  // A fresh database, so the only SUPERADMINs in it are the two this fixture owns.
  await mongoose.connection.dropDatabase();

  const stamp = `${process.pid}-${Date.now()}`;
  const create = (label) =>
    createPlatformAdminAccount({
      email: `plat8-race-${label}-${stamp}@example.com`,
      name: `PLAT8 ${label}`,
      password: PASSWORD,
      role: PLATFORM_ROLES.SUPERADMIN,
    });

  const first = await create('first');
  const second = await create('second');
  // No row needed: the service checks only that the actor is not the target.
  const actorId = new mongoose.Types.ObjectId();

  // 1. ENABLING takes no lease. Hold a live lease and prove a status change to
  //    ACTIVE still completes; a regression that locks every status change would
  //    wait five seconds and then answer 409.
  await PlatformAdmin.updateOne({ _id: second._id }, { $set: { status: 'DISABLED' } });
  await PlatformAdminGuard.updateOne(
    { _id: 'last-active-superadmin' },
    {
      $set: {
        lockToken: 'held-by-another-operation',
        lockExpiresAt: new Date(Date.now() + 60_000),
      },
    },
    { upsert: true },
  );
  const enabledWhileLeased = await setPlatformAdminStatus({
    actorId,
    targetId: String(second._id),
    status: 'ACTIVE',
  });
  assert.equal(enabledWhileLeased.admin.status, 'ACTIVE');
  await PlatformAdminGuard.updateOne(
    { _id: 'last-active-superadmin' },
    { $set: { lockToken: null, lockExpiresAt: null } },
  );

  // 2. A STALE lease is taken over rather than deadlocking the plane.
  await PlatformAdminGuard.updateOne(
    { _id: 'last-active-superadmin' },
    {
      $set: {
        lockToken: 'crashed-holder',
        lockExpiresAt: new Date(Date.now() - 1_000),
      },
    },
    { upsert: true },
  );
  const afterStaleLease = await setPlatformAdminStatus({
    actorId,
    targetId: String(first._id),
    status: 'DISABLED',
  });
  assert.equal(afterStaleLease.admin.status, 'DISABLED');
  await PlatformAdmin.updateOne({ _id: first._id }, { $set: { status: 'ACTIVE' } });
  await PlatformAdmin.updateOne({ _id: second._id }, { $set: { status: 'ACTIVE' } });

  let refusedDisables = 0;
  for (let round = 1; round <= DISABLE_ROUNDS; round += 1) {
    await PlatformAdmin.updateMany(
      { _id: { $in: [first._id, second._id] } },
      { $set: { status: 'ACTIVE' } },
    );

    // Both requests read and write different rows, which is exactly the pair a
    // count-then-write guard lets through. Under the lease one must be refused.
    const outcomes = await Promise.allSettled([
      setPlatformAdminStatus({
        actorId,
        targetId: String(first._id),
        status: 'DISABLED',
      }),
      setPlatformAdminStatus({
        actorId,
        targetId: String(second._id),
        status: 'DISABLED',
      }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(
      fulfilled.length,
      1,
      `round ${round}: expected exactly one disable to commit, got ${fulfilled.length}`,
    );
    assert.equal(rejected.length, 1, `round ${round}: expected exactly one refusal`);
    assert.equal(
      rejected[0].reason && rejected[0].reason.code,
      'PLATFORM_ADMIN_LAST_SUPERADMIN',
      `round ${round}: the refusal must name the last-SUPERADMIN rule`,
    );

    const active = await PlatformAdmin.countDocuments({
      role: PLATFORM_ROLES.SUPERADMIN,
      status: 'ACTIVE',
    });
    assert.equal(active, 1, `round ${round}: ${active} active SUPERADMINs remain, expected 1`);
    refusedDisables += 1;
  }

  // The same rule across the two destructive verbs.
  await PlatformAdmin.updateMany(
    { _id: { $in: [first._id, second._id] } },
    { $set: { status: 'ACTIVE' } },
  );
  const mixed = await Promise.allSettled([
    deletePlatformAdmin({ actorId, targetId: String(first._id) }),
    setPlatformAdminStatus({
      actorId,
      targetId: String(second._id),
      status: 'DISABLED',
    }),
  ]);
  const mixedFulfilled = mixed.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(
    mixedFulfilled.length,
    1,
    `delete/disable race: expected exactly one commit, got ${mixedFulfilled.length}`,
  );
  const activeAfterMixed = await PlatformAdmin.countDocuments({
    role: PLATFORM_ROLES.SUPERADMIN,
    status: 'ACTIVE',
  });
  assert.equal(activeAfterMixed, 1, 'delete/disable race must leave exactly one active SUPERADMIN');

  completed = true;
  console.log(
    JSON.stringify({
      disableRounds: DISABLE_ROUNDS,
      refusedDisables,
      activeAfterDisableRaces: 1,
      deleteRaceFulfilled: mixedFulfilled.length,
      activeAfterDeleteRace: activeAfterMixed,
      enableTookNoLease: true,
      staleLeaseTakenOver: true,
    }),
  );
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  if (!completed) process.exitCode = 1;
}
