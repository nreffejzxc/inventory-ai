// Pure half of the installed-app transfer verification.
//
// The device journey (`scripts/device/run.mjs --journey=transfer`) writes six
// ledger rows with references derived from one run id:
//
//   PHONE-TRF-<runId>-IN    STOCK_IN   +1 at the source
//   PHONE-TRF-<runId>-F     TRANSFER   -1 at the source, +1 at the destination
//   PHONE-TRF-<runId>-R     TRANSFER   +1 at the source, -1 at the destination
//   PHONE-TRF-<runId>-OUT   STOCK_OUT  -1 at the source
//
// and no rows for the two refused submissions (`-SAME`, `-OVER`), because the
// submit button is disabled. This module decides whether the database agrees.
//
// It is pure: no imports and no I/O, so the decision is asserted with synthetic
// rows in `server/test/transfer-ui-verification.test.mjs`. The CLI is
// `server/scripts/verify-transfer-ui.mjs`; it only reads.

export const TRANSFER_UI_PREFIX = 'PHONE-TRF-';
const RUN_ID = /^[A-Za-z0-9-]{1,40}$/;

/** The references one device run owns. */
export function transferRefs(runId) {
  const prefix = `${TRANSFER_UI_PREFIX}${String(runId ?? '')}`;
  return {
    in: `${prefix}-IN`,
    out: `${prefix}-OUT`,
    forward: `${prefix}-F`,
    reverse: `${prefix}-R`,
    same: `${prefix}-SAME`,
    over: `${prefix}-OVER`,
  };
}

function valueOf(flag, argv) {
  const prefix = `${flag}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) return { repeated: true, value: values[0] };
  return values.length === 1 ? { repeated: false, value: values[0] } : null;
}

/** Parse the standalone verifier's arguments. Pure, so every refusal is testable. */
export function parseVerifyArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const problems = [];
  const runId = valueOf('--run-id', args);
  const sku = valueOf('--sku', args);
  const source = valueOf('--source', args);
  const destination = valueOf('--destination', args);
  const business = valueOf('--business', args);
  const format = valueOf('--format', args);

  for (const [flag, seen] of [
    ['--run-id', runId],
    ['--sku', sku],
    ['--source', source],
    ['--destination', destination],
    ['--business', business],
    ['--format', format],
  ]) {
    if (seen?.repeated) problems.push(`${flag} was given more than once.`);
  }

  const required = [
    ['--run-id', runId],
    ['--sku', sku],
    ['--source', source],
    ['--destination', destination],
  ];
  for (const [flag, seen] of required) {
    if (!seen || !String(seen.value).trim()) problems.push(`${flag} is required.`);
  }

  let runIdValue = runId?.value ?? '';
  if (runId && !RUN_ID.test(runIdValue)) {
    problems.push('--run-id must be 1-40 letters, numbers or hyphens.');
  }

  let businessId = null;
  if (business) {
    if (!/^[a-f0-9]{24}$/i.test(business.value)) {
      problems.push('--business must be a 24-character hexadecimal id.');
    } else {
      businessId = business.value.toLowerCase();
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

  for (const arg of args) {
    if (arg.startsWith('--database=') || arg === '--database') {
      problems.push(
        '--database is not accepted. This command reads the development database, or production with --with-production.'
      );
    } else if (
      arg.startsWith('--') &&
      !/^--(help|with-production|run-id=|sku=|source=|destination=|business=|format=)/.test(arg)
    ) {
      problems.push(`Unknown argument: ${arg}`);
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      problems.push(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help: args.includes('--help') || args.includes('-h'),
    withProduction: args.includes('--with-production'),
    runId: runIdValue,
    sku: sku?.value ?? '',
    source: source?.value ?? '',
    destination: destination?.value ?? '',
    businessId,
    format: output,
    problems,
  };
}

function num(value) {
  return typeof value === 'number' ? value : Number(value);
}

function id(value) {
  return String(value ?? '');
}

/**
 * Judge one run's six expected rows and the two locations' final quantities.
 *
 * @param {{
 *   rows: Array<{reference: string, type: string, locationId: unknown, quantity: number,
 *     previousQuantity: number, newQuantity: number, createdAt: unknown}>,
 *   sourceId: unknown,
 *   destinationId: unknown,
 *   currentSource: number|null,
 *   currentDestination: number|null,
 *   refs: ReturnType<typeof transferRefs>
 * }} input
 */
export function verifyTransferRows({
  rows = [],
  sourceId,
  destinationId,
  currentSource,
  currentDestination,
  refs,
}) {
  const source = id(sourceId);
  const destination = id(destinationId);
  const list = Array.isArray(rows) ? rows : [];
  const errors = [];
  const expected = [
    { ref: refs.in, type: 'STOCK_IN', location: source, delta: 1 },
    { ref: refs.out, type: 'STOCK_OUT', location: source, delta: -1 },
    {
      ref: refs.forward,
      type: 'TRANSFER',
      legs: [
        { location: source, delta: -1 },
        { location: destination, delta: 1 },
      ],
    },
    {
      ref: refs.reverse,
      type: 'TRANSFER',
      legs: [
        { location: source, delta: 1 },
        { location: destination, delta: -1 },
      ],
    },
  ];

  const known = new Set(expected.map((entry) => entry.ref));
  const invalid = new Set([refs.same, refs.over]);
  const byRef = new Map();

  for (const row of list) {
    const reference = String(row.reference ?? '');
    if (invalid.has(reference)) {
      errors.push(`refused submission wrote a ledger row: ${reference}`);
      continue;
    }
    if (!known.has(reference)) {
      errors.push(`unexpected run reference in the ledger: ${reference || '(none)'}`);
      continue;
    }
    const group = byRef.get(reference) ?? [];
    group.push(row);
    byRef.set(reference, group);
  }

  for (const entry of expected) {
    const group = byRef.get(entry.ref) ?? [];
    const legs = entry.legs ?? [{ location: entry.location, delta: entry.delta }];
    if (group.length !== legs.length) {
      errors.push(`${entry.ref}: expected ${legs.length} row(s), found ${group.length}`);
      continue;
    }

    for (const leg of legs) {
      const matches = group.filter((row) => id(row.locationId) === leg.location);
      if (matches.length !== 1) {
        errors.push(
          `${entry.ref}: expected exactly one row at ${leg.location === source ? 'the source' : 'the destination'}, found ${matches.length}`
        );
        continue;
      }
      const row = matches[0];
      if (String(row.type) !== entry.type) {
        errors.push(`${entry.ref}: type is ${row.type}, expected ${entry.type}`);
      }
      if (num(row.quantity) !== 1) {
        errors.push(`${entry.ref}: quantity is ${row.quantity}, expected 1`);
      }
      const actual = num(row.newQuantity) - num(row.previousQuantity);
      if (actual !== leg.delta) {
        errors.push(
          `${entry.ref}: ${row.previousQuantity} → ${row.newQuantity} is ${actual}, expected ${leg.delta}`
        );
      }
    }
  }

  const net = new Map([
    [source, 0],
    [destination, 0],
  ]);
  for (const row of list) {
    if (row.reference === refs.same || row.reference === refs.over) continue;
    const location = id(row.locationId);
    if (!net.has(location)) continue;
    net.set(location, net.get(location) + (num(row.newQuantity) - num(row.previousQuantity)));
  }
  if (net.get(source) !== 0) errors.push(`source net movement is ${net.get(source)}, expected 0`);
  if (net.get(destination) !== 0) {
    errors.push(`destination net movement is ${net.get(destination)}, expected 0`);
  }

  for (const [location, current, label] of [
    [source, currentSource, 'source'],
    [destination, currentDestination, 'destination'],
  ]) {
    if (current == null || !Number.isFinite(Number(current))) {
      errors.push(`${label} inventory row is missing`);
      continue;
    }
    const atLocation = list
      .filter((row) => id(row.locationId) === location)
      .filter((row) => row.reference !== refs.same && row.reference !== refs.over)
      .slice()
      .sort((a, b) => {
        const at = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (at !== 0) return at;
        return String(a._id ?? '').localeCompare(String(b._id ?? ''));
      });
    const last = atLocation[atLocation.length - 1];
    if (!last) {
      errors.push(`${label} has no run movement to reconcile`);
    } else if (num(last.newQuantity) !== num(current)) {
      errors.push(
        `${label} final stock is ${current}, but its last run movement ended at ${last.newQuantity}`
      );
    }
  }

  return { ok: errors.length === 0, errors, checkedRows: list.length, net: Object.fromEntries(net) };
}
