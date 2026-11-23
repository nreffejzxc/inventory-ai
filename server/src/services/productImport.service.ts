import crypto from 'node:crypto';
import mongoose from 'mongoose';

import Product from '../models/product.model.ts';
import Category from '../models/category.model.ts';
import Location from '../models/location.model.ts';
import ProductImport from '../models/productImport.model.ts';
import { productService } from './product.service.ts';
import { inventoryService } from './inventory.service.ts';
import { enqueueAndDeliverProductImportAudit } from './productImportAudit.service.ts';
import { isProductCurrencyCode } from '../constants/currencies.ts';
import ApiError from '../utils/ApiError.ts';
import { throwValidation } from '../utils/errors.ts';
import { parseCsv, CSV_MAX_BYTES, CSV_MAX_ROWS, type CsvProblem, type CsvRow } from '../utils/csv.ts';

const { ObjectId } = mongoose.Types;

/**
 * FW-01 — bulk catalogue and opening-stock import.
 *
 * The whole file is validated before the first product is written. A dry run
 * uses the same validator and writes nothing. An apply is still a sequence of
 * durable single-product writes, because the project deliberately has no
 * multi-document transactions (see inventory.service.ts); the import receipt
 * records what landed, so a retry resumes and the opening stock uses the
 * existing per-movement receipt. Nothing here silently reports a partial file
 * as complete.
 */

export const IMPORT_COLUMNS = Object.freeze({
  name: 'name',
  sku: 'sku',
  barcode: 'barcode',
  brand: 'brand',
  description: 'description',
  specifications: 'specifications',
  category: 'category',
  unit: 'unit',
  costprice: 'costPrice',
  sellingprice: 'sellingPrice',
  currency: 'currency',
  minimumstock: 'minimumStock',
  openinglocation: 'openingLocation',
  openingquantity: 'openingQuantity',
  imageurl: 'imageUrl',
});

type ImportRequest = {
  fileName: string;
  csv: string;
  dryRun: boolean;
};

type NormalizedRow = {
  line: number;
  name: string;
  sku?: string;
  barcode?: string;
  brand?: string;
  description?: string;
  specifications?: string;
  categoryId?: string;
  unit?: string;
  costPrice?: number;
  sellingPrice?: number;
  currency: string;
  minimumStock: number;
  imageUrl?: string;
  openingLocationId?: string;
  openingQuantity: number;
};

type RowError = CsvProblem;

type ImportResponse = {
  status: number;
  body: Record<string, unknown>;
};

type ValidationResult = {
  rows: NormalizedRow[];
  errors: RowError[];
  totalRows: number;
  fileName: string;
};

type ReceiptLike = {
  _id: unknown;
  fingerprint: string;
  status?: string;
  userId?: unknown;
  createdProducts?: Array<{ line: number; productId: unknown }>;
  stockOperations?: Array<{ line: number; quantity: number; inventoryTransactionId?: unknown }>;
  result?: unknown;
};

/** The progress projection returned by `GET /api/products/import/:key`. */
type ImportStatusRow = {
  key: string;
  status: string;
  fileName: string;
  totalRows?: number;
  createdProducts?: Array<{ line: number }>;
  stockOperations?: Array<{ line: number; quantity: number }>;
  failures?: Array<{ line: number; field?: string | null; code: string; message: string }>;
  result?: unknown;
  finishedAt?: Date | null;
};

const FIELD_LIMITS = {
  name: 120,
  sku: 100,
  barcode: 100,
  brand: 80,
  description: 1000,
  specifications: 1000,
  unit: 30,
  imageUrl: 1000,
} as const;
const CURRENCY_LENGTH = 3;
const MAX_PRICE = 1_000_000_000_000;
const STOCK_REASON = 'CSV import opening stock';

function field(row: CsvRow, key: string): string {
  return String(row.values[key] ?? '').trim();
}

function rowError(line: number, fieldName: string | null, code: string, message: string): RowError {
  return { line, field: fieldName, code, message };
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 11000;
}

function normaliseFileName(value: string): string {
  return value.split(/[\\/]/).pop()?.trim().slice(0, 200) || 'products.csv';
}

function parseMoney(value: string): number | undefined | Error {
  if (value === '') return undefined;
  const n = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return new Error('must be a number between 0 and 1000000000000');
  return n;
}

function parseInteger(value: string, { min = 0 }: { min?: number } = {}): number | Error {
  if (value === '') return min === 0 ? 0 : new Error(`must be a whole number of at least ${min}`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > CSV_MAX_ROWS * 1_000_000) {
    return new Error(`must be a whole number of at least ${min}`);
  }
  return n;
}

function nameLookup<T extends { name?: unknown }>(docs: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const doc of docs) {
    const key = String(doc.name ?? '').trim().toLowerCase();
    if (!key) continue;
    const existing = out.get(key);
    if (existing) existing.push(doc);
    else out.set(key, [doc]);
  }
  return out;
}

/**
 * One validator for preview and apply. It resolves category and location names
 * inside the caller's business (never a client-supplied id), checks duplicate
 * codes inside the file and against existing products, and returns every row
 * error it found before anything is written.
 */
async function validateImport(
  businessId: string,
  request: ImportRequest,
  allowedCreatedProducts: Map<number, string> = new Map(),
): Promise<ValidationResult> {
  const fileName = normaliseFileName(request.fileName);
  const parsed = parseCsv(request.csv);
  if (!parsed.table) {
    return { rows: [], errors: parsed.problems, totalRows: 0, fileName };
  }

  const errors: RowError[] = [];
  const known = new Set(Object.keys(IMPORT_COLUMNS));
  for (const header of parsed.table.headers) {
    if (!known.has(header)) {
      errors.push(
        rowError(1, header, 'UNKNOWN_COLUMN', `"${header}" is not a supported column.`),
      );
    }
  }
  if (!parsed.table.headers.includes('name')) {
    errors.push(rowError(1, 'name', 'MISSING_COLUMN', 'The name column is required.'));
  }
  if (!parsed.table.headers.includes('currency')) {
    errors.push(rowError(1, 'currency', 'MISSING_COLUMN', 'The currency column is required.'));
  }

  const [categories, locations, products] = await Promise.all([
    Category.find({ businessId }).select('_id name status').lean(),
    Location.find({ businessId }).select('_id name status').lean(),
    Product.find({ businessId }).select('_id sku barcode').lean(),
  ]);
  const categoryByName = nameLookup(categories);
  const locationByName = nameLookup(locations);
  const productBySku = new Map<string, { _id: unknown }>();
  const productByBarcode = new Map<string, { _id: unknown }>();
  for (const product of products) {
    if (typeof product.sku === 'string' && product.sku !== '') productBySku.set(product.sku, product);
    if (typeof product.barcode === 'string' && product.barcode !== '') {
      productByBarcode.set(product.barcode, product);
    }
  }

  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  const rows: NormalizedRow[] = [];
  const badLines = new Set<number>();

  for (const row of parsed.table.rows) {
    const before = errors.length;
    const add = (fieldName: string | null, code: string, message: string) => {
      errors.push(rowError(row.line, fieldName, code, message));
    };

    const name = field(row, 'name');
    if (!name) {
      add('name', 'NAME_REQUIRED', 'name is required.');
    } else if (name.length > FIELD_LIMITS.name) {
      add('name', 'NAME_TOO_LONG', `name must be at most ${FIELD_LIMITS.name} characters.`);
    }

    const currencyRaw = field(row, 'currency');
    const currency = currencyRaw.toUpperCase();
    if (!currency) {
      add('currency', 'CURRENCY_REQUIRED', 'currency is required.');
    } else if (currency.length !== CURRENCY_LENGTH || !isProductCurrencyCode(currency)) {
      add('currency', 'CURRENCY_INVALID', 'currency must be a valid ISO 4217 code such as PHP or USD.');
    }

    const sku = field(row, 'sku') || undefined;
    if (sku && sku.length > FIELD_LIMITS.sku) {
      add('sku', 'SKU_TOO_LONG', `sku must be at most ${FIELD_LIMITS.sku} characters.`);
    }
    const barcode = field(row, 'barcode') || undefined;
    if (barcode && barcode.length > FIELD_LIMITS.barcode) {
      add('barcode', 'BARCODE_TOO_LONG', `barcode must be at most ${FIELD_LIMITS.barcode} characters.`);
    }

    for (const key of ['brand', 'description', 'specifications', 'unit'] as const) {
      const value = field(row, key);
      if (value.length > FIELD_LIMITS[key]) {
        add(key, `${key.toUpperCase()}_TOO_LONG`, `${key} must be at most ${FIELD_LIMITS[key]} characters.`);
      }
    }
    const imageUrl = field(row, 'imageurl') || undefined;
    if (imageUrl && imageUrl.length > FIELD_LIMITS.imageUrl) {
      add('imageurl', 'IMAGE_URL_TOO_LONG', `imageUrl must be at most ${FIELD_LIMITS.imageUrl} characters.`);
    }

    const costPrice = parseMoney(field(row, 'costprice'));
    if (costPrice instanceof Error) add('costprice', 'COST_PRICE_INVALID', `costPrice ${costPrice.message}.`);
    const sellingPrice = parseMoney(field(row, 'sellingprice'));
    if (sellingPrice instanceof Error) {
      add('sellingprice', 'SELLING_PRICE_INVALID', `sellingPrice ${sellingPrice.message}.`);
    }
    const minimumStock = parseInteger(field(row, 'minimumstock'));
    if (minimumStock instanceof Error) {
      add('minimumstock', 'MINIMUM_STOCK_INVALID', `minimumStock ${minimumStock.message}.`);
    }
    const openingQuantity = parseInteger(field(row, 'openingquantity'));
    if (openingQuantity instanceof Error) {
      add('openingquantity', 'OPENING_QUANTITY_INVALID', `openingQuantity ${openingQuantity.message}.`);
    }

    const categoryName = field(row, 'category');
    let categoryId: string | undefined;
    if (categoryName) {
      const matches = categoryByName.get(categoryName.toLowerCase()) ?? [];
      if (matches.length === 0) {
        add('category', 'CATEGORY_NOT_FOUND', `No category named "${categoryName}" exists in this business.`);
      } else if (matches.length > 1) {
        add('category', 'CATEGORY_AMBIGUOUS', `More than one category is named "${categoryName}".`);
      } else if (matches[0]!.status !== 'ACTIVE') {
        add('category', 'CATEGORY_ARCHIVED', `The category "${categoryName}" is archived.`);
      } else {
        categoryId = String(matches[0]!._id);
      }
    }

    const openingLocationName = field(row, 'openinglocation');
    let openingLocationId: string | undefined;
    if (openingLocationName) {
      const matches = locationByName.get(openingLocationName.toLowerCase()) ?? [];
      if (matches.length === 0) {
        add(
          'openinglocation',
          'OPENING_LOCATION_NOT_FOUND',
          `No location named "${openingLocationName}" exists in this business.`,
        );
      } else if (matches.length > 1) {
        add('openinglocation', 'OPENING_LOCATION_AMBIGUOUS', `More than one location is named "${openingLocationName}".`);
      } else if (matches[0]!.status !== 'ACTIVE') {
        add('openinglocation', 'OPENING_LOCATION_ARCHIVED', `The location "${openingLocationName}" is archived.`);
      } else {
        openingLocationId = String(matches[0]!._id);
      }
    }
    if (typeof openingQuantity === 'number' && openingQuantity > 0 && !openingLocationName) {
      add('openinglocation', 'OPENING_LOCATION_REQUIRED', 'openingLocation is required when openingQuantity is greater than 0.');
    }

    if (sku) {
      const duplicate = seenSku.get(sku);
      if (duplicate !== undefined) {
        add('sku', 'DUPLICATE_SKU_IN_FILE', `sku "${sku}" also appears on line ${duplicate}.`);
      } else {
        seenSku.set(sku, row.line);
      }
      const existing = productBySku.get(sku);
      if (existing && String(existing._id) !== allowedCreatedProducts.get(row.line)) {
        add('sku', 'SKU_ALREADY_EXISTS', `sku "${sku}" already exists in this business.`);
      }
    }
    if (barcode) {
      const duplicate = seenBarcode.get(barcode);
      if (duplicate !== undefined) {
        add('barcode', 'DUPLICATE_BARCODE_IN_FILE', `barcode "${barcode}" also appears on line ${duplicate}.`);
      } else {
        seenBarcode.set(barcode, row.line);
      }
      const existing = productByBarcode.get(barcode);
      if (existing && String(existing._id) !== allowedCreatedProducts.get(row.line)) {
        add('barcode', 'BARCODE_ALREADY_EXISTS', `barcode "${barcode}" already exists in this business.`);
      }
    }

    if (errors.length > before) badLines.add(row.line);

    if (
      name &&
      currency &&
      !(costPrice instanceof Error) &&
      !(sellingPrice instanceof Error) &&
      !(minimumStock instanceof Error) &&
      !(openingQuantity instanceof Error)
    ) {
      rows.push({
        line: row.line,
        name,
        sku,
        barcode,
        brand: field(row, 'brand') || undefined,
        description: field(row, 'description') || undefined,
        specifications: field(row, 'specifications') || undefined,
        categoryId,
        unit: field(row, 'unit') || undefined,
        costPrice,
        sellingPrice,
        currency,
        minimumStock,
        imageUrl,
        openingLocationId,
        openingQuantity,
      });
    }
  }

  errors.sort((a, b) => a.line - b.line || String(a.field ?? '').localeCompare(String(b.field ?? '')));
  return {
    rows: rows.filter((row) => !badLines.has(row.line)),
    errors,
    totalRows: parsed.table.rows.length,
    fileName,
  };
}

function summaryOf(result: ValidationResult) {
  const openingStockRows = result.rows.filter((row) => row.openingQuantity > 0);
  return {
    totalRows: result.totalRows,
    validRows: result.rows.length,
    errorRows: new Set(result.errors.filter((e) => e.line > 1).map((e) => e.line)).size,
    productCount: result.rows.length,
    openingStockRows: openingStockRows.length,
    openingStockUnits: openingStockRows.reduce((sum, row) => sum + row.openingQuantity, 0),
  };
}

function sampleOf(result: ValidationResult) {
  return result.rows.slice(0, 5).map((row) => ({
    line: row.line,
    name: row.name,
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    currency: row.currency,
    categoryId: row.categoryId ?? null,
    openingLocationId: row.openingLocationId ?? null,
    openingQuantity: row.openingQuantity,
  }));
}

function validationBody(result: ValidationResult, dryRun = true) {
  return {
    dryRun,
    valid: result.errors.length === 0,
    fileName: result.fileName,
    totalRows: result.totalRows,
    validRows: result.rows.length,
    errors: result.errors,
    // The shared mobile client already understands `fields`; keep `errors` as
    // the richer row contract while `fields` makes the same report renderable.
    fields: result.errors.map((e) => ({
      field: e.line > 1 ? `line ${e.line}${e.field ? ` · ${e.field}` : ''}` : e.field ?? 'file',
      message: e.message,
    })),
    summary: summaryOf(result),
    sample: sampleOf(result),
  };
}

function receiptFingerprint(fileName: string, csv: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({ fileName, csv })).digest('hex');
}

function importStockKey(importId: unknown, line: number): string {
  return `import:${String(importId)}:${line}`;
}

/**
 * The product id reserved for one CSV line. It is derived from the durable import
 * receipt, so the SAME line always gets the SAME id on a retry. The receipt gets
 * this id before the product create; if the process dies in between, the retry
 * sees the reservation and can create the missing product without a duplicate
 * SKU refusal. The id is a normal 24-hex ObjectId and is never exposed as a key.
 */
function importProductId(importId: unknown, line: number): mongoose.Types.ObjectId {
  const hex = crypto
    .createHash('sha256')
    .update(`product-import:${String(importId)}:${line}`)
    .digest('hex')
    .slice(0, 24);
  return new ObjectId(hex);
}

async function receiptFor(businessId: string, key: string): Promise<ReceiptLike | null> {
  return ProductImport.findOne({ businessId: new ObjectId(businessId), key }).lean<ReceiptLike>();
}

function createdByLine(receipt: ReceiptLike | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const item of receipt?.createdProducts ?? []) out.set(item.line, String(item.productId));
  return out;
}

function stockByLine(
  operations: Array<{ line: number; quantity: number }> | undefined,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const item of operations ?? []) out.set(item.line, item.quantity);
  return out;
}

/**
 * Every receipt status write goes through this conditional transition. Once a
 * receipt is COMPLETED it is terminal: a late validation failure, product-create
 * failure or opening-stock failure from a concurrent delivery must not rewrite
 * the durable result (or its finishedAt) back to PARTIAL/FAILED/IN_PROGRESS.
 *
 * Returns the updated receipt, or null when the receipt was already completed
 * (or no longer exists). Callers that need a response read the current receipt
 * and replay it.
 */
export async function markReceiptUnlessCompleted(
  receiptId: unknown,
  update: Record<string, unknown>,
): Promise<ReceiptLike | null> {
  return ProductImport.findOneAndUpdate(
    { _id: receiptId, status: { $ne: 'COMPLETED' } },
    { $set: update },
    { returnDocument: 'after' },
  ).lean<ReceiptLike>();
}

async function receiptAfterCompletion(
  receiptId: unknown,
): Promise<ImportResponse> {
  const current = await ProductImport.findById(receiptId).lean<ReceiptLike>();
  if (!current || current.status !== 'COMPLETED') {
    throw new ApiError(
      409,
      'The import receipt changed state before it could be replayed',
      'IMPORT_RECEIPT_STATE_CHANGED',
    );
  }
  return completedResponse(current, true);
}

/**
 * Reserve one CSV line on the durable receipt before its product create. The
 * write is `$addToSet`, not `$push`: two same-key deliveries can both reach this
 * line, and the reservation is identical in both, so it must stay one entry.
 */
export async function reserveImportProduct(
  receiptId: unknown,
  line: number,
  productId: string,
) {
  await ProductImport.updateOne(
    { _id: receiptId, status: { $ne: 'COMPLETED' } },
    { $addToSet: { createdProducts: { line, productId } } },
  );
}

/**
 * Record opening-stock progress after the ledger movement committed. The
 * deterministic movement key prevents a second movement; `$addToSet` prevents a
 * concurrent same-key delivery from appending a second identical progress row.
 */
export async function recordImportStockProgress(
  receiptId: unknown,
  line: number,
  quantity: number,
  inventoryTransactionId: unknown,
) {
  await ProductImport.updateOne(
    { _id: receiptId, status: { $ne: 'COMPLETED' } },
    {
      $addToSet: {
        stockOperations: { line, quantity, inventoryTransactionId },
      },
    },
  );
}

function partialResponse(
  errors: RowError[],
  completed: Map<number, string>,
  stock: Map<number, number>,
): ImportResponse {
  return {
    status: 409,
    body: {
      code: 'IMPORT_PARTIAL',
      message: 'Part of the import was applied. Retry with the same key to finish it.',
      errors,
      fields: errors.map((e) => ({ field: `line ${e.line}`, message: e.message })),
      completed: [...completed.entries()].map(([line, productId]) => ({ line, productId })),
      stock: [...stock.entries()].map(([line, quantity]) => ({ line, quantity })),
    },
  };
}

function completedResponse(receipt: ReceiptLike, replayed: boolean): ImportResponse {
  return {
    status: replayed ? 200 : 201,
    body: {
      ...(receipt.result as Record<string, unknown> | undefined),
      replayed,
    },
  };
}

export const productImportService = {
  /**
   * Validate a request body. This is structural only; the CSV contract itself is
   * checked by `validateImport` so a dry run and an apply cannot disagree.
   */
  validateRequest(body: unknown): ImportRequest {
    const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const problems: { field: string; message: string }[] = [];
    const fileName = typeof data.fileName === 'string' ? data.fileName.trim() : '';
    if (!fileName) problems.push({ field: 'fileName', message: 'fileName is required.' });
    if (fileName.length > 200) problems.push({ field: 'fileName', message: 'fileName must be at most 200 characters.' });
    if (typeof data.csv !== 'string' || data.csv.trim() === '') {
      problems.push({ field: 'csv', message: 'csv is required.' });
    } else if (Buffer.byteLength(data.csv, 'utf8') > CSV_MAX_BYTES) {
      problems.push({
        field: 'csv',
        message: `csv must be at most ${Math.floor(CSV_MAX_BYTES / 1024)} KiB.`,
      });
    }
    if (data.dryRun !== undefined && typeof data.dryRun !== 'boolean') {
      problems.push({ field: 'dryRun', message: 'dryRun must be true or false.' });
    }
    if (problems.length) throwValidation(problems);
    return {
      fileName: normaliseFileName(fileName),
      csv: data.csv as string,
      dryRun: data.dryRun === true,
    };
  },

  /**
   * Progress for one import key, scoped to the caller's business. This is how a
   * client that lost the HTTP answer learns whether the server is still working,
   * finished, or needs the same-key retry. It never returns the CSV, a row's
   * contents or another tenant's receipt: a missing key and a key from another
   * business are the same 404.
   */
  async status(businessId: string, key: string) {
    const receipt = await ProductImport.findOne({
      businessId: new ObjectId(businessId),
      key,
    }).lean<ImportStatusRow>();
    if (!receipt) {
      throw new ApiError(404, 'No import was found for this key', 'IMPORT_NOT_FOUND');
    }

    const createdProducts = receipt.createdProducts ?? [];
    const stockOperations = receipt.stockOperations ?? [];
    return {
      key: receipt.key,
      status: receipt.status,
      fileName: receipt.fileName,
      totalRows: receipt.totalRows ?? 0,
      createdCount: createdProducts.length,
      openingStockCount: stockOperations.length,
      openingStockUnits: stockOperations.reduce((sum, operation) => sum + operation.quantity, 0),
      failures: receipt.failures ?? [],
      finishedAt: receipt.finishedAt ?? null,
      // The full result is useful only once the receipt is terminal; an in-progress
      // client gets counts from the arrays above instead.
      result: receipt.status === 'COMPLETED' ? receipt.result : null,
    };
  },

  async preview(businessId: string, request: ImportRequest): Promise<ImportResponse> {
    const result = await validateImport(businessId, request);
    const valid = result.errors.length === 0;
    return {
      status: valid ? 200 : 422,
      body: {
        ...validationBody(result),
        code: valid ? undefined : 'IMPORT_VALIDATION_FAILED',
        message: valid ? undefined : 'The CSV has validation errors. Nothing was written.',
      },
    };
  },

  /**
   * Apply validated rows. The receipt is created only after the file passes
   * validation, so a typo does not consume an idempotency key. Once created, a
   * retry with the same key and file resumes: products already created are
   * skipped, and opening-stock movements use a deterministic per-line receipt
   * key in `inventoryService.stockIn`.
   */
  async apply(
    businessId: string,
    userId: string,
    key: string | undefined,
    request: ImportRequest,
  ): Promise<ImportResponse> {
    if (!key) {
      throw new ApiError(
        400,
        'An Idempotency-Key header is required to import products',
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }

    const fileName = normaliseFileName(request.fileName);
    const fingerprint = receiptFingerprint(fileName, request.csv);
    let receipt: ReceiptLike | null = await receiptFor(businessId, key);
    if (receipt && receipt.fingerprint !== fingerprint) {
      throw new ApiError(
        422,
        'This idempotency key was already used for a different import file',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    if (receipt && receipt.status === 'COMPLETED') return completedResponse(receipt, true);

    const alreadyCreated = createdByLine(receipt);
    const validation = await validateImport(businessId, request, alreadyCreated);
    if (validation.errors.length > 0) {
      // A receipt can already contain rows when a retry no longer validates, for
      // example because another product took a later row's SKU after the first
      // attempt was interrupted. Saying "nothing was written" in that case would
      // hide the completed products and stock. Only a receipt with no applied
      // work is a clean validation refusal.
      const completedStock = stockByLine(receipt?.stockOperations);
      const hasAppliedWork = alreadyCreated.size > 0 || completedStock.size > 0;
      if (receipt) {
        const updated = await markReceiptUnlessCompleted(receipt._id, {
          status: hasAppliedWork ? 'PARTIAL' : 'FAILED',
          failures: validation.errors,
        });
        if (!updated) return receiptAfterCompletion(receipt._id);
      }
      if (hasAppliedWork) return partialResponse(validation.errors, alreadyCreated, completedStock);
      return {
        status: 422,
        body: {
          ...validationBody(validation, false),
          code: 'IMPORT_VALIDATION_FAILED',
          message: 'The CSV has validation errors. Nothing was written.',
        },
      };
    }

    if (!receipt) {
      try {
        receipt = await ProductImport.create({
          businessId: new ObjectId(businessId),
          key,
          fingerprint,
          fileName,
          userId: new ObjectId(userId),
          status: 'IN_PROGRESS',
          totalRows: validation.totalRows,
        });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        receipt = await receiptFor(businessId, key);
        if (!receipt) throw err;
        if (receipt.fingerprint !== fingerprint) {
          throw new ApiError(
            422,
            'This idempotency key was already used for a different import file',
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        if (receipt.status === 'COMPLETED') return completedResponse(receipt, true);
      }
    }
    const opened = await markReceiptUnlessCompleted(receipt._id, {
      status: 'IN_PROGRESS',
      totalRows: validation.totalRows,
      failures: [],
    });
    if (!opened) return receiptAfterCompletion(receipt._id);
    receipt = opened;

    const created = new Map<number, string>(createdByLine(receipt));
    const stockDone = stockByLine(receipt.stockOperations);

    for (const row of validation.rows) {
      const reserved = created.has(row.line);
      const intendedId = reserved ? created.get(row.line)! : String(importProductId(receipt._id, row.line));

      if (!reserved) {
        // Reserve before creating. If the create commits but this process dies,
        // the next same-key attempt sees the reservation and recreates the same
        // id instead of treating the committed row as an unexplained duplicate.
        await reserveImportProduct(receipt._id, row.line, intendedId);
        created.set(row.line, intendedId);
      } else {
        const exists = await Product.exists({
          _id: new ObjectId(intendedId),
          businessId: new ObjectId(businessId),
        });
        if (exists) continue;
        // The reservation outlived its product: a crash between the receipt
        // reservation and the create, or a create that failed after it landed.
      }

      try {
        await productService.create(
          businessId,
          userId,
          {
            name: row.name,
            brand: row.brand,
            sku: row.sku,
            barcode: row.barcode,
            description: row.description,
            specifications: row.specifications,
            categoryId: row.categoryId,
            costPrice: row.costPrice,
            sellingPrice: row.sellingPrice,
            currency: row.currency,
            unit: row.unit,
            minimumStock: row.minimumStock,
            imageUrl: row.imageUrl,
          },
          { audit: false, id: intendedId },
        );
      } catch (err) {
        // A lost acknowledgement can make a committed insert look like a failure.
        // The reserved id is the proof: if it exists, this row is done.
        const committed = await Product.exists({
          _id: new ObjectId(intendedId),
          businessId: new ObjectId(businessId),
        });
        if (committed) continue;

        // Do not leave a reservation that will never become a product. Earlier
        // rows stay recorded; this row is the explicit failure in the receipt.
        await ProductImport.updateOne(
          { _id: receipt._id, status: { $ne: 'COMPLETED' } },
          { $pull: { createdProducts: { line: row.line } } },
        );
        created.delete(row.line);
        const code = isDuplicateKey(err)
          ? row.sku
            ? 'SKU_ALREADY_EXISTS'
            : 'BARCODE_ALREADY_EXISTS'
          : 'PRODUCT_CREATE_FAILED';
        const internalMessage = String(
          (err as { message?: unknown } | null | undefined)?.message ?? 'unknown error',
        );
        // The response is a customer-facing row error; the provider/database
        // message goes to the operator log only. A duplicate code is safe to
        // name because it was already checked against this tenant's catalogue.
        console.error(`[product-import] line ${row.line} product create failed: ${internalMessage}`);
        const errors = [
          rowError(
            row.line,
            row.sku ? 'sku' : 'barcode',
            code,
            code === 'PRODUCT_CREATE_FAILED'
              ? 'The product could not be created. Nothing else was written for this row; retry with the same key.'
              : 'Another product already uses this code. Refresh the file and try again.',
          ),
        ];
        // Products are archive-only and are never deleted by the application
        // (AGENTS.md §4). A product write that committed before this row failed
        // stays in the catalogue; the receipt makes the partial result explicit
        // and a same-key retry resumes after it. This is never reported as a
        // successful whole-file import.
        const updated = await markReceiptUnlessCompleted(receipt._id, {
          status: 'PARTIAL',
          failures: errors,
        });
        if (!updated) return receiptAfterCompletion(receipt._id);
        return partialResponse(errors, created, stockDone);
      }
    }

    for (const row of validation.rows) {
      if (row.openingQuantity <= 0 || stockDone.has(row.line)) continue;
      if (!row.openingLocationId) {
        const errors = [
          rowError(
            row.line,
            'openinglocation',
            'OPENING_LOCATION_REQUIRED',
            'openingLocation is required when openingQuantity is greater than 0.',
          ),
        ];
        const updated = await markReceiptUnlessCompleted(receipt._id, {
          status: 'PARTIAL',
          failures: errors,
        });
        if (!updated) return receiptAfterCompletion(receipt._id);
        return partialResponse(errors, created, stockDone);
      }
      try {
        const out = await inventoryService.stockIn(businessId, userId, {
          productId: created.get(row.line)!,
          locationId: row.openingLocationId,
          quantity: row.openingQuantity,
          reason: STOCK_REASON,
          reference: `CSV import: ${fileName}`.slice(0, 200),
          idempotencyKey: importStockKey(receipt._id, row.line),
        });
        stockDone.set(row.line, row.openingQuantity);
        await recordImportStockProgress(
          receipt._id,
          row.line,
          row.openingQuantity,
          (out.transaction as { id?: unknown } | undefined)?.id,
        );
      } catch (err) {
        const errCode = (err as { code?: unknown } | null | undefined)?.code;
        const internalMessage = String(
          (err as { message?: unknown } | null | undefined)?.message ?? 'unknown error',
        );
        console.error(`[product-import] line ${row.line} opening stock failed: ${internalMessage}`);
        const errors = [
          rowError(
            row.line,
            'openingquantity',
            typeof errCode === 'string' ? errCode : 'OPENING_STOCK_FAILED',
            err instanceof ApiError
              ? err.message
              : 'The opening stock movement could not be applied. Retry with the same key.',
          ),
        ];
        const updated = await markReceiptUnlessCompleted(receipt._id, {
          status: 'PARTIAL',
          failures: errors,
        });
        if (!updated) return receiptAfterCompletion(receipt._id);
        return partialResponse(errors, created, stockDone);
      }
    }

    const productRows = validation.rows.map((row) => ({
      line: row.line,
      id: created.get(row.line) ?? null,
      name: row.name,
      sku: row.sku ?? null,
    }));
    const result = {
      dryRun: false,
      fileName,
      totalRows: validation.totalRows,
      createdCount: created.size,
      openingStockCount: stockDone.size,
      openingStockUnits: [...stockDone.values()].reduce((sum, quantity) => sum + quantity, 0),
      products: productRows,
    };
    // The receipt is the single-winner claim for this import. Two concurrent
    // same-key deliveries can both reach this point after reading the same
    // IN_PROGRESS receipt; only the caller that changes the status hands the
    // audit event to the durable outbox. The loser returns the durable result as
    // a replay instead of appending a second audit entry.
    const completed = await markReceiptUnlessCompleted(receipt._id, {
      status: 'COMPLETED',
      result,
      failures: [],
      finishedAt: new Date(),
    });
    if (!completed) {
      return receiptAfterCompletion(receipt._id);
    }

    // The outbox row is written before the AuditLog insert. A crash after this
    // point leaves either a PENDING row that the recovery pass delivers, or a
    // completed receipt with no auditEnqueuedAt that the repair scan enqueues.
    // The import response is not turned into a failure by an audit outage.
    await enqueueAndDeliverProductImportAudit({
      _id: String(receipt._id),
      businessId,
      userId,
      fileName,
      totalRows: validation.totalRows,
      createdCount: result.createdCount,
      openingStockCount: result.openingStockCount,
      openingStockUnits: result.openingStockUnits,
    });

    return { status: 201, body: { ...result, replayed: false } };
  },
};

export default productImportService;
