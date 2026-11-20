// TLI migration fixture — runs against a DISPOSABLE database.
//
// The shared test database already has the unique guard, so duplicates cannot
// be created there. This process builds the exact historical state the migration
// exists for: exact duplicate legs plus one ambiguous group, then proves the
// migration refuses before any write, deduplicates only the exact copies, and
// leaves the unique partial index enforcing the guard.

import mongoose from 'mongoose';

import InventoryTransaction from '../../src/models/inventoryTransaction.model.ts';
import {
  runTransferLedgerMigration,
  TRANSFER_LEDGER_QUARANTINE_COLLECTION,
} from '../../src/services/transferLedgerMigration.service.ts';

const DB_NAME = String(process.env.MIGRATION_DB_NAME || '').trim();
if (!/^inventoryai_mig_[0-9]+_[a-z0-9]+$/.test(DB_NAME)) {
  throw new Error('[tli] MIGRATION_DB_NAME is missing or is not a disposable inventoryai_mig_* name.');
}
const uri = String(process.env.MONGODB_URI || '').trim();
if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
  throw new Error('[tli] MONGODB_URI is missing.');
}

await mongoose.connect(uri, {
  dbName: DB_NAME,
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 15_000,
  connectTimeoutMS: 15_000,
});

let completed = false;
try {
  await mongoose.connection.dropDatabase();

  const businessId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const operationId = new mongoose.Types.ObjectId();
  const ambiguousOperationId = new mongoose.Types.ObjectId();
  const base = {
    businessId,
    productId,
    locationId,
    type: 'TRANSFER',
    previousQuantity: 5,
    newQuantity: 3,
    reason: 'TLI fixture',
    reference: 'TLI-REF',
    transferOperationId: operationId,
    userId,
  };

  await InventoryTransaction.collection.insertMany([
    { ...base, _id: new mongoose.Types.ObjectId(), quantity: 2, createdAt: new Date('2026-01-01T00:00:00Z') },
    { ...base, _id: new mongoose.Types.ObjectId(), quantity: 2, createdAt: new Date('2026-01-01T00:00:01Z') },
    { ...base, _id: new mongoose.Types.ObjectId(), quantity: 2, createdAt: new Date('2026-01-01T00:00:02Z') },
    {
      ...base,
      _id: new mongoose.Types.ObjectId(),
      transferOperationId: ambiguousOperationId,
      quantity: 2,
      createdAt: new Date('2026-01-01T00:00:03Z'),
    },
    {
      ...base,
      _id: new mongoose.Types.ObjectId(),
      transferOperationId: ambiguousOperationId,
      quantity: 4,
      createdAt: new Date('2026-01-01T00:00:04Z'),
    },
  ]);

  const blocked = await runTransferLedgerMigration({ apply: true });
  const rowsAfterBlocked = await InventoryTransaction.countDocuments({});
  const quarantineAfterBlocked = await mongoose.connection
    .collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION)
    .countDocuments({});

  // Remove only the ambiguous fixture rows; the exact group remains for apply.
  await InventoryTransaction.deleteMany({ transferOperationId: ambiguousOperationId });

  // A legacy same-key index that is not the unique partial guard must block
  // before any duplicate is removed, not fail at createIndex after the deletes.
  const legacyIndexName = 'legacy_transfer_ledger_key';
  await InventoryTransaction.collection.createIndex(
    { businessId: 1, transferOperationId: 1, locationId: 1 },
    { name: legacyIndexName }
  );
  const conflicted = await runTransferLedgerMigration({ apply: true });
  const rowsAfterConflict = await InventoryTransaction.countDocuments({});
  const quarantineAfterConflict = await mongoose.connection
    .collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION)
    .countDocuments({});
  await InventoryTransaction.collection.dropIndex(legacyIndexName);

  // A capped scan cannot prove there is no later group. It must refuse before
  // deleting the first page and attempting an index build that cannot succeed.
  const capped = await runTransferLedgerMigration({ apply: true, limit: 1 });
  const rowsAfterCapped = await InventoryTransaction.countDocuments({});

  const applied = await runTransferLedgerMigration({ apply: true });
  const remainingGroupRows = await InventoryTransaction.countDocuments({
    transferOperationId: operationId,
  });
  const quarantined = await mongoose.connection
    .collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION)
    .countDocuments({});

  const ordinary = [1, 2, 3].map(() => ({
    businessId: new mongoose.Types.ObjectId(),
    productId: new mongoose.Types.ObjectId(),
    locationId: new mongoose.Types.ObjectId(),
    type: 'STOCK_IN',
    quantity: 1,
    previousQuantity: 0,
    newQuantity: 1,
    userId,
  }));
  await InventoryTransaction.insertMany(ordinary);
  const ordinaryRowsAccepted = await InventoryTransaction.countDocuments({
    businessId: { $in: ordinary.map((row) => row.businessId) },
  });

  let duplicateRejected = false;
  try {
    await InventoryTransaction.collection.insertOne({
      ...base,
      _id: new mongoose.Types.ObjectId(),
      quantity: 2,
      createdAt: new Date(),
    });
  } catch (err) {
    duplicateRejected = err?.code === 11000;
  }

  const index = (await InventoryTransaction.collection.indexes()).find(
    (entry) => entry.name === 'uniq_transfer_operation_location'
  );

  completed = true;
  console.log(
    JSON.stringify({
      blockedBeforeWrites: blocked.status === 'BLOCKED',
      rowsAfterBlocked,
      quarantineAfterBlocked,
      conflictBlocked: conflicted.status === 'BLOCKED',
      conflictName: conflicted.indexConflict,
      rowsAfterConflict,
      quarantineAfterConflict,
      cappedBlocked: capped.status === 'BLOCKED',
      cappedReason: capped.blockedReason,
      rowsAfterCapped,
      appliedStatus: applied.status,
      quarantined,
      remainingGroupRows,
      ordinaryRowsAccepted,
      duplicateRejected,
      indexUnique: index?.unique === true,
      indexPartialField: index?.partialFilterExpression
        ? Object.keys(index.partialFilterExpression)[0] ?? null
        : null,
      indexKey: index?.key ?? null,
    })
  );
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  if (!completed) process.exitCode = 1;
}
