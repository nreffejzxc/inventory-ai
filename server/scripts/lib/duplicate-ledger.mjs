// Pure half of `npm run audit:duplicates`.
//
// WHAT A SUSPECTED DUPLICATE IS. Before §27GZ an inventory write had no
// idempotency key, so one operation delivered twice wrote two ledger rows. The
// second row is not a copy of the first: it carries the quantity the first one
// produced (`previousQuantity` of the second equals `newQuantity` of the first),
// which is exactly why a naive "identical rows" search finds nothing. What the
// two rows DO share is every field the client sent: type, product, location,
// quantity, user, reason and reference — and their timestamps are seconds apart.
//
// SO THE SIGNATURE IS THE REQUEST, NOT THE ROW:
//   businessId · type · productId · locationId · quantity · userId · reason · reference
// Within a signature the rows are ordered by time, and each row is compared with the
// row IMMEDIATELY before it in that signature. Two rows within `windowSeconds` of each
// other are reported as a pair.
//
// WHY ADJACENCY AND NOT A CLOCK-HOUR BUCKET. An earlier version grouped by signature
// plus the hour, so a pair at 10:59:59.900 and 11:00:00.100 — 200 ms apart — landed in
// two groups and was never reported. The bucket was only ever an approximation of
// "these rows are close together"; the window function makes it exact, and there is no
// boundary left to fall across.
//
// WHY A PAIR AND NOT A CLUSTER. A cluster would have to decide how far a chain may
// reach, and a span test over it hides an adjacent pair whenever a third, legitimate
// row of the same signature falls later inside the same group. One row and its
// immediate predecessor is exact, bounded, and proportional to the ledger rather than
// to a bucket. A signature applied three times in a row yields two adjacent pairs; the
// middle row appears in both, and the extra-row count is still the number of rows
// beyond one operation.
//
// THIS IS A HEURISTIC AND SAYS SO. Two deliberate, identical movements by the same
// member at the same location inside two minutes produce the same signature, and
// they are indistinguishable from a duplicate without the request itself. That is
// why the command is an AUDIT ("suspected") and not a cleanup, and why it never
// writes, deletes or repairs anything.
//
// No imports: this module is pure so the parser, the pipeline and the summary can
// be asserted without a database.

/** Default pair window. A retry after a client timeout lands well inside this. */
export const DEFAULT_WINDOW_SECONDS = 120;
/** Default history boundary. The project's first commit is 2026-09-08; 90 days covers it today. */
export const DEFAULT_DAYS = 90;

const MAX_WINDOW_SECONDS = 3600;
const MAX_DAYS = 3650;
/** A 24-hex ObjectId. The audit accepts an id, never a name (a name can resolve to two tenants). */
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Reads `--flag=value` from an argv array. Returns `null` when absent. A flag given
 * twice is not special-cased: the first occurrence wins, and the parser reports a
 * repeated flag so a typo cannot silently pick one of two values.
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
 *
 * @param {string[]} argv  the flags only (`process.argv.slice(2)` by default)
 */
export function parseDuplicateArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];

  const business = valueOf('--business', args);
  const days = valueOf('--days', args);
  const windowSeconds = valueOf('--window-seconds', args);
  const format = valueOf('--format', args);

  if (business?.repeated) problems.push('--business was given more than once.');
  if (days?.repeated) problems.push('--days was given more than once.');
  if (windowSeconds?.repeated) problems.push('--window-seconds was given more than once.');
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

  let window = DEFAULT_WINDOW_SECONDS;
  if (windowSeconds) {
    if (
      !/^[0-9]+$/.test(windowSeconds.value) ||
      Number(windowSeconds.value) < 1 ||
      Number(windowSeconds.value) > MAX_WINDOW_SECONDS
    ) {
      problems.push(`--window-seconds must be a whole number from 1 to ${MAX_WINDOW_SECONDS}.`);
    } else {
      window = Number(windowSeconds.value);
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
  // `check:accounts` follows. Naming one here would let a read of production be
  // written as a harmless-looking `--database=`, bypassing `--with-production`.
  for (const arg of args) {
    if (arg.startsWith('--database=') || arg === '--database') {
      problems.push(
        '--database is not accepted. This command reads the development database, or production with --with-production.'
      );
    } else if (arg.startsWith('--') && !/^--(help|with-production|business=|days=|window-seconds=|format=)/.test(arg)) {
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
    windowSeconds: window,
    format: output,
    problems,
  };
}

/**
 * The aggregation that finds suspected duplicates. Rows are partitioned by the
 * request signature and ordered by time; `$shift` gives each row the one before it,
 * and a gap inside the window is a suspected pair. No bucketing: a pair straddling a
 * clock-hour boundary is found exactly like any other.
 *
 * `allowDiskUse` is passed by the caller, not encoded here: the pipeline is data,
 * and the CLI is the place that decides how much disk a scan may use.
 *
 * @param {{ businessId?: unknown, since?: Date|null, windowSeconds?: number }} options
 *   `businessId` is an ObjectId (or anything the driver can match), `since` a Date.
 */
export function buildScanPipeline({
  businessId = null,
  since = null,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
} = {}) {
  const match = {};
  if (businessId) match.businessId = businessId;
  if (since) match.createdAt = { $gte: since };

  // A missing reason/reference and an empty string are the same request as far as
  // the client is concerned (`|| undefined` on the way in), so they must not split
  // one duplicate pair into two partitions.
  const signature = {
    businessId: '$businessId',
    type: '$type',
    productId: '$productId',
    locationId: '$locationId',
    quantity: '$quantity',
    userId: '$userId',
    reason: { $ifNull: ['$reason', ''] },
    reference: { $ifNull: ['$reference', ''] },
  };

  return [
    ...(Object.keys(match).length > 0 ? [{ $match: match }] : []),
    {
      $setWindowFields: {
        partitionBy: signature,
        // `_id` breaks a tie deterministically, so two rows sharing a millisecond are
        // still compared in one fixed order instead of an engine-chosen one.
        sortBy: { createdAt: 1, _id: 1 },
        output: {
          previous: {
            $shift: {
              output: {
                id: '$_id',
                at: '$createdAt',
                previousQuantity: '$previousQuantity',
                newQuantity: '$newQuantity',
              },
              by: -1,
              default: null,
            },
          },
        },
      },
    },
    // The first row of a partition has no predecessor: `$subtract` with null yields
    // null, which the `$lte` below cannot match.
    { $addFields: { gapMs: { $subtract: ['$createdAt', '$previous.at'] } } },
    { $match: { previous: { $ne: null }, gapMs: { $lte: windowSeconds * 1000 } } },
    {
      $project: {
        _id: signature,
        count: { $literal: 2 },
        firstCreatedAt: '$previous.at',
        lastCreatedAt: '$createdAt',
        spanMs: '$gapMs',
        rows: {
          $concatArrays: [
            [
              {
                id: '$previous.id',
                at: '$previous.at',
                previousQuantity: '$previous.previousQuantity',
                newQuantity: '$previous.newQuantity',
              },
            ],
            [
              {
                id: '$_id',
                at: '$createdAt',
                previousQuantity: '$previousQuantity',
                newQuantity: '$newQuantity',
              },
            ],
          ],
        },
      },
    },
    { $sort: { lastCreatedAt: -1, _id: 1 } },
  ];
}

/**
 * Per-tenant totals over the flagged pairs. Pure; returns new objects.
 *
 * Each flagged group is one row and its predecessor, so `count` is 2 and `extraRows`
 * adds one per pair: one row is the operation, the other the suspected duplicate. It
 * is deliberately NOT a claim of that many "wrong" rows — a legitimate identical pair
 * counts here too, which the text report says.
 */
export function summarizeGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const byTenant = new Map();

  for (const group of list) {
    const key = String(group?._id?.businessId ?? '');
    const entry = byTenant.get(key) ?? { businessId: key, groups: [], extraRows: 0 };
    entry.groups.push(group);
    entry.extraRows += Math.max(0, Number(group.count ?? 0) - 1);
    byTenant.set(key, entry);
  }

  const tenants = [...byTenant.values()].sort(
    (a, b) => b.extraRows - a.extraRows || b.groups.length - a.groups.length
  );

  return {
    tenants,
    totalGroups: list.length,
    extraRows: tenants.reduce((sum, tenant) => sum + tenant.extraRows, 0),
  };
}

/** The cutoff `--days` implies, or `null` for `--days=all`. `now` is injectable for tests. */
export function cutoffForDays(days, now = new Date()) {
  if (days === 'all') return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Deterministic thousands separators; `toLocaleString` depends on the host ICU. */
function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** An ISO timestamp, or the value as text. */
export function iso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

const shortId = (value) => {
  const text = String(value ?? '');
  return text.length > 10 ? `${text.slice(0, 10)}…` : text || '—';
};
const seconds = (ms) => `${(Number(ms) / 1000).toFixed(1)}s`;

/**
 * The human report. Pure: takes the summary and the already-resolved group views,
 * so the text and JSON outputs are built from the same resolved data.
 *
 * Exported because the BODY with findings is the part an operator actually reads,
 * and the only way to test it without writing a duplicate into a real database is
 * to feed it one here.
 */
export function formatTextReport({ database, days, windowSeconds, scanned, summary, tenants, businessName }) {
  const lines = [];
  lines.push(`[duplicates] database: ${database} — READ-ONLY`);
  lines.push(
    `[duplicates] scope: ${days === 'all' ? 'all history' : `last ${days} day(s)`} · ` +
      'same type, product, location, quantity, user, reason and reference · ' +
      `each row within ${windowSeconds}s of the previous row of that signature`
  );
  lines.push(`[duplicates] scanned: ${grouped(scanned)} ledger row(s)`);

  if (summary.totalGroups === 0) {
    lines.push('[duplicates] no suspected duplicates in the scanned rows.');
    lines.push('[duplicates] nothing was changed.');
    return lines.join('\n');
  }

  lines.push(
    `[duplicates] SUSPECTED: ${grouped(summary.totalGroups)} pair(s), ` +
      `${grouped(summary.extraRows)} extra row(s) beyond the first of each pair`
  );
  lines.push('');

  for (const tenant of tenants) {
    const name = businessName(tenant.businessId);
    lines.push(
      `  ${name} (${shortId(tenant.businessId)}) — ${tenant.groups.length} pair(s), ${tenant.extraRows} extra row(s)`
    );
    for (const view of tenant.groups) {
      const product = view.product.name ?? shortId(view.product.id);
      const sku = view.product.sku ? ` (${view.product.sku})` : '';
      const location = view.location.name ?? shortId(view.location.id);
      lines.push(`    ${view.type} × ${grouped(view.quantity)} · ${product}${sku} @ ${location}`);
      const parts = [`${view.count} rows · ${seconds(view.spanMs)} apart`];
      if (view.userId) parts.push(`user ${shortId(view.userId)}`);
      if (view.reason) parts.push(`reason "${view.reason}"`);
      if (view.reference) parts.push(`reference "${view.reference}"`);
      lines.push(`      ${parts.join(' · ')}`);
      for (const row of view.rows) {
        lines.push(
          `      • ${row.at}  prev ${grouped(row.previousQuantity)} → ${grouped(row.newQuantity)}  txn ${shortId(row.id)}`
        );
      }
      if (view.reason === 'PO receipt') {
        lines.push(
          '      NOTE: two equal partial receipts on one PO look exactly like this — check the PO\'s own receipts before treating it as a duplicate.'
        );
      }
    }
    lines.push('');
  }

  lines.push('[duplicates] nothing was changed. "Suspected" means the rows share the request fields and sit inside the window;');
  lines.push('             a deliberate identical repeat inside the window looks the same.');
  return lines.join('\n');
}
