// FW-01 — bulk catalogue and opening-stock import.
//
// The parser is tested without a database. The HTTP suite runs over the real
// app and MongoDB, and proves the acceptance boundaries: a dry run writes
// nothing, row errors name the physical line, duplicate codes are refused both
// in-file and against the tenant, opening stock becomes real ledger rows, the
// import is idempotent beyond the transport middleware, the audit carries no
// row contents, and another business cannot resolve or write this one's data.

import 'dotenv/config';

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { parseCsv } from '../src/utils/csv.ts';
import Product from '../src/models/product.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import AuditLog from '../src/models/auditLog.model.ts';
import AuditOutbox from '../src/models/auditOutbox.model.ts';
import IdempotencyRecord from '../src/models/idempotencyRecord.model.ts';
import ProductImport from '../src/models/productImport.model.ts';
import {
  markReceiptUnlessCompleted,
  recordImportStockProgress,
  reserveImportProduct,
} from '../src/services/productImport.service.ts';
import productImportService from '../src/services/productImport.service.ts';
import { recordAudit, recordAuditOnce } from '../src/services/audit.service.ts';
import { ROLES } from '../src/constants/roles.ts';

const { ObjectId } = mongoose.Types;

unitSuite('FW-01 CSV parser', () => {
  it('reads quoted commas, newlines and doubled quotes with physical line numbers', () => {
    const parsed = parseCsv(
      '\uFEFFname,sku,description\r\n"Widget, large",W-1,"A ""quoted""\nvalue"\r\nGadget,G-1,plain\r\n',
    );
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.table.headers, ['name', 'sku', 'description']);
    assert.equal(parsed.table.rows.length, 2);
    assert.equal(parsed.table.rows[0].line, 2);
    assert.equal(parsed.table.rows[0].values.name, 'Widget, large');
    assert.equal(parsed.table.rows[0].values.description, 'A "quoted"\nvalue');
    assert.equal(parsed.table.rows[1].line, 4);
  });

  it('refuses an unterminated quote and a file over the row cap', () => {
    const unclosed = parseCsv('name,currency\n"Widget,PHP\n');
    assert.equal(unclosed.problems[0].code, 'CSV_MALFORMED');

    const rows = Array.from({ length: 501 }, (_, i) => `P${i},PHP`).join('\n');
    const tooMany = parseCsv(`name,currency\n${rows}\n`);
    assert.equal(tooMany.problems[0].code, 'CSV_TOO_MANY_ROWS');
  });
});

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

let owner;
let other;
let mainLocation;
let mainCategory;
let memberToken; // MANAGER in the owner's business

async function newCategory(biz, name = uniqueName('CAT')) {
  const res = await api('POST', '/api/categories', { token: biz.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function newLocation(biz, name = uniqueName('LOC')) {
  const res = await api('POST', '/api/locations', { token: biz.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

function csv(rows) {
  return ['name,sku,barcode,category,currency,costprice,sellingprice,minimumstock,openinglocation,openingquantity', ...rows].join('\n');
}

async function postImport(biz, body, key) {
  return api('POST', '/api/products/import', {
    token: biz.token,
    body,
    headers: key ? { 'idempotency-key': key } : undefined,
  });
}

async function getImportStatus(biz, key) {
  return api('GET', `/api/products/import/${encodeURIComponent(key)}`, { token: biz.token });
}

dbSuite('FW-01 product import over real HTTP', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    other = await registerOwner(api, tracker);
    mainLocation = await newLocation(owner);
    mainCategory = await newCategory(owner);
    const manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    memberToken = manager.token;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('dry run validates names and changes nothing', async () => {
    const res = await postImport(owner, {
      fileName: 'catalogue.csv',
      csv: csv([
        `Widget,W-1,111,${mainCategory.name},PHP,5,10,2,${mainLocation.name},7`,
        `Gadget,G-1,222,${mainCategory.name},USD,1.25,3,0,${mainLocation.name},0`,
      ]),
      dryRun: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.valid, true);
    assert.equal(res.json.summary.productCount, 2);
    assert.equal(res.json.summary.openingStockRows, 1);
    assert.equal(res.json.summary.openingStockUnits, 7);

    assert.equal(await Product.countDocuments({ businessId: owner.businessId }), 0);
    assert.equal(await Inventory.countDocuments({ businessId: owner.businessId }), 0);
    assert.equal(await ProductImport.countDocuments({ businessId: owner.businessId }), 0);
  });

  it('reports every invalid row by physical line and writes nothing', async () => {
    const res = await postImport(owner, {
      fileName: 'bad.csv',
      csv: csv([
        `One,DUP-1,301,${mainCategory.name},PHP,1,2,0,${mainLocation.name},0`,
        `Two,DUP-1,302,${mainCategory.name},NOT-A-CURRENCY,1,2,0,${mainLocation.name},0`,
        `Three,DUP-3,303,${mainCategory.name},PHP,1,2,0,,5`,
      ]),
      dryRun: true,
    });
    assert.equal(res.status, 422, JSON.stringify(res.json));
    assert.equal(res.json.code, 'IMPORT_VALIDATION_FAILED');
    const duplicate = res.json.errors.find((e) => e.code === 'DUPLICATE_SKU_IN_FILE');
    assert.equal(duplicate.line, 3);
    assert.match(duplicate.message, /line 2/);
    assert.ok(res.json.errors.some((e) => e.code === 'CURRENCY_INVALID' && e.line === 3));
    assert.ok(res.json.errors.some((e) => e.code === 'OPENING_LOCATION_REQUIRED' && e.line === 4));
    assert.equal(await Product.countDocuments({ businessId: owner.businessId }), 0);
    assert.equal(await InventoryTransaction.countDocuments({ businessId: owner.businessId }), 0);
  });

  it('reports a partial receipt when a retry fails validation after writes', async () => {
    const key = uniqueName('partial-validation');
    const fileName = 'partial-validation.csv';
    const sku = uniqueName('PARTIAL-SKU');
    const productId = new ObjectId();
    const body = {
      fileName,
      csv: csv([
        `Already imported,${sku},,${mainCategory.name},PHP,5,10,2,${mainLocation.name},0`,
        `Bad row,BAD-1,,${mainCategory.name},NOT-A-CURRENCY,1,2,0,${mainLocation.name},0`,
      ]),
      dryRun: false,
    };
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ fileName, csv: body.csv }))
      .digest('hex');

    await Product.create({
      _id: productId,
      businessId: new ObjectId(owner.businessId),
      name: 'Already imported',
      sku,
      currency: 'PHP',
    });
    const receipt = await ProductImport.create({
      businessId: new ObjectId(owner.businessId),
      key,
      fingerprint,
      fileName,
      status: 'PARTIAL',
      totalRows: 2,
      createdProducts: [{ line: 2, productId }],
    });

    const res = await postImport(owner, body, key);
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.code, 'IMPORT_PARTIAL');
    assert.match(res.json.message, /Part of the import was applied/);
    assert.equal(res.json.completed.length, 1);
    assert.equal(res.json.completed[0].line, 2);
    assert.equal(res.json.stock.length, 0);
    assert.ok(res.json.errors.some((e) => e.line === 3 && e.code === 'CURRENCY_INVALID'));

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.status, 'PARTIAL');
    assert.ok(stored.failures.some((e) => e.line === 3));

    // Keep the next test's tenant-wide product count independent of this fixture.
    await ProductImport.deleteOne({ _id: receipt._id });
    await Product.deleteOne({ _id: productId, businessId: new ObjectId(owner.businessId) });
  });

  it('★ keeps one reservation and one stock-progress row under concurrent same-key writes', async () => {
    const receipt = await ProductImport.create({
      businessId: new ObjectId(owner.businessId),
      key: uniqueName('concurrent-progress'),
      fingerprint: 'concurrent-progress-fingerprint',
      fileName: 'concurrent-progress.csv',
      status: 'IN_PROGRESS',
      totalRows: 1,
    });
    const productId = new ObjectId();
    const transactionId = new ObjectId();

    // Both writes are the exact duplicate a second same-key delivery performs.
    // `$push` would append 40 copies; `$addToSet` must keep one.
    await Promise.all(
      Array.from({ length: 40 }, () =>
        reserveImportProduct(receipt._id, 2, String(productId)),
      ),
    );
    await Promise.all(
      Array.from({ length: 40 }, () =>
        recordImportStockProgress(receipt._id, 2, 5, String(transactionId)),
      ),
    );

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.createdProducts.length, 1);
    assert.equal(stored.stockOperations.length, 1);
    assert.equal(String(stored.createdProducts[0].productId), String(productId));
    assert.equal(stored.stockOperations[0].quantity, 5);
    assert.equal(String(stored.stockOperations[0].inventoryTransactionId), String(transactionId));

    await ProductImport.deleteOne({ _id: receipt._id });
  });

  it('★ concurrent duplicate same-key deliveries leave one catalogue and one receipt', async () => {
    // A dedicated tenant keeps this test's eight products out of the fixture
    // counts the older single-import tests assert on the shared owner.
    const importOwner = await registerOwner(api, tracker);
    const importLocation = await newLocation(importOwner);
    const importCategory = await newCategory(importOwner);
    const key = uniqueName('concurrent-http');
    const fileName = 'concurrent-http.csv';
    const skus = Array.from({ length: 8 }, (_, i) => uniqueName(`CONCURRENT-${i}`));
    const body = {
      fileName,
      csv: csv(
        skus.map((sku) => `Concurrent ${sku},${sku},,${importCategory.name},PHP,1,2,0,${importLocation.name},1`),
      ),
      dryRun: false,
    };

    const replies = await Promise.all([postImport(importOwner, body, key), postImport(importOwner, body, key)]);
    for (const reply of replies) {
      assert.ok([200, 201, 409].includes(reply.status), JSON.stringify(reply.json));
    }
    assert.ok(
      replies.some((reply) => reply.status === 200 || reply.status === 201),
      `no delivery applied the import: ${JSON.stringify(replies.map((reply) => reply.json))}`,
    );

    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = await getImportStatus(importOwner, key);
      assert.equal(status.status, 200, JSON.stringify(status.json));
      if (status.json.status === 'COMPLETED' || status.json.status === 'PARTIAL') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.json.status, 'COMPLETED', JSON.stringify(status.json));
    assert.equal(status.json.createdCount, skus.length);
    assert.equal(status.json.openingStockCount, skus.length);

    const receipt = await ProductImport.findOne({
      businessId: new ObjectId(importOwner.businessId),
      key,
    }).lean();
    assert.equal(receipt.createdProducts.length, skus.length);
    assert.equal(receipt.stockOperations.length, skus.length);
    assert.equal(new Set(receipt.createdProducts.map((row) => row.line)).size, skus.length);
    assert.equal(new Set(receipt.createdProducts.map((row) => String(row.productId))).size, skus.length);
    assert.equal(new Set(receipt.stockOperations.map((row) => row.line)).size, skus.length);

    const products = await Product.find({
      businessId: new ObjectId(importOwner.businessId),
      sku: { $in: skus },
    }).lean();
    assert.equal(products.length, skus.length);
    const productIds = products.map((product) => product._id);
    assert.equal(
      await Inventory.countDocuments({
        businessId: new ObjectId(importOwner.businessId),
        productId: { $in: productIds },
      }),
      skus.length,
    );
    assert.equal(
      await InventoryTransaction.countDocuments({
        businessId: new ObjectId(importOwner.businessId),
        productId: { $in: productIds },
        type: 'STOCK_IN',
      }),
      skus.length,
    );

    // The transport row is not the only idempotency guard: a replay after it is
    // removed must return the durable receipt without writing another row.
    await IdempotencyRecord.deleteMany({ businessId: new ObjectId(importOwner.businessId), key });
    const replay = await postImport(importOwner, body, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.createdCount, skus.length);
    assert.equal(
      await Product.countDocuments({ businessId: new ObjectId(importOwner.businessId), sku: { $in: skus } }),
      skus.length,
    );
  });

  it('★ direct concurrent service applies write exactly one import audit row', async () => {
    // The HTTP test above also has the transport idempotency row. Call the service
    // directly, with an already-applied receipt reset to IN_PROGRESS, so two
    // callers race only on finalization: both see every product and stock row as
    // done and both try to close the same key. Only one may append the audit.
    const importOwner = await registerOwner(api, tracker);
    const importLocation = await newLocation(importOwner);
    const importCategory = await newCategory(importOwner);
    const key = uniqueName('concurrent-service');
    const fileName = 'concurrent-service.csv';
    const skus = [uniqueName('SERVICE-A'), uniqueName('SERVICE-B')];
    const request = {
      fileName,
      csv: csv(
        skus.map((sku) => `Service ${sku},${sku},,${importCategory.name},PHP,1,2,0,${importLocation.name},1`),
      ),
      dryRun: false,
    };

    const first = await productImportService.apply(importOwner.businessId, importOwner.userId, key, request);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const businessFilter = { businessId: new ObjectId(importOwner.businessId) };
    await AuditLog.deleteMany({ ...businessFilter, action: 'PRODUCTS_IMPORTED' });
    // This deliberately rewinds a terminal receipt, so its already-DELIVERED
    // outbox hand-off is rewound too; otherwise the re-finalization has no new
    // event to append and the test would not exercise the audit race.
    await AuditOutbox.deleteMany({ ...businessFilter });
    await ProductImport.updateOne(
      { ...businessFilter, key },
      { $set: { status: 'IN_PROGRESS', finishedAt: null, result: null, auditEnqueuedAt: null } },
    );

    const replies = await Promise.all([
      productImportService.apply(importOwner.businessId, importOwner.userId, key, request),
      productImportService.apply(importOwner.businessId, importOwner.userId, key, request),
    ]);
    const applied = replies.filter((reply) => reply.status === 201);
    const replayed = replies.filter((reply) => reply.status === 200);
    assert.equal(replies.length, 2);
    assert.equal(applied.length, 1, JSON.stringify(replies.map((reply) => reply.body)));
    assert.equal(replayed.length, 1, JSON.stringify(replies.map((reply) => reply.body)));

    const stored = await ProductImport.findOne({ ...businessFilter, key }).lean();
    const audits = await AuditLog.find({
      ...businessFilter,
      action: 'PRODUCTS_IMPORTED',
      entityId: String(stored._id),
    }).lean();
    assert.equal(audits.length, 1, `expected one audit row, got ${audits.length}`);
    assert.equal(audits[0].dedupeKey, `product-import:${String(stored._id)}:completed`);
    assert.equal(audits[0].metadata.fileName, fileName);
    assert.equal(audits[0].metadata.createdCount, skus.length);
    assert.equal(audits[0].metadata.openingStockCount, skus.length);

    assert.equal(await Product.countDocuments({ ...businessFilter, sku: { $in: skus } }), skus.length);
    assert.equal(
      await InventoryTransaction.countDocuments({
        ...businessFilter,
        type: 'STOCK_IN',
        reference: `CSV import: ${fileName}`,
      }),
      skus.length,
    );
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.createdProducts.length, skus.length);
    assert.equal(stored.stockOperations.length, skus.length);
  });

  it('★ a completed receipt is terminal under late failure transitions', async () => {
    const importOwner = await registerOwner(api, tracker);
    const key = uniqueName('terminal-receipt');
    const receipt = await ProductImport.create({
      businessId: new ObjectId(importOwner.businessId),
      key,
      fingerprint: 'terminal-receipt-fingerprint',
      fileName: 'terminal.csv',
      status: 'IN_PROGRESS',
      totalRows: 3,
    });
    const result = {
      dryRun: false,
      fileName: 'terminal.csv',
      totalRows: 3,
      createdCount: 3,
      openingStockCount: 2,
      openingStockUnits: 7,
      products: [{ line: 2, id: String(new ObjectId()), name: 'One', sku: 'T-1' }],
    };
    const completed = await markReceiptUnlessCompleted(receipt._id, {
      status: 'COMPLETED',
      result,
      failures: [],
      finishedAt: new Date(),
    });
    assert.ok(completed, 'the first completion must win the receipt');

    // These are the exact late branches that used to overwrite a completed
    // receipt: validation failure, product-create failure and retry startup.
    // Running them together proves none can reopen the terminal state.
    const late = await Promise.all([
      markReceiptUnlessCompleted(receipt._id, {
        status: 'PARTIAL',
        failures: [{ line: 3, code: 'LATE_FAILURE', message: 'late' }],
      }),
      markReceiptUnlessCompleted(receipt._id, {
        status: 'FAILED',
        failures: [{ line: 4, code: 'LATE_FAILURE', message: 'late' }],
      }),
      markReceiptUnlessCompleted(receipt._id, {
        status: 'IN_PROGRESS',
        totalRows: 99,
        failures: [],
      }),
    ]);
    assert.deepEqual(late, [null, null, null]);

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.totalRows, 3);
    assert.deepEqual(stored.failures, []);
    assert.deepEqual(stored.result, result);
    assert.ok(stored.finishedAt instanceof Date);
  });

  it('★ a completed receipt is terminal against late progress writes', async () => {
    const importOwner = await registerOwner(api, tracker);
    const receipt = await ProductImport.create({
      businessId: new ObjectId(importOwner.businessId),
      key: uniqueName('terminal-progress'),
      fingerprint: 'terminal-progress-fingerprint',
      fileName: 'terminal-progress.csv',
      status: 'IN_PROGRESS',
      totalRows: 2,
    });
    const productId = new ObjectId();
    const transactionId = new ObjectId();
    await reserveImportProduct(receipt._id, 2, String(productId));
    await recordImportStockProgress(receipt._id, 2, 4, String(transactionId));
    const completed = await markReceiptUnlessCompleted(receipt._id, {
      status: 'COMPLETED',
      result: { dryRun: false, createdCount: 1, openingStockCount: 1 },
      failures: [],
      finishedAt: new Date(),
    });
    assert.ok(completed);

    await reserveImportProduct(receipt._id, 3, String(new ObjectId()));
    await recordImportStockProgress(receipt._id, 3, 9, String(new ObjectId()));

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.createdProducts.length, 1);
    assert.equal(stored.stockOperations.length, 1);
    assert.equal(stored.stockOperations[0].line, 2);
  });

  it('★ shared audit dedupe closes the replay window across businesses', async () => {
    await AuditLog.init();
    const importOwner = await registerOwner(api, tracker);
    const dedupeKey = uniqueName('audit-dedupe');
    const event = {
      businessId: importOwner.businessId,
      userId: importOwner.userId,
      action: 'PRODUCTS_IMPORTED',
      entityType: 'PRODUCT_IMPORT',
      entityId: String(new ObjectId()),
      metadata: { replay: true },
      dedupeKey,
    };

    const raced = await Promise.all(
      Array.from({ length: 12 }, () => recordAuditOnce(event)),
    );
    assert.equal(new Set(raced.map((row) => String(row._id))).size, 1);
    assert.equal(
      await AuditLog.countDocuments({ businessId: importOwner.businessId, dedupeKey }),
      1,
    );

    // A replay key is tenant-scoped: another business may use the same opaque
    // value without being treated as the first business's duplicate.
    await recordAuditOnce({ ...event, businessId: other.businessId, userId: other.userId });
    assert.equal(await AuditLog.countDocuments({ businessId: other.businessId, dedupeKey }), 1);

    // Ordinary events keep their historical append-only behaviour.
    const noKey = { ...event, dedupeKey: undefined };
    await recordAudit(noKey);
    await recordAudit(noKey);
    assert.equal(
      await AuditLog.countDocuments({ businessId: importOwner.businessId, action: 'PRODUCTS_IMPORTED' }),
      // The dedupe test wrote one, and the two ordinary writes are distinct events.
      3,
    );
  });

  it('★ completion wins a concurrent failure/completion transition', async () => {
    const importOwner = await registerOwner(api, tracker);
    const key = uniqueName('concurrent-completion');
    const receipt = await ProductImport.create({
      businessId: new ObjectId(importOwner.businessId),
      key,
      fingerprint: 'concurrent-completion-fingerprint',
      fileName: 'concurrent-completion.csv',
      status: 'IN_PROGRESS',
      totalRows: 1,
    });
    const result = { dryRun: false, fileName: 'concurrent-completion.csv', createdCount: 1 };

    const [failure, completion] = await Promise.all([
      markReceiptUnlessCompleted(receipt._id, {
        status: 'PARTIAL',
        failures: [{ line: 2, code: 'LATE_FAILURE', message: 'late' }],
      }),
      markReceiptUnlessCompleted(receipt._id, {
        status: 'COMPLETED',
        result,
        failures: [],
        finishedAt: new Date(),
      }),
    ]);
    assert.ok(completion, 'one completion must claim the receipt');
    // If the failure ran first it may have written PARTIAL, but completion still
    // overwrites it. If completion ran first, the failure sees a terminal row and
    // returns null. In both orders the final state must be COMPLETED.
    assert.ok(failure === null || failure.status === 'PARTIAL');

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.status, 'COMPLETED');
    assert.deepEqual(stored.failures, []);
    assert.deepEqual(stored.result, result);
  });

  it('applies products and opening stock once, then replays from the durable receipt', async () => {
    const key = uniqueName('import-key');
    const body = {
      fileName: 'opening.csv',
      csv: csv([
        `Widget,W-1,111,${mainCategory.name},PHP,5,10,2,${mainLocation.name},7`,
        `Gadget,G-1,222,${mainCategory.name},USD,1.25,3,0,${mainLocation.name},0`,
      ]),
      dryRun: false,
    };
    const res = await postImport(owner, body, key);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.createdCount, 2);
    assert.equal(res.json.openingStockCount, 1);
    assert.equal(res.json.openingStockUnits, 7);

    const products = await Product.find({ businessId: owner.businessId }).lean();
    assert.equal(products.length, 2);
    const widget = products.find((p) => p.sku === 'W-1');
    assert.equal(widget.name, 'Widget');
    assert.equal(widget.currency, 'PHP');
    assert.equal(widget.categoryId.toString(), mainCategory.id);

    const movement = await InventoryTransaction.findOne({
      businessId: owner.businessId,
      productId: widget._id,
      type: 'STOCK_IN',
    }).lean();
    assert.ok(movement, 'opening quantity has a ledger transaction');
    assert.equal(movement.quantity, 7);
    assert.equal(movement.reference, 'CSV import: opening.csv');
    assert.equal(await Inventory.countDocuments({ businessId: owner.businessId }), 1);

    const audit = await AuditLog.find({ businessId: owner.businessId, action: 'PRODUCTS_IMPORTED' }).lean();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].metadata.fileName, 'opening.csv');
    assert.equal(audit[0].metadata.createdCount, 2);
    const auditText = JSON.stringify(audit[0].metadata);
    assert.ok(!auditText.includes('Widget'), 'audit must not carry row contents');
    assert.ok(!auditText.includes('W-1'), 'audit must not carry row contents');

    // Prove the receipt, not only the HTTP middleware, prevents a duplicate:
    // remove the transport row and deliver the exact same key and body again.
    await IdempotencyRecord.deleteMany({ businessId: new ObjectId(owner.businessId), key });
    const replay = await postImport(owner, body, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.createdCount, 2);
    assert.equal(replay.json.openingStockCount, 1);
    assert.equal(await Product.countDocuments({ businessId: owner.businessId }), 2);
    assert.equal(await InventoryTransaction.countDocuments({ businessId: owner.businessId }), 1);
    assert.equal(await AuditLog.countDocuments({ businessId: owner.businessId, action: 'PRODUCTS_IMPORTED' }), 1);

    const reused = await postImport(owner, { ...body, fileName: 'different.csv' }, key);
    assert.equal(reused.status, 422, JSON.stringify(reused.json));
    assert.equal(reused.json.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await Product.countDocuments({ businessId: owner.businessId }), 2);

    const status = await getImportStatus(owner, key);
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(status.json.status, 'COMPLETED');
    assert.equal(status.json.fileName, 'opening.csv');
    assert.equal(status.json.totalRows, 2);
    assert.equal(status.json.createdCount, 2);
    assert.equal(status.json.openingStockCount, 1);
    assert.equal(status.json.openingStockUnits, 7);
    assert.equal(status.json.result.createdCount, 2);
  });

  it('recovers a reserved product row when the receipt landed before the create', async () => {
    const key = uniqueName('reserved-key');
    const sku = uniqueName('RESERVED-SKU');
    const body = {
      fileName: 'reserved.csv',
      csv: csv([`Reserved ${sku},${sku},888,${mainCategory.name},PHP,0,0,0,${mainLocation.name},0`]),
      dryRun: false,
    };
    const reservationId = new ObjectId();
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ fileName: 'reserved.csv', csv: body.csv }))
      .digest('hex');
    const receipt = await ProductImport.create({
      businessId: new ObjectId(owner.businessId),
      key,
      fingerprint,
      fileName: 'reserved.csv',
      status: 'IN_PROGRESS',
      totalRows: 1,
      createdProducts: [{ line: 2, productId: reservationId }],
    });

    const res = await postImport(owner, body, key);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.createdCount, 1);
    const product = await Product.findOne({ _id: reservationId, businessId: owner.businessId }).lean();
    assert.ok(product, 'the reserved product was recreated with the same id');
    assert.equal(product.sku, sku);

    const stored = await ProductImport.findById(receipt._id).lean();
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.createdProducts.length, 1);
  });

  it('does not take over a 90-second-old import claim while its window is ten minutes', async () => {
    const key = uniqueName('claim-key');
    const sku = uniqueName('CLAIM-SKU');
    const body = {
      fileName: 'claim.csv',
      csv: csv([`Claim ${sku},${sku},777,${mainCategory.name},PHP,1,2,0,${mainLocation.name},0`]),
      dryRun: false,
    };
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ method: 'POST', path: '/api/products/import', body }))
      .digest('hex');
    await IdempotencyRecord.create({
      businessId: new ObjectId(owner.businessId),
      key,
      fingerprint,
      state: 'IN_PROGRESS',
      createdAt: new Date(Date.now() - 90_000),
    });

    const res = await postImport(owner, body, key);
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.code, 'IDEMPOTENT_REQUEST_IN_PROGRESS');
    assert.equal(await Product.countDocuments({ businessId: owner.businessId, sku }), 0);

    await IdempotencyRecord.deleteOne({ businessId: new ObjectId(owner.businessId), key });
  });

  it('reports in-progress counts and refuses another tenant or an unprivileged role', async () => {
    const key = uniqueName('progress-key');
    const receipt = await ProductImport.create({
      businessId: new ObjectId(owner.businessId),
      key,
      fingerprint: 'progress-fingerprint',
      fileName: 'progress.csv',
      status: 'IN_PROGRESS',
      totalRows: 3,
      createdProducts: [{ line: 2, productId: new ObjectId() }],
      stockOperations: [{ line: 2, quantity: 4 }],
    });

    const status = await getImportStatus(owner, key);
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(status.json.status, 'IN_PROGRESS');
    assert.equal(status.json.createdCount, 1);
    assert.equal(status.json.openingStockCount, 1);
    assert.equal(status.json.openingStockUnits, 4);
    assert.equal(status.json.result, null);

    const foreign = await getImportStatus(other, key);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    assert.equal(foreign.json.code, 'IMPORT_NOT_FOUND');

    const manager = await api('GET', `/api/products/import/${encodeURIComponent(key)}`, {
      token: memberToken,
    });
    assert.equal(manager.status, 403, JSON.stringify(manager.json));

    const malformed = await getImportStatus(owner, 'short');
    assert.equal(malformed.status, 400, JSON.stringify(malformed.json));
    assert.equal(malformed.json.code, 'VALIDATION_ERROR');

    await ProductImport.deleteOne({ _id: receipt._id });
  });

  it('keeps tenant resolution and codes isolated', async () => {
    const ownLocation = await newLocation(other);
    const ownCategory = await newCategory(other);
    const sameSku = await postImport(
      other,
      {
        fileName: 'other.csv',
        csv: csv([`Other Widget,W-1,999,${ownCategory.name},PHP,2,4,0,${ownLocation.name},0`]),
        dryRun: false,
      },
      uniqueName('other-key'),
    );
    assert.equal(sameSku.status, 201, JSON.stringify(sameSku.json));

    const foreignNames = await postImport(
      other,
      {
        fileName: 'foreign-names.csv',
        csv: csv([`Foreign,F-1,998,${mainCategory.name},PHP,2,4,0,${mainLocation.name},0`]),
        dryRun: true,
      },
    );
    assert.equal(foreignNames.status, 422, JSON.stringify(foreignNames.json));
    assert.ok(foreignNames.json.errors.some((e) => e.code === 'CATEGORY_NOT_FOUND'));
    assert.ok(foreignNames.json.errors.some((e) => e.code === 'OPENING_LOCATION_NOT_FOUND'));

    // The owner's list contains its own W-1 and never the other tenant's copy.
    const otherWidget = await Product.findOne({ businessId: other.businessId, sku: 'W-1' }).lean();
    assert.ok(otherWidget);
    const list = await api('GET', '/api/products?limit=100', { token: owner.token });
    assert.equal(list.status, 200);
    assert.ok(list.json.items.some((p) => p.sku === 'W-1'));
    assert.ok(!list.json.items.some((p) => p.id === String(otherWidget._id)));
  });

  it('accepts a CSV above the default JSON body cap but under its own bound', async () => {
    const bigCsv = [
      'name,currency,description',
      ...Array.from({ length: 300 }, (_, i) => `Bulk ${i},PHP,${'x'.repeat(1000)}`),
    ].join('\n');
    assert.ok(Buffer.byteLength(bigCsv, 'utf8') > 100 * 1024, 'fixture must exceed the default 100 KiB body cap');
    assert.ok(Buffer.byteLength(bigCsv, 'utf8') < 512 * 1024, 'fixture must remain a valid CSV size');

    const res = await postImport(owner, { fileName: 'bulk.csv', csv: bigCsv, dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.valid, true);
    assert.equal(res.json.summary.productCount, 300);
  });

  it('enforces OWNER/ADMIN, a required key, and bounded request shape', async () => {
    const managerAttempt = await api('POST', '/api/products/import', {
      token: memberToken,
      body: { fileName: 'x.csv', csv: csv([]), dryRun: true },
    });
    assert.equal(managerAttempt.status, 403, JSON.stringify(managerAttempt.json));

    const missingKey = await postImport(owner, {
      fileName: 'x.csv',
      csv: csv([`NoKey,X-1,333,${mainCategory.name},PHP,0,0,0,${mainLocation.name},0`]),
      dryRun: false,
    });
    assert.equal(missingKey.status, 400, JSON.stringify(missingKey.json));
    assert.equal(missingKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const badShape = await postImport(owner, { fileName: '', csv: '', dryRun: 'yes' });
    assert.equal(badShape.status, 400, JSON.stringify(badShape.json));
    assert.equal(badShape.json.code, 'VALIDATION_ERROR');
    assert.equal(badShape.json.fields.length >= 3, true);
  });
});
