// Local child-process crash-injection harness for the durable audit outbox.
//
// Four boundaries are injected by a child process that writes the durable
// business/receipt state and then dies WITHOUT running the normal hand-off:
//
//   1. import-commit       completed ProductImport, no outbox row / marker
//   2. movement-enqueued   COMPLETED movement + ledger row + outbox row,
//                          no auditEnqueuedAt marker
//   3. po-receipt          OPEN PO receipt with receiveId, no batch outbox row
//   4. audit-in-flight     AuditLog exists, outbox left SENDING with an expired
//                          claim
//
// The parent then runs the real repair/flush functions, concurrently where a
// second delivery is possible, and verifies exactly one AuditLog row per event.
// It only runs against the test database (inventoryai_test_db) and removes the
// rows it created.
//
// Run:
//   cd server
//   npm run test:audit-crash
//
// The focused test is test/AUDIT-CRASH-HARNESS.test.mjs. No commit, deployment,
// production database or production configuration is involved.

import 'dotenv/config';

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import { DATABASE_NAMES } from '../src/config/env.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import AuditOutbox from '../src/models/auditOutbox.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import ProductImport from '../src/models/productImport.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import StockMovementOperation from '../src/models/stockMovementOperation.model.ts';
import {
  enqueueAuditOnce,
  flushAuditOutbox,
} from '../src/services/auditOutbox.service.ts';
import {
  productImportAuditEvent,
  recoverProductImportAudits,
} from '../src/services/productImportAudit.service.ts';
import {
  movementAuditEvent,
  recoverMovementAudits,
} from '../src/services/stockMovementAudit.service.ts';
import { recoverPoReceiveAudits } from '../src/services/purchaseOrderReceiveAudit.service.ts';
import { recordAuditOnce } from '../src/services/audit.service.ts';

const { ObjectId } = mongoose.Types;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const scriptPath = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--child=';

const CASES = ['import-commit', 'movement-enqueued', 'po-receipt', 'audit-in-flight'];

function unique(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${new ObjectId().toString().slice(-8)}`;
}

async function connect(database) {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: database,
    autoIndex: false,
    autoCreate: false,
  });
}

async function childMain(caseName) {
  const database = process.env.MONGODB_DB_NAME;
  if (database !== DATABASE_NAMES.test) {
    throw new Error(`refusing child crash injection outside ${DATABASE_NAMES.test}`);
  }
  const businessId = new ObjectId(process.env.AUDIT_CRASH_BUSINESS_ID);
  const userId = new ObjectId();
  const productId = new ObjectId();
  const locationId = new ObjectId();

  await connect(database);

  if (caseName === 'import-commit') {
    await ProductImport.create({
      businessId,
      key: unique('crash-import'),
      fingerprint: unique('crash-import-fingerprint'),
      fileName: 'crash-import.csv',
      userId,
      status: 'COMPLETED',
      totalRows: 1,
      createdProducts: [{ line: 1, productId }],
      stockOperations: [],
      result: { createdCount: 1, openingStockCount: 0, openingStockUnits: 0 },
      finishedAt: new Date(),
    });
  } else if (caseName === 'movement-enqueued') {
    const receipt = await StockMovementOperation.create({
      businessId,
      requestKey: unique('crash-move'),
      requestFingerprint: unique('crash-move-fingerprint'),
      kind: 'STOCK_IN',
      state: 'COMPLETED',
      createdBy: userId,
      productId,
      locationId,
      quantity: 2,
      previousQuantity: 0,
      newQuantity: 2,
      auditTracked: true,
    });
    const txn = await InventoryTransaction.create({
      businessId,
      productId,
      locationId,
      type: 'STOCK_IN',
      quantity: 2,
      previousQuantity: 0,
      newQuantity: 2,
      reason: 'crash harness',
      userId,
      movementOperationId: receipt._id,
    });
    await StockMovementOperation.updateOne(
      { _id: receipt._id },
      { $set: { inventoryTransactionId: txn._id } },
    );
    const stored = await StockMovementOperation.findById(receipt._id).lean();
    await enqueueAuditOnce(
      movementAuditEvent(
        stored,
        {
          transaction: {
            id: txn._id,
            type: 'STOCK_IN',
            quantity: 2,
            previousQuantity: 0,
            newQuantity: 2,
            productId,
            locationId,
          },
          previousQuantity: 0,
          newQuantity: 2,
        },
        txn._id,
      ),
    );
  } else if (caseName === 'po-receipt') {
    await PurchaseOrder.create({
      businessId,
      number: unique('PO-CRASH'),
      supplierId: new ObjectId(),
      locationId,
      status: 'OPEN',
      items: [
        {
          productId,
          productName: 'Crash harness product',
          quantityOrdered: 3,
          quantityReceived: 1,
          quantityCommitted: 1,
        },
      ],
      claims: [],
      receipts: [
        {
          receivedAt: new Date(),
          userId,
          reference: 'CRASH-HARNESS',
          receiveId: new ObjectId(),
          lines: [
            {
              productId,
              quantity: 1,
              inventoryTransactionId: new ObjectId(),
              previousQuantity: 0,
              newQuantity: 1,
            },
          ],
        },
      ],
    });
  } else if (caseName === 'audit-in-flight') {
    const receipt = await ProductImport.create({
      businessId,
      key: unique('crash-in-flight'),
      fingerprint: unique('crash-in-flight-fingerprint'),
      fileName: 'crash-in-flight.csv',
      userId,
      status: 'COMPLETED',
      totalRows: 1,
      createdProducts: [{ line: 1, productId }],
      stockOperations: [],
      result: { createdCount: 1, openingStockCount: 0, openingStockUnits: 0 },
      finishedAt: new Date(),
    });
    const event = productImportAuditEvent(receipt.toObject());
    const row = await enqueueAuditOnce(event);
    await recordAuditOnce(event);
    await AuditOutbox.collection.updateOne(
      { _id: row._id },
      {
        $set: {
          status: 'SENDING',
          claimedAt: new Date(Date.now() - 2 * 60_000),
        },
      },
    );
  } else {
    throw new Error(`unknown crash case: ${caseName}`);
  }

  // The process dies here, before the normal hand-off can finish. No cleanup,
  // no disconnect and no graceful shutdown: this is the crash being injected.
  process.exit(86);
}

function runChild(caseName, businessId, database) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, `${CHILD_FLAG}${caseName}`], {
      cwd: serverRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_MODE: 'db',
        MONGODB_DB_NAME: database,
        AUDIT_CRASH_BUSINESS_ID: String(businessId),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 86) {
        reject(
          new Error(
            `crash child ${caseName} exited ${code ?? signal}, expected 86\n` +
              `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function cleanup(businessId) {
  await Promise.all([
    AuditLog.deleteMany({ businessId }),
    AuditOutbox.deleteMany({ businessId }),
    ProductImport.deleteMany({ businessId }),
    StockMovementOperation.deleteMany({ businessId }),
    PurchaseOrder.deleteMany({ businessId }),
    InventoryTransaction.deleteMany({ businessId }),
  ]);
}

async function verify(caseName, businessId) {
  if (caseName === 'import-commit') {
    const summary = await recoverProductImportAudits({
      olderThanMs: 0,
      businessId,
      limit: 10,
    });
    const audits = await AuditLog.countDocuments({
      businessId,
      action: 'PRODUCTS_IMPORTED',
    });
    const outbox = await AuditOutbox.find({ businessId }).lean();
    const receipt = await ProductImport.findOne({ businessId }).lean();
    assertExactlyOne(caseName, audits, outbox);
    if (!receipt?.auditEnqueuedAt) throw new Error(`${caseName}: receipt marker missing`);
    return { summary, audits };
  }

  if (caseName === 'movement-enqueued') {
    const summary = await recoverMovementAudits({
      olderThanMs: 0,
      businessId,
      limit: 10,
    });
    const audits = await AuditLog.countDocuments({
      businessId,
      action: 'INVENTORY_STOCK_IN',
    });
    const outbox = await AuditOutbox.find({ businessId }).lean();
    const receipt = await StockMovementOperation.findOne({ businessId }).lean();
    assertExactlyOne(caseName, audits, outbox);
    if (!receipt?.auditEnqueuedAt) throw new Error(`${caseName}: receipt marker missing`);
    return { summary, audits };
  }

  if (caseName === 'po-receipt') {
    const summaries = await Promise.all(
      Array.from({ length: 4 }, () =>
        recoverPoReceiveAudits({ olderThanMs: 0, businessId, limit: 10 }),
      ),
    );
    const audits = await AuditLog.countDocuments({
      businessId,
      action: 'PURCHASE_ORDER_RECEIVED',
    });
    const outbox = await AuditOutbox.find({ businessId }).lean();
    const po = await PurchaseOrder.findOne({ businessId }).lean();
    assertExactlyOne(caseName, audits, outbox);
    if (!po?.receipts?.[0]?.auditEnqueuedAt) {
      throw new Error(`${caseName}: PO receipt marker missing`);
    }
    if (audits === 1) {
      const audit = await AuditLog.findOne({ businessId }).lean();
      if (audit?.metadata?.receivedLines?.length !== 1) {
        throw new Error(`${caseName}: audit did not contain exactly the applied line`);
      }
    }
    return { summaries, audits };
  }

  if (caseName === 'audit-in-flight') {
    const summaries = await Promise.all(
      Array.from({ length: 8 }, () => flushAuditOutbox({ businessId, limit: 10 })),
    );
    const audits = await AuditLog.countDocuments({ businessId });
    const outbox = await AuditOutbox.find({ businessId }).lean();
    assertExactlyOne(caseName, audits, outbox);
    if (outbox[0]?.status !== 'DELIVERED') {
      throw new Error(`${caseName}: outbox did not converge to DELIVERED`);
    }
    return { summaries, audits };
  }

  throw new Error(`unknown crash case: ${caseName}`);
}

function assertExactlyOne(caseName, audits, outbox) {
  if (audits !== 1) {
    throw new Error(`${caseName}: expected exactly one audit row, found ${audits}`);
  }
  if (outbox.length !== 1) {
    throw new Error(`${caseName}: expected exactly one outbox row, found ${outbox.length}`);
  }
  if (outbox[0].status !== 'DELIVERED') {
    throw new Error(`${caseName}: outbox status is ${outbox[0].status}, expected DELIVERED`);
  }
}

/**
 * Run all four child-process crash cases against the test database and return
 * one result per case. The caller must already be connected; this function does
 * not disconnect a caller's connection.
 */
export async function runAuditCrashHarness({
  database = DATABASE_NAMES.test,
  cases = CASES,
} = {}) {
  if (database !== DATABASE_NAMES.test) {
    throw new Error(
      `audit crash harness only runs against ${DATABASE_NAMES.test}; received ${database}`,
    );
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error('audit crash harness requires an active MongoDB connection');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set; nothing was run');
  }

  const results = [];
  for (const caseName of cases) {
    const businessId = new ObjectId();
    try {
      const child = await runChild(caseName, businessId, database);
      const verified = await verify(caseName, businessId);
      results.push({
        case: caseName,
        childExitCode: child.code,
        businessId: String(businessId),
        audits: verified.audits,
        summaries: verified.summaries ?? verified.summary,
      });
    } finally {
      await cleanup(businessId);
    }
  }
  return results;
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npm run test:audit-crash -- [--database=inventoryai_test_db]\n' +
        'Runs four child-process crash windows against the test database only.\n' +
        'Requires MONGODB_URI and the local test database to be reachable.',
    );
    return 0;
  }
  const databaseArg = args.find((arg) => arg.startsWith('--database='));
  const database = databaseArg?.slice('--database='.length) || DATABASE_NAMES.test;
  if (database !== DATABASE_NAMES.test) {
    throw new Error(
      `refusing ${database}; the crash harness only runs against ${DATABASE_NAMES.test}`,
    );
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set; nothing was run');
  }
  await connect(database);
  try {
    const results = await runAuditCrashHarness({ database });
    for (const result of results) {
      console.log(
        `[audit-crash] ${result.case}: child exit=${result.childExitCode} ` +
          `audits=${result.audits} exactly-once=yes`,
      );
    }
    console.log(`[audit-crash] ${results.length}/${results.length} boundaries passed`);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly =
  process.argv[1] != null &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const childArg = process.argv.slice(2).find((arg) => arg.startsWith(CHILD_FLAG));
  if (childArg) {
    const caseName = childArg.slice(CHILD_FLAG.length);
    childMain(caseName).catch((err) => {
      console.error(`[audit-crash] child ${caseName} failed: ${err?.message ?? err}`);
      process.exit(1);
    });
  } else {
    cli()
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(`[audit-crash] ${err?.message ?? err}`);
        process.exitCode = 1;
      });
  }
}
