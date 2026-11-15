/**
 * AI-116 — the bounded context behind one answer.
 *
 * WHY IT EXISTS. Two trust problems share one missing fact: what did this answer
 * actually read? The footer needs to say when the inventory was read, from which
 * sources, how many products and under which filters; a later follow-up needs to
 * know which products the previous answer was about. Neither needs the tool
 * payload itself, so this context is deliberately small: the tool names, the
 * filters that were applied, a bounded set of product ids, counts and the web
 * sources that were cited.
 *
 * STALENESS. The product ids are MEMBERSHIP, never quantities. A follow-up tool
 * re-reads those products from the database before answering, so a captured
 * stock level can never become the next answer's stock level.
 */

export interface AnswerFilter {
  label: string;
  value: string;
}

export interface AnswerWebSource {
  title: string;
  url: string;
}

/** The stored shape on an assistant message. Dates are ISO strings on the wire. */
export interface AnswerContext {
  retrievedAt: string;
  tools: string[];
  sources: string[];
  productCount: number;
  total: number | null;
  hasMore: boolean;
  filters: AnswerFilter[];
  resultTool?: string;
  resultInput?: Record<string, string | number | boolean>;
  resultProductIds: string[];
  webSources: AnswerWebSource[];
}

/** The bounded previous set the next turn may filter; no quantities travel with it. */
export interface PreviousResultContext {
  tool: string;
  input: Record<string, string | number | boolean>;
  productIds: string[];
  retrievedAt: string;
  total: number | null;
}

export interface ToolReadContext {
  tool: string;
  input: Record<string, string | number | boolean>;
  productIds: string[];
  total: number | null;
  hasMore: boolean;
  retrievedAt: string;
}

/** At most this many ids are kept. A follow-up is a filter, not an export. */
export const MAX_CONTEXT_PRODUCTS = 100;

const INVENTORY_TOOLS = new Set([
  'getInventorySummary',
  'getInventory',
  'getProductsByLocation',
  'getInventoryHistory',
  'getLowStockProducts',
  'getOutOfStockProducts',
  'getReorderNeededProducts',
  'searchProducts',
  'findProducts',
  'getCatalogOverview',
  'getProduct',
  'listLocations',
  'listCategories',
  'listBrands',
  'getLocationBreakdown',
  'getHighestStockProducts',
  'getStockValue',
  'getProductsNeverSold',
]);

const RESEARCH_TOOLS = new Set(['researchInventoryProducts', 'researchMarketPrices']);

/** The reads whose rows can become a previous result set for a follow-up. */
const FOLLOW_UP_TOOLS = new Set([
  'getInventory',
  'getProductsByLocation',
  'getLowStockProducts',
  'getOutOfStockProducts',
  'getReorderNeededProducts',
  'searchProducts',
  'findProducts',
  'getProductsNeverSold',
  'getHighestStockProducts',
  'getStockValue',
  'getProduct',
]);

const FILTER_LABELS: Record<string, string> = {
  q: 'Search',
  exactSku: 'SKU',
  category: 'Category',
  categoryId: 'Category ID',
  location: 'Location',
  locationId: 'Location ID',
  status: 'Status',
  lowStock: 'Low stock',
  outOfStock: 'Out of stock',
  type: 'Movement type',
  from: 'From',
  to: 'To',
  limit: 'Limit',
};

const CONTEXT_INPUT_KEYS = new Set(Object.keys(FILTER_LABELS));

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultOf(output: unknown): Record<string, unknown> | null {
  const outer = record(output);
  if (!outer) return null;
  return record(outer.result) ?? outer;
}

function primitiveMap(input: unknown): Record<string, string | number | boolean> {
  const raw = record(input);
  if (!raw) return {};
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!CONTEXT_INPUT_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    }
  }
  return clean;
}

/** The filters a member can read, in the order the form lists them. */
export function filterLabels(input: unknown): AnswerFilter[] {
  const clean = primitiveMap(input);
  const labels: AnswerFilter[] = [];
  for (const key of Object.keys(FILTER_LABELS)) {
    const label = FILTER_LABELS[key];
    if (!label) continue;
    if (!(key in clean)) continue;
    const value = clean[key];
    if (typeof value === 'boolean' && !value) continue;
    labels.push({
      label,
      value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value),
    });
  }
  return labels;
}

/** Human-facing source names; an empty list means this answer read no data at all. */
export function sourcesForTools(tools: string[]): string[] {
  const sources: string[] = [];
  if (tools.some((tool) => INVENTORY_TOOLS.has(tool))) sources.push('Inventory records');
  if (tools.some((tool) => RESEARCH_TOOLS.has(tool))) sources.push('Public web');
  return sources;
}

/** Product ids from one successful tool result, bounded and de-duplicated in order. */
export function productIdsFromToolResult(name: string, output: unknown): string[] {
  if (!FOLLOW_UP_TOOLS.has(name)) return [];
  const result = resultOf(output);
  if (!result) return [];
  const ids: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) return;
    if (!ids.includes(value)) ids.push(value);
  };

  if (name === 'getProduct') {
    add(record(result.product)?.id);
  } else if (name === 'getStockValue') {
    for (const raw of Array.isArray(result.topByValue) ? result.topByValue : []) {
      add(record(raw)?.id);
    }
  } else if (name === 'getInventory') {
    for (const raw of Array.isArray(result.items) ? result.items : []) {
      add(record(record(raw)?.product)?.id);
    }
  } else {
    for (const raw of Array.isArray(result.items) ? result.items : []) {
      const row = record(raw);
      if (!row) continue;
      add(row.id);
    }
  }
  return ids.slice(0, MAX_CONTEXT_PRODUCTS);
}

/** The count the tool reported for the whole matched set, when it reported one. */
export function totalFromToolResult(output: unknown): number | null {
  const result = resultOf(output);
  if (!result) return null;
  const value = Number(result.count ?? result.total);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function hasMoreInToolResult(output: unknown): boolean {
  return resultOf(output)?.hasMore === true;
}

/**
 * The last row-shaped read, captured ONLY when it returned product ids.
 *
 * A tool with no product rows (a history total, a reference list) is still named
 * in `tools` and `sources` for freshness, but it cannot become a follow-up set:
 * "which of those" needs a set of products to filter.
 */
export function toolReadContext(
  name: string,
  input: unknown,
  output: unknown,
  retrievedAt: string,
): ToolReadContext | null {
  const productIds = productIdsFromToolResult(name, output);
  if (!productIds.length) return null;
  return {
    tool: name,
    input: primitiveMap(input),
    productIds,
    total: totalFromToolResult(output),
    hasMore: hasMoreInToolResult(output),
    retrievedAt,
  };
}

/** Build the context stored with an assistant message. */
export function buildAnswerContext({
  tools,
  retrievedAt,
  read,
  webSources = [],
}: {
  tools: string[];
  retrievedAt: string;
  read?: ToolReadContext | null;
  webSources?: AnswerWebSource[];
}): AnswerContext {
  const uniqueTools = [...new Set(tools)].sort((a, b) => a.localeCompare(b));
  return {
    retrievedAt,
    tools: uniqueTools,
    sources: sourcesForTools(uniqueTools),
    productCount: read?.productIds.length ?? 0,
    total: read?.total ?? null,
    hasMore: read?.hasMore ?? false,
    filters: filterLabels(read?.input),
    ...(read
      ? {
          resultTool: read.tool,
          resultInput: read.input,
          resultProductIds: read.productIds,
        }
      : { resultProductIds: [] }),
    webSources: webSources.slice(0, 10).map((source) => ({ title: source.title, url: source.url })),
  };
}

/**
 * Is this question narrowing the previous answer rather than asking a new one?
 *
 * Deliberately narrow. A false positive would attach an old result set to an
 * unrelated question, which is worse than asking one extra lookup; "which
 * products are low?" has no anaphor and therefore starts a fresh read.
 */
export function isPreviousResultFollowUp(message: string): boolean {
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return (
    /\b(?:which|what|how many)\s+(?:of\s+)?(?:those|these|them|ones)\b/i.test(text) ||
    /\b(?:among|from|within)\s+(?:those|these|them|that list|the list|this list)\b/i.test(text) ||
    /\b(?:filter|narrow|show)\s+(?:those|these|them|that list|the list|this list)\b/i.test(text)
  );
}
