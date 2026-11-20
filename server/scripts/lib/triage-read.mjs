// Read-only database evidence for `triage:integrity`.
//
// Keeping the queries here, outside the CLI's argument/connect/exit-code shell,
// lets a DB-backed test prove the exact report a stuck row produces and count the
// collections before and after. This module only reads; the CLI source guard and
// the DB test both fail if a write method is added.

import mongoose from 'mongoose';

import Business from '../../src/models/business.model.ts';
import InventoryTransaction from '../../src/models/inventoryTransaction.model.ts';
import Location from '../../src/models/location.model.ts';
import Product from '../../src/models/product.model.ts';
import StockMovementOperation from '../../src/models/stockMovementOperation.model.ts';
import StockTransferOperation from '../../src/models/stockTransferOperation.model.ts';
import User from '../../src/models/user.model.ts';
import { TRANSFER_LEDGER_QUARANTINE_COLLECTION } from '../../src/services/transferLedgerMigration.service.ts';
import { TRIAGE_DEFAULT_LIMIT } from './triage-integrity.mjs';

function oid(value) {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
}

function add(set, value) {
  if (value != null && String(value)) set.add(String(value));
}

async function resolveNames({ transfers, movements, quarantine, ledgerRows }) {
  const businessIds = new Set();
  const productIds = new Set();
  const locationIds = new Set();
  const userIds = new Set();

  for (const operation of transfers) {
    add(businessIds, operation.businessId);
    add(productIds, operation.productId);
    add(locationIds, operation.fromLocationId);
    add(locationIds, operation.toLocationId);
    add(userIds, operation.createdBy);
  }
  for (const movement of movements) {
    add(businessIds, movement.businessId);
    add(productIds, movement.productId);
    add(locationIds, movement.locationId);
    add(userIds, movement.createdBy);
  }
  for (const row of quarantine) {
    add(businessIds, row.businessId);
    add(productIds, row.productId);
    add(locationIds, row.locationId);
  }
  for (const row of ledgerRows) add(locationIds, row.locationId);

  const [businesses, products, locations, users] = await Promise.all([
    businessIds.size
      ? Business.find({ _id: { $in: [...businessIds] } }).select('name').lean()
      : Promise.resolve([]),
    productIds.size
      ? Product.find({ _id: { $in: [...productIds] } }).select('name sku').lean()
      : Promise.resolve([]),
    locationIds.size
      ? Location.find({ _id: { $in: [...locationIds] } }).select('name').lean()
      : Promise.resolve([]),
    userIds.size
      ? User.find({ _id: { $in: [...userIds] } }).select('name').lean()
      : Promise.resolve([]),
  ]);

  return {
    businesses: new Map(businesses.map((row) => [String(row._id), row.name ?? null])),
    products: new Map(
      products.map((row) => [String(row._id), { name: row.name ?? null, sku: row.sku ?? null }])
    ),
    locations: new Map(locations.map((row) => [String(row._id), row.name ?? null])),
    users: new Map(users.map((row) => [String(row._id), row.name ?? null])),
  };
}

/**
 * Read every row a person needs to review, scoped to one tenant when given.
 * A missing collection is treated as empty: a never-used deployment must be
 * reportable, not "NOT CHECKED".
 */
export async function readAttentionEvidence({
  businessId = null,
  limit = TRIAGE_DEFAULT_LIMIT,
  connection = mongoose.connection,
} = {}) {
  const biz = businessId == null ? null : oid(businessId);
  const transferMatch = { state: 'REQUIRES_ATTENTION' };
  if (biz) transferMatch.businessId = biz;

  const movementMatch = { state: 'REQUIRES_ATTENTION' };
  if (biz) movementMatch.businessId = biz;

  const quarantineMatch = biz ? { businessId: biz } : {};
  const quarantine = await connection
    .collection(TRANSFER_LEDGER_QUARANTINE_COLLECTION)
    .find(quarantineMatch)
    .sort({ quarantinedAt: -1, _id: 1 })
    .limit(limit)
    .toArray();

  const [transfers, movements] = await Promise.all([
    StockTransferOperation.find(transferMatch)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .lean(),
    StockMovementOperation.find(movementMatch)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .lean(),
  ]);

  const operationIds = transfers.map((operation) => operation._id);
  const ledgerRows = operationIds.length
    ? await InventoryTransaction.find({ transferOperationId: { $in: operationIds } })
        .sort({ createdAt: 1, _id: 1 })
        .lean()
    : [];

  const names = await resolveNames({ transfers, movements, quarantine, ledgerRows });
  return { transfers, movements, quarantine, ledgerRows, names };
}
