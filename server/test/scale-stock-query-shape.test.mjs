// §27DF — the STOCK LIST's query shape, pinned at the size that broke it.
//
// WHAT HAPPENED. On the 131 000-product tenant (261 918 inventory rows) four assistant
// tools — `getLowStockProducts`, `getOutOfStockProducts`, `getReorderNeededProducts`,
// `getProductsByLocation` — returned `TOOL_ERROR`, and `GET /api/products?lowStock=true`
// (the Inventory and Restock screens) returned a 500, with MongoDB's own sentence:
//
//     Exceeded memory limit for $group, but didn't allow external sort.
//     Pass allowDiskUse:true to opt in.
//
// The merge that computes per-product availability is ONE `$group` over the union of the
// catalog and its inventory rows, and `$group` memory is memory PER GROUP — so the cost
// was never the row count, it was the PAYLOAD: the first version carried the whole product
// document (`__product: '$$ROOT'`) through that group, i.e. the catalog in RAM.
//
// WHY A SOURCE GUARD IS THE ONLY HONEST TEST. Both halves of the fix are invisible to a
// functional test: the merge now publishes four scalars and hydrates the page afterwards,
// and every catalog aggregation opts into disk spilling as a backstop. A suite over a
// small tenant passes on both shapes — it did, before and after. The properties that
// distinguish them are structural, and the same is true of the two facts measured the
// same day for the inventory list:
//
//   * `outOfStock` is ROW-LOCAL (`available <= 0`), so it must not be routed through the
//     per-row product join — that routing cost 5.4 s for a 15-row page and ~0.6 s after;
//   * `lowStock` must prefilter rows against the largest `minimumStock` in the business
//     BEFORE the join, which is exact (a row above the maximum threshold cannot satisfy
//     `available <= minimumStock` for any product) and keeps 147 225 of 261 918 rows out
//     of the join.
//
// Every checker below carries an in-memory POSITIVE CONTROL: a checker that cannot fail is
// decoration, so each one is run against a mutated copy of the source it reads and must
// report the mutation. Nothing is written to disk by this file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(here, '..', 'src', 'services', name), 'utf8');

/**
 * The source WITHOUT its comments — because the thing this suite judges is code, and the
 * prose above each pipeline discusses the very shapes it must not contain. The first run
 * of this file proved that: the property test failed on `$$ROOT` present in
 * `product.service.ts`, and the occurrence was the **comment** that explains why the
 * merge must not carry a document. A scanner has to say which text it means, and here it
 * means the executable text; the defect is still caught when it is real, which the
 * mutation control below demonstrates.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PRODUCT_SERVICE = 'product.service.ts';
const INVENTORY_SERVICE = 'inventory.service.ts';

/** The `allowDiskUse` opt-in that must follow `needle` within a short window. */
function optInAfter(src, needle, window = 260) {
  const at = src.indexOf(needle);
  if (at === -1) return false;
  return src.slice(at, at + window).includes('allowDiskUse: true');
}

/**
 * The catalog-side properties. Every one of them is a property of the SHAPE, and each is
 * the mirror of a real measurement: the first was the failure, the rest are the fix.
 */
function productServiceProblems(rawSrc) {
  const src = codeOnly(rawSrc);
  const problems = [];
  if (src.includes('$$ROOT')) {
    problems.push('the availability merge must not carry the product document ($$ROOT) through its $group');
  }
  if (!/\$project: \{\s*__product: \{ \$literal: true \},/.test(src)) {
    problems.push('the merge must carry a presence marker (`__product: { $literal: true }`), not a document');
  }
  if (!src.includes('availabilityIdStages')) {
    problems.push('the id-space merge (`availabilityIdStages`) is missing');
  }
  if (!src.includes('hydrateStockPage')) {
    problems.push('the page must be hydrated AFTER the group (`hydrateStockPage`), not carried through it');
  }
  const paged = (src.match(/Product\.aggregate\(pipeline, \{ allowDiskUse: true \}\)/g) || []).length;
  if (paged !== 3) {
    problems.push(`every paged catalog aggregate must pass allowDiskUse (found ${paged})`);
  }
  if (src.includes('categoryStages')) {
    problems.push('the category join moved out of the pipeline; its return means the hydration changed');
  }
  return problems;
}

/** The inventory-side properties — the row-local path and the lowStock prefilter. */
function inventoryServiceProblems(rawSrc) {
  const src = codeOnly(rawSrc);
  const problems = [];

  const declared = src.match(/const filtersOnProduct = ([^;]+);/);
  if (!declared) problems.push('`filtersOnProduct` is missing');
  else if (declared[1].includes('outOfStock')) {
    problems.push('`outOfStock` is row-local and must not be routed through the product join');
  }

  if (!src.includes('const rowLocalOutOfStock = Boolean(outOfStock) && !filtersOnProduct;')) {
    problems.push('the row-local `outOfStock` decision (`rowLocalOutOfStock`) is missing');
  }
  if (!src.includes('$lte: [rowAvailableExpr, 0]')) {
    problems.push('the fast path must apply the row-local predicate it is routed for');
  }
  if (!optInAfter(src, "max: { $max: '$minimumStock' }")) {
    problems.push('the `lowStock` threshold aggregate must pass allowDiskUse');
  }
  if (!src.includes('$lte: [rowAvailableExpr, maxMinimumStock]')) {
    problems.push('the `lowStock` prefilter must run above the join, against the largest minimumStock');
  }
  return problems;
}

describe('the stock-list query shapes that a small tenant cannot distinguish', () => {
  test('the catalog merge carries scalars, and the page is hydrated after it', () => {
    const src = read(PRODUCT_SERVICE);
    assert.deepEqual(productServiceProblems(src), []);
  });

  test('the inventory list keeps `outOfStock` row-local and prefilters `lowStock`', () => {
    const src = read(INVENTORY_SERVICE);
    assert.deepEqual(inventoryServiceProblems(src), []);
  });
});

/**
 * Apply a mutation EVERYWHERE it occurs, not at the first match.
 *
 * This is not cosmetic. The first draft used `String.replace`, and its `$$ROOT` case
 * mutated the **comment** that explains the defect — the file mentions the old shape in
 * prose before it appears in code — while the checker, which strips comments, correctly
 * saw nothing. The control caught it (that case failed), and the fix is to mutate every
 * occurrence, so the code copy is always included.
 */
const mutate = (src, from, to) => src.split(from).join(to);

describe('each checker fails on the shape it exists to catch', () => {
  test('carrying `$$ROOT` through the merge is reported', () => {
    const mutated = mutate(
      read(PRODUCT_SERVICE),
      '__product: { $literal: true },',
      "__product: '$$ROOT',"
    );
    const problems = productServiceProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes('$$ROOT')),
      `the mutation must be reported, got: ${JSON.stringify(problems)}`
    );
  });

  test('dropping an `allowDiskUse` opt-in is reported', () => {
    const mutated = mutate(
      read(PRODUCT_SERVICE),
      'Product.aggregate(pipeline, { allowDiskUse: true })',
      'Product.aggregate(pipeline)'
    );
    const problems = productServiceProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes('allowDiskUse')),
      `the mutation must be reported, got: ${JSON.stringify(problems)}`
    );
  });

  test('routing `outOfStock` back through the product join is reported', () => {
    const mutated = mutate(
      read(INVENTORY_SERVICE),
      'const filtersOnProduct = productOnlyFilters || Boolean(lowStock);',
      'const filtersOnProduct = productOnlyFilters || Boolean(lowStock) || Boolean(outOfStock);'
    );
    const problems = inventoryServiceProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes('row-local') || p.includes('outOfStock')),
      `the mutation must be reported, got: ${JSON.stringify(problems)}`
    );
  });

  test('removing the `lowStock` prefilter is reported', () => {
    const mutated = mutate(
      read(INVENTORY_SERVICE),
      '$lte: [rowAvailableExpr, maxMinimumStock]',
      '$lte: [rowAvailableExpr, Number.MAX_SAFE_INTEGER]'
    );
    const problems = inventoryServiceProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes('prefilter')),
      `the mutation must be reported, got: ${JSON.stringify(problems)}`
    );
  });

  test('the mutations were applied to real text, not to a copy that missed', () => {
    // A guard proved by a mutation that never applied proves nothing. Each mutation
    // above must change its source AND change it in CODE — the stripped text is where the
    // checkers look, so this is the control that the `$$ROOT` case needed: prose alone
    // cannot satisfy it.
    const productSrc = read(PRODUCT_SERVICE);
    assert.notEqual(
      productSrc,
      mutate(productSrc, '__product: { $literal: true },', "__product: '$$ROOT',")
    );
    assert.match(
      codeOnly(mutate(productSrc, '__product: { $literal: true },', "__product: '$$ROOT',")),
      /\$\$ROOT/
    );
    assert.notEqual(
      productSrc,
      mutate(productSrc, 'Product.aggregate(pipeline, { allowDiskUse: true })', 'Product.aggregate(pipeline)')
    );
    const inventorySrc = read(INVENTORY_SERVICE);
    const routingMutation = mutate(
      inventorySrc,
      'const filtersOnProduct = productOnlyFilters || Boolean(lowStock);',
      'const filtersOnProduct = productOnlyFilters || Boolean(lowStock) || Boolean(outOfStock);'
    );
    assert.notEqual(inventorySrc, routingMutation);
    assert.match(codeOnly(routingMutation), /Boolean\(outOfStock\)/);
    assert.notEqual(
      inventorySrc,
      mutate(
        inventorySrc,
        '$lte: [rowAvailableExpr, maxMinimumStock]',
        '$lte: [rowAvailableExpr, Number.MAX_SAFE_INTEGER]'
      )
    );
  });
});
