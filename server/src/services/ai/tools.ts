/**
 * Read-only AI tools (V1). See SYSTEM_SPECIFICATION.md §22–§24.
 *
 * Every tool:
 *   1. receives the authenticated session context { businessId, userId, role },
 *   2. enforces the same role permission its REST counterpart uses,
 *   3. queries only the user's own business (businessId always from ctx),
 *   4. validates arguments against a strict JSON Schema (no businessId, no
 *      MongoDB operators/keys, no unrestricted filters, no collection names),
 *   5. caps every result list,
 *   6. returns structured data — it never writes and never executes arbitrary
 *      MongoDB queries. Unauthorized/unknown/invalid calls are soft results the
 *      assistant can explain, not crashes.
 *
 * Result payloads deliberately reuse the existing read services (products,
 * inventory, transactions, dashboard) so the numbers match the app exactly.
 *
 * Typing note: the JSON Schemas below are runtime DATA — they are handed to the
 * model verbatim — so they stay plain objects described by schema shapes, never
 * replaced by interfaces that could not be sent. Argument typing is a boundary
 * annotation only: the model's arguments arrive as `unknown`, and the runtime
 * checks in `validateToolArgs` (unchanged) are what admit them. Each tool's
 * argument interface documents what survives that check; it never performs it.
 */

import { dashboardService } from '../dashboard.service.ts';
import { inventoryService } from '../inventory.service.ts';
import { productService } from '../product.service.ts';
import { categoryService, locationService } from '../reference.service.ts';
import { transactionsService, TRANSACTION_TYPES } from '../transactions.service.ts';
import { hasPermission, PERMISSIONS } from '../../constants/roles.ts';
import { localDateTime } from '../../utils/timeZone.ts';

/** The authenticated session context a tool runs under — always server-derived. */
interface ToolContext {
  businessId: string;
  userId: string;
  role: string;
  /**
   * The member's IANA zone for THIS turn (already resolved by the service).
   * Optional so a direct caller gets the pre-existing payload shape; every
   * production path supplies it.
   */
  timeZone?: string;
}

/**
 * Arguments as the model produced them: an unvalidated bag of JSON values.
 * Nothing may read a field before `validateToolArgs` has checked it.
 */
type ToolArguments = Record<string, unknown>;

/** The JSON Schema keywords these tool schemas use, and that validation reads. */
interface PropertySchema {
  type?: string;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
}

/**
 * A tool's `parameters`. The index signature is what keeps a schema assignable
 * to the provider layer's `Record<string, unknown>`, because the model — not
 * TypeScript — is what consumes it.
 */
interface ToolSchema extends Record<string, unknown> {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, PropertySchema>;
  description?: string;
}

/** A product row this module formats: a hydrated document or an aggregate row. */
type ProductDTOSource = Parameters<typeof productService.toProductDTO>[0];

/** The same row plus the summed availability the stock lists attach to it. */
type StockCardSource = ProductDTOSource & { available?: number | null };

/** One inventory row, exactly as `listRows` returns it. */
type InventoryRow = Awaited<ReturnType<typeof inventoryService.listRows>>['items'][number];

/**
 * Per-tool argument shapes: what each tool's schema admits, and therefore what
 * `validateToolArgs` has already enforced by the time its executor runs. Each
 * extends `ToolArguments` so it stays assignable to the single executor
 * signature the tool table declares.
 */
interface SearchProductsArgs extends ToolArguments, CategoryRef {
  q?: string;
  status?: string;
  limit?: number;
}

interface GetProductArgs extends ToolArguments {
  id?: string;
  sku?: string;
  barcode?: string;
}

interface LocationRef {
  locationId?: string;
  location?: string;
}

interface CategoryRef {
  categoryId?: string;
  category?: string;
}

interface GetInventoryArgs extends ToolArguments, LocationRef {
  productId?: string;
  q?: string;
  status?: string;
  lowStock?: boolean;
  outOfStock?: boolean;
  limit?: number;
}

interface LimitArgs extends ToolArguments {
  limit?: number;
}

interface ReorderArgs extends ToolArguments, CategoryRef {
  q?: string;
  limit?: number;
}

interface HistoryArgs extends ToolArguments, LocationRef {
  productId?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
}

interface ProductsByLocationArgs extends ToolArguments, LocationRef {
  limit?: number;
}

interface ReferenceListArgs extends ToolArguments {
  q?: string;
  status?: string;
  limit?: number;
}

/**
 * One entry of the tool table. `executor` is declared with method syntax so the
 * per-tool argument interfaces above stay assignable to it, while the call site
 * still hands it the validated argument bag `validateToolArgs` produced.
 */
interface Tool {
  name: string;
  description: string;
  permission: string;
  defaultLimit?: number;
  parameters?: ToolSchema;
  executor(ctx: ToolContext, args: ToolArguments): Promise<unknown>;
}

const objectId = { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
const statusEnum = { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] };
const limitParam = (def: number, max: number) => ({ type: 'integer', minimum: 1, maximum: max, description: `Maximum rows (default ${def}, up to ${max}).` });

function productCore(doc: ProductDTOSource) {
  const dto = productService.toProductDTO(doc);
  return {
    id: dto.id,
    name: dto.name,
    sku: dto.sku,
    barcode: dto.barcode,
    unit: dto.unit,
    status: dto.status,
    minimumStock: dto.minimumStock,
    category: dto.category,
    sellingPrice: dto.sellingPrice,
  };
}

function stockCard(doc: StockCardSource) {
  return { ...productCore(doc), availableQuantity: Number.isFinite(doc.available) ? doc.available : null };
}

/**
 * A reference row (location or category) as the MODEL needs it.
 *
 * Why this mapping exists at all, rather than returning `toPublic()` verbatim: it
 * carries `id`, `name`, `description` and `status` — the id is the point, because it
 * is what the id-taking tools below require — and it deliberately OMITS `businessId`.
 * The tenant is already the session's, so publishing it into the transcript buys the
 * model nothing and puts a tenant identifier in a prompt.
 */
function referenceItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ?? null,
    status: row.status,
  };
}

/**
 * AI-15 — resolve the location a tool call refers to, by id OR by exact name.
 *
 * WHY A NAME IS ACCEPTED AT ALL. A member says *"Main Warehouse"*; the tools used to take
 * only an id, so the model had to spend a whole provider round-trip on `listLocations` to
 * translate the name before it could ask the real question. On the measured free-tier turns
 * that round-trip costs about 5 s and a full re-send of the prompt and tool catalogue — and
 * the reference lookup had no purpose beyond the translation. With this, one call does the
 * job whenever the name is exact.
 *
 * WHY IT IS NOT A GUESS. Only an EXACT name (case- and surrounding-whitespace-insensitive,
 * anchored in the query) resolves, only among ACTIVE locations, and only within the
 * session's own business. Anything else is a soft result the model can explain: no match
 * points it at `listLocations`, and a duplicated name returns **both** candidates rather
 * than picking one, because picking is how a member is told about the wrong shelf. Passing
 * both forms in one call is refused for the same reason: two answers are not one.
 */
async function resolveLocation(ctx: ToolContext, args: LocationRef, { required = true }: { required?: boolean } = {}) {
  if (args.locationId && args.location) {
    return {
      ok: false as const,
      result: {
        found: false,
        error: 'Pass either locationId or location, not both.',
      },
    };
  }
  if (args.locationId) return { ok: true as const, id: args.locationId };
  // `getInventory` is a general inventory query, and "all locations" is its documented
  // default — so for it, no location is a legitimate absence rather than a missing
  // argument. `getProductsByLocation` is about one place by definition and does refuse.
  if (!args.location) {
    if (!required) return { ok: true as const, id: undefined };
    return { ok: false as const, result: { found: false, error: 'A locationId or a location name is required.' } };
  }

  const name = args.location.trim();
  if (!name) {
    return { ok: false as const, result: { found: false, error: 'The location name was empty.' } };
  }

  const { items } = await locationService.list(ctx.businessId, {
    exactName: name,
    status: 'ACTIVE',
    skip: 0,
    limit: 2,
  });
  // `limit: 2` above is what makes this cheap: one match resolves, two prove a duplicate,
  // and there is no third case that changes the answer.
  const [first, second] = items;
  if (first && !second) return { ok: true as const, id: String(first.id) };
  if (first && second) {
    return {
      ok: false as const,
      result: {
        found: false,
        ambiguous: true,
        message: `More than one active location is named "${name}". Pass locationId instead.`,
        matches: [first, second].map((row) => ({ id: String(row.id), name: String(row.name) })),
      },
    };
  }
  return {
    ok: false as const,
    result: {
      found: false,
      message: `No active location is named "${name}". Use listLocations to see the active locations.`,
    },
  };
}

/**
 * AI-16 — resolve the CATEGORY a tool call refers to, by id OR by exact name.
 *
 * The same defect AI-15 fixed for locations, one tool over: `searchProducts` and
 * `getReorderNeededProducts` filter on `categoryId`, so *"how many beverages products are
 * low?"* cost a provider round-trip to `listCategories` purely to translate the word
 * "beverages". A category name is a member's word, not a key, so the rules are the ones
 * AI-15 established for locations and for the same reasons: only an EXACT name
 * (case- and surrounding-whitespace-insensitive, anchored and escaped), only among ACTIVE
 * categories of the session's own business; a duplicated name returns BOTH candidates
 * rather than choosing; asking by both forms at once is refused.
 *
 * CATEGORY IS OPTIONAL here, unlike `getProductsByLocation`'s location: both tools are
 * documented as catalogue-wide queries, so no category means "every category" — the
 * existing behaviour, not a missing argument.
 */
async function resolveCategory(ctx: ToolContext, args: CategoryRef, { required = false }: { required?: boolean } = {}) {
  if (args.categoryId && args.category) {
    return {
      ok: false as const,
      result: {
        found: false,
        error: 'Pass either categoryId or category, not both.',
      },
    };
  }
  if (args.categoryId) return { ok: true as const, id: args.categoryId };
  if (!args.category) {
    if (!required) return { ok: true as const, id: undefined };
    return { ok: false as const, result: { found: false, error: 'A categoryId or a category name is required.' } };
  }

  const name = args.category.trim();
  if (!name) {
    return { ok: false as const, result: { found: false, error: 'The category name was empty.' } };
  }

  const { items } = await categoryService.list(ctx.businessId, {
    exactName: name,
    status: 'ACTIVE',
    skip: 0,
    limit: 2,
  });
  const [first, second] = items;
  if (first && !second) return { ok: true as const, id: String(first.id) };
  if (first && second) {
    return {
      ok: false as const,
      result: {
        found: false,
        ambiguous: true,
        message: `More than one active category is named "${name}". Pass categoryId instead.`,
        matches: [first, second].map((row) => ({ id: String(row.id), name: String(row.name) })),
      },
    };
  }
  return {
    ok: false as const,
    result: {
      found: false,
      message: `No active category is named "${name}". Use listCategories to see the active categories.`,
    },
  };
}

/**
 * AI-18 — every paged list states its own page, in the data rather than in the prompt alone.
 *
 * WHY THIS EXISTS, measured on the device on 2026-10-19. The specification's own example
 * question, *"Show me the inventory in Main Warehouse"*, called `getInventory`, received a
 * page of 25 rows out of 203, and rendered all 25 as a Markdown table — 800 output tokens,
 * exactly AI-8's cap, so the answer stopped mid-table at row 16 and the member read a
 * truncation note instead of an answer. The model HAD the total (`count: 203`) beside the
 * array and even said "showing the first 25 of 203" — and enumerated anyway, because a bare
 * number next to `items` does not say the array is a window rather than the list. `hasMore`
 * is that missing sentence. It is reported by every paged list, so a new tool cannot quietly
 * omit it, and it costs a handful of tokens per result beside a page of rows.
 */
function page(count: number, items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    count,
    returned: items.length,
    hasMore: count > items.length,
    ...extra,
    items,
  };
}

/**
 * AI-19 — a history row as the MODEL needs it, not as the ledger stores it.
 *
 * WHY THIS EXISTS. `getInventoryHistory` returned `transactionPublic` verbatim, which
 * carries `businessId` and `userId` — so every history answer put a tenant identifier and an
 * internal user id into the prompt, the one thing the reference rows (`referenceItem`) take
 * care to omit, and charged the member for ~48 characters of identifiers per row they never
 * see. Narrowing the row is also what makes a page fit the output budget: measured on the
 * device 2026-10-19, *"What moved recently in Main Warehouse?"* spent its whole 800-token
 * answer reproducing ledger fields, and the turn came back `degraded` with the table cut
 * off. The fields kept here are the ones an answer actually says out loud — what moved,
 * where, how much, before and after, why, and when — plus the product and location NAMES the
 * `$lookup` already paid for.
 */
type HistoryItemSource = Awaited<ReturnType<typeof transactionsService.list>>['items'][number];

/** `createdAt` as the member's local `YYYY-MM-DD HH:mm`, when it is a real instant. */
function localTimeOf(value: unknown, timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  const instant = new Date(value as string | number | Date);
  return Number.isNaN(instant.getTime()) ? undefined : localDateTime(instant, timeZone);
}

/**
 * The movement as the model reads it, in the member's own clock.
 *
 * `createdAt` is kept (an instant is the unambiguous record), and `localTime`
 * is added beside it because the model cannot be trusted to do arithmetic on a
 * UTC string: asked to convert, it states the UTC time or invents an offset. The
 * prompt points it at `localTime`, and the row itself is unambiguous.
 */
function transferDirectionOf(previousQuantity: number, newQuantity: number): 'out' | 'in' | undefined {
  if (newQuantity < previousQuantity) return 'out';
  if (newQuantity > previousQuantity) return 'in';
  return undefined;
}

function historyItemForModel(item: HistoryItemSource, timeZone?: string) {
  const product = item.product as { id?: unknown; name?: unknown } | null | undefined;
  const location = item.location as { id?: unknown; name?: unknown } | null | undefined;
  const local = localTimeOf(item.createdAt, timeZone);
  const direction =
    item.type === 'TRANSFER' ? transferDirectionOf(Number(item.previousQuantity), Number(item.newQuantity)) : undefined;
  return {
    id: item.id,
    type: item.type,
    quantity: item.quantity,
    previousQuantity: item.previousQuantity,
    newQuantity: item.newQuantity,
    reason: item.reason ?? null,
    reference: item.reference ?? null,
    product: product ? { id: product.id, name: product.name } : null,
    location: location ? { id: location.id, name: location.name } : null,
    createdAt: item.createdAt,
    ...(local ? { localTime: local } : {}),
    ...(direction ? { direction } : {}),
  };
}

type HistoryItem = ReturnType<typeof historyItemForModel>;

/**
 * AI-42 — a complete transfer pair as ONE model-facing event.
 *
 * WHY THE LEGS ARE FOLDED HERE. A transfer is one business event and two immutable
 * ledger rows, and `transactionsService.list` is deliberately shared with the Inventory
 * History screen, which keeps both rows (phase19's history case). The assistant reads the
 * rows, not the dashboard's grouped activity, so an ungrouped page let an answer count one
 * transfer twice — and a phone answer also put the source on the wrong side, because a
 * single leg carries only its own location. Folding the pair here gives the model `from`,
 * `to` and one event without changing what the History screen shows.
 *
 * A single leg — a location-filtered page, or a pair split by the page boundary — stays a
 * leg and carries `direction`, which is the one fact a leg can state on its own.
 */
function foldTransferEvents(rows: HistoryItem[]) {
  const legsByReference = new Map<string, HistoryItem[]>();
  for (const row of rows) {
    if (row.type !== 'TRANSFER' || row.reference == null || row.reference === '') continue;
    const key = String(row.reference);
    const legs = legsByReference.get(key);
    if (legs) legs.push(row);
    else legsByReference.set(key, [row]);
  }

  const complete = new Map<string, { source: HistoryItem; destination: HistoryItem }>();
  for (const [key, legs] of legsByReference) {
    if (legs.length !== 2) continue;
    const source = legs.find((leg) => leg.direction === 'out');
    const destination = legs.find((leg) => leg.direction === 'in');
    if (source && destination) complete.set(key, { source, destination });
  }
  if (complete.size === 0) return { items: rows, pairs: 0 };

  const emitted = new Set<string>();
  const items: (HistoryItem | Record<string, unknown>)[] = [];
  for (const row of rows) {
    const key = row.type === 'TRANSFER' && row.reference != null ? String(row.reference) : '';
    const pair = key ? complete.get(key) : undefined;
    if (!pair) {
      items.push(row);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    items.push({
      id: key,
      type: 'TRANSFER',
      quantity: pair.source.quantity,
      product: pair.source.product,
      from: pair.source.location,
      to: pair.destination.location,
      reference: pair.source.reference,
      createdAt: row.createdAt,
      ...(row.localTime ? { localTime: row.localTime } : {}),
    });
  }
  return { items, pairs: complete.size };
}

function rowResult(r: InventoryRow) {
  return {
    id: r.id,
    product: r.product,
    location: r.location,
    quantity: r.quantity,
    reservedQuantity: r.reservedQuantity,
    availableQuantity: r.availableQuantity,
    isLowStock: r.isLowStock,
    isOutOfStock: r.isOutOfStock,
  };
}

const tools: Tool[] = [
  {
    name: 'searchProducts',
    description:
      'Search the product catalog by name, SKU, or barcode (partial match, case-insensitive). Use this first when the user names a product and you need its id. A category may be given as `categoryId` or as the exact `category` name (an ACTIVE category of this business). Returns catalog fields only — use getProduct or getInventory for stock levels.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 100, description: 'Search text (product name, SKU, or barcode).' },
        status: statusEnum,
        categoryId: objectId,
        category: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE category, e.g. "Beverages". Use instead of categoryId when no id is known.',
        },
        limit: limitParam(15, 25),
      },
    },
    async executor(ctx: ToolContext, args: SearchProductsArgs) {
      const category = await resolveCategory(ctx, args);
      if (!category.ok) return category.result;
      const { items, total } = await productService.list(ctx.businessId, {
        q: args.q,
        status: args.status,
        categoryId: category.id,
        skip: 0,
        limit: Math.min(args.limit ?? 15, 25),
      });
      return page(total, items.map(productCore));
    },
  },

  {
    name: 'getProduct',
    description:
      'Get one product (by id, SKU, or barcode) with its current stock per location. Returns found:false when the product does not exist in this business.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: objectId,
        sku: { type: 'string', maxLength: 100, description: 'Exact SKU.' },
        barcode: { type: 'string', maxLength: 100, description: 'Exact barcode.' },
      },
      description: 'Provide exactly one of id, sku, or barcode.',
    },
    async executor(ctx: ToolContext, args: GetProductArgs) {
      if (!args.id && !args.sku && !args.barcode) {
        return { found: false, error: 'Provide one of id, sku, or barcode.' };
      }
      const doc = await productService.getByIdentifier(ctx.businessId, {
        id: args.id,
        sku: args.sku,
        barcode: args.barcode,
      });
      if (!doc) return { found: false };
      const rows = await inventoryService.listRows(ctx.businessId, {
        productId: String(doc._id),
        skip: 0,
        limit: 20,
      });
      return {
        found: true,
        product: { ...productCore(doc), stock: rows.items.map(rowResult), stockRows: rows.total },
      };
    },
  },

  {
    name: 'getInventory',
    description:
      'Inventory rows (a product at a location) with on-hand quantity, reserved quantity, and available quantity. Filter by product, location, product search text, product status, low stock, or out of stock. A location may be given as `locationId` or as the exact `location` name (an ACTIVE location of this business).',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: objectId,
        locationId: objectId,
        location: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE location, e.g. "Main Warehouse". Use instead of locationId when no id is known.',
        },
        q: { type: 'string', maxLength: 100, description: 'Search product name/SKU/barcode.' },
        status: statusEnum,
        lowStock: { type: 'boolean', description: 'Only rows where available is at or below the product minimum.' },
        outOfStock: { type: 'boolean', description: 'Only rows where available is zero or negative.' },
        limit: limitParam(15, 25),
      },
    },
    async executor(ctx: ToolContext, args: GetInventoryArgs) {
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      const { items, total } = await inventoryService.listRows(ctx.businessId, {
        productId: args.productId,
        locationId: location.id,
        q: args.q,
        status: args.status,
        lowStock: args.lowStock,
        outOfStock: args.outOfStock,
        skip: 0,
        limit: Math.min(args.limit ?? 15, 25),
      });
      // The resolved id travels with the page for the same reason AI-15 gave it to
      // `getProductsByLocation`: it is what makes the answer checkable ("is this page really
      // Main Warehouse?") without spending another call. Absent when no location was given.
      return page(total, items.map(rowResult), location.id ? { locationId: location.id } : {});
    },
  },

  {
    name: 'getLowStockProducts',
    description:
      'Products whose available quantity is at or below their configured minimum stock (availability summed across all locations), including products with nothing available. Returns the current page of matching products. For a restock list that flags each item as out-of-stock or low-stock, prefer getReorderNeededProducts.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 20,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: limitParam(20, 50) },
    },
    async executor(ctx: ToolContext, args: LimitArgs) {
      const { items, total } = await productService.list(ctx.businessId, {
        lowStock: true,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(stockCard));
    },
  },

  {
    name: 'getOutOfStockProducts',
    description:
      'Products with no available stock (available quantity zero or below, summed across all locations). Returns the current page of matching products. Use for "what products are out of stock". For a restock list that also includes low-stock items, prefer getReorderNeededProducts.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 20,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: limitParam(20, 50) },
    },
    async executor(ctx: ToolContext, args: LimitArgs) {
      const { items, total } = await productService.list(ctx.businessId, {
        outOfStock: true,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(stockCard));
    },
  },

  {
    name: 'getReorderNeededProducts',
    description:
      'Products that need restocking: ACTIVE products whose available quantity (summed across all locations) is at or below their configured minimum stock. Each result is flagged stockStatus OUT_OF_STOCK when nothing is available, otherwise LOW_STOCK, and out-of-stock items are listed first. A category may be given as `categoryId` or as the exact `category` name (an ACTIVE category of this business). Use for "what products need restocking", "which products are low in stock or out of stock", "what should I reorder", or "what is running low".',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 20,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 100, description: 'Search product name/SKU/barcode.' },
        categoryId: objectId,
        category: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE category, e.g. "Beverages". Use instead of categoryId when no id is known.',
        },
        limit: limitParam(20, 50),
      },
    },
    async executor(ctx: ToolContext, args: ReorderArgs) {
      const category = await resolveCategory(ctx, args);
      if (!category.ok) return category.result;
      const { items, total } = await productService.listReorder(ctx.businessId, {
        q: args.q,
        categoryId: category.id,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(productService.reorderItemPublic));
    },
  },

  {
    name: 'getInventorySummary',
    description:
      'Business-wide inventory-health counts: active products, healthy in-stock products (available above their minimum stock), total on-hand quantity, low-stock and out-of-stock product counts, and the most recent stock movements — one entry per logical event, so a transfer between locations appears once with its source and destination rather than as two rows. Use for "how is my inventory doing".',
    permission: PERMISSIONS.DASHBOARD_VIEW,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async executor(ctx: ToolContext) {
      // AI-41 — the dashboard's recent activity carries the same instants as the
      // history page, so it gets the same local rendering. The rest of the summary
      // is returned untouched: this is a display field, not a new metric.
      const summary = await dashboardService.summary(ctx.businessId);
      const { timeZone } = ctx;
      if (!timeZone) return summary;
      return {
        ...summary,
        recentActivity: summary.recentActivity.map((item) => {
          const local = localTimeOf(item.createdAt, timeZone);
          return local ? { ...item, localTime: local } : item;
        }),
      };
    },
  },

  // ---------------------------------------------------------------------------
  // AI-23 — THE COMPARISON A SINGLE LOOKUP CAN ANSWER.
  //
  // Measured on the device 2026-10-19 (§27DO): *"Compare my two locations, how many
  // products are in each?"* cost 3 provider calls and 29.3 s even after AI-22 taught
  // the model to batch — because the member never names the locations, so a call had to
  // be spent learning them before any per-location question could be phrased. Batching
  // cannot help there: the second lookup is unwritable until the first answers.
  //
  // This is the capability that turns it into ONE lookup. It takes no arguments at all,
  // which is also the strictest possible schema — there is no field in which a
  // businessId could arrive, and a model that tries one is refused like anywhere else.
  // The permission is DASHBOARD_VIEW because this is the same inventory-health read the
  // dashboard performs, one level down: it is a read capability among the four the
  // assistant may hold, and all four roles hold it.
  {
    name: 'getLocationBreakdown',
    description:
      'Stock broken down BY LOCATION: for every location, how many distinct products it holds and how many units are on hand, plus business totals. Use it for ANY question that compares locations or asks where stock is held — "compare my two locations", "how many products are at each location", "which location has the most stock", "where is my stock" — in ONE call, instead of listing the locations and then asking about each one. Archived locations are included and marked, because they still hold stock; a location with no stock appears with zero rather than being omitted.',
    permission: PERMISSIONS.DASHBOARD_VIEW,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async executor(ctx: ToolContext) {
      return inventoryService.locationBreakdown(ctx.businessId);
    },
  },

  {
    name: 'getInventoryHistory',
    description:
      'Recent stock movements (newest first). Optionally filter by product, location, movement type, and a createdAt range. A location may be given as `locationId` or as the exact `location` name. Returns the current page of logical events. A complete stock transfer is ONE event with `from` and `to` even though the ledger keeps two rows; a location-filtered page may return one leg, whose `direction` is `out` or `in`.',
    permission: PERMISSIONS.INVENTORY_HISTORY_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: objectId,
        locationId: objectId,
        location: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE location, e.g. "Main Warehouse". Use instead of locationId when no id is known.',
        },
        type: { type: 'string', enum: [...TRANSACTION_TYPES], description: 'Movement type.' },
        from: { type: 'string', format: 'date-time', maxLength: 40, description: 'ISO date; include movements created at or after this.' },
        to: { type: 'string', format: 'date-time', maxLength: 40, description: 'ISO date; include movements created at or before this.' },
        limit: limitParam(15, 50),
      },
    },
    async executor(ctx: ToolContext, args: HistoryArgs) {
      // Optional here for the same reason it is optional on `getInventory`: history with no
      // location means every location, which is the tool's documented default.
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      const { items, total } = await transactionsService.list(ctx.businessId, {
        productId: args.productId,
        locationId: location.id,
        type: args.type,
        from: args.from,
        to: args.to,
        skip: 0,
        limit: Math.min(args.limit ?? 15, 50),
      });
      const mapped = items.map((item) => historyItemForModel(item, ctx.timeZone));
      const folded = foldTransferEvents(mapped);
      // `transferStats` counts the filtered set, not this page, so the total stays logical
      // even when a pair sits beyond the page boundary. No transfer filter can contribute
      // to a non-TRANSFER type, so the extra aggregation is skipped for those pages.
      let logicalTotal = total;
      if (!args.type || args.type === 'TRANSFER') {
        const stats = await transactionsService.transferStats(ctx.businessId, {
          productId: args.productId,
          locationId: location.id,
          type: args.type,
          from: args.from,
          to: args.to,
        });
        logicalTotal = total - stats.rows + stats.events;
      }
      return page(logicalTotal, folded.items, location.id ? { locationId: location.id } : {});
    },
  },

  {
    name: 'getProductsByLocation',
    description:
      'Products currently stocked at a specific location, with the available quantity at that location. Give the location by exact name (`location`, e.g. "Main Warehouse") or by id (`locationId`) — the name saves a lookup step when the member already said it.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 20,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: objectId,
        location: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE location, e.g. "Main Warehouse". Use instead of locationId when no id is known.',
        },
        limit: limitParam(20, 50),
      },
    },
    async executor(ctx: ToolContext, args: ProductsByLocationArgs) {
      const location = await resolveLocation(ctx, args);
      if (!location.ok) return location.result;
      const { items, total } = await productService.list(ctx.businessId, {
        locationId: location.id,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(stockCard), { locationId: location.id });
    },
  },

  // ---------------------------------------------------------------------------
  // AI-14 — REFERENCE DATA, and why it is a capability rather than a nicety.
  //
  // Two tools above take an ID the model has no way to look up. `getInventory` and
  // `getProductsByLocation` both filter on `locationId`, and `searchProducts` /
  // `getReorderNeededProducts` filter on `categoryId`, but until now nothing in the
  // tool table could turn "the Main Warehouse" or "Beverages" into one — so the
  // questions the specification's own examples use (*"Show me inventory in the
  // warehouse"*) were answerable only by luck, when an unrelated inventory row
  // happened to carry the id. Nothing in the assistant could answer *"which
  // locations do I have?"* at all.
  //
  // THE PERMISSION IS THE INTERESTING PART. The REST counterparts of these reads
  // (`GET /api/locations`, `GET /api/categories`) require only authentication — every
  // member of a business can list its locations and categories — so there is no
  // reference-read permission to mirror and no new one is invented: the tools are
  // gated on `INVENTORY_VIEW` and `PRODUCTS_VIEW` because that is what they are FOR
  // (resolving a filter on the inventory and catalogue tools), and all four roles hold
  // both, so this can narrow nobody's access. It is at least as strict as the route.
  //
  // ARCHIVED IS EXCLUDED BY DEFAULT, and the response says so in `status`. The app's
  // lists show archived rows only when asked; a model handed an archived location
  // would confidently report stock "in" somewhere that cannot receive any, which is
  // worse than not knowing it exists. `status: 'ARCHIVED'` is available when the
  // member asks about a closed location, and the description states the default.
  // ---------------------------------------------------------------------------
  {
    name: 'listLocations',
    description:
      'List this business’s locations with their ids and names. Use it to answer "which locations do I have" and to resolve a location NAME the member mentions into the id that getInventory and getProductsByLocation require — never guess a location id. Returns ACTIVE locations only unless status is given; an archived location cannot hold stock.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 25,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 100, description: 'Search location name or description.' },
        status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'], description: 'Defaults to ACTIVE.' },
        limit: limitParam(25, 50),
      },
    },
    async executor(ctx: ToolContext, args: ReferenceListArgs) {
      const status = args.status ?? 'ACTIVE';
      const { items, total } = await locationService.list(ctx.businessId, {
        q: args.q,
        status,
        skip: 0,
        limit: Math.min(args.limit ?? 25, 50),
      });
      return page(total, items.map(referenceItem), { status });
    },
  },

  {
    name: 'listCategories',
    description:
      'List this business’s product categories with their ids and names. Use it to answer category questions and to resolve a category NAME that a tool does not accept directly into its id — never guess a category id. searchProducts and getReorderNeededProducts accept the exact `category` name themselves, so no lookup is needed when the member’s word is exact. Returns ACTIVE categories only unless status is given.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    defaultLimit: 25,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 100, description: 'Search category name or description.' },
        status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'], description: 'Defaults to ACTIVE.' },
        limit: limitParam(25, 50),
      },
    },
    async executor(ctx: ToolContext, args: ReferenceListArgs) {
      const status = args.status ?? 'ACTIVE';
      const { items, total } = await categoryService.list(ctx.businessId, {
        q: args.q,
        status,
        skip: 0,
        limit: Math.min(args.limit ?? 25, 50),
      });
      return page(total, items.map(referenceItem), { status });
    },
  },
];

export const AI_TOOLS = Object.freeze(tools);

export const aiToolsById = new Map(tools.map((t) => [t.name, t] as const));

/** The tool catalog exposed to the AI model (name/description/JSON Schema). */
export const AI_TOOL_DEFS = Object.freeze(
  tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
);

function typeMatches(value: unknown, spec: PropertySchema) {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * Strict argument validation against the tool's JSON Schema. Any unknown key,
 * wrong type, out-of-range value, or malformed identifier produces a problem —
 * this is what makes an AI-supplied businessId, Mongo operator, or arbitrary
 * filter impossible to smuggle into the executors.
 *
 * `rawArgs` is `unknown` on purpose: it is model output, so the undefined/null
 * and non-object guards below are the contract, not a formality. The assertions
 * further down only tell the compiler what `typeMatches` has already proven at
 * runtime — they never stand in for it.
 */
export function validateToolArgs(tool: Tool, rawArgs: unknown) {
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { problems: ['arguments must be an object'], cleaned: {} };
  }

  const schema = tool.parameters ?? {};
  const props = schema.properties ?? {};
  const problems: string[] = [];
  const cleaned: ToolArguments = {};

  for (const key of schema.required ?? []) {
    // The assertion is only about `null`: narrowing `unknown` through
    // `typeof … === 'object'` admits it again, though the guard above has
    // already replaced a null with `{}`. The check itself is unchanged.
    if (!(key in (rawArgs as ToolArguments))) problems.push(`missing required argument "${key}"`);
  }

  for (const [key, value] of Object.entries(rawArgs as ToolArguments)) {
    const spec = props[key];
    if (!spec) {
      problems.push(`unknown argument "${key}" is not allowed`);
      continue;
    }
    if (value === null) {
      problems.push(`argument "${key}" must not be null`);
      continue;
    }
    if (!typeMatches(value, spec)) {
      problems.push(`argument "${key}" must be a ${spec.type}`);
      continue;
    }
    if (spec.type === 'string') {
      if (spec.enum && !spec.enum.includes(value)) {
        problems.push(`argument "${key}" must be one of: ${spec.enum.join(', ')}`);
        continue;
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value as string)) {
        problems.push(`argument "${key}" has an invalid value`);
        continue;
      }
      if (typeof spec.maxLength === 'number' && (value as string).length > spec.maxLength) {
        problems.push(`argument "${key}" is too long (max ${spec.maxLength} characters)`);
        continue;
      }
      if (spec.format === 'date-time' && Number.isNaN(Date.parse(value as string))) {
        problems.push(`argument "${key}" must be an ISO date-time`);
        continue;
      }
    }
    if ((spec.type === 'integer' || spec.type === 'number')) {
      if (typeof spec.minimum === 'number' && (value as number) < spec.minimum) {
        problems.push(`argument "${key}" must be at least ${spec.minimum}`);
        continue;
      }
      if (typeof spec.maximum === 'number' && (value as number) > spec.maximum) {
        problems.push(`argument "${key}" must be at most ${spec.maximum}`);
        continue;
      }
    }
    cleaned[key] = value;
  }
  return { problems, cleaned };
}

/**
 * Run one tool call for the authenticated context. Never throws for model-
 * driven problems — invalid/unauthorized/unknown calls become structured
 * results the assistant can see and explain.
 *
 * A permission check is repeated here, at execution time, because the tool table
 * is the last gate before a query runs: the model cannot reach an executor by
 * presenting a role, and `businessId` is only ever the one from `ctx`.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext) {
  const tool = aiToolsById.get(name);
  if (!tool) {
    return { ok: false, code: 'TOOL_NOT_FOUND', error: `The tool "${name}" is not available.` };
  }
  if (!hasPermission(ctx.role, tool.permission)) {
    return {
      ok: false,
      code: 'TOOL_FORBIDDEN',
      error: `You do not have permission to use the "${tool.name}" tool. Only a higher role can access that data.`,
    };
  }
  const { problems, cleaned } = validateToolArgs(tool, rawArgs);
  if (problems.length) {
    return { ok: false, code: 'TOOL_INVALID_ARGUMENTS', error: `Invalid arguments for "${tool.name}": ${problems.join('; ')}` };
  }
  try {
    const value = await tool.executor(ctx, cleaned);
    return { ok: true, result: value };
  } catch (err) {
    // `err` is `unknown`: a thrown value has no shape TypeScript may assume, and
    // the assertion is the erasable way to read the message this log has always
    // read. Nothing is attached to the error that leaves.
    console.error('[ai] tool execution failed', name, (err as { message?: unknown })?.message ?? err);
    return { ok: false, code: 'TOOL_ERROR', error: 'The tool failed to run. Please try again.' };
  }
}

export default { AI_TOOLS, AI_TOOL_DEFS, executeTool, validateToolArgs };
