// Hard stops for a production HTTP evaluation. The gate must never continue after a paid request,
// an unknown cost, a depleted free allowance, or an inventory shape change it did not cause.

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function assertFreeAllowance(usage, required) {
  if (!Number.isInteger(required) || required < 1) throw new Error('required free allowance must be positive');
  if (usage?.status && usage.status !== 'OK') {
    throw new Error(`free allowance is ${usage.status}: ${usage.detail ?? 'unreadable'}`);
  }
  const remaining = finite(usage?.daily?.remaining);
  if (remaining === null) throw new Error('free allowance remaining is unknown');
  if (remaining < required) {
    throw new Error(`free allowance ${remaining} is below the ${required} requests this gate needs`);
  }
  return remaining;
}

export function assertFreeZeroCost({ model, costUsd, label = 'turn' }) {
  if (typeof model !== 'string' || !/:free$/i.test(model)) {
    throw new Error(`${label}: served by non-free model ${model ?? 'unknown'}; aborting before another request`);
  }
  const cost = finite(costUsd);
  if (cost === null) throw new Error(`${label}: cost is unknown; zero cost cannot be proven`);
  if (cost !== 0) throw new Error(`${label}: cost is $${cost.toFixed(6)}; aborting`);
  return true;
}

export function datasetFingerprint({ products, inventoryRows, totalQuantity, reserved = 0 }) {
  const fields = { products, inventoryRows, totalQuantity, reserved };
  for (const [name, value] of Object.entries(fields)) {
    if (finite(value) === null) throw new Error(`dataset fingerprint has no numeric ${name}`);
  }
  return {
    products: Number(fields.products),
    inventoryRows: Number(fields.inventoryRows),
    totalQuantity: Number(fields.totalQuantity),
    reserved: Number(fields.reserved),
  };
}

export function assertDatasetUnchanged(before, after) {
  const expected = datasetFingerprint(before);
  const actual = datasetFingerprint(after);
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `inventory shape changed during the gate: ${key} ${expected[key]} -> ${actual[key]}; aborting`,
      );
    }
  }
  return true;
}

export function assertRestored(snapshot, rows) {
  if (!Array.isArray(snapshot) || !Array.isArray(rows)) throw new Error('restore check needs arrays');
  if (snapshot.length !== rows.length) {
    throw new Error(`restore check row count ${rows.length} != snapshot ${snapshot.length}`);
  }
  const expected = new Map(
    snapshot.map((row) => [
      String(row._id),
      { quantity: Number(row.quantity), reservedQuantity: Number(row.reservedQuantity ?? 0) },
    ]),
  );
  for (const row of rows) {
    const want = expected.get(String(row._id));
    if (!want) throw new Error(`restore check found an unexpected row ${row._id}`);
    if (Number(row.quantity) !== want.quantity || Number(row.reservedQuantity ?? 0) !== want.reservedQuantity) {
      throw new Error(
        `restore mismatch for ${row._id}: ${row.quantity}/${row.reservedQuantity ?? 0} != ` +
          `${want.quantity}/${want.reservedQuantity}`,
      );
    }
  }
  return true;
}

export function assertPaidUsageUnchanged(before, after) {
  const start = finite(before?.paidUsage);
  const end = finite(after?.paidUsage);
  if (start === null || end === null) throw new Error('paid usage is unreadable; zero paid usage cannot be proven');
  if (end !== start) throw new Error(`provider paid usage changed ${start} -> ${end}; aborting`);
  return true;
}
