// Pure half of `npm run audit:integrity`.
//
// WHAT THIS AUDIT IS FOR. Two failure shapes cannot be seen from the app:
//
//   1. ORPHAN STOCK_IN — a ledger row says stock came in, but the inventory row
//      for its business/product/location does not exist. The movement is then
//      visible in history while nothing is on the shelf. The compensated paths
//      normally remove the transaction with the row, so this is an anomaly, not
//      a legitimate movement.
//
//   2. UNRECEIPTED PO STOCK_IN — a STOCK_IN written by purchase-order receiving
//      (`reason: 'PO receipt'`, `reference: <PO number>`) that no receipt on that
//      purchase order references. Receiving claims first, stock-ins second and
//      finalizes third, all in one request. A finalize that THROWS is deliberately
//      not compensated (the write may have applied), so the database can be left
//      with a durable movement and no receipt. This is the observable signature of
//      that ambiguous finalize. A finalize that applied despite throwing carries a
//      receipt and is therefore NOT reported here.
//
// THIS IS AN AUDIT, NOT A REPAIR. It reports candidates for a human to judge. A
// purchase-order number can be typed into a manual stock-in, and an inventory row
// can be deleted by an operator, so neither finding proves intent. There is no
// `--fix` flag and the module never writes.
//
// No imports: pure so the parser, pipelines and summary can be tested without a
// database.

/** The audit's default is all history: an orphan from last year is still an orphan. */
export const DEFAULT_DAYS = 'all';
export const MAX_DAYS = 3650;
export const PO_RECEIPT_REASON = 'PO receipt';

/** A 24-hex ObjectId. The audit accepts an id, never a name (a name can resolve to two tenants). */
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Reads `--flag=value` from an argv array. Returns `null` when absent. A flag given
 * twice is reported rather than silently choosing one.
 */
function valueOf(flag, argv) {
  const prefix = `${flag}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) return { repeated: true, value: values[0] };
  return values.length === 1 ? { repeated: false, value: values[0] } : null;
}

/**
 * Parse the command line. Pure, and returns `problems` rather than printing or
 * exiting, so every refusal is asserted in a unit test.
 */
export function parseIntegrityArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];

  const business = valueOf('--business', args);
  const days = valueOf('--days', args);
  const format = valueOf('--format', args);

  if (business?.repeated) problems.push('--business was given more than once.');
  if (days?.repeated) problems.push('--days was given more than once.');
  if (format?.repeated) problems.push('--format was given more than once.');

  let businessId = null;
  if (business) {
    if (!OBJECT_ID.test(business.value)) {
      problems.push('--business must be a 24-character hexadecimal id.');
    } else {
      businessId = business.value.toLowerCase();
    }
  }

  let dayCount = DEFAULT_DAYS;
  if (days) {
    if (days.value === 'all') {
      dayCount = 'all';
    } else if (!/^[0-9]+$/.test(days.value) || Number(days.value) < 1 || Number(days.value) > MAX_DAYS) {
      problems.push(`--days must be a whole number from 1 to ${MAX_DAYS}, or "all".`);
    } else {
      dayCount = Number(days.value);
    }
  }

  let output = 'text';
  if (format) {
    if (format.value !== 'text' && format.value !== 'json') {
      problems.push('--format must be "text" or "json".');
    } else {
      output = format.value;
    }
  }

  // The database is a FIXED choice, never a free-form flag — the same rule
  // `audit:duplicates` follows. Naming one here would let a production read be
  // written as a harmless-looking `--database=`, bypassing `--with-production`.
  for (const arg of args) {
    if (arg.startsWith('--database=') || arg === '--database') {
      problems.push(
        '--database is not accepted. This command reads the development database, or production with --with-production.'
      );
    } else if (arg.startsWith('--') && !/^--(help|with-production|business=|days=|format=)/.test(arg)) {
      problems.push(`Unknown argument: ${arg}`);
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      problems.push(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help: args.includes('--help') || args.includes('-h'),
    withProduction: args.includes('--with-production'),
    businessId,
    days: dayCount,
    format: output,
    problems,
  };
}

/** The cutoff `--days` implies, or `null` for `--days=all`. `now` is injectable for tests. */
export function cutoffForDays(days, now = new Date()) {
  if (days === 'all') return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function scopeMatch({ businessId = null, since = null, extra = {} } = {}) {
  const match = { ...extra };
  if (businessId) match.businessId = businessId;
  if (since) match.createdAt = { $gte: since };
  return Object.keys(match).length > 0 ? [{ $match: match }] : [];
}

/**
 * The aggregation that finds a STOCK_IN with no inventory row for the same
 * business/product/location. The lookup is bounded to one row: existence is the
 * question, and the row's quantity is not needed to decide it.
 */
export function buildOrphanStockInPipeline({ businessId = null, since = null } = {}) {
  return [
    ...scopeMatch({ businessId, since, extra: { type: 'STOCK_IN' } }),
    {
      $lookup: {
        from: 'inventory',
        let: { businessId: '$businessId', productId: '$productId', locationId: '$locationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$businessId', '$$businessId'] },
                  { $eq: ['$productId', '$$productId'] },
                  { $eq: ['$locationId', '$$locationId'] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
        as: 'inventoryRows',
      },
    },
    { $match: { inventoryRows: { $size: 0 } } },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $project: {
        businessId: 1,
        productId: 1,
        locationId: 1,
        userId: 1,
        quantity: 1,
        previousQuantity: 1,
        newQuantity: 1,
        reason: 1,
        reference: 1,
        createdAt: 1,
      },
    },
  ];
}

/** The nested receipt transaction ids, flattened without a per-receipt unwind. */
const RECEIPT_TXN_IDS = {
  $reduce: {
    input: { $ifNull: ['$receipts', []] },
    initialValue: [],
    in: {
      $concatArrays: ['$$value', { $ifNull: ['$$this.lines.inventoryTransactionId', []] }],
    },
  },
};

/**
 * The aggregation that finds a PO-receipt STOCK_IN whose transaction id is not
 * referenced by any receipt on the purchase order with the same number. Matches
 * only the receiving reason, so a manual stock-in that happens to carry a PO-like
 * reference is not swept in unless it also claims to be a PO receipt.
 */
export function buildUnreceiptedPoStockInPipeline({ businessId = null, since = null } = {}) {
  return [
    ...scopeMatch({
      businessId,
      since,
      extra: {
        type: 'STOCK_IN',
        reason: PO_RECEIPT_REASON,
        reference: { $exists: true, $nin: [null, ''] },
      },
    }),
    {
      $lookup: {
        from: 'inventory',
        let: { businessId: '$businessId', productId: '$productId', locationId: '$locationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$businessId', '$$businessId'] },
                  { $eq: ['$productId', '$$productId'] },
                  { $eq: ['$locationId', '$$locationId'] },
                ],
              },
            },
          },
          { $project: { quantity: 1 } },
          { $limit: 1 },
        ],
        as: 'inventoryRows',
      },
    },
    {
      $lookup: {
        from: 'purchase_orders',
        let: { businessId: '$businessId', number: '$reference' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$businessId', '$$businessId'] }, { $eq: ['$number', '$$number'] }],
              },
            },
          },
          {
            $project: {
              number: 1,
              status: 1,
              receiptCount: { $size: { $ifNull: ['$receipts', []] } },
              receiptTransactionIds: RECEIPT_TXN_IDS,
              claimCount: { $size: { $ifNull: ['$claims', []] } },
              claimQuantity: {
                $sum: {
                  $map: {
                    input: { $ifNull: ['$claims', []] },
                    as: 'claim',
                    in: '$$claim.quantity',
                  },
                },
              },
            },
          },
        ],
        as: 'purchaseOrders',
      },
    },
    {
      $addFields: {
        receipted: {
          $anyElementTrue: {
            $map: {
              input: '$purchaseOrders',
              as: 'po',
              in: { $in: ['$_id', '$$po.receiptTransactionIds'] },
            },
          },
        },
      },
    },
    { $match: { receipted: false } },
    {
      $addFields: {
        purchaseOrder: { $arrayElemAt: ['$purchaseOrders', 0] },
        rowFound: { $gt: [{ $size: '$inventoryRows' }, 0] },
        rowQuantity: { $arrayElemAt: ['$inventoryRows.quantity', 0] },
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $project: {
        businessId: 1,
        productId: 1,
        locationId: 1,
        userId: 1,
        quantity: 1,
        previousQuantity: 1,
        newQuantity: 1,
        reason: 1,
        reference: 1,
        createdAt: 1,
        purchaseOrder: 1,
        rowFound: 1,
        rowQuantity: 1,
      },
    },
  ];
}

/** Counts for the report. Pure; returns new values. */
export function summarizeFindings({ orphanStockIns = [], unreceiptedPoStockIns = [] } = {}) {
  const orphan = Array.isArray(orphanStockIns) ? orphanStockIns.length : 0;
  const unreceipted = Array.isArray(unreceiptedPoStockIns) ? unreceiptedPoStockIns.length : 0;
  return { orphanStockIns: orphan, unreceiptedPoStockIns: unreceipted, total: orphan + unreceipted };
}

/** An ISO timestamp, or the value as text. */
export function iso(value) {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const shortId = (value) => {
  const text = String(value ?? '');
  return text.length > 12 ? `${text.slice(0, 12)}…` : text || '—';
};

/**
 * The human report. Pure: takes already-resolved names and findings, so the text
 * and the JSON payload cannot disagree about what was found.
 */
export function formatTextReport({
  database,
  days,
  businessId = null,
  scanned,
  findings,
  names,
}) {
  const summary = summarizeFindings(findings);
  const lines = [];
  const businessName = (id) => names?.businesses?.get(String(id)) ?? 'Unknown business';
  const productName = (id) => names?.products?.get(String(id)) ?? { name: null, sku: null };
  const locationName = (id) => names?.locations?.get(String(id)) ?? null;

  const scope = days === 'all' ? 'all history' : `last ${days} day(s)`;
  lines.push(`[integrity] database: ${database} — READ-ONLY`);
  lines.push(
    `[integrity] scanned: ${grouped(scanned)} STOCK_IN ledger row(s) · scope: ${scope} · tenant: ${
      businessId ? shortId(businessId) : 'all'
    }`
  );
  lines.push('');

  const describe = (row) => {
    const product = productName(row.productId);
    const location = locationName(row.locationId);
    return (
      `    ${businessName(row.businessId)} · ${product.name ?? 'Unknown product'}` +
      ` (${product.sku ?? 'no SKU'}) @ ${location ?? 'Unknown location'}` +
      `\n      txn ${String(row._id)} · ${row.quantity} unit(s) · ${iso(row.createdAt)}` +
      `\n      reason ${row.reason || '—'} · reference ${row.reference || '—'}`
    );
  };

  lines.push(`ORPHAN STOCK_IN (ledger row without an inventory row): ${summary.orphanStockIns}`);
  if (findings.orphanStockIns.length === 0) {
    lines.push('    none');
  } else {
    for (const row of findings.orphanStockIns) lines.push(describe(row));
  }
  lines.push('');

  lines.push(
    `UNRECEIPTED PO RECEIPT (ambiguous finalize candidate): ${summary.unreceiptedPoStockIns}`
  );
  if (findings.unreceiptedPoStockIns.length === 0) {
    lines.push('    none');
  } else {
    for (const row of findings.unreceiptedPoStockIns) {
      lines.push(describe(row));
      const po = row.purchaseOrder;
      const poState = po
        ? `PO ${po.number} (${po.status}) · receipts ${po.receiptCount} · claims ${po.claimCount}/${po.claimQuantity} unit(s)`
        : `PO ${row.reference} NOT FOUND`;
      const rowState = row.rowFound ? `row quantity ${row.rowQuantity}` : 'inventory row MISSING';
      lines.push(`      ${poState} · ${rowState}`);
    }
  }
  lines.push('');

  if (summary.total === 0) {
    lines.push('CLEAN: no orphan STOCK_IN and no unreceipted PO receipt in this scope.');
  } else {
    lines.push(
      `FINDINGS: ${summary.total} candidate(s) across ${summary.orphanStockIns} orphan STOCK_IN and ` +
        `${summary.unreceiptedPoStockIns} unreceipted PO receipt(s).`
    );
  }
  lines.push(
    'NOTHING WAS MODIFIED. A finding is a candidate for review, not proof of intent: a manual ' +
      'stock-in can use a PO-like reference, and an inventory row can be removed by an operator.'
  );

  return lines.join('\n');
}
