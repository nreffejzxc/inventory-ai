/**
 * AI-99 — the FREE-MODEL route for simple inventory reads.
 *
 * WHY THIS IS A ROUTE, NOT A SECOND ASSISTANT. The five questions this module recognises
 * (one product's stock, whether a product exists, what needs restocking, what is low, and
 * how many products those are) still need the SAME business-scoped tool reads the paid model
 * uses. The only thing that changes is which model is asked to choose the read and phrase
 * the answer, so the existing tool loop, grounding guards and deterministic finalizers stay
 * exactly where they are — the model never becomes the source of a quantity.
 *
 * WHY IT IS DELIBERATELY NARROW. The free tier's daily allowance is a shared, finite
 * resource; a question that needs a comparison, a price, a movement history, a location
 * breakdown, a category, a brand, advice or the public web is not "simple" in the sense
 * that matters here — a false positive would send work a weaker model may handle badly to
 * the wrong place. A false negative costs credits; a false positive costs an answer. So
 * every advanced cue below leaves the turn exactly as it was before this feature.
 */

import { languageDirective } from './language.ts';
import { declaresToolSupport } from './modelCapabilities.ts';
import { asksForResearchModel, asksForWebResearch } from './webCapabilities.ts';

export type SimpleInventoryOperation =
  | 'product_stock'
  | 'product_existence'
  | 'restock_list'
  | 'restock_count';

export interface SimpleInventoryIntent {
  operation: SimpleInventoryOperation;
  /** Tools that can satisfy this turn's read. At least one must SUCCEED. */
  readTools: string[];
  /** A short human label used by the prompt and by escalation logs. */
  readLabel: string;
  /** The exact SKU the member named, when one was written as `SKU <value>`. */
  exactSku?: string;
}

/** Reads that return a product's recorded stock, or prove it is absent. */
const PRODUCT_STOCK_READS = ['getInventory', 'getProduct', 'findProducts'];
/** Reads that report shortages from the recorded minimum, never from a page of rows. */
const SHORTAGE_READS = [
  'getReorderNeededProducts',
  'getLowStockProducts',
  'getOutOfStockProducts',
];

/**
 * A simple question is short. A long message is treated as a compound request even when
 * one sentence inside it looks simple, because the free route's prompt is deliberately
 * narrower than the ordinary one and a compound request needs the full instructions.
 */
const MAX_SIMPLE_CHARS = 280;

const RESTOCK_WORDING =
  /\b(?:restock(?:ing|ed)?|reorder(?:ing|ed)?|low(?:\s+on)?\s+stock|running\s+low|run\s+low|below\s+(?:the\s+|their\s+)?(?:reorder\s+)?minimum|(?:reached|reaches|at)\s+(?:the\s+|their\s+)?(?:configured\s+)?(?:reorder\s+)?minimum(?:\s+(?:stock|level|levels|quantity))?)\b/i;

const QUANTITY_QUESTION =
  /\bhow\s+(?:many|much)\b|\b(?:pila|ilan)\b|\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?(?:stock|quantity|on[\s-]?hand|availability)\b/i;

const STOCK_WORDING =
  /\b(?:units?|pieces?|pcs|quantity|qty|stock|on[\s-]?hand|available|availability)\b/i;

/**
 * A single-product stock total needs a product to be about.
 *
 * Without this cue, "how much stock do we hold?" and "how many units are in Main
 * Warehouse?" look like quantity questions but are catalogue/location summaries. Those
 * must keep the ordinary route: the simple route's read and its computed total are for
 * one product, and routing a summary to it produced an ungrounded answer in the provider
 * suite. A missed named product costs credits; a false positive costs the answer.
 */
const PRODUCT_REFERENCE =
  /\b(?:products?|items?|skus?|models?|unit(?:s)?\s+of|stock\s+(?:level\s+)?of|quantity\s+of)\b/i;

const OWNERSHIP_QUESTION = /\b(?:do|does)\s+(?:we|you)\s+(?:have|stock|carry)\b/i;

const EXISTENCE_WORDING =
  /\b(?:do|does|did)\s+(?:we|you|i)\s+(?:have|carry|stock)\b|\bis\s+there\s+(?:an?\s+|any\s+)?\S|\bexist(?:s|ed|ing)?\b|\bin\s+(?:our|the)\s+inventory\b/i;

/**
 * "How many products do we have?" is a catalogue count, and "how many total units do we
 * have?" is a whole-inventory stock total. Neither is a single product's stock. They are
 * fine questions, but they do not belong on a route whose read requirement is a product
 * stock read, so they stay with the configured model. The negative lookahead keeps a
 * named-product question such as "how many units of the Logitech MX Keys S are in stock?"
 * on the simple route.
 */
const AGGREGATE_NOUN =
  /^\s*how\s+(?:many|much)\s+(?:total\s+)?(?:(?:inventory|stock)\s+)?(?:products?|items?|skus?|units?|pieces?|pcs|categories?|locations?|brands?|users?|accounts?|suppliers?|orders?|customers?|movements?|transactions?)\b(?:\s+in\s+total|\s+of\s+(?:inventory|stock|merchandise))?(?!(?:\s+(?:in\s+)?total)?\s+of\b)/i;

/**
 * Everything that makes a question more than a simple read. Price and value questions need
 * getStockValue and its currency rules; sales and movements need the ledger; comparisons,
 * brands, categories and location breakdowns have their own prompt rules and finalizers.
 * None of them may be shortened into the simple prompt.
 */
const ADVANCED_INTENT =
  /\b(?:prices?|pricing|presyo|presyuhan|costs?|worth|value|revenue|sales?|sold|profit|margin|compare|comparison|versus|vs|recommend\w*|best|cheapest|expensive|brands?|categor(?:y|ies)|suppliers?|vendors?|distributors?|wholesalers?|history|movements?|dead\s+stock|never\s+sold|top|rank\w*|under|over|breakdown|summary|per\s+location|each\s+location|every\s+location|all\s+locations|across\s+locations|where\s+(?:is|are))\b/i;

const LIST_QUESTION = /\b(?:which|what|list|name|show|give)\b/i;

/**
 * The SKU a member wrote after the word "SKU".
 *
 * `getInventory`'s `q` is a SUBSTRING search, and a short SKU is a prefix of other SKUs:
 * "SEEDSKU-42" matched 111 products in the 10,256-product tenant, so the exact product's
 * rows were not on the 25-row page. An explicitly named SKU is an exact identifier, not a
 * search phrase; the simple route passes it through this field so the tool can resolve it.
 */
const NAMED_SKU = /\bsku\b\s*(?:[:#=]|\bis\b)?\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i;

function namedSku(text: string): string | undefined {
  const match = NAMED_SKU.exec(text);
  return match?.[1] || undefined;
}

/**
 * Classify one member message as a simple inventory read, or null to leave the turn alone.
 *
 * The order matters. A restock question is checked before the aggregate-noun exclusion, so
 * "how many products need restocking?" is a count; the exclusion is only there for
 * catalogue-wide totals such as "how many products do we have".
 */
export function simpleInventoryIntent(message: string): SimpleInventoryIntent | null {
  const text = String(message ?? '').trim();
  if (!text || text.length > MAX_SIMPLE_CHARS) return null;
  if ((text.match(/\?/g) ?? []).length > 1) return null;
  if (asksForWebResearch(text) || asksForResearchModel(text)) return null;
  if (ADVANCED_INTENT.test(text)) return null;

  if (RESTOCK_WORDING.test(text)) {
    if (QUANTITY_QUESTION.test(text) && !LIST_QUESTION.test(text)) {
      return {
        operation: 'restock_count',
        readTools: SHORTAGE_READS,
        readLabel: 'shortage read',
      };
    }
    return {
      operation: 'restock_list',
      readTools: SHORTAGE_READS,
      readLabel: 'shortage read',
    };
  }

  if (AGGREGATE_NOUN.test(text)) return null;

  if (EXISTENCE_WORDING.test(text)) {
    const exactSku = namedSku(text);
    return {
      operation: 'product_existence',
      readTools: PRODUCT_STOCK_READS,
      readLabel: 'product read',
      ...(exactSku ? { exactSku } : {}),
    };
  }

  if (
    QUANTITY_QUESTION.test(text) &&
    PRODUCT_REFERENCE.test(text) &&
    (STOCK_WORDING.test(text) || OWNERSHIP_QUESTION.test(text))
  ) {
    const exactSku = namedSku(text);
    return {
      operation: 'product_stock',
      readTools: PRODUCT_STOCK_READS,
      readLabel: 'product stock read',
      ...(exactSku ? { exactSku } : {}),
    };
  }

  return null;
}

/**
 * The first configured fallback that is free AND may call tools.
 *
 * `toolSupport` is injectable so the rule can be tested without a catalogue cache; the live
 * default is the same AI-29 capability map the failover chain already filters with. An
 * UNKNOWN capability is allowed, exactly as it is there: refusing a free model because a
 * free check did not run would turn a cache miss into an outage of the route.
 */
export function selectSimpleModel(
  models: readonly string[],
  toolSupport: (id: string) => boolean | undefined = declaresToolSupport,
): string | null {
  for (const raw of models) {
    const id = String(raw ?? '').trim();
    if (!id || !/:free$/i.test(id)) continue;
    if (toolSupport(id) === false) continue;
    return id;
  }
  return null;
}

/**
 * AI-99 — a simple stock total needs every location, not a model-sized page.
 *
 * `getInventory` accepts at most 25 rows, but the model chooses `limit` and a measured paid
 * fallback passed 1, received one of the product's two rows with `hasMore: true`, and could
 * only say that the second location was not displayed. The simple stock route raises the
 * limit to the tool's maximum for that one read; the deterministic total then sums real rows.
 * Other questions and tools keep exactly the input the model chose.
 */
export function simpleInventoryToolInput(
  intent: SimpleInventoryIntent | null,
  toolName: string,
  input: unknown,
): unknown {
  if (!intent || toolName !== 'getInventory') return input;
  if (intent.operation !== 'product_stock' && intent.operation !== 'product_existence') {
    return input;
  }
  if (intent.operation === 'product_existence' && !intent.exactSku) return input;
  if (input === null || input === undefined) {
    return {
      ...(intent.operation === 'product_stock' ? { limit: 25 } : {}),
      ...(intent.exactSku ? { exactSku: intent.exactSku } : {}),
    };
  }
  if (typeof input !== 'object' || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    ...(intent.operation === 'product_stock' ? { limit: 25 } : {}),
    ...(intent.exactSku ? { exactSku: intent.exactSku } : {}),
  };
}

const DESCRIPTIONS: Record<SimpleInventoryOperation, string> = {
  product_stock: 'a product stock count',
  product_existence: 'a product existence check',
  restock_list: 'a restock or low-stock list',
  restock_count: 'a restock count',
};

/**
 * The extra instruction a simple turn carries.
 *
 * It is appended, never substituted: rules 1 (tool data only), 11 (never name a tool in the
 * answer), 12 (answer only what was asked) and 38 (reply in the member's language) still
 * apply. The last line keeps the free model's answer the size of the question.
 */
export function simpleInventoryPrompt(intent: SimpleInventoryIntent, message = ''): string {
  const lines = [
    'SIMPLE INVENTORY READ FOR THIS TURN.',
    `The member asked for ${DESCRIPTIONS[intent.operation]}.`,
    `Call ${intent.readTools.join(' or ')} once, then answer only from the rows it returns.`,
    'Do not call any other tool, do not list products before reading stock, and do not add, average or infer a quantity.',
    'Quote the product names, quantities and count exactly as the result states them.',
    'If the result has no matching product or no shortage rows, say that plainly in one sentence.',
    'Keep the answer to at most three sentences; no table, no recommendation and no extra section.',
  ];
  const language = languageDirective(message);
  if (language) lines.push(language);
  return lines.join(' ');
}

/** The first re-ask stays on the free model. */
export function simpleInventoryReask(intent: SimpleInventoryIntent): string {
  return (
    'That answer was written without the inventory read this question needs, so it must not ' +
    `be shown. Call ${intent.readTools.join(' or ')} now and answer only from its result. ` +
    'Do not describe or name the tool, and do not state a quantity, count or product name ' +
    'until you have read it.'
  );
}

/** The second failure escalates the same turn to the paid primary. */
export function simpleInventoryEscalationAsk(intent: SimpleInventoryIntent): string {
  return (
    'Read the recorded data before answering. Call ' +
    `${intent.readTools.join(' or ')} now, then answer only from that result. Do not state ` +
    'any product, quantity or count that the result does not contain.'
  );
}

export default {
  simpleInventoryIntent,
  selectSimpleModel,
  simpleInventoryToolInput,
  simpleInventoryPrompt,
  simpleInventoryReask,
  simpleInventoryEscalationAsk,
};
