// Pure parsing, shaping and text output for the read-only attention triage.
// This module imports no database driver and performs no writes.

export const TRIAGE_DEFAULT_LIMIT = 200;
export const TRIAGE_MAX_LIMIT = 5_000;

export function parseTriageArgs(argv = process.argv.slice(2)) {
  const args = {
    withProduction: false,
    format: 'text',
    businessId: null,
    limit: TRIAGE_DEFAULT_LIMIT,
    help: false,
    problems: [],
  };
  const seen = new Set();
  for (const raw of argv) {
    if (raw === '--with-production') {
      if (seen.has('production')) args.problems.push('--with-production was given more than once.');
      seen.add('production');
      args.withProduction = true;
    } else if (raw === '--help' || raw === '-h') {
      args.help = true;
    } else if (raw.startsWith('--format=')) {
      if (seen.has('format')) args.problems.push('--format was given more than once.');
      seen.add('format');
      const value = raw.slice('--format='.length).trim();
      if (!['text', 'json'].includes(value)) args.problems.push('--format must be text or json.');
      else args.format = value;
    } else if (raw.startsWith('--business=')) {
      if (seen.has('business')) args.problems.push('--business was given more than once.');
      seen.add('business');
      const value = raw.slice('--business='.length).trim();
      if (!/^[a-f0-9]{24}$/i.test(value)) {
        args.problems.push('--business must be a 24-character hexadecimal id.');
      } else args.businessId = value;
    } else if (raw.startsWith('--limit=')) {
      if (seen.has('limit')) args.problems.push('--limit was given more than once.');
      seen.add('limit');
      const value = Number(raw.slice('--limit='.length).trim());
      if (!Number.isInteger(value) || value < 1 || value > TRIAGE_MAX_LIMIT) {
        args.problems.push(`--limit must be an integer from 1 to ${TRIAGE_MAX_LIMIT}.`);
      } else args.limit = value;
    } else {
      args.problems.push(`unknown argument: ${raw}`);
    }
  }
  return args;
}

function idOf(value) {
  return value == null ? null : String(value);
}

function idText(value) {
  return idOf(value) ?? '';
}

function numberOrNull(value) {
  return value == null || value === '' ? null : Number(value);
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nameFrom(map, id) {
  if (!(map instanceof Map) || !id) return null;
  return map.get(id) ?? null;
}

function ledgerView(row, locations) {
  const locationId = idText(row.locationId);
  return {
    id: idText(row._id),
    location: { id: locationId, name: nameFrom(locations, locationId) },
    type: row.type ?? null,
    quantity: numberOrNull(row.quantity),
    previousQuantity: numberOrNull(row.previousQuantity),
    newQuantity: numberOrNull(row.newQuantity),
    reference: row.reference ?? null,
    reason: row.reason ?? null,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Build the one report shape both output formats use. Every row is included as
 * evidence; nothing is repaired, retried or deleted.
 */
export function buildAttentionReport({
  database,
  generatedAt = new Date().toISOString(),
  businessId = null,
  limit = TRIAGE_DEFAULT_LIMIT,
  transfers = [],
  movements = [],
  quarantine = [],
  ledgerRows = [],
  names = {},
} = {}) {
  const businesses = names.businesses ?? new Map();
  const products = names.products ?? new Map();
  const locations = names.locations ?? new Map();
  const users = names.users ?? new Map();

  const ledgerByOperation = new Map();
  for (const row of Array.isArray(ledgerRows) ? ledgerRows : []) {
    const key = idText(row.transferOperationId);
    if (!key) continue;
    if (!ledgerByOperation.has(key)) ledgerByOperation.set(key, []);
    ledgerByOperation.get(key).push(ledgerView(row, locations));
  }

  const transferViews = (Array.isArray(transfers) ? transfers : []).map((operation) => {
    const id = idText(operation._id);
    const business = idText(operation.businessId);
    const productId = idText(operation.productId);
    const fromId = idText(operation.fromLocationId);
    const toId = idText(operation.toLocationId);
    const createdBy = idText(operation.createdBy);
    const product = products instanceof Map ? products.get(productId) : null;
    return {
      id,
      business: { id: business, name: nameFrom(businesses, business) },
      state: operation.state ?? null,
      product: {
        id: productId,
        name: product?.name ?? null,
        sku: product?.sku ?? null,
      },
      from: { id: fromId, name: nameFrom(locations, fromId) },
      to: { id: toId, name: nameFrom(locations, toId) },
      quantity: numberOrNull(operation.quantity),
      reference: operation.reference ?? null,
      requestKey: operation.requestKey ?? null,
      reason: operation.reason ?? null,
      failure: operation.failure ?? null,
      failureReason: operation.failure || 'no failure reason recorded',
      createdBy: { id: createdBy, name: nameFrom(users, createdBy) },
      reconciledAt: iso(operation.reconciledAt),
      createdAt: iso(operation.createdAt),
      updatedAt: iso(operation.updatedAt),
      snapshots: {
        source: {
          rowId: idOf(operation.sourceRowId),
          previousQuantity: numberOrNull(operation.sourcePreviousQuantity),
          newQuantity: numberOrNull(operation.sourceNewQuantity),
        },
        destination: {
          rowId: idOf(operation.destinationRowId),
          previousQuantity: numberOrNull(operation.destinationPreviousQuantity),
          newQuantity: numberOrNull(operation.destinationNewQuantity),
        },
      },
      ledgerRows: ledgerByOperation.get(id) ?? [],
    };
  });

  const movementViews = (Array.isArray(movements) ? movements : []).map((movement) => {
    const business = idText(movement.businessId);
    const productId = idText(movement.productId);
    const locationId = idText(movement.locationId);
    const createdBy = idText(movement.createdBy);
    const product = products instanceof Map ? products.get(productId) : null;
    return {
      id: idText(movement._id),
      business: { id: business, name: nameFrom(businesses, business) },
      kind: movement.kind ?? null,
      state: movement.state ?? null,
      product: {
        id: productId,
        name: product?.name ?? null,
        sku: product?.sku ?? null,
      },
      location: { id: locationId, name: nameFrom(locations, locationId) },
      quantity: numberOrNull(movement.quantity),
      previousQuantity: numberOrNull(movement.previousQuantity),
      newQuantity: numberOrNull(movement.newQuantity),
      requestKey: movement.requestKey ?? null,
      reason: movement.reason ?? null,
      reference: movement.reference ?? null,
      inventoryRowId: idOf(movement.inventoryRowId),
      inventoryTransactionId: idOf(movement.inventoryTransactionId),
      failure: movement.failure ?? null,
      failureReason: movement.failure || 'no failure reason recorded',
      createdBy: { id: createdBy, name: nameFrom(users, createdBy) },
      createdAt: iso(movement.createdAt),
      updatedAt: iso(movement.updatedAt),
    };
  });

  const quarantineViews = (Array.isArray(quarantine) ? quarantine : []).map((row) => {
    const business = idText(row.businessId);
    const productId = idText(row.productId);
    const locationId = idText(row.locationId);
    const product = products instanceof Map ? products.get(productId) : null;
    return {
      id: idText(row._id),
      business: { id: business, name: nameFrom(businesses, business) },
      reason: row.quarantineReason ?? 'no quarantine reason recorded',
      quarantinedAt: iso(row.quarantinedAt),
      keptId: idOf(row.keptId),
      transferOperationId: idOf(row.transferOperationId),
      product: {
        id: productId,
        name: product?.name ?? null,
        sku: product?.sku ?? null,
      },
      location: { id: locationId, name: nameFrom(locations, locationId) },
      type: row.type ?? null,
      quantity: numberOrNull(row.quantity),
      previousQuantity: numberOrNull(row.previousQuantity),
      newQuantity: numberOrNull(row.newQuantity),
      reference: row.reference ?? null,
      createdAt: iso(row.createdAt),
    };
  });

  return {
    command: 'triage:integrity',
    readOnly: true,
    generatedAt,
    database: database ?? null,
    scope: { businessId, limit },
    counts: {
      transfers: transferViews.length,
      movements: movementViews.length,
      quarantine: quarantineViews.length,
    },
    transfers: transferViews,
    movements: movementViews,
    quarantine: quarantineViews,
    note:
      'READ-ONLY: these are REQUIRES_ATTENTION transfer journals, keyed movement receipts and ' +
      'quarantined ledger rows. Nothing was repaired or modified by this command.',
  };
}

function label(product) {
  if (!product?.name) return product?.id ?? 'unknown product';
  return product.sku ? `${product.name} (${product.sku})` : product.name;
}

/** Human-readable form of the same report; every reason and evidence row is printed. */
export function formatAttentionText(report) {
  const lines = [
    `Integrity attention triage on ${report.database ?? '(database not reported)'} (READ-ONLY)`,
    `Generated: ${report.generatedAt}`,
    `Scope: business=${report.scope?.businessId ?? 'all'} limit=${report.scope?.limit ?? '?'}`,
    '',
    `REQUIRES_ATTENTION transfers: ${report.counts.transfers}`,
  ];

  if (report.counts.transfers === 0) {
    lines.push('  none');
  }
  report.transfers.forEach((transfer, index) => {
    lines.push(
      `${index + 1}. transfer ${transfer.id} — ${label(transfer.product)} at ` +
        `${transfer.from.name ?? transfer.from.id} → ${transfer.to.name ?? transfer.to.id}, qty ${transfer.quantity}`
    );
    lines.push(`   reason: ${transfer.failureReason}`);
    if (transfer.reason) lines.push(`   caller reason: ${transfer.reason}`);
    if (transfer.reference) lines.push(`   reference: ${transfer.reference}`);
    lines.push(`   updated: ${transfer.updatedAt ?? 'unknown'} reconciled: ${transfer.reconciledAt ?? 'not reconciled'}`);
    lines.push(
      `   source snapshot: row ${transfer.snapshots.source.rowId ?? 'none'} ` +
        `${transfer.snapshots.source.previousQuantity ?? '?'} → ${transfer.snapshots.source.newQuantity ?? '?'}`
    );
    lines.push(
      `   destination snapshot: row ${transfer.snapshots.destination.rowId ?? 'none'} ` +
        `${transfer.snapshots.destination.previousQuantity ?? '?'} → ${transfer.snapshots.destination.newQuantity ?? '?'}`
    );
    if (transfer.ledgerRows.length === 0) {
      lines.push('   ledger rows: none');
    } else {
      lines.push(`   ledger rows (${transfer.ledgerRows.length}):`);
      for (const row of transfer.ledgerRows) {
        lines.push(
          `   - ${row.id} ${row.location.name ?? row.location.id} ${row.type ?? 'unknown'} ` +
            `qty=${row.quantity} ${row.previousQuantity} → ${row.newQuantity} at ${row.createdAt ?? 'unknown'}`
        );
      }
    }
  });

  lines.push('', `REQUIRES_ATTENTION movement receipts: ${report.counts.movements}`);
  if (report.counts.movements === 0) {
    lines.push('  none');
  }
  report.movements.forEach((movement, index) => {
    lines.push(
      `${index + 1}. ${movement.kind ?? 'movement'} ${movement.id} — ${label(movement.product)} at ` +
        `${movement.location.name ?? movement.location.id}, qty ${movement.quantity}`
    );
    lines.push(`   reason: ${movement.failureReason}`);
    lines.push(`   request key: ${movement.requestKey ?? 'none'} — do NOT retry under a new key`);
    if (movement.reason) lines.push(`   caller reason: ${movement.reason}`);
    if (movement.reference) lines.push(`   reference: ${movement.reference}`);
    lines.push(
      `   before/after: ${movement.previousQuantity ?? '?'} → ${movement.newQuantity ?? '?'} ` +
        `row: ${movement.inventoryRowId ?? 'none'} ledger: ${movement.inventoryTransactionId ?? 'none'}`
    );
    lines.push(`   updated: ${movement.updatedAt ?? 'unknown'}`);
  });

  lines.push('', `Quarantined ledger rows: ${report.counts.quarantine}`);
  if (report.counts.quarantine === 0) {
    lines.push('  none');
  }
  report.quarantine.forEach((row, index) => {
    lines.push(
      `${index + 1}. row ${row.id} — ${row.reason} at ${row.quarantinedAt ?? 'unknown time'}`
    );
    lines.push(
      `   product: ${label(row.product)} location: ${row.location.name ?? row.location.id} ` +
        `type: ${row.type ?? 'unknown'} qty: ${row.quantity}`
    );
    lines.push(
      `   before/after: ${row.previousQuantity} → ${row.newQuantity} ` +
        `operation: ${row.transferOperationId ?? 'none'} kept: ${row.keptId ?? 'none'}`
    );
    if (row.reference) lines.push(`   reference: ${row.reference}`);
  });

  lines.push('', report.note);
  return lines.join('\n');
}
