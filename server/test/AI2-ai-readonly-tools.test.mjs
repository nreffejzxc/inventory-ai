// AI-2 — the read-only invariant of the AI assistant, made PROVABLE.
//
// WHY THIS EXISTS. CLAUDE.md §4 makes AI V1's read-only scope mandatory and
// SYSTEM_SPECIFICATION §22–§24 define it, but until now nothing in the repository
// could FAIL if someone added a write capability to the tool table. The invariant
// held only because every contributor remembered it. That is the same class of gap
// the project already closed for the RBAC mirror (lib/permissions.ts), the route
// inventory (phase-docs-route-inventory) and the Expo pin set
// (mobile/__tests__/expo-sdk-pins.test.ts) — a cross-cutting rule that a green
// typecheck, a green lint and a green suite cannot see being broken.
//
// THE FOUR WAYS A WRITE COULD APPEAR, and the test for each:
//
//   1. A new tool in the table that reaches a write service method. Caught by a
//      mechanical scan of `tools.ts`'s own source against an allow-list of read
//      calls — the scan that has a POSITIVE CONTROL below, because a scan that
//      cannot fail proves nothing.
//   2. A tool whose declared permission is a write capability. Caught by pinning
//      every tool permission to the four read permissions, and by asserting none
//      of those four is write-shaped.
//   3. A model GUESSING a write tool name. Caught behaviourally: the names a model
//      realistically tries (createProduct, stockOut, adjustStock, …) must all
//      answer TOOL_NOT_FOUND. `phase06-ai-behavior.test.mjs` already observes this
//      through the real route; this pins it at the table, without a database.
//   4. Smuggling scope through the ARGUMENTS. Caught for EVERY tool: an unknown
//      key — `businessId` above all — must be rejected by `validateToolArgs`, so
//      no tool can be reached with a business context the session did not supply.
//
// WHAT IT DOES NOT PROVE: that a tool's QUERY is business-scoped. That is a
// property of the services the table calls (Phase 04/09, and
// `phase06-ai-security.test.mjs` measures it over HTTP with a real database).
// This suite proves the table cannot be reached for anything but reading.

import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { PERMISSIONS, ROLES, hasPermission } from '../src/constants/roles.ts';
import { AI_TOOLS, AI_TOOL_DEFS, executeTool, validateToolArgs } from '../src/services/ai/tools.ts';

/** The tool table's own source — read, never transcribed. */
const TOOLS_SOURCE = readFileSync(new URL('../src/services/ai/tools.ts', import.meta.url), 'utf8');

/** Every `someService.method(` call site in a source text. */
const SERVICE_CALL = /\b(\w+Service)\.(\w+)\s*\(/g;

/**
 * The complete set of service calls the READ-ONLY table is allowed to make.
 * `toProductDTO` and `reorderItemPublic` are formatters on the product service,
 * not queries, but they go through the same service and are listed explicitly so
 * the allow-list stays exhaustive rather than pattern-matched.
 */
const READ_ONLY_SERVICE_CALLS = new Set([
  'productService.list',
  'productService.listReorder',
  'productService.getByIdentifier',
  'productService.toProductDTO',
  'productService.reorderItemPublic',
  'inventoryService.listRows',
  // AI-23: the per-location breakdown is one aggregate read over inventory rows — the same
  // class as the dashboard summary above, and named here explicitly so adding it was a
  // deliberate act rather than a hole in the scan.
  'inventoryService.locationBreakdown',
  'dashboardService.summary',
  'transactionsService.list',
  // AI-42: the transfer statistics are one aggregate read over the same history rows —
  // it exists so the assistant's count stays logical when a pair spans the page edge.
  'transactionsService.transferStats',
  // AI-14: reference lists. `list()` is the only read the factory pair exposes here —
  // `create`/`update`/`setStatus` on the same services are writes and stay OFF this list,
  // which is what keeps the allow-list meaningful: it names methods, not services.
  'locationService.list',
  'categoryService.list',
]);

/** Every service call in `source` that is NOT on the read-only allow-list. */
function writeShapedServiceCalls(source) {
  const found = new Set();
  for (const match of source.matchAll(SERVICE_CALL)) {
    const key = `${match[1]}.${match[2]}`;
    if (!READ_ONLY_SERVICE_CALLS.has(key)) found.add(key);
  }
  return [...found];
}

/** Every service call in `source`, allow-listed or not — the scan's own sightline. */
function everyServiceCall(source) {
  return [...new Set([...source.matchAll(SERVICE_CALL)].map((m) => `${m[1]}.${m[2]}`))];
}

/** The four read capabilities the assistant may hold. */
const READ_ONLY_PERMISSIONS = new Set([
  PERMISSIONS.PRODUCTS_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_HISTORY_VIEW,
  PERMISSIONS.DASHBOARD_VIEW,
]);

/** Tool names a model plausibly invents when asked to change something. */
const WRITE_TOOL_NAMES = [
  'createProduct',
  'updateProduct',
  'archiveProduct',
  'deleteProduct',
  'stockIn',
  'stockOut',
  'adjustStock',
  'transferStock',
  'setPrice',
];

const ctx = { businessId: 'b-dummy', userId: 'u-dummy', role: ROLES.OWNER };

unitSuite('AI-2 the AI tool table is structurally read-only', () => {
  it('declares no tool that reaches a service call outside the read-only allow-list', () => {
    assert.deepEqual(
      writeShapedServiceCalls(TOOLS_SOURCE),
      [],
      'a tool reached a service call an operator would not expect from a read-only assistant',
    );
  });

  it('the read-only scan can SEE the calls it clears (or it would pass vacuously)', () => {
    // The negative control above is only meaningful if the scan is live. This is
    // the other half: the same regex must find the reads that are genuinely there.
    const seen = everyServiceCall(TOOLS_SOURCE);
    for (const expected of ['inventoryService.listRows', 'dashboardService.summary', 'productService.list']) {
      assert.ok(
        seen.includes(expected),
        `the scan failed to find ${expected}, so its empty result above proves nothing`,
      );
    }
  });

  it('POSITIVE CONTROL: the same scan REJECTS an injected write call', () => {
    // A guard that cannot fail is decoration. Both mutations below are the shape a
    // real mistake takes — one extra line inside an executor.
    const anchor = 'async executor(ctx: ToolContext, args: SearchProductsArgs) {';
    const archive = TOOLS_SOURCE.replace(
      anchor,
      `${anchor}\n      await productService.archive(ctx.businessId, args.id);`,
    );
    const adjust = TOOLS_SOURCE.replace(
      anchor,
      `${anchor}\n      await inventoryService.adjustStock(ctx.businessId, args.id, 5);`,
    );

    // If the anchor ever moves, the mutation silently does nothing and this test
    // would become the decoration it exists to prevent.
    assert.notEqual(archive, TOOLS_SOURCE, 'the positive control failed to mutate the source');
    assert.notEqual(adjust, TOOLS_SOURCE, 'the positive control failed to mutate the source');
    assert.deepEqual(writeShapedServiceCalls(archive), ['productService.archive']);
    assert.deepEqual(writeShapedServiceCalls(adjust), ['inventoryService.adjustStock']);
  });

  it('grants every tool a read permission, and never a write-shaped one', () => {
    for (const tool of AI_TOOLS) {
      assert.ok(
        READ_ONLY_PERMISSIONS.has(tool.permission),
        `${tool.name} is gated on "${tool.permission}", which is not a read permission`,
      );
    }
    // The read set itself must be read-shaped, or the pin above would accept a
    // write capability that happened to be added to it.
    for (const permission of READ_ONLY_PERMISSIONS) {
      assert.doesNotMatch(
        permission,
        /manage|stock-in|stock-out|receive|delete/,
        `"${permission}" is a write capability and must never gate an AI tool`,
      );
    }
  });

  it('advertises exactly the tools it can execute — no hidden callable, no ghost', () => {
    // A tool present in the table but absent from AI_TOOL_DEFS is invisible to the
    // model yet still reachable by name through executeTool; the reverse is a lie
    // told to the model. The two must be the same list.
    assert.deepEqual(
      AI_TOOL_DEFS.map((t) => t.name),
      AI_TOOLS.map((t) => t.name),
    );
  });

  it('every tool is fully declared', () => {
    const names = AI_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
    for (const tool of AI_TOOLS) {
      assert.ok(tool.name && typeof tool.name === 'string', 'a tool needs a name');
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(typeof tool.executor, 'function', `${tool.name} needs an executor`);
      assert.ok(tool.permission, `${tool.name} must declare a permission`);
    }
  });

  it('rejects a smuggled businessId or Mongo operator on EVERY tool', () => {
    // The argument layer is the only place a client- or model-supplied tenant
    // could enter: businessId always comes from the session, and an unknown key
    // must be refused before any executor sees it.
    for (const tool of AI_TOOLS) {
      for (const injected of [{ businessId: 'other-tenant' }, { $where: 'this' }, { role: 'OWNER' }]) {
        const { problems } = validateToolArgs(tool, injected);
        assert.ok(
          problems.some((p) => p.includes('unknown argument')),
          `${tool.name} accepted ${JSON.stringify(injected)}: ${problems.join('; ') || 'no problem reported'}`,
        );
      }
    }
  });

  it('cannot be asked to run a write tool, whether or not the model invents the name', async () => {
    for (const name of WRITE_TOOL_NAMES) {
      const result = await executeTool(name, {}, ctx);
      assert.equal(result.ok, false, `${name} must not exist`);
      assert.equal(result.code, 'TOOL_NOT_FOUND', `${name} answered ${result.code}`);
    }
  });

  it('denies a tool whose permission the role does not hold, before it can run', async () => {
    // Derived, not hardcoded: find a tool STAFF cannot hold. The assertion that one
    // exists is what keeps this test from becoming vacuously true.
    const denied = AI_TOOLS.find((t) => !hasPermission(ROLES.STAFF, t.permission));
    assert.ok(denied, 'no tool is beyond STAFF — this test would prove nothing');
    assert.equal(
      hasPermission(ROLES.STAFF, denied.permission),
      false,
      `${denied.name} is expected to be gated on ${denied.permission}`,
    );

    const result = await executeTool(denied.name, {}, { ...ctx, role: ROLES.STAFF });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOOL_FORBIDDEN');
  });

  it('does not deny everything — a role that holds the permission gets past the gate', () => {
    // The mirror of the test above: STAFF legitimately reads the catalogue, so the
    // denial there is a permission decision and not a table that refuses all comers.
    assert.equal(hasPermission(ROLES.STAFF, PERMISSIONS.PRODUCTS_VIEW), true);
    assert.ok(AI_TOOLS.some((t) => t.permission === PERMISSIONS.PRODUCTS_VIEW));
  });
});
