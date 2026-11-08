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
import { researchInventoryWeb, WEB_RESEARCH_NOTE, type ResearchFocus, type ResearchSubject } from './webResearch.ts';
import { MARKET_PRICE_NOTE, researchMarketPrices, type PriceSubject } from './marketPrices.ts';
import { aiConfig } from './aiConfig.ts';
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
  /**
   * The turn's cancellation signal. Tools that can wait on the network (price
   * research) must forward it, so a deadline or a client disconnect stops the
   * work instead of letting the tool outlive the turn.
   */
  signal?: AbortSignal;
  /**
   * The turn's absolute deadline. Research tools use it to stop before the whole
   * budget is gone, so the model still has a round left to answer with the evidence
   * that was collected.
   */
  deadlineAt?: number;
}

/**
 * The deadline a research tool may run to: the smaller of the turn's remaining
 * budget and its own research budget. The turn deadline alone is too late — a tool
 * that spends it all leaves no round for the answer, which was the measured 60 s
 * timeout on the phone.
 */
/** Time kept back from research so the model can still compose a cited answer. */
const RESEARCH_ANSWER_RESERVE_MS = 15000;

function researchDeadlineAt(ctx: ToolContext): number {
  const now = Date.now();
  const budgetEnd = now + aiConfig().researchBudgetMs;
  if (ctx.deadlineAt === undefined) return budgetEnd;
  // Several research tools can run in one turn, so the budget is clamped by what is
  // left of the turn too: a second tool gets only the remaining time, and every tool
  // stops before the reserve. Research that starts inside the reserve does no work and
  // returns partial evidence immediately, which still lets the model answer.
  const answerBy = ctx.deadlineAt - RESEARCH_ANSWER_RESERVE_MS;
  return Math.max(now, Math.min(budgetEnd, answerBy));
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

interface FindProductsArgs extends ToolArguments, CategoryRef {
  keywords?: string;
  inStockOnly?: boolean;
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

/** AI-61 — a stock list that can be narrowed to one place ("what's low at the counter?"). */
interface LocationLimitArgs extends ToolArguments, LocationRef {
  limit?: number;
}

/** AI-71 — dead stock, optionally since a date and optionally on one shelf. */
interface NeverSoldArgs extends ToolArguments, LocationRef {
  from?: string;
  limit?: number;
}

interface ReorderArgs extends ToolArguments, CategoryRef {
  q?: string;
  limit?: number;
}

/** AI-59 — the valuation read is optional-filtered by place and by kind of product. */
interface StockValueArgs extends ToolArguments, LocationRef, CategoryRef {
  limit?: number;
}

interface BrandSummaryArgs extends ToolArguments, CategoryRef {
  q?: string;
  limit?: number;
}

interface ResearchProductsArgs extends ToolArguments {
  productIds?: string;
  focus?: string;
}

interface ResearchPricesArgs extends ToolArguments {
  productIds?: string;
  stores?: string;
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

/**
 * AI-43 — the catalogue facts a recommendation may rest on.
 *
 * The product model has NO brand, model, specification, rating or review field. When a
 * member asks for the "best brands", the only way a model can comply from a row like
 * "Ultra Detergent 10990" is to treat the name's adjective as a quality claim or to fill
 * the gap from outside knowledge. Both are fabrication. This note travels with the rows so
 * the boundary is stated where the model reads it, not only in a system rule it may skim.
 *
 * `description` is free text and CAN name a brand or a specification. The note therefore
 * says a fact is known only when the description states it; it does not deny that a
 * description can carry one. The field is shortened in a list so a page of long
 * descriptions cannot push rows out through the tool-result cap; getProduct, which reads
 * one product, keeps the whole value.
 */
const CATALOG_GROUNDING_NOTE =
  'Catalogue facts are limited to the fields on these rows. Brand and specifications are optional recorded fields: null means none is recorded, not that the product has no brand or specifications. A description is free text and may add context, but never treat it as a specification that the specifications field does not state. Compare only against recorded specifications; if one product has no such fact, say it is not recorded and do not infer it. Recommend only products returned here, and never infer a brand or quality from a product name or from words such as "Premium", "Pro" or "Ultra".';
const BRAND_NOTE =
  'Brand is an optional recorded field. A product with no brand recorded is not counted here; no result means no brand is recorded for this filter, not that no brand exists. This page covers ACTIVE products only and does not include stock levels — use searchProducts, getProduct or getInventory to check what is on hand. The price range is the recorded selling price, not a quality or value rating; it carries the `currency` code when one is recorded on those products and `currency: null` when none is. When a brand has products in more than one currency the row sets `mixedCurrency: true`, `priceRange` min/max are null, and `priceRanges` holds one range per currency — compare only within the same currency and never add or convert them. Descriptions are free text, so compare only what they state. Never infer a brand from a product name or a description.';
const SEARCH_DESCRIPTION_NOTE =
  'No product name, recorded brand, SKU or barcode matched the query, so these rows are the ones whose recorded description or specifications contain its words. They are possible matches, not confirmed ones: name the match you relied on and ask before changing stock or price. If the member expected a different item, run findProducts with everyday synonyms before saying the catalogue has nothing.';
const FIND_NOTE =
  'This is a discovery search, not a quality ranking. It matches the supplied terms against product name, recorded brand, recorded description, recorded specifications, SKU and barcode, and returns available stock. Compare only the recorded brand, specifications, description, price, unit and availability; never call an item best, trusted or suitable for a use unless the row states it. No match means none of these terms are recorded, not that the business cannot stock such a product.';
const LIST_DESCRIPTION_MAX = 160;
const DETAIL_DESCRIPTION_MAX = 500;
const LIST_SPECIFICATIONS_MAX = 300;
const DETAIL_SPECIFICATIONS_MAX = 1000;

function catalogText(value: string | null | undefined, max: number) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function productCoreWithDescription(
  doc: ProductDTOSource,
  descriptionMax: number,
  specificationsMax: number,
) {
  const dto = productService.toProductDTO(doc);
  return {
    id: dto.id,
    name: dto.name,
    brand: dto.brand,
    sku: dto.sku,
    barcode: dto.barcode,
    description: catalogText(dto.description, descriptionMax),
    specifications: catalogText(dto.specifications, specificationsMax),
    unit: dto.unit,
    status: dto.status,
    minimumStock: dto.minimumStock,
    category: dto.category,
    sellingPrice: dto.sellingPrice,
    // The ISO code the price was recorded in, or null. The assistant must not guess one.
    currency: dto.currency ?? null,
  };
}

// No second parameter on either wrapper: `items.map(productCore)` passes the array index as
// the second argument, and an index read as a description limit would quietly change every
// row after the first.
function productCore(doc: ProductDTOSource) {
  return productCoreWithDescription(doc, LIST_DESCRIPTION_MAX, LIST_SPECIFICATIONS_MAX);
}

function productDetailCore(doc: ProductDTOSource) {
  return productCoreWithDescription(doc, DETAIL_DESCRIPTION_MAX, DETAIL_SPECIFICATIONS_MAX);
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
      'Search the product catalog by name, recorded brand, SKU, or barcode (partial match, case-insensitive). Use this first when the user names a product and you need its id. A category may be given as `categoryId` or as the exact `category` name (an ACTIVE category of this business). Returns catalog fields only, including the recorded brand, description and specifications — use getProduct or getInventory for stock levels. When no name, brand, SKU or barcode matches, it retries the same words against the recorded descriptions and specifications and marks those rows with `matchedOn`, so an everyday word that appears only in a description still finds the product. For a broad discovery search across several synonyms, use findProducts.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 100, description: 'Search text (product name, brand, SKU, or barcode).' },
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
      const limit = Math.min(args.limit ?? 15, 25);
      let { items, total } = await productService.list(ctx.businessId, {
        q: args.q,
        status: args.status,
        categoryId: category.id,
        skip: 0,
        limit,
      });
      let matchedDescriptions = false;
      if (total === 0 && args.q?.trim()) {
        // A catalog name rarely repeats the everyday word the member used: "keyboard"
        // lives in the description of a `Keychron K8 Pro`, so a name-only search says
        // "nothing here". Retrying the same word against description and
        // specifications is the difference between a dead end and a usable answer.
        const terms = args.q
          .split(/[^a-z0-9]+/i)
          .map((term) => term.trim())
          .filter((term) => term.length >= 2)
          .slice(0, 4);
        if (terms.length > 0) {
          const deeper = await productService.list(ctx.businessId, {
            terms,
            includeDescription: true,
            status: args.status,
            categoryId: category.id,
            skip: 0,
            limit,
          });
          if (deeper.total > 0) {
            items = deeper.items;
            total = deeper.total;
            matchedDescriptions = true;
          }
        }
      }
      return page(
        total,
        items.map(productCore),
        matchedDescriptions
          ? { note: SEARCH_DESCRIPTION_NOTE, matchedOn: ['description', 'specifications'] }
          : { note: CATALOG_GROUNDING_NOTE },
      );
    },
  },

  {
    name: 'findProducts',
    description:
      'Find products for an everyday use, maintenance task or kind of product. Pass several likely words or phrases separated by commas — for example "engine oil, motor oil, 10W-40" — because the recorded name, brand, description or specifications may use a different one. It searches name, recorded brand, recorded description, recorded specifications, SKU and barcode, returns available stock, and can filter to an exact category or to items currently in stock. Use this BEFORE concluding the catalogue has nothing for a request. When nothing matches, the result carries the ACTIVE categories and a stop instruction: answer from that result, do not run another search. This is discovery, not a quality ranking: never call a result best or trusted unless its recorded data says so.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keywords'],
      properties: {
        keywords: {
          type: 'string',
          maxLength: 200,
          description: 'Comma-separated everyday search terms, e.g. "engine oil, motor oil, 10W-40". At least one non-empty term.',
        },
        categoryId: objectId,
        category: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE category, e.g. "Automotive". Use instead of categoryId when no id is known.',
        },
        inStockOnly: { type: 'boolean', description: 'When true, return only products with available stock above zero.' },
        limit: limitParam(15, 25),
      },
    },
    async executor(ctx: ToolContext, args: FindProductsArgs) {
      const category = await resolveCategory(ctx, args);
      if (!category.ok) return category.result;
      const rawKeywords = String(args.keywords ?? '').trim();
      // "products under 5,000" is a price request, not a product called "under 5,000".
      // The ceiling is applied in the database before paging, so a bounded page still
      // contains every qualifying row the answer may need.
      const priceLimit = rawKeywords.match(
        /\b(?:less than|under|below|cheaper than|up to|within)\s+(?:php|p|\u20b1)?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i,
      );
      const maxSellingPrice = priceLimit
        ? Number((priceLimit[1] ?? '').replace(/,/g, '')) * (priceLimit[2] ? 1000 : 1)
        : undefined;
      const withoutPrice = priceLimit
        ? rawKeywords.replace(priceLimit[0], ' ')
        : rawKeywords;
      const cleaned = withoutPrice
        .replace(
          /\b(?:products?|items?|things?|anything|something|show|me|which|what|are|is|cost|costs|costing|priced|price|prices|budget|php|pesos?)\b/gi,
          ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();
      const requestedTerms = cleaned
        .split(/[,;|]+/)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 8);
      // A headset is a headphone with a microphone. The catalogue records Sony as
      // headphones and SteelSeries as a headset, so a literal "headset" query hid the
      // Sony row from the office-calls question. These are search synonyms, not a claim
      // that both products have the same features.
      const terms = [
        ...new Set(
          requestedTerms.flatMap((term) => {
            const key = term.toLowerCase().replace(/s$/, '');
            return key === 'headset' || key === 'headphone'
              ? [term, 'headset', 'headphones', 'headphone']
              : [term];
          }),
        ),
      ].slice(0, 8);
      if (terms.length === 0 && maxSellingPrice === undefined) {
        const empty = {
          count: 0,
          returned: 0,
          hasMore: false,
          items: [],
          note: FIND_NOTE,
          error: 'Pass at least one search term in keywords.',
        };
        return empty;
      }
      const pageLimit = Math.min(args.limit ?? 15, 25);
      const search = (searchTerms: string[]) =>
        productService.list(ctx.businessId, {
          terms: searchTerms,
          includeDescription: true,
          status: 'ACTIVE',
          categoryId: category.id,
          maxSellingPrice,
          inStockOnly: args.inStockOnly,
          withStock: true,
          skip: 0,
          limit: pageLimit,
        });
      let result = await search(terms);
      let searchedTerms = terms;
      let expandedTerms = false;
      // A phrase from the member's own sentence ("portable SSD travel") is one literal
      // substring, but a row may record those words separately. Only after the exact
      // phrase finds nothing, retry its significant words independently. This is a
      // discovery widening, not a claim that every word describes one product.
      if (
        result.total === 0 &&
        requestedTerms.some((term) => /\s/.test(term)) &&
        maxSellingPrice === undefined
      ) {
        const words = [
          ...new Set(
            requestedTerms.flatMap((term) =>
              term
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 3),
            ),
          ),
        ].slice(0, 8);
        if (words.length > 1) {
          const widened = await search(words);
          if (widened.total > 0) {
            result = widened;
            searchedTerms = words;
            expandedTerms = true;
          }
        }
      }
      const { items, total } = result;
      // A no-match result is the END of this search, not an invitation to try
      // one-word variants until the six-step budget dies. Return the catalogue’s
      // actual categories in the same payload, so the model can say what does
      // exist without another tool call, and state the stop in the data it reads.
      const categories =
        total === 0
          ? await categoryService.list(ctx.businessId, { status: 'ACTIVE', skip: 0, limit: 50 })
          : null;
      return page(total, items.map(stockCard), {
        note: FIND_NOTE,
        terms: searchedTerms,
        ...(expandedTerms ? { expandedTerms: true } : {}),
        ...(maxSellingPrice !== undefined ? { maxSellingPrice } : {}),
        ...(categories
          ? {
              categories: categories.items.map(referenceItem),
              guidance:
                'No product matched these terms. Do not call another search for this question; answer now using this empty result and the categories below. Say which terms you checked, and never infer a brand or quality.',
            }
          : {}),
      });
    },
  },

  {
    name: 'getProduct',
    description:
      'Get one product (by id, SKU, or barcode) with its recorded brand, recorded specifications, current stock per location, and its full recorded description, when there is one. Brand or specifications are null when not recorded. Compare only the facts recorded here; do not infer a missing specification. Returns found:false when the product does not exist in this business.',
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
      const noStockRows = rows.total === 0;
      return {
        found: true,
        note: noStockRows
          ? `${CATALOG_GROUNDING_NOTE} This product has no inventory rows at all: on-hand quantity is 0 and it is out of stock. Report that, not an unreadable quantity.`
          : CATALOG_GROUNDING_NOTE,
        product: {
          ...productDetailCore(doc),
          stock: rows.items.map(rowResult),
          stockRows: rows.total,
          ...(noStockRows ? { quantityOnHand: 0, stockStatus: 'OUT_OF_STOCK' } : {}),
        },
      };
    },
  },

  {
    name: 'getInventory',
    description:
      'Inventory rows (a product at a location) with on-hand quantity, reserved quantity, and available quantity. Filter by product, location, product search text, product status, low stock, or out of stock. A location may be given as `locationId` or as the exact `location` name (an ACTIVE location of this business). When the member names a product and asks where it is, pass `q` (the product name) so the rows come back for EVERY location — an unfiltered page is sorted arbitrarily and can cut off exactly the rows that answer the question. Every row also carries product.sellingPrice and product.currency — the recorded price and its ISO code — so a value question can be answered by multiplying the recorded price by availableQuantity; both are null when the price was never recorded, and that is what to report instead of an estimate.',
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
      // A product with no inventory rows is genuinely out of stock, not unreadable. Without
      // this, a valid product lookup returned an empty page and the model told the member the
      // quantity "could not be read" (measured on the ASUS ROG Strix Flare II, 2026-11-05).
      // Only resolve that product when the request names one and no location/stock filter is
      // narrowing the page, so an empty filtered page is never mistaken for zero global stock.
      const exactProductRequest =
        !location.id &&
        !args.status &&
        args.lowStock === undefined &&
        args.outOfStock === undefined &&
        Boolean(args.productId || args.q?.trim());
      if (total === 0 && exactProductRequest) {
        const productDoc = args.productId
          ? await productService.getByIdentifier(ctx.businessId, { id: args.productId })
          : await productService
              .list(ctx.businessId, { q: args.q, skip: 0, limit: 2 })
              .then((matches) => (matches.total === 1 ? matches.items[0] : null));
        if (productDoc) {
          return page(0, [], {
            noInventoryRows: true,
            product: productCore(productDoc),
            note:
              `No inventory rows exist for ${productDoc.name}: on-hand quantity is 0 and it is ` +
              'out of stock. Report 0 units and out of stock; do not say the quantity could not be read.',
          });
        }
      }
      // The resolved id travels with the page for the same reason AI-15 gave it to
      // `getProductsByLocation`: it is what makes the answer checkable ("is this page really
      // Main Warehouse?") without spending another call. Absent when no location was given.
      //
      // AI-67 — and when this is only a page, the result says so in words, because `hasMore`
      // alone was read past: measured on the phone 2026-11-05 5:58 PM, a page of 15 of 17 rows
      // became "No other location shows stock for this product" while the Store Room held 25.
      return page(total, items.map(rowResult), {
        ...(location.id ? { locationId: location.id } : {}),
        ...(total > items.length
          ? {
              note:
                `This is only ${items.length} of ${total} inventory rows. Other locations or products ` +
                'may be in the part you did not receive: call getInventory again with `q` set to the ' +
                'product name (and no location) to see every location that holds it before saying ' +
                'where it is or that somewhere else has none.',
            }
          : {}),
      });
    },
  },

  {
    name: 'getLowStockProducts',
    description:
      'Products whose available quantity is at or below their configured minimum stock (availability summed across all locations by default), including products with nothing available. Pass `location`/`locationId` to judge each product against what ONE place holds — use that whenever the member asks what is low AT a named place, because a full store room otherwise hides a selling shelf that has run down. Returns the current page of matching products. For a restock list that flags each item as out-of-stock or low-stock, prefer getReorderNeededProducts.',
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
    async executor(ctx: ToolContext, args: LocationLimitArgs) {
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      const { items, total } = await productService.list(ctx.businessId, {
        lowStock: true,
        locationId: location.id,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(stockCard), location.id ? { locationId: location.id } : {});
    },
  },

  {
    name: 'getOutOfStockProducts',
    description:
      'Products with no available stock (available quantity zero or below, summed across all locations by default). Pass `location`/`locationId` for what is sold out AT one place, which is a different question from what the business has run out of overall. Returns the current page of matching products. Use for "what products are out of stock". For a restock list that also includes low-stock items, prefer getReorderNeededProducts.',
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
    async executor(ctx: ToolContext, args: LocationLimitArgs) {
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      const { items, total } = await productService.list(ctx.businessId, {
        outOfStock: true,
        locationId: location.id,
        skip: 0,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items.map(stockCard), location.id ? { locationId: location.id } : {});
    },
  },

  {
    name: 'getProductsNeverSold',
    description:
      'ACTIVE products with no stock-out on record at all — the dead-stock question. Reach for this on "dead stock", "what is not selling", "what has never sold", "what has not moved", "unsold", "stale stock", "zero sales" or "sitting on the shelf", NOT for low stock or out of stock: those products may be selling fine, and a full shelf is not a slow one. It is answered by comparing the whole catalogue against the whole ledger instead of asking the model to read one list against another. Optionally scoped to one location ("what has never moved from the sidewalk shelf?"), which also reports availability AT that location. A stock-out is stock LEAVING a location: usually a sale, but it can be usage, damage or a write-off, so this answers "has anything ever left the shelf for this product" and must never be reported as proof of a sale. Pass `from` when the member asks about a period ("nothing has moved since June"). Each row carries availableQuantity across all locations, and the result adds `soldProductCount` so "how many products have sold at all" needs no page counting.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 15,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: {
          type: 'string',
          format: 'date-time',
          maxLength: 40,
          description: 'ISO date; only stock-outs created at or after this count as movement.',
        },
        locationId: objectId,
        location: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE location, e.g. "Front Counter". Scope the answer to products stocked there.',
        },
        limit: limitParam(15, 25),
      },
    },
    async executor(ctx: ToolContext, args: NeverSoldArgs) {
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      // The exclusion set is every product the ledger says something LEFT for. `totals` is the
      // same counted read AI-68 added, so this cannot disagree with "what sold the most".
      const totals = await transactionsService.totals(ctx.businessId, {
        type: 'STOCK_OUT',
        from: args.from,
        locationId: location.id,
      });
      const soldIds = totals.products.filter((p) => p.unitsOut > 0).map((p) => p.productId);
      const { items, total } = await productService.list(ctx.businessId, {
        status: 'ACTIVE',
        excludeIds: soldIds,
        withStock: true,
        // With a location, listWithStock returns only products STOCKED there and reports
        // availability at that location — a shelf question, not a business-wide one.
        locationId: location.id,
        skip: 0,
        limit: Math.min(args.limit ?? 15, 25),
      });
      // `resolveLocation` hands back an id only, so the human-readable place is whatever the
      // model named; a bare id still reads correctly as "the chosen location".
      const place = location.id ? ` at ${args.location?.trim() || 'the chosen location'}` : '';
      // "at Front Counter at some point" reads badly, and the sentence that follows already
      // says "since the ledger began", so the trailing clause is only needed without a place.
      const when = args.from ? ` since ${args.from}` : place ? '' : ' at some point';
      // An EMPTY list is the trap. On the phone 2026-11-05 the member asked what had never
      // sold at the Front Counter; every product stocked there had moved, so the page was
      // empty, and the answer came back as "No products at the Front Counter have a recorded
      // stock-out" — the exact opposite of the truth. `count: 0` alone is ambiguous between
      // "nothing to report" and "no data", so the empty case states its own meaning.
      const emptyNote =
        `The list is EMPTY because every ACTIVE product${place ? ` stocked at ${args.location?.trim() || 'that location'}` : ''}` +
        ` already has at least one stock-out on record${args.from ? ` since ${args.from}` : ' since the ledger began'}` +
        '. That means there is NO dead stock in this scope — it does not mean data is missing or that nothing has sold. ' +
        'Say that plainly and do not list products.';
      return page(total, items.map(stockCard), {
        soldProductCount: soldIds.length,
        ...(args.from ? { countedFrom: args.from } : {}),
        ...(location.id ? { locationId: location.id } : {}),
        ...(total === 0 ? { emptyReason: 'everyProductHasMoved' } : {}),
        note:
          total === 0
            ? emptyNote
            : `${soldIds.length} products have at least one stock-out on record${place}${when}` +
              ' and are NOT in this list. Every row here has none, so nothing has left' +
              (place ? ' that shelf' : ' the shelf') +
              (args.from ? ' in that period' : ' since the ledger began') +
              '. A stock-out can be usage, damage or a write-off rather than a sale, so say "no ' +
              'stock-out recorded" and offer the detail (its stock, its price) instead of calling it "unsold" as a fact about customers.',
      });
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
    name: 'getStockValue',
    description:
      'What the stock is WORTH at the recorded selling price: total value of on-hand stock (available quantity times sellingPrice, summed across locations) across ACTIVE products, the number of products and units counted, and the products with the highest value. Products with no recorded price are reported apart (unpricedProducts, unpricedUnits) and are NOT counted as zero value — say so when they exist. Use for "what is my stock worth", "what is my most valuable stock", "what is tied up in inventory". Narrow it with `location`/`locationId` for one place ("what is Main Warehouse worth", "how much is tied up in the storeroom") or `category`/`categoryId` for one kind of product ("what are our keyboards worth") — the tool then computes that subset itself, so never add up row prices yourself. `scope` echoes the filter that was applied and is null for the whole business. A location-scoped total counts only products actually holding stock there. The value is at the recorded price only, not at cost or market price, and the app records no cost basis or sale revenue.',
    permission: PERMISSIONS.INVENTORY_VIEW,
    defaultLimit: 10,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: limitParam(10, 25),
        locationId: objectId,
        location: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE location, e.g. "Main Warehouse". Use instead of locationId when no id is known.',
        },
        categoryId: objectId,
        category: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE category, e.g. "Keyboards". Use instead of categoryId when no id is known.',
        },
      },
    },
    async executor(ctx: ToolContext, args: StockValueArgs) {
      // Both are optional here: no location or category means the whole business, which is
      // this tool's documented default and the answer it gave before AI-59.
      const location = await resolveLocation(ctx, args, { required: false });
      if (!location.ok) return location.result;
      const category = await resolveCategory(ctx, args);
      if (!category.ok) return category.result;
      return productService.stockValue(ctx.businessId, {
        limit: Math.min(args.limit ?? 10, 25),
        ...(location.id ? { locationId: location.id } : {}),
        ...(category.id ? { categoryId: category.id } : {}),
      });
    },
  },

  {
    name: 'getCatalogOverview',
    description:
      'One-call overview of what the ACTIVE catalogue contains: total active products, per-category product counts, how many distinct brands are recorded, and how many products have a recorded brand or description. Use for "what do we carry", "what categories do we have", "how complete is our brand data" and to frame a recommendation before a narrower search. This read has no stock, price or quality data and no product names; use findProducts, listBrands, getProduct or getInventory for those. A count is not a quality claim, and "no brand recorded" is not "no brand exists".',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async executor(ctx: ToolContext) {
      return productService.catalogOverview(ctx.businessId);
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
      'Recent stock movements (newest first) — what came in, what went out, adjustments and transfers. Stock that was sold or used is recorded as a STOCK_OUT movement, so this is also the tool for "what sold", "what moved" and recent activity; it does not hold sale prices or invoices. Optionally filter by product, location, movement type, and a createdAt range; when a range finds nothing it returns `windowEmpty` with the newest movements that DO match the other filters from before it, in `mostRecentOutsideWindow`. "What moved out of X" means anything leaving X — a STOCK_OUT or the out leg of a TRANSFER — so do not narrow it to one type unless the member did. A location may be given as `locationId` or as the exact `location` name. Returns the current page of logical events, plus totals for the WHOLE matched set: `unitsSold`, `unitsReceived`, `stockOutMovements` (the number of STOCK_OUT ledger movements, distinct from all movement types) and `topOut` (the five products with the most units out), so ranking and counting questions read a computed figure instead of adding page rows. A complete stock transfer is ONE event with `from` and `to` even though the ledger keeps two rows; a location-filtered page may return one leg, whose `direction` is `out` or `in`. Transfer legs are movement, never sales.',
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
      // AI-68 — the totals for the WHOLE matched set, because "which sold the most" and
      // "how many units did we sell" are rankings and sums over every row, not over the page.
      // Measured on the phone 2026-11-05: asked for a count, the model added page rows itself
      // and said 9 for a movement of 8. So the ranking arrives already computed, and `topOut`
      // is the only thing it has to read.
      const totals = await transactionsService.totals(ctx.businessId, {
        productId: args.productId,
        locationId: location.id,
        type: args.type,
        from: args.from,
        to: args.to,
      });
      const topOut = totals.products
        .filter((p) => p.unitsOut > 0)
        .sort((a, b) => b.unitsOut - a.unitsOut || String(a.name ?? '').localeCompare(String(b.name ?? '')))
        .slice(0, 5)
        .map((p) => ({ product: p.name, productId: p.productId, unitsOut: p.unitsOut }));
      const stockOutMovements = totals.byType.STOCK_OUT?.rows ?? 0;
      const soldSummary =
        topOut.length > 0
          ? {
              ...(totals.byType.STOCK_OUT ? { unitsSold: totals.byType.STOCK_OUT.units, sales: totals.byType.STOCK_OUT.rows } : {}),
              ...(totals.byType.STOCK_IN ? { unitsReceived: totals.byType.STOCK_IN.units, deliveries: totals.byType.STOCK_IN.rows } : {}),
              ...(totals.byType.TRANSFER ? { transferLegs: totals.byType.TRANSFER.rows } : {}),
              stockOutMovements,
              topOut,
              totalsNote:
                'topOut is computed over EVERY row matching the filters, not just this page, ' +
                'so it is the answer to "which sold the most" and to "how many units sold": read ' +
                'the figure, do not add the rows up yourself. unitsSold counts STOCK_OUT units ' +
                'only; transferLegs is movement between locations and is NOT part of sales.',
            }
          : {};

      // AI-65 — an empty window is an answer, but a dead-end one.
      //
      // Measured on the phone 2026-11-05 5:38 PM: *"What moved out of the Store Room
      // recently"* was answered, correctly and uselessly, "No stock-out movements were
      // recorded for the Store Room in the last 7 days … nothing left the Store Room during
      // that window." The Store Room had 13 movements, the newest eleven days earlier, and the
      // member was left with nothing to act on. The window was empty; the question was not.
      //
      // So when a from/to filter finds nothing, the newest matching rows OUTSIDE it are
      // attached with a sentence saying exactly what they are. The filters the member asked
      // about (product, location, type) are kept, so "nothing sold this week" can still be
      // followed by "the last sale was on 24 October" rather than an unrelated delivery.
      // It costs one extra read only on a turn that would otherwise have nothing to say.
      const windowEmpty = logicalTotal === 0 && (args.from != null || args.to != null);
      const recentWithoutWindow = async (type?: string) =>
        foldTransferEvents(
          (
            await transactionsService.list(ctx.businessId, {
              productId: args.productId,
              locationId: location.id,
              type: type as HistoryArgs['type'],
              skip: 0,
              limit: 3,
            })
          ).items.map((item) => historyItemForModel(item, ctx.timeZone)),
        ).items;
      const recentOutsideWindow = windowEmpty ? await recentWithoutWindow(args.type) : [];
      // The member's word is not the ledger's type: "what moved out of the Store Room" was
      // asked as a STOCK_OUT read on 2026-11-05 and found zero, because moving stock between
      // locations is recorded as a TRANSFER leg, not a stock-out — the room had 13 movements,
      // 8 of them transfers. So a type-filtered window that comes back empty also reports the
      // newest rows for the same product and location with the type filter dropped, and the
      // note says so plainly. Nothing is relabelled: each row keeps its own type and, for a
      // transfer leg, its direction.
      const recentIgnoringType =
        windowEmpty && args.type != null && (recentOutsideWindow as unknown[]).length === 0
          ? await recentWithoutWindow(undefined)
          : [];
      return page(logicalTotal, folded.items, {
        ...(location.id ? { locationId: location.id } : {}),
        stockOutMovements,
        ...soldSummary,
        ...(windowEmpty
          ? {
              windowEmpty: true,
              ...(recentIgnoringType.length > 0
                ? {
                    mostRecentIgnoringType: recentIgnoringType,
                    note:
                      'Nothing matched inside the requested window, and nothing matches that type at all for this product/location. mostRecentIgnoringType holds the newest movements there with the TYPE filter dropped (each row keeps its real type, and a transfer leg carries direction) — say the window is empty, then name the latest of these and its localTime, and do not call a transfer a stock-out.',
                  }
                : recentOutsideWindow.length > 0
                  ? {
                      mostRecentOutsideWindow: recentOutsideWindow,
                      note:
                        'Nothing matched inside the requested window. mostRecentOutsideWindow holds the newest movements that DO match the product/location/type filter, from before it — say that the window is empty, then name the latest one and its localTime so the member is not left without an answer.',
                    }
                  : {
                      note:
                        'Nothing matched inside the requested window, and nothing matches that filter at all. Say so plainly in movement terms.',
                    }),
            }
          : {}),
      });
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

  {
    name: 'listBrands',
    description:
      'List the brands recorded on ACTIVE products, with how many products carry each brand, its categories, and a few product names. Use for "what brands do we carry", "which detergent brands do we have", or "is brand X available". When asked what brands the business carries, report every brand in `items`; do not omit one because it has few products. Brand is optional: a product with no recorded brand is not counted, and an empty result means no brand is recorded for that filter, not that the business stocks no brands. Stock is not included; use searchProducts and getProduct or getInventory to check a brand’s stock levels.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    defaultLimit: 20,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 80, description: 'Search recorded brand text (partial match, case-insensitive).' },
        categoryId: objectId,
        category: {
          type: 'string',
          maxLength: 100,
          description: 'Exact name of an ACTIVE category, e.g. "Household". Use instead of categoryId when no id is known.',
        },
        limit: limitParam(20, 50),
      },
    },
    async executor(ctx: ToolContext, args: BrandSummaryArgs) {
      const category = await resolveCategory(ctx, args);
      if (!category.ok) return category.result;
      const { items, total } = await productService.brandSummary(ctx.businessId, {
        q: args.q,
        categoryId: category.id,
        limit: Math.min(args.limit ?? 20, 50),
      });
      return page(total, items, {
        note: BRAND_NOTE,
        ...(category.id ? { categoryId: category.id } : {}),
      });
    },
  },

  // ---------------------------------------------------------------------------
  // AI-47 — RESEARCH, BOUND TO THE ROWS THE BUSINESS ACTUALLY HAS.
  //
  // The model supplies product IDs, never brand names. The executor loads those
  // rows through the same business-scoped product read as getProduct, so a brand
  // that is not recorded in this tenant cannot enter the web query. The research
  // client then drops any finding keyed to a name outside this list; the prompt
  // rule tells the final answer to recommend only these subjects.
  //
  // This is still a read: no stock, price, product or brand is written. Research
  // evidence is returned beside the recorded rows, never in place of them.
  // ---------------------------------------------------------------------------
  {
    name: 'researchInventoryProducts',
    description:
      'Research live web sources about products already recorded in this business. Pass one to eight product ids returned by findProducts or searchProducts — the tool loads those rows itself and searches only their recorded names and brands, so it cannot research a brand the business does not have. Use this AFTER finding the inventory products, when the member asks for quality, reliability, affordability, reviews, a brand recommendation, the specifications of a recorded product, or whether a newer model, generation or replacement exists and what changed (use focus "specifications" for that last group — it searches the manufacturer’s own pages first). Returns sourced findings and source URLs; a finding may summarize search-result snippets when a full review summary was unavailable, so say when the evidence is only a snippet. Research is external evidence, not inventory data: recommend only the subjects listed, cite the returned sources, and never add a product or brand that appears only in a source. A subject with no finding means no evidence was found, not that the thing does not exist — say which. It does not check or change stock. If it reports available:false, answer from inventory facts only and say the web evidence was unavailable.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['productIds'],
      properties: {
        productIds: {
          type: 'string',
          maxLength: 220,
          description: 'Comma-separated product ids from findProducts or searchProducts (1 to 8). The tool resolves each id in this business and refuses missing or archived products.',
        },
        focus: {
          type: 'string',
          enum: ['overall', 'quality', 'affordability', 'reliability', 'specifications'],
          description:
            'What to research. "specifications" covers recorded specs, the newest model or generation of the line, and what changed — use it when the member is updating a product record. Defaults to overall.',
        },
      },
    },
    async executor(ctx: ToolContext, args: ResearchProductsArgs) {
      const ids = [
        ...new Set(
          String(args.productIds ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      const unavailable = (message: string) => ({
        available: false,
        reason: 'PRODUCTS_NOT_AVAILABLE',
        message,
        findings: [],
        sources: [],
        subjects: [],
        brandsRecorded: [],
        note: WEB_RESEARCH_NOTE,
      });

      if (ids.length === 0 || ids.length > 8) {
        return unavailable('Pass between one and eight product ids returned by findProducts.');
      }
      if (!ids.every((id) => /^[0-9a-fA-F]{24}$/.test(id))) {
        return unavailable('One or more product ids are not valid. Use ids returned by findProducts.');
      }

      const docs = await Promise.all(
        ids.map((id) => productService.getByIdentifier(ctx.businessId, { id })),
      );
      if (docs.some((doc) => !doc || doc.status !== 'ACTIVE')) {
        return unavailable(
          'One or more selected products are missing, archived, or belong to another business. Use findProducts again and select ACTIVE products from its results.',
        );
      }

      const subjects: ResearchSubject[] = docs.map((doc) => {
        const dto = productService.toProductDTO(doc!);
        return {
          id: dto.id,
          name: String(dto.name),
          brand: dto.brand,
          category:
            dto.category && typeof dto.category.name === 'string' ? dto.category.name : null,
          sellingPrice: typeof dto.sellingPrice === 'number' ? dto.sellingPrice : null,
          currency: dto.currency ?? null,
          unit: dto.unit,
          specifications: dto.specifications,
        };
      });
      const focus =
        args.focus === 'quality' ||
        args.focus === 'affordability' ||
        args.focus === 'reliability' ||
        args.focus === 'specifications'
          ? args.focus
          : ('overall' as ResearchFocus);

      const research = await researchInventoryWeb({ subjects, focus, deadlineAt: researchDeadlineAt(ctx) });
      return { ...research, subjects };
    },
  },

  // ---------------------------------------------------------------------------
  // AI-49 — MARKET PRICES, WITH THE CITATION AS THE ONLY SOURCE OF A NUMBER.
  //
  // The review tool asks a model to summarise quality. A price cannot be accepted
  // that way: a model can write a plausible number that no page showed. This tool
  // ignores the model's prose and reads the cited page text, so every returned
  // price is a string the source displayed. It also takes product IDs only, which
  // keeps an outside model or brand out of the search and out of the answer.
  // ---------------------------------------------------------------------------
  {
    name: 'researchMarketPrices',
    description:
      'Compare current online retail prices for up to three products already recorded in this business. Pass product ids returned by findProducts or searchProducts; the tool loads those rows itself, so it cannot price a product the business does not have. It uses free keyless public search and public result pages by default, with no OpenRouter search spend, and reads retailers such as Shopee, Lazada, Amazon, official brand stores and local shops whenever they appear in the results. It returns only prices visible on a cited page or in a search-result snippet: each listing carries the exact price text, marketplace, source URL, retrieval time, evidence kind and a short snippet. `searchedQueries` shows the exact queries that ran and `checkedMarketplaces` shows only the retailers actually present in the sources, so describe the search from those fields rather than assuming a marketplace was covered. When the member names a shop or site ("check rkgamingstore.com", "what does Shopee charge?"), pass it in `stores` — each named store is then asked directly, and `storeChecks` reports per store whether its pages were reached and whether any of them showed a price. The recorded selling price remains separate in `subjects`. Online prices are external evidence, not inventory prices; it does not change stock or prices, convert currency or add shipping. If no price is verified, it reports available:false with the reason and the names of the products it could not price, instead of estimating.',
    permission: PERMISSIONS.PRODUCTS_VIEW,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['productIds'],
      properties: {
        productIds: {
          type: 'string',
          maxLength: 120,
          description: 'Comma-separated product ids from findProducts or searchProducts (1 to 3). The tool resolves each id in this business and refuses missing or archived products.',
        },
        stores: {
          type: 'string',
          maxLength: 160,
          description:
            'Comma-separated shops the member named, 1 to 3, as a domain (rkgamingstore.com) or a name (Shopee). Only add what the member actually named, never a shop you chose yourself. Omit it for an open "what do stores charge" question.',
        },
      },
    },
    async executor(ctx: ToolContext, args: ResearchPricesArgs) {
      const ids = [
        ...new Set(
          String(args.productIds ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      const unavailable = (message: string) => ({
        available: false,
        reason: 'PRODUCTS_NOT_AVAILABLE',
        message,
        listings: [],
        sources: [],
        subjects: [],
        checkedMarketplaces: [],
        searchedQueries: [],
        targetedMarketplaces: [],
        retrievedAt: new Date().toISOString(),
        note: MARKET_PRICE_NOTE,
      });

      if (ids.length === 0 || ids.length > 3) {
        return unavailable('Pass between one and three product ids returned by findProducts.');
      }
      if (!ids.every((id) => /^[0-9a-fA-F]{24}$/.test(id))) {
        return unavailable('One or more product ids are not valid. Use ids returned by findProducts.');
      }

      const docs = await Promise.all(
        ids.map((id) => productService.getByIdentifier(ctx.businessId, { id })),
      );
      if (docs.some((doc) => !doc || doc.status !== 'ACTIVE')) {
        return unavailable(
          'One or more selected products are missing, archived, or belong to another business. Use findProducts again and select ACTIVE products from its results.',
        );
      }

      const subjects: PriceSubject[] = docs.map((doc) => {
        const dto = productService.toProductDTO(doc!);
        return {
          id: dto.id,
          name: String(dto.name),
          brand: dto.brand,
          sellingPrice: typeof dto.sellingPrice === 'number' ? dto.sellingPrice : null,
          currency: dto.currency ?? null,
          unit: dto.unit,
        };
      });
      const stores = String(args.stores ?? '')
        .split(',')
        .map((store) => store.trim())
        .filter(Boolean)
        .slice(0, 3);
      const research = await researchMarketPrices({
        subjects,
        stores,
        signal: ctx.signal,
        deadlineAt: researchDeadlineAt(ctx),
      });
      return { ...research, subjects };
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
    // A cancelled turn is not a tool failure. Returning a result here would let
    // the model spend another provider call on a turn whose caller has already
    // gone away or whose deadline has passed, so the cancellation is rethrown.
    if (ctx.signal?.aborted || (err as { name?: unknown } | null)?.name === 'AbortError') throw err;
    // `err` is `unknown`: a thrown value has no shape TypeScript may assume, and
    // the assertion is the erasable way to read the message this log has always
    // read. Nothing is attached to the error that leaves.
    console.error('[ai] tool execution failed', name, (err as { message?: unknown })?.message ?? err);
    return { ok: false, code: 'TOOL_ERROR', error: 'The tool failed to run. Please try again.' };
  }
}

export default { AI_TOOLS, AI_TOOL_DEFS, executeTool, validateToolArgs };
