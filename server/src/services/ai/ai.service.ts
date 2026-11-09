/**
 * AI orchestration service (SYSTEM_SPECIFICATION.md §21–§26).
 *
 * Runs the controlled tool-calling loop: it hands the provider the read-only
 * tool catalog, executes whatever tool calls come back through executeTool
 * (business-scoped, permission-checked, arg-validated), and feeds results back
 * to the provider — bounded by AI_MAX_TOOL_ITERATIONS so a misbehaving model
 * can never loop forever or burn unbounded tokens.
 *
 * The service never touches the database itself and never lets the model pick
 * a tool argument it did not declare. businessId/userId/role always come from
 * the authenticated session passed in by the caller.
 */

import {
  trimIncompleteAnswer,
  humaniseStatusConstants,
  normaliseAnswerMarkup,
  statesRecordedFigure,
  asksForRecordedData,
  asksForProductAdvice,
  looksUnanswered,
  looksLikeFailureNotice,
  claimsEmptyElsewhere,
  claimsEmptyResult,
  asksBusinessWide,
  relabelBusinessWideScope,
  scopedPlaceIn,
  routeDeadStockReads,
  asksForRevenue,
  statesUnqualifiedMoney,
  withRevenueQualifier,
  normaliseReversedQuantityRange,
  stripUnrequestedLowStockTail,
  asksForBrandList,
  asksForBrandListOnly,
  withCompleteBrandList,
  canonicalBrandListAnswer,
  withCompleteRestockNames,
  restockThreeAnswer,
  asksForThreeRestockNames,
  lowStockValueAnswer,
  mostExpensiveProductAnswer,
  highestStockValueAnswer,
  asksForTotalStockValue,
  replaceFalseToolClaims,
  stripUnsupportedSalesClaims,
  topOutAnswer,
  brandStockRangeAnswer,
  asksForRestockList,
  asksForLowStockValue,
  asksForMostExpensive,
  asksForHighestStockValue,
  asksForTopOut,
  asksForBrandStockRange,
  asksForLocationTotals,
  locationTotalsAnswer,
  asksForProductStockByLocation,
  productStockByLocationAnswer,
  asksForStockOutCount,
  stockOutCountAnswer,
  asksForProductsUnderPrice,
  productsUnderPriceAnswer,
} from './answerCompletion.ts';
import type { CatalogueFact, StockValueSummary, TopOutFact } from './answerCompletion.ts';
import { locationService } from '../reference.service.ts';
import { aiConfig } from './aiConfig.ts';
import {
  AI_UNAVAILABLE,
  AiAbandoned,
  AiOutputLimit,
  AiProviderError,
  AiQuotaExceeded,
  AiTimeout,
  aiErrorAccounting,
  isAiError,
  isModelAvailabilityFailure,
  isModelSpecificProviderFailure,
} from './aiErrors.ts';
import { noteQuotaRefusal, noteQuotaSuccess, quotaBlockRemainingMs, quotaSnapshot } from './quota.ts';
import { declaresToolSupport } from './modelCapabilities.ts';
import { clearModelHealth, isModelHealthBlocked, modelHealthBlockRemainingMs } from './modelHealthGate.ts';
import {
  coolingModels,
  isModelCooling,
  modelCooldownRemainingMs,
  recordModelFailure,
  recordModelSuccess,
} from './modelBreaker.ts';
import { activeModel, promoteModel } from './modelSelection.ts';
import { selectProvider, type ProviderMessage, type ProviderResponse, type ProviderUsage, type ToolDefinition } from './providers/index.ts';
import { capToolResult } from './toolPayload.ts';
import {
  asksForInventoryOnly,
  asksForResearchModel,
  asksForSourceSensitiveQuestion,
  asksForWebResearch,
  webToolLabel,
  type WebToolName,
} from './webCapabilities.ts';
import { executeTool, AI_TOOL_DEFS } from './tools.ts';
import { appendMissingSourceUrls, type ResearchSource } from './webResearch.ts';
import { localDate, localTime, resolveTimeZone, utcOffsetLabel } from '../../utils/timeZone.ts';

/**
 * One prior turn as this service replays it to the provider. The controller
 * builds these from served USER/ASSISTANT messages, so tool turns never appear
 * in history — the neutral message list is this service's to own. Exported
 * because the controller's history loader returns exactly this shape.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One user turn's input. Every field is server-derived, never client-supplied. */
interface ChatParams {
  businessId: string;
  userId: string;
  role: string;
  message: string;
  history?: ChatTurn[];
  /**
   * Aborted when the caller has gone away (AI-1). The turn then ends promptly
   * rather than running to its deadline, so a client that gave up stops costing
   * money instead of quietly paying for an answer nobody will read.
   */
  signal?: AbortSignal;
  /**
   * AI-40 — deliver answer text as the model writes it.
   *
   * Supplying this is the ONLY way to turn streaming on: the caller that can show live text is
   * the caller that asks for it, and every existing caller (and every test) keeps the exact
   * request it made before. The callback may be invoked several times per turn (a tool round
   * can precede the final answer) and never with anything that is not going to be part of the
   * answer's text.
   */
  onTextDelta?: (text: string) => void;
  /**
   * AI-74 — discard text already delivered through `onTextDelta`.
   *
   * The model writes into the stream, but the answer the server stores is a different string:
   * status constants are humanised, markup is normalised, a false place label is relabelled, a
   * revenue qualifier is appended, a cut-off unit is trimmed, and a draft that no tool supports
   * is thrown away and re-asked. Without this the member keeps reading the replaced version until
   * `done` arrives — on the measured 7:32 PM re-ask, for the whole retry. The callback tells the
   * client to clear what it has shown; `done` remains the authority on what is stored.
   */
  onTextReset?: () => void;
  /**
   * The member's IANA time zone, as reported by the client. Untrusted and
   * display-only: it changes the dates the model is told and the `localTime`
   * on tool rows, and it never participates in an authorization decision.
   * Absent or unusable values fall back to UTC (`resolveTimeZone`).
   */
  timeZone?: string;
  /**
   * A controlled failover drill (Guide 16 §9): fail the research model ONCE, on purpose, so the
   * deployment's real fallback path can be observed in production without changing an
   * environment variable or waiting for an upstream outage.
   *
   * Set only by the controller, only for an OWNER request that asked for it, and only together
   * with a research question — so no member can make the assistant fail on purpose and no
   * ordinary turn is affected. The simulated failure is never recorded by the model breaker:
   * nothing was actually wrong with the real research model.
   */
  researchDrill?: boolean;
}

/**
 * Marks the ONE failure a failover drill synthesises, so the turn loop can tell it apart from a
 * real provider failure. A symbol rather than a public field: it is internal to this service and
 * cannot collide with anything an error already carries.
 */
const DRILL_FAILURE = Symbol('aiFailoverDrill');

const isDrillFailure = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { [DRILL_FAILURE]?: unknown })[DRILL_FAILURE] === true;

/**
 * The normalised result of one turn. `model` and `usage` are optional because a
 * provider is allowed to report neither; `iterations` counts provider calls
 * made, so a single-call answer is 1.
 */
/**
 * Why a turn ended without a real answer (AI-2). Exported because the controller
 * passes it through to the client unchanged and the tests assert the exact value:
 * it is a contract, not an internal detail.
 */
export type DegradedReason = CannedReason | 'OUTPUT_LIMIT';

/**
 * The degraded outcomes whose COPY IS THE ANSWER, because there is no answer.
 *
 * AI-8 — `OUTPUT_LIMIT` is deliberately NOT one of these, and that is the whole shape of
 * the fix: a truncated turn produced a real answer that is worth reading (the first rows
 * of a list are what was asked for), so replacing it with a sentence would throw the
 * useful half away. It is marked instead, and the mark is drawn as an annotation beside
 * the answer rather than in place of it.
 */
type CannedReason =
  | 'EMPTY_COMPLETION'
  | 'ITERATION_LIMIT'
  | 'UNGROUNDED_ANSWER'
  | 'UNVERIFIED_RESEARCH';

/**
 * The canned outcomes, each with the sentence the member reads.
 *
 * Kept in ONE table because the reason and its copy must not drift apart: the
 * reason is what the log and the API report, the sentence is what the user sees,
 * and a turn that reported one while showing the other would be worse than no
 * signal at all. Before AI-2 the sentence was inlined at two separate exits with
 * nothing recorded beside it.
 */
const DEGRADED: Record<CannedReason, string> = {
  EMPTY_COMPLETION: 'I could not generate a response right now. Please try again.',
  ITERATION_LIMIT:
    'I could not finish that request within the allowed number of steps. Please try a more specific question.',
  // AI-64 — the model kept narrating a read instead of doing one. The member gets an honest
  // sentence rather than the plan: "I'll call getInventoryHistory … [awaiting tool response]"
  // was measured on the phone as a final answer on 2026-11-05 5:29 PM.
  UNGROUNDED_ANSWER:
    'I could not read that from your records just now. Please ask again — or open the Inventory screen to check it directly.',
  // AI-80 — an online question answered without a web read is not a finding. The member
  // must be told the web was not consulted, so an invented price, review or URL cannot
  // pass as verified research.
  UNVERIFIED_RESEARCH:
    "I couldn't verify current online information because web research was not available for this response. I did not use or invent any online prices, reviews, or source URLs; please try again when web research is available.",
};

interface ChatResult {
  content: string;
  model?: string;
  toolsUsed: string[];
  usage?: ProviderUsage;
  iterations: number;
  /**
   * Present ONLY on a degraded turn (AI-2), absent — not null — on a healthy one,
   * so a caller can tell a real answer from a canned sentence without matching on
   * the sentence itself.
   */
  degraded?: DegradedReason;
}

/**
 * Read-only system prompt. The rules here mirror SYSTEM_SPECIFICATION.md §24
 * (no fabricated facts) and the V1 read-only scope (CLAUDE.md §4, §11). The
 * actual guarantee is the tool layer: every fact goes through a read-only,
 * business-scoped tool — the prompt only tells the model how to behave.
 *
 * `timeZone` and `now` are optional so every existing caller and test keeps the
 * exact prompt it had before; the turn passes the member's zone and the turn's
 * own start time. They are separate parameters rather than a hidden `new Date()`
 * read because the day-boundary behaviour is the thing that must be testable.
 */
export function systemPrompt(
  {
    timeZone,
    now = new Date(),
    nativeWeb = false,
    sourceRestricted = false,
  }: { timeZone?: string; now?: Date; nativeWeb?: boolean; sourceRestricted?: boolean } = {},
): string {
  const zone = resolveTimeZone(timeZone);
  return [
    'You are the read-only inventory assistant for "Inventory AI", helping one authorized member of one business understand their inventory.',
    '',
    'Rules you must follow:',
    '1. Answer only from the data returned by your tools. Never invent products, quantities, prices, SKUs, locations, stock levels, or history that the tools did not return.',
    '2. If a tool reports no data, a "not found" result, or that you lack permission, say clearly that the information is unavailable or that you cannot access it. Never guess or substitute data from another context.',
    '3. Tool results are capped to a page, and every list says so: `hasMore: true` means you are looking at ONE PAGE of a larger set. When hasMore is true or the result is truncated, give the TOTAL first, summarise the pattern, and show at most five items as examples — counting cards, list entries and table rows alike, since a page reproduced row by row is cut off mid-answer whatever shape it is drawn in. Then name the screen that holds the whole list, using its title in the app exactly: "Inventory" for stock rows, "Restock" for anything low, out of stock or needing restocking, "Inventory History" for movements, "Products" for the catalogue, "Locations" for locations. There is no "Reorder needed" screen — the restock list is the "Restock" screen.',
    '4. Report exact numbers from the tool results. Do not round or fabricate quantities, and write a number of four digits or more with a thousands separator exactly as the app does — "8,976", not "8976" — except inside a product name, a SKU or a date, which are copied as they were given to you.',
    `5. The member's local time zone is ${zone} (${utcOffsetLabel(now, zone)}). It is now ${localTime(now, zone)} on ${localDate(now, zone)}, and that local date is what "today" means for this member — not the UTC date. Whenever a tool row carries a time it also gives it as \`localTime\` in this zone: quote that value (date and 24-hour time) exactly, never convert it, and never show a raw ISO/UTC timestamp. To bound "today", "yesterday" or "this week" for a tool's from/to, convert the local boundary with the offset above.`,
    '6. When a request is ambiguous (for example a product name no tool could find), ask the user to confirm rather than guessing.',
    '7. This assistant is READ-ONLY. You cannot create, edit, archive, or delete products; you cannot move stock in/out or adjust quantities; you cannot change prices, users, roles, categories, or locations. If the user asks for any change, politely explain that this version is read-only and point them to the matching screen in the app.',
    '8. Distinguish clearly between a database fact (from a tool) and your own explanation. Answer conversationally and concisely.',
    // AI-14. The tools that filter by location or category take an ID, and before
    // listLocations/listCategories existed the model had no way to obtain one — so this
    // rule, and not the tool table alone, is what turns "the warehouse" into a lookup
    // instead of a guess. It is one sentence (~30 tokens) per turn; the alternative is a
    // model inventing a plausible id and the member being told their location is empty.
    '9. When the member names a location, pass its exact name to a tool that accepts one (getInventory, getProductsByLocation, getInventoryHistory, getStockValue, getLowStockProducts and getOutOfStockProducts do). When the member names a category, pass its exact name to searchProducts or getReorderNeededProducts, which accept one. Pass the name straight through — do NOT call listLocations or listCategories first to confirm it exists; the tool answers a name it cannot match with the name it needs, and only then is a lookup useful. Never guess an id. A shortage question about a named place is about THAT place: stock summed across every location can show a product as healthy while the shelf the member is asking about is empty, so pass the location rather than answering from the business-wide total.',
    // AI-22. Read off the device 2026-10-19: "Compare my two locations, how many products are
    // in each?" cost FIVE provider calls and 51.6 seconds (calls=5 toolRuns=4, providerMs
    // 50879) — one model round-trip per lookup, ~10 s each, against a 60 s deadline. The
    // answer was exact (203 / 99) and the path to it was the defect. Rules 10 and 11 are the
    // two halves the same answer showed: the lookups must travel together, and the member
    // must never be shown an internal tool name in prose (the chip was fixed by AI-21; the
    // sentence was not).
    '10. You can request SEVERAL tools in ONE response, and you should whenever a question needs more than one independent lookup — the same tool for two different locations, or two different tools. Request them together instead of spending a separate round-trip on each: every extra round-trip makes the member wait longer for the same answer.',
    '11. Never name your tools, functions or internal identifiers in the answer. Describe what you read in the member\'s terms and the app\'s screens, not in the server\'s — "your inventory records", not "getProductsByLocation".',
    // AI-22, the third thing the same answer showed: it appended an unrequested movement
    // summary after the two counts. Every extra section costs output tokens, and output
    // tokens are generation time on the member's clock; the 50 000-product probe (§27DN)
    // then had a model STOP mid-sentence inside an unrequested section. The rule keeps one
    // volunteered fact, because the failure is bloat, not helpfulness.
    '12. Answer the question that was asked, and stop there. Do not append extra sections the member did not ask for (a movements summary after a stock count, recommendations, or a menu of further questions); if one related fact is worth volunteering, give it in a single short sentence.',
    // AI-23. The one place the prompt names a tool, and the reason is measured rather than
    // assumed: with `getLocationBreakdown` in the table — described as answering every
    // location at once — a live turn still called `listLocations` and then asked about one
    // location, because the model reaches for the tools it already knows. Naming the tool
    // once, for the question shape it exists for, is the cheapest lever that changes what it
    // reaches for; the alternative was a capability nothing used (~40 tokens per turn).
    '13. When a question compares locations or asks where stock is held, call getLocationBreakdown ONCE — it reports every location at the same time. Do not list the locations and then ask about each one: that spends a round-trip per location and still leaves you comparing pages.',
    // AI-26. Two rules, both read off STORED answers on 2026-10-19 rather than imagined.
    // The corpus contained "indicated `hasMore: true`", a 24-character Mongo id inside a
    // table cell, "Let me know how many additional rows you'd like", and "the remaining
    // low-stock products are available in subsequent pages" — the last one promising a
    // paging control the chat does not have. Every one is a sentence about the server's
    // data shape shown to a member, and every one costs output tokens that a truncated
    // answer needs for its own last row.
    '14. Never put internal identifiers or raw field names in an answer: no 24-character hex ids, no `productId`, `_id`, `hasMore`, `truncated`, `availableQuantity`, `items` or `total` — not in a sentence, not as a table column, and not as a parenthetical after a column name (write "Product", not "Product (name)"). Never print a stored status constant either: write "Out of stock", "Low stock" and "In stock", never OUT_OF_STOCK, LOW_STOCK or IN_STOCK. Say things in the member\'s terms: "13 more products", "the first 20 rows".',
    '15. When you are showing one page of a longer list, the FIRST sentence must state both numbers, in this shape: "47 products need restocking; the 5 most urgent are below." Never show a page without its total, because a member who cannot see "of 47" does not know the list continues. Then stop. Never ask the member how many rows to show, never offer to fetch another page, and never say the rest is "on subsequent pages" — the app shows the whole list on the screen named in rule 3. Keep a table to the columns the member needs — at most three, and never an id.',
    // AI-43. Read off the phone on 2026-11-03: the catalogue has no brand, model,
    // specification, rating or review field, and a seeded tenant can still offer rows named
    // "Premium Battery" or "Ultra Detergent". The assistant answered the sample questions
    // honestly, but that was model compliance, not a boundary: a name adjective is not
    // evidence, and a brand from outside the catalogue is a fabrication even when it is
    // famous. Rule 16 states the boundary where the model can use it on every turn; the
    // matching note on searchProducts/getProduct states it beside the rows.
    '16. Recommend only products a tool returned for this business, and call getInventory or getProduct before saying one is available or in stock. Brand and specifications are optional recorded fields: use them when non-null, and when the member asks for a fact and it is null, say plainly that it is not recorded for that product. Never infer a brand or quality from a product name (words like "Premium", "Pro" or "Ultra" are part of the name, not evidence), and never call a product the best, highest-quality, trusted or suitable for a use unless the tool data states it. A description is free text; use only the facts it states. Never infer a specification from the description or from general knowledge: compare only the recorded specifications, and if a specification is not recorded for one product, say it is not recorded rather than filling the gap. When quality evidence is not recorded, offer the products that do exist by name, brand, category, price and stock. Never fill the gap with a brand or product from outside this business.',
    // AI-43, the other half of the same phone pass: "do we have any products for vehicle
    // repairs?" was answered from ONE empty search plus the category list, which was right
    // here but would be wrong on a catalogue that holds the item under a synonym. The rule
    // asks for the category check and the obvious words, and forbids turning one empty
    // result into a claim about the whole catalogue.
    '17. When the member asks whether the business stocks a KIND of product (a trade, a category or a use), check the categories and search the obvious product words with findProducts; it does both in one call. If it finds nothing, say the catalogue has no matching products or category, and say what you checked; do not turn one empty search into a claim about the whole catalogue.',
    // AI-44. Brand is now a recorded field, and this is the question it exists for.
    // The tool aggregates the field; this rule keeps the model from enumerating the
    // catalogue by hand when one read answers it, and keeps the distinction between
    // "no brand recorded" and "no brand exists" explicit.
    '18. When the member asks which brands the business carries, or for the brands of a kind of product, call listBrands (optionally with the category) before listing products. Report only brands it returns, and when the question is which brands the business carries, name EVERY brand in the result — including brands with no stock or few products — without summarizing, counting instead of naming, or omitting a returned brand; if it returns none, say no brand is recorded for that filter. To check what is on hand for a brand, search that brand and use getProduct or getInventory — Use its categories, sample descriptions and price range to explain recorded differences, but the price range is not a quality or value rating. To check what is on hand, search that brand and use getProduct or getInventory — listBrands itself does not report stock.',
    // AI-45. A manager says "engine oil" or "something for vehicle maintenance"; the
    // catalogue may record "Motor Oil 10W-40" and put "petrol cars" in the description.
    // The tool exists so one natural search can cross those words instead of forcing the
    // member to know the product's name.
    '19. When the member asks what products exist for a use, a maintenance task or a kind of product, call findProducts with several likely terms separated by commas (for example "engine oil, motor oil, 10W-40") BEFORE concluding that nothing exists. It searches product names, recorded brands, recorded descriptions, recorded specifications and returns stock. If it finds nothing, the result already carries the ACTIVE categories and a stop instruction: answer from that result immediately. Do NOT call listCategories or run a series of one-word searchProducts calls for the same request; that spends the turn’s step budget without adding a fact. Say which terms you checked. For a recommendation, offer the returned products and compare only recorded facts — brand, specifications, description, price, unit and available stock. Never call one best, trusted or suitable without recorded evidence; say plainly when quality or specification data is not recorded.',
    '20. When the member asks what the catalogue carries, what categories it has, how many products are recorded, or how complete its brand/description data is, call getCatalogOverview ONCE and answer from its counts. Use the category list and coverage it returns; follow with listBrands for specific brands and findProducts for specific products. This overview has no stock, price or quality data: never present a count as a quality ranking, never say a brand is trusted because it has many products, and never claim stock from it.',
    // AI-47. The boundary is enforced in two places because neither alone is enough:
    // the tool can only receive product ids and filters the findings it returns, while
    // this rule tells the model WHAT TO DO with those findings — evaluate the inventory
    // it found, never add a brand from the open web, and show the source URLs.
    '21. When the member asks for quality, reliability, affordability, reviews, a product update, specifications or a brand recommendation, first use findProducts (and listBrands when brands are the question) to identify what this business actually has. Then call researchInventoryProducts ONCE with up to eight product ids from that result. It researches only those recorded products and brands. Use its findings to evaluate the inventory you already found, never to introduce a new product or brand: recommend only the names in its subjects, keep recorded stock, price and brand facts separate from web findings, and cite the source URLs you used so the member can review them. If a finding says it is a search-result snippet rather than a full review, describe it that way. If it returns no sources, no matching brand is recorded, or the research is unavailable, say so plainly instead of filling the gap with outside knowledge. Name a publication only when a returned source carries its URL; when a finding has no source URL, say that no source was returned rather than naming one. A research call that failed earlier in this conversation is not proof that reviews do not exist: the free public search engine is occasionally busy, so when the member asks again, call researchInventoryProducts again for those products instead of reusing the old failure. Describe an unavailable result in plain words (for example "reviews could not be retrieved just now, try again in a moment"); never show internal fields or reason codes such as available:false, SEARCH_UNAVAILABLE or NO_SOURCES to the member. When the question is about specifications, the latest or a newer model, or what changed in a product line, pass focus "specifications" to researchInventoryProducts: it searches the model name without the recorded year, because the year pins results to the model you already stock. Never answer that no newer model or update exists from the inventory record alone — the catalogue cannot know what a brand released after the last stock update; say the research found nothing newer only after a call returns no newer sources. A web-research answer has a fixed output budget, so when the question has several parts answer them in the order asked with at most three short bullets each, cite each source URL once, and do not re-list recorded fields the member did not ask about; if the parts will not fit, finish the part you are on and say plainly which part still needs its own question instead of trailing off mid-section. When the member asks what people say on Facebook, TikTok, Reddit or another social site, report what the search actually returned: name the publication or page you read, and when no post from that site came back, say no Facebook or TikTok post was returned by the search rather than claiming you have no access to those sites.',
    // AI-48. Specifications are now a recorded field, but a comparison is only
    // honest when every side has the same fact. The rule names the field and the
    // missing-value behaviour so the model cannot fill a gap from memory.
    '22. When comparing products, use the recorded specifications field as the primary evidence for technical facts such as size, weight, battery, connectivity, capacity, panel or switch type. Do not infer a specification from the description, the product name or general knowledge. If a specification is not recorded for one of the products, say it is not recorded and compare only the facts both products record. A web finding can add context, but it does not become a recorded specification.',
    '23. When the member asks for current online prices, a marketplace comparison, or whether a product is cheaper elsewhere, first use findProducts or searchProducts to identify at most three recorded products, then call researchMarketPrices ONCE with their ids. Quote only the exact `priceText` it returns, name the marketplace, include its source URL, and state the retrieval date. Keep the recorded selling price separate: web prices are external listings, not inventory prices, and the default research path uses free public search and pages with no paid search charge. When the `priceSource` of a listing is `search-snippet`, say the evidence is a search-result snippet rather than a full page. Format the recorded price with the ISO code in the recorded `currency` field (for example "PHP 6,990"); when that field is null the currency was never recorded, so write the bare number with no symbol and never guess or default it. Show the recorded price and a listing side by side only as recorded; do not subtract, rank or convert them when the currency is unknown, and never convert between a recorded currency and a listing currency. Never convert currency, add shipping, average the listings, or use a price for a different model or variant. If a marketplace has no verified price, say it is unavailable rather than estimating. When the member names a shop or website ("check rkgamingstore.com", "what does Shopee charge?"), pass those names in `stores`: each is then asked directly and `storeChecks` reports it. Say a named store was not checked when `reachedStore` is false, and say its pages were read but showed no price when `reachedStore` is true with no listing — never turn either into "the store does not sell it". Say it in plain language, not the tool\'s field names: "the Amazon pages were read and showed no listing for this model", never "the listings array was empty" or a `storeChecks`/`listings: []` fragment, and keep tool field names out of any notes table. Recommend only products this business stocks.',
    // AI-49 — two measured failures from the realistic stress pass. Q5 ("good
    // value under 10,000 for a home office") spent six tool rounds searching the
    // use phrase and the catalogue overview, then ended at the iteration cap
    // without an answer. The catalogue overview has no prices or names, and
    // findProducts already returns both price and stock, so the missing rule was
    // how to narrow a broad value question. Q1 also listed the peripherals it
    // found without saying that the requested computer parts were absent.
    '24. When the member asks for products under or over a recorded price, or which products are good value, do not use getCatalogOverview — it has no product names or prices. Call findProducts ONCE with broad product words from the request (for a home office, for example "keyboard, mouse, monitor, headset"), then compare the recorded sellingPrice and available stock it returns yourself. Call researchInventoryProducts at most once for the shortlist, then answer: a low price is not by itself proof of value, so state the price, stock and sourced evidence the comparison rests on. When a request names several kinds of product and only some are present, name what you found and say plainly which requested kinds the catalogue does not contain; never let a related match stand in for an absent kind.',
    // AI-55. Read off the phone on 2026-11-04: "What did we sell in the last 7 days?" was
    // answered in one provider call with NO tool call, as "the inventory system only tracks
    // current on-hand stock, not historical sales records". That is false — every stock-out
    // is a recorded movement and `getInventoryHistory` reads them — so the member was told a
    // capability did not exist because the model never looked. Rule 2 alone could not stop
    // it: "say the information is unavailable" is satisfied by an answer that never checked.
    // The rule names the movement types rather than only the tool, because "sold" is the
    // member's word and `STOCK_OUT` is the record's.
    '25. Never tell a member that a kind of information is unavailable until you have called the tool that would report it. What the business sold, used, moved, received or wrote off is recorded stock movement: call getInventoryHistory for it (pass type STOCK_OUT for sales and usage, STOCK_IN for receipts, and a from/to for the period), and if that window is empty say so in movement terms — "no stock-out movements recorded in the last 7 days" — instead of claiming the app keeps no such records, which is false. When the result carries `windowEmpty`, do not stop at "none in that period": `mostRecentOutsideWindow` or `mostRecentIgnoringType` holds the last movement that did happen, so name it with its localTime and its real type, because a member asking what moved wants the last thing that did. The app does not record sale prices, invoices or customers, so say that plainly when asked for revenue; never turn it into "the system only tracks on-hand stock". If you do offer a figure for revenue or sales value, it is an ESTIMATE — recorded selling price × units out, which may include usage, damage or write-offs and leaves out anything unpriced — so label it as one in the same sentence instead of reporting it as revenue.',
    // AI-56. The same phone answer that leaked `<br>` also laid four marketplace listings
    // beside their long product URLs in a two-column table: at phone width the URL column
    // wrapped three characters wide and the table ran off the bubble. The markup is now
    // stripped whatever the model does; this rule is what keeps the answer readable in the
    // first place, because a stripped tag still leaves the bad shape behind.
    '26. Write in plain text and simple markdown only: never use HTML tags such as <br>, <b> or <p>, because the chat shows them as literal characters. When an answer carries source URLs or several prices, give ONE short line per item — "PC Express: PHP 205,995 — https://…" — rather than a two-column table, and never put a URL inside a table cell, where a phone wraps it to a few characters.',
    '27. For what stock is worth, the most valuable stock, or what is tied up in inventory, call getStockValue once. Quote its totalValue as value at the recorded selling price, and say how many products had no recorded price (unpricedProducts) and are therefore excluded, rather than adding them up yourself from getInventory. The value is in the recorded currency: when `mixedCurrency` is true, `totalValue` is null because the catalogue holds more than one currency, so report each entry of `totalsByCurrency` separately with its own code and never add or convert them. When a row\'s `currency` is null, quote the bare number and do not invent a symbol.',
    // AI-58. Measured on the device 2026-11-05: asked what the stock was worth, the model
    // answered from getInventory rows, which carried no price at all, and invented one per
    // product (PHP 45,000 for a product recorded at PHP 139,995). The rows now carry the
    // recorded price, so the only remaining failure is the model prefering its own figure;
    // this rule names the field to copy and the words to use when it is null.
    '28. Take every price from tool output: a row\'s product.sellingPrice with its product.currency. Never estimate, round or restate a price from memory, and never multiply an assumed price by a quantity — a value is only ever recorded price × available quantity, or a total a tool returned. When sellingPrice is null the price was never recorded: say so for that product and leave it out of any total instead of supplying a number.',
    // AI-59 — measured on the device 2026-11-05: "what is Main Warehouse worth" had no
    // scoped total to read, so the answer would have had to add row values itself, which is
    // the arithmetic AI-58 exists to prevent. The tool now takes the filter, so the rule is
    // about passing it rather than about being careful.
    '29. When a value question is about ONE place or ONE kind of product, call getStockValue once with `location`/`locationId` or `category`/`categoryId` and quote the total it returns — do not list the rows and add their values yourself. Say which subset the total covers ("at Main Warehouse", "our keyboards"), and when `scope` is null the total is the whole business. If a location or category name is not found, say that and offer the business-wide total instead of substituting a similar one.',
    // AI-68/AI-69 — measured on the device 2026-11-05: "which products sold the most this
    // week" was answered for the Store Room, because the previous turn had been about that
    // room, and then stopped at "the window is empty". Two separate disciplines: the scope of
    // THIS question, and the totals the tool now computes.
    '30. Every question sets its own scope. Unless the member names a location, product, category or period in THIS question, do not carry one over from an earlier turn — "which products sold the most this week" is the whole business, not the room discussed before it. Pass a location only when the member named one or referred to "here"/"there" about a place you both just named.',
    '31. When a question ranks or counts, read the figure from tool output instead of adding rows: getInventoryHistory returns `unitsSold`, `unitsReceived` and `topOut` computed over every matching movement, not just the page, so "which sold the most" is `topOut[0]` and "how many units sold" is `unitsSold`. Never sum page rows yourself, and never count transfer legs as sales.',
    // AI-75 — a measured Samsung answer said "between 596 and 242 units" while the rows held
    // 0, 0, 75, 147, 186, 238, 242, 307 and 596. The range was reversed and its floor was the
    // third-largest quantity, so the member could not tell the real spread.
    '32. When stock differs across SKUs, report the quantities in ascending order using the true smallest and largest values the tool returned — for example "from 75 to 596 units", never "between 596 and 242 units". If some SKUs have none, say how many have none separately instead of folding zero into the range. Never put the larger number first, and never call two middle values the range.',
    // AI-78 — measured against the demo catalogue on 2026-11-05: a real product with no
    // inventory rows was answered as "the quantity on hand could not be read" even though
    // the absence of rows is exactly 0 units. The tool now says so; this rule holds the
    // wording on turns where the model reads the rows itself.
    '33. A product that exists but has no inventory row at all has 0 units on hand and is out of stock, not an unreadable quantity. When a tool result has `noInventoryRows`, or returns the product with an empty stock list, write "0 units on hand (out of stock)"; never say the stock could not be read unless the product itself was not found.',
    // AI-79 — measured against the demo catalogue on 2026-11-05: a question asking for a
    // product's price AND units on hand was answered "53 units" after nothing but
    // searchProducts, which carries no stock at all. The number was invented. Rule 16 says
    // which tool to call; this rule makes the two reads visibly different, and the turn loop
    // now refuses a stock answer that never read stock.
    '34. A catalogue search and a stock read are different tools. searchProducts returns catalogue fields only, so never use it to report units on hand, available quantity, low stock or out of stock. When the member asks for a price and a quantity together, call getInventory or getProduct (or findProducts, which returns available stock) and take the quantity from that result; if only the price was read, answer the price and say the stock was not checked rather than guessing it.',
    // AI-80 — measured on the phone 2026-11-05 7:31 AM: "Research owner reviews for the
    // Logitech MX Master 3S" was answered "I don't have any recorded owner reviews in the
    // inventory data" with no research call. Reviews live on the public web, not in the
    // catalogue, so that was a false capability statement. Research questions are not
    // inventory fields; the turn loop now sends one back when it skips the research tool.
    '35. Reviews, ratings, quality, reliability, specifications and current online prices are public-web questions, not inventory fields. Never answer that the inventory record has no owner reviews or no quality data. Use findProducts to identify the recorded product, then call researchInventoryProducts for reviews, quality or specifications, or researchMarketPrices for current online prices; answer only from the returned sources and say plainly when the web search itself was unavailable.',
    // AI-86 — the paid OpenRouter server tools are gated by the turn loop, but once
    // offered the model still needs the boundary between public research and inventory
    // facts. The local research tools remain the preferred path for product research.
    '36. Web search and web fetch are paid, optional tools for public information. Use them only when the member explicitly asks to search or read the web, or when the question needs current external facts that no inventory tool can provide (market prices, reviews, quality, recommendations or a named URL). Never use them for stock, movements, catalogue fields, locations or recorded selling prices; use the inventory tools for those. When product research is needed, prefer researchInventoryProducts or researchMarketPrices.',
    // AI-82 — measured in the 120-question stress run on 2026-11-05. “Most expensive” was
    // answered with the Sony at 19,990 (the largest stock VALUE) while the Dell monitor was
    // recorded at 38,990; a low-stock subtotal quoted the business-wide total; and “under
    // 3,000” was sent as a literal search phrase, which returned nothing. These are three
    // different comparison mistakes, so the rule names the field, the filter and the subset.
    '36. For price comparisons, use the recorded sellingPrice, never stock value or quantity: "most expensive" and "highest price per unit" mean the largest sellingPrice across every product returned, even when another product has a larger stock value or appears on a later page. For "under/over X", call findProducts with a broad product word or no q, then filter the rows by sellingPrice; never put the price threshold in the search query. For a subset value total, add only the rows in that subset and never quote the business-wide getStockValue total. Make any stated unit total equal the rows you show.',
    // AI-83 — the restock answer named the total and the most urgent item but none of the
    // other products on the page, so the member could not act on four of the five rows.
    '37. When a restock question returns several products, name every product in the returned page, out-of-stock first, not only the count and the most urgent item; if the page is shorter than the total, say how many are not shown.',
    // AI-84 — measured in the 14-question Bisaya/Tagalog control on 2026-11-06:
    // the assistant usually replied in English regardless of the question, and a
    // Bisaya question was once answered in Tagalog. The member has to ask in the
    // language they think in; an English reply is not a translation of the answer,
    // and Tagalog is not a substitute for Bisaya.
    '38. Reply in the language of the member\'s latest message: English for English, Tagalog/Filipino for Tagalog, and Bisaya/Cebuano for Bisaya. These are different languages: never answer a Bisaya question in Tagalog or a Tagalog question in Bisaya. Do not switch to English because tool results, product names, field labels or the rest of the app are in English; translate the answer, but keep product names, SKUs, codes, numbers, URLs and necessary technical terms exactly as recorded.',
    // AI-88 — a source lock is enforced by the tool table, but the model also needs to
    // know WHY the research tools are absent. This rule is deliberately exclusive of
    // native web: a locked turn never offers either path, so the two rules cannot occur
    // together.
    // AI-93 — measured on 2026-11-09: the model said it repeated a total "without using any
    // tools" while the turn log carried getInventorySummary. A member cannot verify the
    // tool chip against that sentence, and a false process claim corrodes trust in the
    // figures. The deterministic cleanup below is the backstop; this rule states the
    // boundary in the prompt as well.
    '40. Never say or imply that you answered without tools, without checking, or from memory when a tool result is present in this turn. Describe what you read in the member\'s terms — "from your recorded inventory" — rather than narrating tool use or denying it. If you did not read the data, say that instead of presenting a figure.',
    // AI-94 — the second measured defect of the same pass: a restock answer called ASUS
    // "best-selling" after reading stock levels only. Sales rankings live in the stock
    // ledger; a display name or a large quantity is not evidence of units sold.
    '41. Never call a product "best-selling", "top-selling" or "fastest-moving" unless this turn read a sales or stock-out ranking and that result supports the claim for that exact product. A restock or stock-level read is not sales evidence. When the member asks which product sells best, call getInventoryHistory with type STOCK_OUT (or the sales ranking tool) and answer from `topOut`; if the read does not support a ranking, say so plainly instead of guessing.',
    ...(sourceRestricted
      ? [
          '39. INVENTORY-ONLY SOURCE LOCK: This question must be answered from the business\'s own recorded data only. Do not search the web, fetch a page, call researchInventoryProducts or researchMarketPrices, or use any external price, supplier, review, rating or quality information. You have no supplier or purchase-order tool on this turn. Use inventory tool output for product names, recorded selling prices, currency, stock and movements. If a market price, cost price, supplier term, lead time, external review or quality rating is not in a tool result, say that it is not available from the inventory tools; do not substitute web data or fill the gap from memory. Do not present an external brand or product as a recommendation. This rule supersedes rules 21, 23, 35 and 36.',
        ]
      : nativeWeb
        ? [
            '39. OpenRouter native web search and web fetch are enabled for this deployment. For any public-web research, use those native tools directly; do NOT call researchInventoryProducts or researchMarketPrices, because they are not offered while both native tools are available. Rules 21, 23 and 35 are superseded for this turn. First identify the recorded product with findProducts. Then use web search for evidence and web fetch to read the specific source page. Never run the same search twice or fetch the same URL twice in one turn. Answer only from what the native tools returned, cite every source URL exactly, and state the retrieval date for prices. Quote a price only when it appears on a fetched page or in a search result, keep the recorded selling price separate, never convert currency, and never add a product or brand the business does not stock. If the native tools return an error or no usable source, say plainly that the web research is unavailable instead of filling the gap from memory.',
          ]
        : []),
  ].join('\n');
}

/**
 * AI-29 — how much of the turn's single deadline must be LEFT before a second model is
 * attempted.
 *
 * A failover spends the member's time, so it has to be a real chance at an answer rather
 * than a formality. Measured turns on this tier take 5.3–19.4 s (§27BE, §27DZ), so five
 * seconds is the smallest budget that can plausibly return anything — below it the
 * honest failure arrives sooner, and the member is not made to wait for a request that
 * cannot finish. A constant rather than a knob: it is a property of the turn budget, not
 * a deployment preference, and the deadline is already configurable for anyone who needs
 * a different shape.
 */
const FAILOVER_MIN_REMAINING_MS = 5000;

/**
 * AI-38 — grace after a CAPPED attempt's slice, in ms.
 *
 * The provider's own `timeoutMs` should fire first, which is what makes a capped attempt a known
 * model-level timeout rather than an unknown hang. This tiny grace is the fallback for a provider
 * (or a test double) that ignores the hint: the turn still moves on, just a few milliseconds after
 * the slice instead of exactly at it. It applies ONLY to a capped attempt — an uncapped one is
 * bounded by the turn deadline itself, which must not be extended.
 */
const ATTEMPT_TIMEOUT_GRACE_MS = 50;

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

/**
 * AI-31 — a provider 2xx that actually did something.
 *
 * An upstream 200 carrying neither text nor a tool call is the empty-completion fault
 * AI-2 retries; it is not evidence that the model is healthy, and it is not an answer a
 * member received. It therefore neither clears a failure streak nor promotes the model.
 */
function hasUsableContent(response: ProviderResponse | null | undefined): boolean {
  if (!response) return false;
  const text = String(response.text ?? '').trim();
  const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  return text.length > 0 || calls.length > 0;
}

/**
 * Bound a promise by wall-clock time AND by the caller's continued interest (AI-1).
 *
 * This race is the GUARANTEE that a turn respects its limits: `timeoutMs` handed
 * to the provider below is only the courtesy that lets a well-behaved provider
 * abort its own socket, and a provider that honours neither would otherwise be
 * free to hang the turn forever (the defect this replaces allowed up to
 * 6 x 60000 ms).
 *
 * The two rejections are deliberately different types — "we gave up waiting" is
 * an AiTimeout (504) and "the caller left" is an AiAbandoned (499) — because
 * they mean different things to the client and to the log. Both listeners are
 * always torn down, so an answer that arrives in time leaves nothing behind to
 * keep the process alive.
 */
function withBudget<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AiTimeout()), ms);
    if (signal) {
      onAbort = () => reject(new AiAbandoned());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * Runs one user turn against the provider.
 *
 * @param {object} params
 * @param {string} params.businessId  server-derived business context
 * @param {string} params.userId      server-derived acting user
 * @param {string} params.role        server-derived role (for tool permissions)
 * @param {Array<{role:'user'|'assistant',content:string}>} params.history prior Q/A text
 * @param {string} params.message     the new user message
 * @returns {Promise<{content:string, model?:string, toolsUsed:string[], usage?:object, iterations:number}>}
 */
export async function runAiChat({
  businessId,
  userId,
  role,
  history = [],
  message,
  signal,
  onTextDelta,
  onTextReset,
  timeZone: requestedTimeZone,
  researchDrill,
}: ChatParams): Promise<ChatResult> {
  const cfg = aiConfig();
  // Resolved once per turn: the prompt and every tool row in this turn must use
  // the same zone, and a turn's 60 s budget cannot span enough time to matter.
  const timeZone = resolveTimeZone(requestedTimeZone);
  // AI-88 — decide the source boundary BEFORE the prompt or any tool list is built.
  // A price, supplier or review question is inventory-only unless the member explicitly
  // asks for an external source; an explicit "only my records" constraint is absolute.
  const inventoryOnly = asksForInventoryOnly(message);
  const webResearchIntent = asksForWebResearch(message);
  const sourceRestricted =
    inventoryOnly || (!webResearchIntent && asksForSourceSensitiveQuestion(message));
  let prompt = systemPrompt({
    timeZone,
    nativeWeb: cfg.nativeWebPrimary && webResearchIntent,
    sourceRestricted,
  });
  const provider = selectProvider();

  const messages: ProviderMessage[] = history
    .slice(-cfg.contextMessages)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  messages.push({ role: 'user', content: message });
  // AI-86 — `webResearchIntent` is decided once from the member's actual question.
  // AI-88 — it is also false for a source-locked or unqualified price/supplier/review
  // question, so neither the paid native path nor the local research fallback can run.
  // Native OpenRouter web tools remain PRIMARY when both switches are on and the turn
  // genuinely asks for public-web research. The local research tools are withheld in
  // that mode and come back only after a native refusal.
  let nativeWebActive = cfg.nativeWebPrimary && webResearchIntent;
  let nativeWebFallbackTried = false;
  let nativeResearchToolBlocked = false;
  const nativeWebToolsUsed = new Set<WebToolName>();
  const localResearchToolNames = new Set(['researchInventoryProducts', 'researchMarketPrices']);
  const toolDefsWithNativeWeb = AI_TOOL_DEFS.filter(
    (tool) => !localResearchToolNames.has(tool.name),
  ) as ToolDefinition[];
  // AI-88 — without an explicit public-web request, the research tools are not offered
  // at all. They are web reads (inventory-bound, but still network research), so a locked
  // turn must not be able to reach them on a model's second attempt either.
  const toolDefsWithoutLocalResearch = AI_TOOL_DEFS.filter(
    (tool) => !localResearchToolNames.has(tool.name),
  ) as ToolDefinition[];
  const toolsForTurn = (): ToolDefinition[] =>
    webResearchIntent
      ? nativeWebActive
        ? toolDefsWithNativeWeb
        : (AI_TOOL_DEFS as ToolDefinition[])
      : toolDefsWithoutLocalResearch;

  let finalText: string | null = null;
  const toolsUsed = new Set<string>();
  // Research URLs are collected from successful tool results and appended after
  // the model's answer, so a model that names a publication without linking it
  // cannot leave the member unable to review the claim.
  const researchSources: ResearchSource[] = [];
  // AI-76 — the brand rows this turn's listBrands reads returned. The final answer is
  // checked against these rows, so a complete tool result cannot become an incomplete list.
  const brandRows: Array<{ brand: string; productCount: number }> = [];
  // Rows the catalogue tools actually returned, used by the deterministic finalizers below.
  const productFacts: CatalogueFact[] = [];
  const inventoryFacts: CatalogueFact[] = [];
  const lowStockFacts: CatalogueFact[] = [];
  const reorderFacts: CatalogueFact[] = [];
  const historyTopOutFacts: TopOutFact[] = [];
  const locationFacts: CatalogueFact[] = [];
  let locationPageComplete = false;
  let stockOutMovements: number | null = null;
  let reorderTotal = 0;
  let lowStockTotal = 0;
  // AI-93 — the total and highest-value item are two answers to the same tool read.
  // Keeping the summary here prevents the finalizer from dropping a total the tool
  // actually returned when the member asked for both in one question.
  let stockValueSummary: StockValueSummary | null = null;
  // AI-28 — seeded from the provider's CONFIGURED model, so a turn whose every call failed still
  // names what it was trying. Before this, a provider-side 404 (a withdrawn or broken model,
  // 2026-10-21) produced `model=unknown` on the one line an operator reads to find out which model
  // to change. A successful response still overwrites this with the model the provider reported.
  let model: string | null = provider.model ?? null;
  let usage: ProviderUsage | null = null;
  // The provider's own charge for the whole turn, in USD. Kept separate from the
  // token counters because a missing cost is not zero: `costMissingCalls` lets the
  // line say that a known total is only a lower bound.
  let turnCostUsd: number | null = null;
  let costMissingCalls = 0;
  /**
   * Add one provider call's tokens and charge to the turn total.
   *
   * The counters used to be assigned from the LAST successful response, so a turn
   * that made three or four model calls reported only the final call's prompt tokens
   * (usually 0 on a streamed `message_start` that omits them) even though every call
   * was billed. Summing here makes `in=` and `out=` describe the whole turn, which is
   * what the allowance and credit questions are actually about. The same rule applies
   * to `cost=`: every call's reported charge is summed, and a call that reported no
   * charge is counted so a partial total cannot look exact.
   */
  const addProviderUsage = (spent: ProviderUsage | null | undefined): void => {
    if (!spent) {
      costMissingCalls += 1;
      return;
    }
    if (typeof spent.costUsd === 'number' && Number.isFinite(spent.costUsd)) {
      turnCostUsd = (turnCostUsd ?? 0) + spent.costUsd;
    } else {
      costMissingCalls += 1;
    }
    usage = {
      inputTokens: (usage?.inputTokens ?? 0) + spent.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + spent.outputTokens,
    };
  };
  let steps = 0;
  // AI-2 — the degraded path's own state: why the turn gave up (null while it is
  // still healthy), how much of the retry budget has been spent, and whether the
  // LAST provider response was empty. That last flag is what lets the exit below
  // name the cause rather than the trigger: a turn that ran out of steps while the
  // model kept answering nothing has an empty-completion problem, not a step-count
  // problem, and reporting the wrong one sends an operator to the wrong knob.
  let degraded: DegradedReason | null = null;
  let emptyResponses = 0;
  let lastWasEmpty = false;
  // AI-26 — how much of a truncated answer the incomplete-unit trim removed. Reported
  // beside the reason so the effect is measurable from the log instead of inferred.
  let trimmedChars = 0;
  // AI-29 — how many candidate models this turn tried. On the turn line because "it worked"
  // and "it worked on the fourth model" are different facts about the deployment, and the
  // second one is the reason to change the primary.
  let failovers = 0;
  // AI-40 — how many characters of answer text have already reached the caller. This is the
  // one fact failover must respect once streaming is on: text that has been delivered cannot
  // be taken back, so a second model answering the same question would show the answer twice.
  // It is counted here rather than at the HTTP layer so the rule lives with the failover it
  // constrains, and it counts DELIVERED text only — an empty completion emits nothing and
  // remains retryable exactly as before.
  let emittedChars = 0;
  // AI-74 — the text the screen is CURRENTLY showing. `emittedChars` stays the count of
  // everything ever delivered (text seen once still forbids a failover), while this is cleared
  // by a reset, so the end of the turn can tell whether the stored answer still matches the
  // screen the member is reading.
  let displayedText = '';
  const emitText = (text: string): void => {
    if (!onTextDelta || !text) return;
    emittedChars += text.length;
    displayedText += text;
    onTextDelta(text);
  };
  /**
   * AI-74 — tell the client to throw away what it has shown.
   *
   * Only when something is actually on screen: a reset with nothing displayed is a wasted event
   * and, after a re-ask, would clear a bubble the next delta is about to fill anyway. The reason
   * is logged so a device run can tell a discarded draft from a rewritten answer.
   */
  const resetStreamedText = (reason: string): void => {
    if (!onTextReset || !displayedText) return;
    displayedText = '';
    console.warn(`[ai] clearing streamed text — ${reason}`);
    onTextReset();
  };

  // AI-5 — the turn's own cost.
  //
  // WHY THIS EXISTS. AI-1 bounded a turn and AI-2 made a DEGRADED one visible, but
  // a turn that SUCCEEDED recorded nothing about itself, so the one question the
  // provider decision rests on — how much of a slow answer is the model, how much
  // is the tools, and how many model round-trips it took — was unanswerable from a
  // running server. It had to be re-measured by a script against a seeded tenant,
  // which spends provider quota and only ever describes a controlled run. These
  // counters are that answer, and `reportTurn` is the ONE place the line is
  // formatted, so its shape cannot drift between the exits below.
  const turnStartedAt = Date.now();
  let providerMs = 0;
  let toolMs = 0;
  let providerCalls = 0;
  let toolRuns = 0;
  // AI-60/63/64 — how many times an answer written with no tool read has been sent back. Two,
  // because a measured turn ignored the first instruction and answered with a plan instead
  // (2026-11-05 5:29 PM), so one re-ask was not enough; the third failure ships the canned
  // sentence, never the invented text.
  const MAX_GROUNDING_RETRIES = 2;
  let groundingRetries = 0;
  // AI-72 — the place names this turn removed from a tool call because the question named the
  // whole business. The read is then wide, but the model can still narrate the place it was
  // about to use (measured on the phone 2026-11-05 11:02 PM: the right business-wide count, 59,
  // introduced as "at Main Warehouse", whose own count is 92), so the answer is relabelled
  // before it ships.
  const droppedPlaces: string[] = [];

  /**
   * AI-70 — the sentence that keeps a money figure honest about where it came from.
   *
   * The assistant has no revenue data: the ledger records stock moving, and a stock-out may be
   * a sale, usage, damage or a write-off. Any money figure it gives for sales is therefore
   * recorded selling price × units out, which is an estimate and nothing more. The wording is
   * the server's, so it cannot be dropped under a confident number.
   */
  const REVENUE_QUALIFIER =
    'Note: this is an estimate, not recorded revenue. The app tracks stock movements, not sale prices, invoices or customers, so the figure is each product\u2019s recorded selling price at the time of the read × units out — which can include usage, damage or write-offs, and leaves out any product with no recorded price.';

  /**
   * AI-36 — the allowance as the last provider response reported it, for the turn line.
   *
   * `unknown` is printed rather than a zero or an omission, because those mean different things:
   * an operator reading `quota=0/50` would conclude a spent account, and one seeing no field at
   * all cannot tell an unmeasured turn from an older log format. It is a number, never a key.
   */
  const quotaLabel = (): string => {
    const snapshot = quotaSnapshot();
    if (!snapshot) return 'unknown';
    const remaining = snapshot.remaining === null ? 'unknown' : String(snapshot.remaining);
    return snapshot.limit === null ? remaining : `${remaining}/${snapshot.limit}`;
  };

  /**
   * The provider-reported charge for the turn, or an honest marker.
   *
   * `$0.000000` is a real measurement from a provider that reported zero. A
   * missing report prints `unknown`; when some calls reported and others did not,
   * the sum is marked `>=` because the true total is higher than what is shown.
   */
  const costLabel = (): string => {
    if (turnCostUsd === null) return 'unknown';
    const amount = `$${turnCostUsd.toFixed(6)}`;
    return costMissingCalls > 0 ? `>=${amount}` : amount;
  };

  /**
   * The turn's one cost line. Emitted from every exit below — including the paths
   * that throw, which is why a failed turn reports what it spent before it died.
   * `outcome` uses the same vocabulary as the error codes the controller returns,
   * so a log line and an HTTP answer name the same thing.
   */
  const reportTurn = (outcome: string): void => {
    console.log(
      `[ai] turn outcome=${outcome} total=${Date.now() - turnStartedAt}ms` +
        ` providerMs=${providerMs}ms calls=${providerCalls}` +
        ` toolMs=${toolMs}ms toolRuns=${toolRuns} tools=${[...toolsUsed].join(',') || 'none'}` +
        ` empty=${emptyResponses} failovers=${failovers} quota=${quotaLabel()}` +
        ` in=${usage?.inputTokens ?? 0} out=${usage?.outputTokens ?? 0} cost=${costLabel()}` +
        ` web=${nativeWebToolsUsed.size ? webToolLabel([...nativeWebToolsUsed]) : 'none'}` +
        ` model=${model ?? 'unknown'} iterations=${steps}`,
    );
  };

  // ONE deadline for the whole turn (AI-1). It is derived once, here, and every
  // provider call below is clamped to the time REMAINING against it — so the
  // ceiling is stated in one place and cannot be the product of two unrelated
  // knobs. Runs out at any point -> AiTimeout, which the controller maps to 504.
  const deadlineAt = Date.now() + cfg.turnDeadlineMs;

  // AI-36 — a refusal that reported ZERO remaining is the one case where a provider call cannot
  // teach us anything: the allowance is shared by every free model, so no model, no failover and
  // no retry can succeed. Answer the 429 the member already needs, now, for the cost of a timer.
  // The window is short and a success lifts it, so a stale reading cannot refuse service.
  const quotaBlockedFor = quotaBlockRemainingMs();
  if (quotaBlockedFor > 0) {
    console.error(
      `[ai] quota was reported spent (${Math.ceil(quotaBlockedFor / 1000)}s left on the block)` +
        ' — failing fast without a provider call',
    );
    reportTurn('AI_QUOTA_EXCEEDED');
    throw new AiQuotaExceeded();
  }

  // AI-29 / AI-30 — WHICH MODEL THIS TURN IS TALKING TO, and which models it may still try.
  //
  //   null   -> the provider's configured model, which is every turn until something fails
  //   string -> an explicit model, chosen because the configured one is cooling down
  //             (AI-30) or because it failed during this turn (AI-29)
  //
  // Sticky for the rest of the turn on purpose: a question that needs a tool makes several
  // model calls, and returning to a model that just answered 404 would re-pay for that
  // refusal on every round. It is also what bounds the feature — the chain is walked once
  // per turn, and never again.
  let currentModel: string | null = null;

  /** The configured primary, as the provider reports it. */
  const primaryModel = provider.model ?? cfg.openrouterModel ?? null;

  /**
   * AI-87 — research-heavy turns start on the operator's research model, while ordinary
   * inventory turns keep the configured primary. `asksForResearchModel` covers reviews, market
   * prices, recommendations, comparisons, buying advice and explicit web research, but not
   * analytics questions such as "best selling product".
   *
   * The choice is per TURN, never global: the research model is not promoted into the
   * default slot (see `configuredActive` below). An unset or identical research model, a
   * non-OpenRouter provider, or a plain inventory question leaves the request exactly as it
   * was before this route existed.
   */
  const researchModel =
    cfg.provider === 'openrouter' ? (cfg.openrouterResearchModel || null) : null;
  const researchTurn = Boolean(
    researchModel &&
      researchModel !== primaryModel &&
      asksForResearchModel(message),
  );

  /**
   * Whether THIS turn injects the drill's simulated failure.
   *
   * It requires a research turn, which is the only kind that starts on the research model — the
   * fallback being drilled does not exist on an ordinary turn, so a drill there could not fire
   * and would look like a pass. The controller refuses that request outright; this is the
   * service's own guarantee for a caller that asks anyway.
   */
  const researchDrillTurn = Boolean(researchDrill && researchTurn);
  let drillFailureInjected = false;

  /**
   * The full ordered chain this turn may use: the primary first on an ordinary turn, or the
   * research model followed by the primary on a research turn, then the operator's
   * candidates, de-duplicated.
   *
   * The PRIMARY and the research model are never excluded for tool support — they are what
   * the deployment chose, and a catalogue read must not become a configuration veto. A
   * candidate is checked because an inventory answer without tools is worse than trying the
   * next candidate. Excluded ids are named on ONE line per turn rather than left silent.
   */
  const orderedChain: string[] = (() => {
    const primaryIds = new Set(
      [provider.model, cfg.openrouterModel].filter((id): id is string => Boolean(id)),
    );
    const out: string[] = [];
    const seen = new Set<string>();
    const skipped: string[] = [];
    const start = researchTurn && researchModel ? [researchModel, primaryModel] : [primaryModel];
    for (const id of start) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    for (const id of cfg.fallbackModels) {
      if (!id || seen.has(id)) continue;
      // A candidate that IS the configured model is the same refusal spent twice, whichever
      // of its two names (`provider.model` or the environment's id) it was written as. On a
      // research turn the primary was already added to the start of the chain above.
      if (primaryIds.has(id)) continue;
      if (declaresToolSupport(id) === false) {
        skipped.push(id);
        continue;
      }
      seen.add(id);
      out.push(id);
    }
    if (skipped.length > 0) {
      console.error(`[ai] fallback skipped (no declared tool support): ${skipped.join(', ')}`);
    }
    return out;
  })();

  // AI-31 — the runtime active model comes first; the configured order is the rotation.
  //
  // The promotion is process-local and never written back to `.env`, so the configured
  // default stays exactly what the operator chose. A promoted id that has since been removed
  // from the configured chain is ignored (there is nothing left to use it with).
  // A research turn deliberately starts on the research model even when the primary is
  // active; otherwise a healthy 20B would take the first slot and the 120B would never be
  // used for the work it was configured for. Ordinary turns continue to follow AI-31.
  const configuredActive = researchTurn ? researchModel : activeModel(primaryModel);
  const activeInChain =
    configuredActive && orderedChain.includes(configuredActive) ? configuredActive : null;
  const turnChain = activeInChain
    ? [activeInChain, ...orderedChain.filter((id) => id !== activeInChain)]
    : orderedChain;

  // Whether the active model was ALREADY confirmed unhealthy when this turn began. A turn
  // can outlast the 30-second cooldown (a tool-heavy answer near the 60-second deadline), and
  // `isModelCooling` would then be false by the time the fallback answers — even though the
  // fallback is the model that just proved itself and the active is still unproven. Capturing
  // the fact here keeps that turn's evidence from being discarded by the clock, while the
  // success-time check below still covers the other direction: a concurrent request may open
  // the active's breaker WHILE this turn is in flight.
  const activeCoolingAtStart = Boolean(activeInChain && isModelCooling(activeInChain));

  /**
   * AI-31 — promote the model that just answered, but only once the active is confirmed
   * unhealthy. A single transient failure must not churn which model future requests start
   * with (1–4 consecutive failures keep the active); the fallback still serves THIS turn.
   * The compare-and-set in `promoteModel` makes a stale concurrent request harmless.
   */
  const maybePromote = (responder: string | null): void => {
    if (!responder || !activeInChain || responder === activeInChain) return;
    if (!activeCoolingAtStart && !isModelCooling(activeInChain)) return;
    if (promoteModel(responder, activeInChain)) {
      console.log(`[ai] promoted model: ${activeInChain} -> ${responder}`);
    }
  };

  // AI-30 — a model that has failed five times in a row is skipped for a short cooldown.
  // The primary is skipped LIKE ANY OTHER, which is the point: a deployment with one dead
  // model and four healthy ones should not pay for the dead one on every turn. It is not
  // removed from configuration, so the moment its cooldown ends it is eligible again.
  const coolingNow = coolingModels(turnChain);
  if (coolingNow.length > 0) {
    console.error(
      `[ai] model cooling down, skipped: ${coolingNow
        .map((id) => `${id} (${Math.ceil(modelCooldownRemainingMs(id) / 1000)}s left)`)
        .join(', ')}`,
    );
  }

  // AI-35 — and a model the PROVIDER reports as not serving is skipped before any request is
  // spent on it. This is the one signal that costs nothing to obtain and arrives before a member
  // asks: the endpoint-health read is a GET, run at boot and every watchdog cycle. A mark is
  // bounded and is cleared by a healthy reading or by an answer, so a stale check cannot remove
  // a model for good.
  const healthBlockedNow = turnChain.filter((id) => isModelHealthBlocked(id));
  if (healthBlockedNow.length > 0) {
    console.error(
      `[ai] model unavailable by the provider, skipped: ${healthBlockedNow
        .map((id) => `${id} (${Math.ceil(modelHealthBlockRemainingMs(id) / 1000)}s left)`)
        .join(', ')}`,
    );
  }

  const eligibleChain = turnChain.filter((id) => !isModelCooling(id) && !isModelHealthBlocked(id));
  if (turnChain.length > 0 && eligibleChain.length === 0) {
    // Every model this deployment knows is unavailable — cooling after our own failures, held out
    // by the provider's health reading, or both. Spending a request to prove it once more is
    // exactly the repeated waiting these two mechanisms exist to stop, so the turn ends here —
    // with the same honest sentence a failed provider call would produce.
    const what = coolingNow.length === turnChain.length ? 'cooling down' : 'unavailable';
    console.error(`[ai] every configured model is ${what} — failing fast without a provider call`);
    reportTurn('AI_UNAVAILABLE');
    throw new AiProviderError('The AI service is temporarily unavailable. Please try again in a moment.');
  }

  const startModel = eligibleChain[0] ?? null;
  // No override when the turn starts on the configured primary: that keeps the configuration
  // the source of truth, and the request carries exactly the model it always did.
  if (startModel && startModel !== primaryModel) {
    currentModel = startModel;
    model = startModel;
  }

  // A drill that cannot fire is reported rather than passed off as one: the operator's next step
  // is to read the log, and a silent ordinary turn would look exactly like a successful drill.
  if (researchDrillTurn && startModel !== researchModel) {
    console.error(
      `[ai] failover drill: ${researchModel} is not this turn's start model` +
        ` (start=${startModel ?? 'none'}); no failure was simulated`,
    );
  }

  /** The candidates left after whichever model this turn starts on. */
  const walkRemaining = eligibleChain.filter((id) => id !== startModel);

  /**
   * One provider call, counted on both paths.
   *
   * Counting moved into this `finally` when failover arrived: the line has to reflect a
   * SECOND call, and the previous shape could only ever count the one call per iteration.
   * The budget is read here rather than at the top of the loop so a fallback call gets the
   * time that is actually left — never more than the turn's own deadline.
   */
  const callProvider = async (attemptCapMs = 0, allowTools = true): Promise<ProviderResponse> => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new AiTimeout();
    // The drill's ONE simulated refusal happens here, before any request is built or sent: no
    // provider is called, no quota is spent, and the counters below never claim a call that did
    // not happen. It is a 503 because that is what a dead upstream returns, so the REAL failover
    // path — not a stand-in for it — is what answers the turn.
    if (researchDrillTurn && !drillFailureInjected && currentModel === researchModel) {
      drillFailureInjected = true;
      console.error(
        `[ai] failover drill: simulated HTTP 503 from ${currentModel}; no provider request`,
      );
      throw Object.assign(
        new AiProviderError('The AI service could not be reached.', AI_UNAVAILABLE, 503),
        { [DRILL_FAILURE]: true },
      );
    }
    // AI-38 — a cap only shortens an attempt that HAS somewhere else to go; it can never spend
    // more than the turn has left, and the last attempt is called with 0 (no cap).
    const capped = attemptCapMs > 0 && attemptCapMs < remaining;
    const budget = capped ? attemptCapMs : remaining;
    const startedAt = Date.now();
    try {
      // AI_TOOL_DEFS is the frozen tool catalog; the provider contract wants the
      // neutral `ToolDefinition` shape, which the frozen entries already satisfy
      // (their `parameters` are JSON Schema objects). The assertion is
      // compiler-only — no runtime conversion, no copy of the array.
      return await withBudget(
        provider.complete({
          system: prompt,
          messages,
          // AI-50 — the final round withholds the tools so the model has to answer from what
          // it already gathered instead of spending the last step on another search.
          ...(allowTools
            ? { tools: toolsForTurn() }
            : {}),
          timeoutMs: budget,
          signal,
          webResearch: webResearchIntent,
          nativeWeb: nativeWebActive,
          ...(currentModel ? { model: currentModel } : {}),
          // AI-40 — streaming is requested ONLY when someone is listening. A provider that
          // does not support it ignores these and answers whole, and the turn is unchanged.
          ...(onTextDelta ? { stream: true, onTextDelta: emitText } : {}),
        }),
        capped ? budget + ATTEMPT_TIMEOUT_GRACE_MS : budget,
        signal,
      );
    } finally {
      providerMs += Date.now() - startedAt;
      providerCalls += 1;
    }
  };

  /**
   * One model call, with at most ONE model-level failover walk (AI-29), and a failure
   * memory that keeps a broken model out of the NEXT turns for a short cooldown (AI-30).
   *
   * The classification is the whole feature. Only a failure that blames the MODEL — a
   * 404/410 from the gateway, or a 5xx from an upstream that is down — reaches the
   * fallback. A spent allowance never does: 402/429 arrive as their own class (AI-6)
   * because the account's daily cap is shared by every free model, so switching models
   * cannot succeed and would spend the refusal twice. Neither does an auth or a
   * bad-request answer (another model changes nothing), nor a transport failure — another
   * model travels the same broken network. A classified transport failure (AI-31) is
   * still COUNTED by the breaker, because five consecutive ones mean the assistant cannot
   * serve at all; it simply ends the turn instead of walking the chain.
   *
   * A failure of the fallback is not bounced back to a model that has just failed: the
   * walk continues FORWARD through the chain and nowhere else.
   */
  let walkStarted = false;

  /**
   * AI-38 — did this attempt expire because of its own slice?
   *
   * That is a fact about the MODEL (it produced nothing while an alternative existed), which is
   * why it is failover-eligible. A network failure is not: another model would travel the same
   * broken path, and that rule is unchanged whether the cap is on or off.
   */
  const attemptTimedOut = (err: unknown, capped: boolean): boolean =>
    capped && (err instanceof AiTimeout || (err instanceof AiProviderError && err.kind === 'timeout'));

  /** A reason for the failover line that exists even when no HTTP status does. */
  const failureReason = (err: unknown): string => {
    if (err instanceof AiProviderError) {
      if (typeof err.status === 'number') return `HTTP ${err.status}`;
      if (err.kind === 'timeout') return 'attempt timeout';
      if (err.kind) return err.kind;
    }
    if (err instanceof AiTimeout) return 'attempt timeout';
    return 'error';
  };

  const completeWithFailover = async (allowTools = true): Promise<ProviderResponse> => {
    const attempted = currentModel ?? primaryModel;
    // The first attempt gets a slice only when there is a candidate behind it (AI-38).
    const attemptCap = cfg.attemptMaxMs > 0 && walkRemaining.length > 0 ? cfg.attemptMaxMs : 0;
    try {
      const response = await callProvider(attemptCap, allowTools);
      // AI-36 — a 2xx proves the allowance is available, whether or not it carried content, so it
      // records the reading and lifts any fail-fast window a previous refusal set.
      noteQuotaSuccess(response.quota);
      // AI-30 — a usable 2xx is the only evidence that a model is healthy, so it is the only
      // thing that clears a failure streak. A half-open trial that succeeds closes the breaker
      // here. AI-31 — the same event promotes a model that is serving while the active is
      // cooling, so the next request starts with the model that just proved it works.
      if (hasUsableContent(response)) {
        if (attempted) {
          recordModelSuccess(attempted);
          // AI-35 — an answer is the freshest evidence there is. It clears a mark set while this
          // turn was already in flight, so a stale reading cannot outlive the model proving it wrong.
          clearModelHealth(attempted);
        }
        maybePromote(attempted);
      }
      return response;
    } catch (err) {
      const timedOut = attemptTimedOut(err, attemptCap > 0);
      // AI-30 / AI-31 — the BREAKER counts availability failures: a model-specific
      // status, a classified transport failure (network, timeout, unparseable body), and (AI-38)
      // an attempt that missed its own slice while another candidate existed. Quota, auth and
      // bad-request failures are still not evidence about this model and never make a healthy
      // model's next turn skip it. A transport failure that is NOT a slice expiry still counts
      // but does not fail over — the throw below is unchanged for it.
      // A DRILLED failure is not evidence about the model: nothing was sent to it, so the
      // breaker must not count it. Otherwise five drills would hold the real research model out
      // of the next cooldown and the drill would damage the deployment it is meant to observe.
      const drillFailure = isDrillFailure(err);
      if (attempted && !drillFailure && (isModelAvailabilityFailure(err) || timedOut)) {
        const outcome = recordModelFailure(attempted, Date.now(), {
          threshold: cfg.modelFailureThreshold,
          cooldownMs: cfg.modelCooldownMs,
        });
        if (outcome.opened) {
          console.error(
            `[ai] model cooling down for ${Math.round(outcome.cooldownMs / 1000)}s after ` +
              `${outcome.failures} consecutive failure(s): ${attempted}`,
          );
        }
      }
      // AI-40 — once answer text has reached the caller, this turn has ONE model. A second
      // model would answer the same question again, and the member would read both answers
      // glued together with no way to tell which one is real. The failure is still recorded
      // above (so the breaker and the promotion see it); the turn simply ends here.
      if (emittedChars > 0) throw err;

      if (!isModelSpecificProviderFailure(err) && !timedOut) throw err;

      // Already walked this turn: a later tool round failing on the model that answered is
      // final. Walking again would re-pay every attempt on every round of the same turn.
      if (walkStarted) throw err;
      walkStarted = true;

      let lastError: unknown = err;
      // The model the NEXT attempt is coming FROM. It starts as the one that just failed and
      // then follows the chain, so attempt 2 names the candidate that just failed rather than
      // repeating the primary — a log that named the primary on every line would make a
      // three-model walk read as if the same model were tried three times.
      let from = attempted ?? 'unknown';
      for (const [candidateIndex, candidate] of walkRemaining.entries()) {
        // AI-30 — a candidate inside its cooldown is not worth a request. The primary is
        // skipped before this loop (it would not be this turn's start model), so this is the
        // normal case for a fallback that has been failing too.
        if (isModelCooling(candidate)) {
          console.error(`[ai] failover skipped (cooling down): ${candidate}`);
          continue;
        }
        // AI-35 — a candidate the provider reports as unavailable is not worth a request here
        // either; the walk exists to find a model that is serving, not to re-check a known one.
        if (isModelHealthBlocked(candidate)) {
          console.error(`[ai] failover skipped (reported unavailable): ${candidate}`);
          continue;
        }
        const remaining = deadlineAt - Date.now();
        // The caller's interest and the turn's deadline outrank the chain: a model that
        // cannot finish before the deadline only delays the honest failure.
        if (signal?.aborted || remaining < FAILOVER_MIN_REMAINING_MS) throw lastError;
        currentModel = candidate;
        failovers += 1;
        // One greppable line per attempt, naming the model it came FROM, the status that
        // sent it there and what was left of the budget. Model ids and an HTTP status only:
        // no credential, no prompt and no upstream body is ever on it.
        console.error(
          `[ai] failover attempt=${failovers} model=${from} -> ${candidate}` +
            ` reason=${failureReason(lastError)} remaining=${remaining}ms`,
        );
        from = candidate;
        // AI-38 — only a candidate with ANOTHER behind it gets a slice; the last one keeps
        // everything left, so a slow-but-working answer is never cut short with nowhere to go.
        const candidateCap =
          cfg.attemptMaxMs > 0 && candidateIndex < walkRemaining.length - 1 ? cfg.attemptMaxMs : 0;
        try {
          const response = await callProvider(candidateCap, allowTools);
          noteQuotaSuccess(response.quota);
          if (hasUsableContent(response)) {
            recordModelSuccess(candidate);
            clearModelHealth(candidate);
            maybePromote(candidate);
          }
          return response;
        } catch (next) {
          // A refusal that is NOT about the model ends the walk: quota is shared by every
          // free model (so the next candidate would be refused identically), and a key or
          // request problem travels with us. Only a model-specific failure (or AI-38's slice
          // expiry) moves on — a classified transport failure on a candidate counts toward its
          // own breaker and ends the walk, because it would travel with the next candidate too.
          const nextTimedOut = attemptTimedOut(next, candidateCap > 0);
          if (isModelAvailabilityFailure(next) || nextTimedOut) {
            const outcome = recordModelFailure(candidate, Date.now(), {
              threshold: cfg.modelFailureThreshold,
              cooldownMs: cfg.modelCooldownMs,
            });
            if (outcome.opened) {
              console.error(
                `[ai] model cooling down for ${Math.round(outcome.cooldownMs / 1000)}s after ` +
                  `${outcome.failures} consecutive failure(s): ${candidate}`,
              );
            }
          }
          // AI-40 — a candidate that had already started answering is the last candidate
          // this turn may use, for the same reason the first one is: the text is on screen.
          if (emittedChars > 0) throw next;
          if (!isModelSpecificProviderFailure(next) && !nextTimedOut) throw next;
          lastError = next;
        }
      }
      throw lastError;
    }
  };

  /**
   * Signatures of the tool calls already made this turn (AI-50).
   *
   * The device run on 2026-11-04 showed the shape of the iteration-cap failure: the model
   * re-issued the same `searchProducts` + `getInventory` pair until the budget ran out and
   * the member got the canned sentence. Nothing told it the call had already run, so it
   * re-ran it. A repeat is still executed (the data may legitimately be newer), but its
   * result now carries a note saying it is a repeat, which is the signal that was missing.
   */
  const seenCallKeys = new Set<string>();
  // AI-67 — did any tool in this turn return a page smaller than its own count? Only then can a
  // "no other location has it" sentence be a claim about rows nobody read.
  let sawPartialPage = false;
  // AI-69 — the movements a window-empty history read handed back as the real answer.
  const fallbackMoves: Array<{ product: string; localTime?: string; type: string }> = [];
  // Research turns need a genuine web read AFTER discovery. Six steps let Q99 spend four
  // rounds on catalogue lookups, get re-asked for research, and reach the answer round
  // with no tool available — so the extra two steps exist only for a research question.
  const iterationBudget = webResearchIntent
    ? Math.min(cfg.maxToolIterations + 2, 8)
    : cfg.maxToolIterations;

  for (let i = 0; i < iterationBudget; i += 1) {
    steps = i + 1;
    // Checked before the budget: a caller who has already gone needs no work done
    // at all, and every tool round below costs a model call.
    if (signal?.aborted) {
      reportTurn('AI_ABANDONED');
      throw new AiAbandoned();
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reportTurn('AI_TIMEOUT');
      throw new AiTimeout();
    }
    /**
     * The LAST round answers, it does not search (AI-50).
     *
     * Before this, the final step was an ordinary tool round: the model could spend it on
     * another search, return tool calls and no prose, and the loop would end at the cap with
     * the canned `ITERATION_LIMIT` sentence — even though everything needed for an answer was
     * already in `messages`. The last step now withholds the tools and says so, so the turn
     * ends with the model's best answer from the evidence it gathered.
     */
    const isAnswerRound = i === iterationBudget - 1;
    if (isAnswerRound) {
      messages.push({
        role: 'user',
        content:
          'No further tools are available in this turn. Answer the request now in your own ' +
          'words, using only the tool results already above. State the recorded facts you ' +
          'found and say plainly anything you could not verify; do not claim to have looked ' +
          'up something you did not.',
      });
    }
    let response: ProviderResponse;
    try {
      response = await completeWithFailover(!isAnswerRound);
    } catch (err) {
      // AI-86 — a gateway or workspace that refuses the native server tools must not
      // turn a research question into a failed turn while the local path still works.
      // Retry ONCE with the local research tools. A 400/403 is the documented shape of
      // that refusal; the retry is skipped after any answer text has been delivered.
      if (
        nativeWebActive &&
        !nativeWebFallbackTried &&
        webResearchIntent &&
        emittedChars === 0 &&
        err instanceof AiProviderError &&
        (err.status === 400 || err.status === 403)
      ) {
        nativeWebFallbackTried = true;
        nativeWebActive = false;
        prompt = systemPrompt({ timeZone, nativeWeb: false, sourceRestricted });
        console.warn(
          `[ai] native web tools were refused (status=${err.status}) — retrying with the local research tools`,
        );
        messages.push({
          role: 'user',
          content:
            'The native OpenRouter web tools are unavailable for this deployment. Do not retry them. ' +
            'Use the local research tool instead: researchInventoryProducts for reviews, quality or ' +
            'specifications, or researchMarketPrices for current online prices. Answer only from what ' +
            'it returns, and say plainly if it is unavailable.',
        });
        continue;
      }
      // AI-52 — the model can spend the ENTIRE output budget reasoning and return neither
      // text nor a tool call; the wire then raises `AiOutputLimit` with nothing to show
      // for it. Two battery questions died this way on 2026-11-04 ("K8 Pro reviews", "do
      // we have anything from Royal Kludge?") while their immediate retry answered fine,
      // i.e. the failure is intermittent, not a too-long question. Retried on the SAME
      // empty-completion budget above, because that is exactly what it is: a completion
      // with no usable content. Nothing was emitted, so resending cannot duplicate text.
      if (err instanceof AiOutputLimit && emittedChars === 0 && emptyResponses < cfg.emptyRetryMax) {
        emptyResponses += 1;
        lastWasEmpty = true;
        console.warn(
          `[ai] output limit reached with no content — resending the request once` +
            ` model=${err.model ?? model} out=${err.usage?.outputTokens ?? '?'}`,
        );
        // AI-53 — the retry asks for something different, not the same thing again.
        // On 2026-11-04 the identical resend died the same way twice in a row for a real
        // question ("...is there a newer Alienware model than the one we stock": two calls,
        // both stop=max_tokens, no text, no tool call), and the member saw only "ran out of
        // room". An unchanged resend at temperature 0 mostly re-spends the budget on the same
        // preamble; a short instruction changes the request enough to break that, and if it
        // still fails the limit is reported as before.
        messages.push({
          role: 'user',
          content:
            'Your previous attempt spent its whole reply budget without producing an answer. ' +
            'Reply very briefly this time: at most one tool call, with a short query, or a ' +
            'direct answer under 120 words.',
        });
        continue;
      }
      if (isAiError(err)) {
        // AI-36 — a quota refusal may carry the allowance reading. Only a ZERO starts the bounded
        // fail-fast window; a refusal without a reading keeps AI-6's one-request behaviour, which
        // is what every existing case and stub relies on.
        if (err instanceof AiQuotaExceeded) {
          noteQuotaRefusal(err.quota, { blockMs: cfg.quotaBlockMs });
        }
        // A failure can still know what it cost. `AiOutputLimit` is raised at the one
        // place where the model and the reported token spend are already parsed, and a
        // spent output budget is the turn whose cost matters most — it used to reach
        // this line as `in=0 out=0 model=unknown`, which reports the opposite of what
        // happened (AI-10's device run, 2026-10-17). Adopted BEFORE the report for the
        // same reason every counter is: the line is written once, from here.
        const spent = aiErrorAccounting(err);
        if (spent.model) model = spent.model;
        if (spent.usage) addProviderUsage(spent.usage);
        reportTurn((err as { code?: string }).code ?? 'AI_ERROR');
        throw err;
      }
      console.error('[ai] provider call failed', (err as { message?: unknown })?.message ?? err);
      reportTurn('AI_UNAVAILABLE');
      throw new AiProviderError('The AI service failed unexpectedly. Please try again.');
    }

    model = response?.model || model;
    addProviderUsage(response?.usage);
    for (const used of response?.webToolsUsed ?? []) nativeWebToolsUsed.add(used);
    // Native web tools return their evidence as tool-result blocks, not as a local
    // research tool. Keep those URLs so the stored answer can end with a clickable
    // source list even when the model wrote only `【source N】` markers.
    for (const source of response?.webSources ?? []) {
      if (researchSources.some((existing) => existing.url === source.url)) continue;
      researchSources.push(source);
    }
    let calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    // Reasoning blocks are bound to the exact tool calls that followed them. Keep the original
    // call shape so a locally rewritten/added call does not replay a signature that covers a
    // different assistant turn.
    const providerCallsJson = JSON.stringify(calls);

    if (calls.length === 0) {
      // AI-2 — an upstream 200 carrying NO usable content is not an answer. Two
      // measured shapes reach here (both 2026-10-12, §27BE): a body with only a
      // `thinking` block and no text (F-52), and — one layer up — a zero-length
      // body that fails to parse (F-54). The request below is re-sent UNCHANGED,
      // which is the right minimal response precisely because the observed failures
      // are intermittent rather than deterministic: nothing was wrong with the
      // question. An ordinary loop iteration, so the signal and the turn deadline
      // are both re-checked at the top and the retry shares the iteration budget.
      const text = String(response?.text ?? '').trim();
      lastWasEmpty = !text;
      if (text) {
        // AI-26 — the stored status constants are the server's vocabulary, not the
        // member's: a device answer drew `OUT_OF_STOCK` in a table cell on 2026-10-19.
        // Rewritten before anything else looks at the text, so the stored message, the
        // screen and the trim below all see the same words.
        // AI-56 — the model's `<br>` and other HTML tags are shown to the member literally, so
        // they are removed before anything reads the text (see normaliseAnswerMarkup).
        const candidate = humaniseStatusConstants(normaliseAnswerMarkup(text));
        // AI-75 — a model failure notice is not an answer. On 2026-11-05 9:50 PM a brand
        // and headset question got the literal "[ERROR: Max turns exceeded]" after one search;
        // the turn had steps left, so this was the model's own text, and it must never be
        // stored or shown. Ask once more with the right tools; if it still arrives, degrade.
        if (looksLikeFailureNotice(candidate)) {
          if (!isAnswerRound && groundingRetries < MAX_GROUNDING_RETRIES) {
            groundingRetries += 1;
            console.warn(
              `[ai] the model returned an error notice instead of an answer — asking again (attempt ${groundingRetries})`,
            );
            messages.push({
              role: 'user',
              content:
                'That reply was an error notice (for example "[ERROR: Max turns exceeded]"), not an ' +
                'answer, and it must not be shown to the member. Do not repeat it or describe a limit. ' +
                'Answer from the tool results above; if a fact the request needs is missing, call ' +
                'listBrands for the brands carried or findProducts for products by use or category, ' +
                'then answer only from what the tool returns. If the data cannot be read, say that plainly.',
            });
            resetStreamedText('an error-notice draft was discarded for a re-ask');
            continue;
          }
          degraded = 'UNGROUNDED_ANSWER';
          finalText = DEGRADED.UNGROUNDED_ANSWER;
          break;
        }
        // AI-72 — the model answered a wide read with the dropped place's name still in it.
        // The figures are already right; only the sentence that says what they cover is not, so
        // the label is corrected here instead of being asked for again (re-asking cost a whole
        // step budget on 2026-11-05 7:32 PM and changed nothing).
        let answerText = candidate;
        for (const place of droppedPlaces) {
          const relabelled = relabelBusinessWideScope(answerText, place);
          if (relabelled !== answerText) {
            console.warn(`[ai] business-wide answer still named ${place} — relabelled to all locations`);
            answerText = relabelled;
          }
        }
        // AI-72 — a place named as the scope WITHOUT being passed to a tool. There is no dropped
        // argument to catch in that case, so the answer itself is the evidence: a business-wide
        // answer that states its scope as "at <place>" is false unless the question named that
        // place, and the business's own location names are what make the check exact. Two or more
        // places is a per-location breakdown and is left alone (see `scopedPlaceIn`).
        if (asksBusinessWide(message)) {
          try {
            const locations = await locationService.list(businessId, { status: 'ACTIVE', skip: 0, limit: 50 });
            const place = scopedPlaceIn(
              answerText,
              locations.items.map((location) => String(location?.name ?? '')),
              message,
            );
            if (place) {
              console.warn(
                `[ai] business-wide answer scoped to ${place} that the turn never read — relabelled to all locations`,
              );
              answerText = relabelBusinessWideScope(answerText, place);
            }
          } catch (err) {
            // The check must never cost the member the answer it is checking.
            console.warn('[ai] could not read location names for the scope check', (err as Error)?.message ?? err);
          }
        }
        // AI-60 — an answer that states money without reading anything.
        //
        // Measured on the device 2026-11-05: in a conversation that had just priced the
        // keyboards, *"How much is the Phone Test Shelf worth"* was answered with
        // "PHP 18,500 … 25 units … PHP 740 each" in 1.2 s with calls=1 toolRuns=0 — no tool
        // was called at all, so every figure was invented. The shelf actually held 26 units
        // worth PHP 383,426. A prompt rule cannot close this, because the model is not
        // disobeying a rule it reads; it is answering from the conversation. So the turn is
        // sent back once to read the data, and the invented text is discarded.
        //
        // It is deliberately narrow: only a turn that ran NO tool at all is re-asked, and only
        // when the answer actually states a figure. A greeting, a capability question or a
        // prose answer passes straight through, and a turn that already read something is not
        // restarted (a wrong figure after a real read is a different, rarer failure).
        // AI-63 — the detector above is one phrasing behind the model: measured twice on the
        // same device on 2026-11-05, the second time as "538 stock-out movements" (seven were
        // recorded). A question that asks about recorded stock, sales or movements, answered
        // with no tool at all, is sent back for the same reason — it cannot have been answered
        // from the business.
        const statedFigure = statesRecordedFigure(candidate);
        const narrated = looksUnanswered(candidate);
        const answeredFromMemory = statedFigure || narrated || asksForRecordedData(message);
        if (
          toolRuns === 0 &&
          nativeWebToolsUsed.size === 0 &&
          !webResearchIntent &&
          !isAnswerRound &&
          groundingRetries < MAX_GROUNDING_RETRIES &&
          answeredFromMemory
        ) {
          groundingRetries += 1;
          console.warn(
            `[ai] no tool read for a ${narrated ? 'tool-narrating' : statedFigure ? 'figure-stating' : 'recorded-data'} answer — asking the model for the data (attempt ${groundingRetries})`,
          );
          messages.push({
            role: 'user',
            content:
              (groundingRetries === 1
                ? 'That answer was written without reading anything from the business, and this ' +
                  'question is about recorded data. '
                : 'You still have not read anything, and this turn cannot answer without it. ') +
              'Call the tool that records it — getStockValue for a value, getInventory or ' +
              'getProduct for stock and prices, getInventoryHistory for movements and sales, ' +
              'getLowStockProducts for shortages, listBrands for the brands carried, and ' +
              'findProducts for products by use or category — and answer only from its output. Do not ' +
              'describe, announce or name a tool, and do not write placeholders such as ' +
              '[awaiting tool response]: call it now in this turn. If the data cannot be read, ' +
              'say that plainly instead of stating a figure.',
          });
          resetStreamedText('a no-tool draft was discarded for a re-ask');
          continue;
        }
        // AI-79 — a catalogue read is not a stock read. Measured on 2026-11-05: a question
        // asking for a price AND units was answered "53 units" after only searchProducts,
        // which returns no quantity at all. The no-tool guard above cannot see this because a
        // tool DID run. Re-ask for a stock-bearing read, then refuse to ship the invented
        // quantity if the model still will not make one.
        const stockReadTools = [
          'getInventory',
          'getProduct',
          'findProducts',
          'getProductsByLocation',
          'getLowStockProducts',
          'getOutOfStockProducts',
          'getReorderNeededProducts',
          'getInventorySummary',
          'getStockValue',
          'getLocationBreakdown',
          'getInventoryHistory',
        ];
        const asksForStock = /\b(?:stocks?|units?|quantit(?:y|ies)|available|availability|on hand|in stock|out of stock)\b/i.test(
          message,
        );
        const answeredStockWithoutRead =
          asksForStock && !stockReadTools.some((tool) => toolsUsed.has(tool));
        if (
          answeredStockWithoutRead &&
          statedFigure &&
          !isAnswerRound &&
          groundingRetries < MAX_GROUNDING_RETRIES
        ) {
          groundingRetries += 1;
          console.warn(
            `[ai] stock answer without a stock read — asking for the stock tool (attempt ${groundingRetries})`,
          );
          messages.push({
            role: 'user',
            content:
              'That answer states a stock quantity, but the tools it used do not report stock. ' +
              'Call getInventory or getProduct for the named product (or findProducts for a ' +
              'shortlist) now, and answer the quantity from that result. Do not reuse a number ' +
              'from a catalogue search. Do not describe or name the tool; just make the read.',
          });
          resetStreamedText('a stock answer without a stock read was discarded for a re-ask');
          continue;
        }
        // AI-67 — a partial page answered as if it were the whole business.
        //
        // Measured on the phone 2026-11-05 5:58 PM: *"Where are the G304s"* read one page of
        // 15 rows out of 17 and said "No other location shows stock for this product" while the
        // Store Room held 25 — in the two rows the page had cut. The result said `hasMore: true`
        // and the model read past it, so the turn is sent back to read the product's own rows.
        if (sawPartialPage && claimsEmptyElsewhere(candidate) && groundingRetries < MAX_GROUNDING_RETRIES) {
          groundingRetries += 1;
          console.warn(
            `[ai] a partial page was answered as a complete roster — asking for the missing rows (attempt ${groundingRetries})`,
          );
          messages.push({
            role: 'user',
            content:
              'One of the results you just read was only a PAGE of a longer list (`hasMore: true`), ' +
              'so it cannot support a sentence saying another location has none. Call getInventory ' +
              'again with `q` set to the product name — that returns that product\u2019s rows at every ' +
              'location — and answer where it is from those rows. If you cannot read them, say which ' +
              'locations you checked instead of claiming the others are empty.',
          });
          resetStreamedText('a partial-page draft was discarded for a re-ask');
          continue;
        }
        // AI-70 — a revenue figure presented as recorded fact.
        //
        // Measured on the phone 2026-11-05 6:23 PM: "PHP 68,975 in revenue this week", computed
        // from selling prices × units out. Nothing in the business records a sale price, an
        // invoice or a customer, and a stock-out may be usage or damage, so the number is an
        // estimate at best and the sentence did not say so. Rule 25 asks for the qualification;
        // the model dropped it, so the turn is sent back for the wording.
        // AI-70 — asked to reword it, the model spent its step budget recomputing instead
        // (6 iterations, 4 tool runs, then "I could not finish that request"), so the
        // qualification is APPENDED by the server rather than requested from the model: a
        // measured 6:27 PM turn got no answer at all where a qualified one was available.
        // AI-69 — an empty window that drops the movements the tool handed back.
        //
        // Measured on the phone 2026-11-05 6:08 PM: the history result carried the last three
        // real movements with a note telling the model to name them, and the answer still said
        // "the history window is empty … nothing to report". Re-asked once with the rows spelled
        // out, because a correct-but-dead-end answer is the defect this whole family of guards
        // exists to prevent.
        if (
          fallbackMoves.length > 0 &&
          claimsEmptyResult(candidate) &&
          !fallbackMoves.some((move) => candidate.toLowerCase().includes(move.product.toLowerCase())) &&
          groundingRetries < MAX_GROUNDING_RETRIES
        ) {
          groundingRetries += 1;
          console.warn(
            `[ai] empty-window answer dropped ${fallbackMoves.length} earlier movements — asking again (attempt ${groundingRetries})`,
          );
          const list = fallbackMoves
            .slice(0, 3)
            .map((move) => `${move.product} (${move.type}${move.localTime ? `, ${move.localTime}` : ''})`)
            .join('; ');
          messages.push({
            role: 'user',
            content:
              'Your answer stops at an empty period, but the tool returned the movements that DID ' +
              `happen outside it: ${list}. Say the period had no matching movement, then name the ` +
              'newest of those with its time and its real type, so the member is not left with ' +
              'nothing. Do not invent anything beyond those rows.',
          });
          resetStreamedText('an empty-window draft was discarded for a re-ask');
          continue;
        }
        // AI-64 — the re-asks are spent and the model is still describing a read it never did.
        // The plan is not an answer, so the member gets the honest sentence instead of it.
        // Any recorded-data question that still has no tool read after both re-asks is
        // ungrounded, whether it narrates a plan or simply states an absence. The earlier
        // version only refused the narration, so a confident "we do not carry it" could ship.
        if (
          toolRuns === 0 &&
          nativeWebToolsUsed.size === 0 &&
          !webResearchIntent &&
          answeredFromMemory &&
          asksForProductAdvice(message)
        ) {
          degraded = 'UNGROUNDED_ANSWER';
          finalText = DEGRADED.UNGROUNDED_ANSWER;
          break;
        }
        if (answeredStockWithoutRead && statedFigure) {
          degraded = 'UNGROUNDED_ANSWER';
          finalText = DEGRADED.UNGROUNDED_ANSWER;
          break;
        }
        // AI-80 — reviews and current marketplace prices are web reads, not catalogue
        // fields. A measured phone turn answered "no recorded owner reviews" without
        // calling either research tool; that is a false capability statement, not a
        // finding. Re-ask with the exact research path, then refuse the claim if it
        // still arrives without a research read.
        const researchReadSucceeded =
          researchSources.length > 0 || nativeWebToolsUsed.size > 0;
        const answeredResearchWithoutRead = webResearchIntent && !researchReadSucceeded;
        if (
          answeredResearchWithoutRead &&
          !isAnswerRound &&
          groundingRetries < MAX_GROUNDING_RETRIES
        ) {
          groundingRetries += 1;
          const priceQuestion =
            /\b(?:prices?|charge|costs?|marketplace|shopee|lazada|amazon|presyo|presyuhan|magkano)\b/i.test(
              message,
            );
          const researchTool = priceQuestion ? 'researchMarketPrices' : 'researchInventoryProducts';
          const useNativeNow = nativeWebActive && groundingRetries === 1;
          if (nativeWebActive && !useNativeNow) {
            // The first re-ask kept the native path; a second unanswered request is
            // evidence the native tools are not running on this model. Switch the
            // prompt and the offered tools together, so the fallback is one path.
            nativeWebActive = false;
            nativeWebFallbackTried = true;
            prompt = systemPrompt({ timeZone, nativeWeb: false, sourceRestricted });
            console.warn(
              '[ai] native web tools did not run — falling back to the local research tools',
            );
          }
          const knownProducts = productFacts
            .filter((fact) => Boolean(fact.id))
            .slice(0, 8)
            .map((fact) => `${fact.name} (${fact.id})`)
            .join(', ');
          console.warn(
            `[ai] research answer without a web read — asking for ${
              useNativeNow ? 'the native web tools' : researchTool
            } (attempt ${groundingRetries})`,
          );
          messages.push({
            role: 'user',
            content:
              'That answer did not consult the public web, and this question asks for reviews, ' +
              'quality, specifications or online prices. Do not say the inventory record contains ' +
              'no reviews. Use findProducts to identify the recorded product, then ' +
              (useNativeNow
                ? 'use the native web search tool for evidence, fetch the specific source pages you need, and answer from those results. Cite the exact source URLs. '
                : `call ${researchTool} now and answer from the returned sources. `) +
              (knownProducts ? `Recorded candidates from this turn: ${knownProducts}. ` : '') +
              'If the web search is unavailable, say that plainly rather than describing an inventory field.',
          });
          resetStreamedText('a research answer without a web read was discarded for a re-ask');
          continue;
        }
        if (answeredResearchWithoutRead) {
          degraded = 'UNVERIFIED_RESEARCH';
          finalText = DEGRADED.UNVERIFIED_RESEARCH;
          break;
        }
        // AI-70 — a revenue figure is never presented as recorded fact.
        //
        // Measured on the phone 2026-11-05 6:23 PM: "PHP 68,975 in revenue this week … the sum
        // of recorded selling prices × units sold". Nothing records a sale price, an invoice or
        // a customer, and a STOCK_OUT may be usage or damage, so the figure is an estimate the
        // answer presented as revenue. The sentence is added HERE, by the server, because asking
        // the model to reword it produced a worse turn: 6 iterations, then "I could not finish
        // that request within the allowed number of steps" (6:27 PM).
        if (asksForRevenue(message) && statesUnqualifiedMoney(candidate)) {
          console.warn('[ai] revenue question answered with unqualified money — qualification appended');
          // Room is reserved for the note inside the cap, so the sentence that explains the
          // figure is never the part that gets cut (see `withRevenueQualifier`).
          finalText = withRevenueQualifier(answerText, REVENUE_QUALIFIER, cfg.maxMessageChars);
        } else {
          finalText = answerText;
        }
        // AI-8 — the answer is here, and the provider may have STOPPED mid-sentence to
        // produce it. That case used to be indistinguishable from a complete answer at
        // every layer: same 201, same stored content, nothing in the log (ISS-29, found
        // on the device 2026-10-14, where `out=800` was exactly the cap and the body end
        // mid-list). The text is kept — it is a real answer — and the turn is marked.
        if (response?.truncated) {
          degraded = 'OUTPUT_LIMIT';
          // AI-26 — the model stopped at the output cap, so the prefix ends inside a table
          // row or a sentence (all four stored `OUTPUT_LIMIT` answers did, measured on
          // 2026-10-19). Drop that ONE incomplete unit and keep the rest: a member reading
          // "Professional Towel 1" cannot tell a product's name from a cut-off one.
          const completed = trimIncompleteAnswer(finalText);
          if (completed !== finalText) {
            trimmedChars = finalText.length - completed.length;
            finalText = completed;
          }
        }
        break;
      }
      // Counted as SEEN, never as "authorised": the log line then reports how many
      // empty responses actually arrived, which is the number an operator can act
      // on. The two differ whenever a budget larger than the iteration cap is
      // configured, and the log must not overstate what happened.
      emptyResponses += 1;
      if (emptyResponses <= cfg.emptyRetryMax) continue;
      // Budget spent and still nothing: give up, and let the exit below supply the
      // matching sentence and mark the turn.
      degraded = 'EMPTY_COMPLETION';
      break;
    }

    // AI-73 — a dead-stock question cannot be answered from the low-stock list.
    //
    // Measured on the phone 2026-11-05 11:01 and 11:07 PM: *"Any dead stock at the Main
    // Warehouse"* (no question mark) routed to getLowStockProducts and the turn shipped rows
    // reading "Stock-out count 1" under a dead-stock heading — the opposite of the definition —
    // while the same phrase WITH a question mark routed correctly at 11:10 PM. Tool choice is not
    // reliable for this vocabulary, so the CALLS are rewritten before they run: the low-stock
    // read becomes the dead-stock read, and a dead-stock question with no read at all gets one.
    // A mixed question keeps both, because dropping the low-stock half would be wrong the other
    // way. A turn that already read the dead-stock tool is never rewritten.
    if (!toolsUsed.has('getProductsNeverSold')) {
      const routed = routeDeadStockReads(calls, message);
      if (routed !== calls) {
        console.warn(
          `[ai] dead-stock question — reads routed to getProductsNeverSold (model asked: ${calls.map((call) => String(call?.name ?? '')).filter(Boolean).join(',') || 'none'})`,
        );
        calls = routed;
      }
    }
    // A brand stock-range answer needs product rows, not just the brand list. The measured
    // “What is the stock range across Logitech products?” turn called listBrands and then
    // stopped with a plan to call getInventory. Add the discovery read before execution so
    // the finalizer has all three products' summed availability.
    if (
      asksForBrandStockRange(message) &&
      !calls.some((call) => ['findProducts', 'getInventory'].includes(String(call?.name ?? '')))
    ) {
      const brand = /(?:across|for)\s+([A-Za-z][\w-]*)\s+products?\b/i.exec(message)?.[1];
      if (brand) {
        calls = [
          ...calls,
          { id: 'call-ai-brand-range', name: 'findProducts', input: { keywords: brand } },
        ];
        console.warn(`[ai] stock-range question — added findProducts for ${brand}`);
      }
    }

    messages.push({
      role: 'assistant',
      content: String(response?.text ?? ''),
      toolCalls: calls.map((call, i) => ({
        id: String(call?.id ?? `call-${i + 1}`),
        name: String(call?.name ?? ''),
        input: call?.input,
      })),
      ...(JSON.stringify(calls) === providerCallsJson ? { thinking: response?.thinking } : {}),
    });

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const name = String(call?.name ?? '');
      // AI-88 — a model can name a tool that is not offered. A research tool is a web
      // read even when it is inventory-bound, so a turn without explicit public-web
      // intent must not run it on a retry. Refuse it as data and keep the turn grounded.
      if (localResearchToolNames.has(name) && !webResearchIntent) {
        console.warn(
          `[ai] blocked ${name} — no explicit public-web research intent on an inventory-only turn`,
        );
        messages.push({
          role: 'tool',
          name,
          toolCallId: String(call?.id ?? `call-${i + 1}`),
          content: JSON.stringify({
            available: false,
            reason: 'INVENTORY_ONLY',
            note:
              'This turn is restricted to the business inventory records. The web research tool was not run. ' +
              'Answer from inventory tool results; if the requested external fact is not recorded, say it is unavailable. ' +
              'Do not use or describe web data.',
          }),
        });
        continue;
      }
      // AI-86 — a model can name a tool that is no longer offered. While the native
      // web tools are primary, running the local research tool would silently spend
      // the fallback path (and duplicate the research) behind the member's back.
      // Answer the call with a native-only notice first; a second attempt is evidence
      // the model cannot use the native path, so switch the turn to the local tools
      // and run it rather than dead-ending.
      if (nativeWebActive && localResearchToolNames.has(name)) {
        if (!nativeResearchToolBlocked) {
          nativeResearchToolBlocked = true;
          console.warn(
            `[ai] blocked ${name} while native web tools are primary — asking for the native tools`,
          );
          messages.push({
            role: 'tool',
            name,
            toolCallId: String(call?.id ?? `call-${i + 1}`),
            content: JSON.stringify({
              available: false,
              reason: 'NATIVE_WEB_REQUIRED',
              note:
                'OpenRouter native web search and web fetch are enabled for this turn. ' +
                'That local research tool was not run. Use the native web tools instead.',
            }),
          });
          continue;
        }
        nativeWebActive = false;
        nativeWebFallbackTried = true;
        prompt = systemPrompt({ timeZone, nativeWeb: false, sourceRestricted });
        console.warn(
          '[ai] native web tools were not used — falling back to the local research tools',
        );
      }
      if (name) toolsUsed.add(name);
      const callArgs = (call?.input ?? null) as Record<string, unknown> | null;
      const namedPlace = typeof callArgs?.location === 'string' ? callArgs.location.trim() : '';
      // AI-72 — the question names the whole business, so a place carried over from an earlier
      // turn cannot narrow the read. This is corrected BEFORE the call, not after the answer:
      // re-asking the model (measured on the phone 2026-11-05 7:32 PM) burned the whole step
      // budget on six iterations and still stored "no products have never left the store", which
      // is false — five products have. Dropping the argument here makes the FIRST read wide, so
      // no retry and no stale page can end up in the answer.
      let toolInput = call?.input;
      if (namedPlace && asksBusinessWide(message) && !message.toLowerCase().includes(namedPlace.toLowerCase())) {
        const rest = { ...(callArgs ?? {}) };
        delete rest.location;
        delete rest.locationId;
        toolInput = rest;
        droppedPlaces.push(namedPlace);
        console.warn(
          `[ai] business-wide question — dropped the location "${namedPlace}" carried over from an earlier turn`,
        );
      }
      const toolStartedAt = Date.now();
      const countTool = (): void => {
        toolMs += Date.now() - toolStartedAt;
        toolRuns += 1;
      };
      // AI-50 — a repeat of the same call is still executed (the data may be newer), but the
      // result now says it is a repeat. Without that note the model saw an ordinary result and
      // re-issued the same search until the iteration cap.
      const callKey = `${name}:${JSON.stringify(call?.input ?? null)}`;
      const repeated = seenCallKeys.has(callKey);
      seenCallKeys.add(callKey);
      let output: unknown;
      // The turn deadline used to stop at the tool boundary: a tool was awaited
      // with no signal and could run for minutes after the phone had gone. The
      // same wall-clock budget now covers the tool, and the tool receives a
      // signal so its fetches stop rather than merely being ignored.
      const toolBudgetMs = Math.max(0, deadlineAt - Date.now());
      const toolController = new AbortController();
      const toolTimer = setTimeout(() => toolController.abort(), toolBudgetMs);
      const toolSignal = signal
        ? AbortSignal.any([signal, toolController.signal])
        : toolController.signal;
      try {
        output = await withBudget(
          executeTool(name, toolInput, { businessId, userId, role, timeZone, signal: toolSignal, deadlineAt }),
          toolBudgetMs,
          signal,
        );
      } catch (err) {
        // A tool that was cancelled or outlived the turn must end the turn, not
        // become a TOOL_ERROR the model can answer with another provider call.
        const abandoned = err instanceof AiAbandoned || signal?.aborted === true;
        const expired = err instanceof AiTimeout || (err as { name?: unknown } | null)?.name === 'AbortError';
        if (abandoned || expired) {
          countTool();
          if (abandoned) {
            reportTurn('AI_ABANDONED');
            throw err instanceof AiAbandoned ? err : new AiAbandoned();
          }
          reportTurn('AI_TIMEOUT');
          throw err instanceof AiTimeout ? err : new AiTimeout();
        }
        // The one exit none of the explicit sites covers: a tool that THROWS
        // rather than returning an error result. It reports and rethrows, so a
        // future failure mode cannot become a silent gap in the log — and it counts
        // the attempt before reporting, for the same reason the provider call does.
        countTool();
        reportTurn('ERROR');
        throw err;
      } finally {
        clearTimeout(toolTimer);
      }
      countTool();
      if (name === 'listBrands' && output && typeof output === 'object') {
        const result = (output as { result?: unknown }).result;
        const items =
          result && typeof result === 'object'
            ? (result as { items?: unknown }).items
            : undefined;
        if (Array.isArray(items)) {
          for (const raw of items) {
            if (!raw || typeof raw !== 'object') continue;
            const brand = String((raw as { brand?: unknown }).brand ?? '').trim();
            if (!brand) continue;
            if (!brandRows.some((existing) => existing.brand.toLowerCase() === brand.toLowerCase())) {
              const productCount = Number((raw as { productCount?: unknown }).productCount);
              brandRows.push({ brand, productCount: Number.isFinite(productCount) ? productCount : 0 });
            }
          }
        }
      }
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        if ((output as { hasMore?: unknown }).hasMore === true) sawPartialPage = true;
        const history = output as { mostRecentIgnoringType?: unknown; mostRecentOutsideWindow?: unknown };
        const rows = Array.isArray(history.mostRecentIgnoringType)
          ? history.mostRecentIgnoringType
          : Array.isArray(history.mostRecentOutsideWindow)
            ? history.mostRecentOutsideWindow
            : [];
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object') continue;
          const row = raw as { product?: { name?: unknown }; localTime?: unknown; type?: unknown };
          const product = typeof row.product?.name === 'string' ? row.product.name : null;
          if (!product) continue;
          fallbackMoves.push({
            product,
            type: String(row.type ?? ''),
            ...(typeof row.localTime === 'string' ? { localTime: row.localTime } : {}),
          });
        }
      }
      // Keep the facts this turn actually read. The finalizers below use these rows only; a
      // model omission cannot become a missing product, price or range.
      const wrappedOutput =
        output && typeof output === 'object' && 'result' in output
          ? (output as { result?: unknown }).result
          : output;
      const resultRecord =
        wrappedOutput && typeof wrappedOutput === 'object' && !Array.isArray(wrappedOutput)
          ? (wrappedOutput as Record<string, unknown>)
          : null;
      const resultItems = Array.isArray(resultRecord?.items) ? (resultRecord.items as unknown[]) : [];
      const factFrom = (raw: unknown): CatalogueFact | null => {
        if (!raw || typeof raw !== 'object') return null;
        const record = raw as Record<string, unknown>;
        const product =
          record.product && typeof record.product === 'object'
            ? (record.product as Record<string, unknown>)
            : record;
        const location =
          record.location && typeof record.location === 'object'
            ? (record.location as Record<string, unknown>)
            : null;
        const name = typeof product.name === 'string' ? product.name.trim() : '';
        if (!name) return null;
        const price = typeof product.sellingPrice === 'number' ? product.sellingPrice : null;
        const directQuantity = typeof record.availableQuantity === 'number' ? record.availableQuantity : null;
        const productQuantity = typeof product.availableQuantity === 'number' ? product.availableQuantity : null;
        return {
          id: typeof product.id === 'string' ? product.id : undefined,
          name,
          brand: typeof product.brand === 'string' ? product.brand : null,
          sellingPrice: price,
          currency: typeof product.currency === 'string' ? product.currency : null,
          availableQuantity: directQuantity ?? productQuantity,
          locationName:
            typeof location?.name === 'string' && location.name.trim()
              ? location.name.trim()
              : null,
          stockValue: typeof record.value === 'number' ? record.value : null,
        };
      };
      if (name === 'getInventoryHistory') {
        const count = Number(resultRecord?.stockOutMovements);
        if (Number.isFinite(count) && count >= 0) stockOutMovements = count;
        // Keep the exact names the history tool already ranked, so a follow-up or a ranking
        // answer cannot substitute a different SKU that happens to share the same model name.
        historyTopOutFacts.length = 0;
        const topOut = Array.isArray(resultRecord?.topOut) ? (resultRecord.topOut as unknown[]) : [];
        for (const raw of topOut) {
          if (!raw || typeof raw !== 'object') continue;
          const row = raw as Record<string, unknown>;
          const productName = typeof row.product === 'string' ? row.product.trim() : '';
          const unitsOut = Number(row.unitsOut);
          if (!productName || !Number.isFinite(unitsOut) || unitsOut <= 0) continue;
          historyTopOutFacts.push({ name: productName, unitsOut });
        }
      }
      if (name === 'getProductsByLocation') {
        // Keep only the last location page: a complete page is the only one whose rows
        // can prove a product/unit total for the location the member asked about.
        locationFacts.length = 0;
        locationPageComplete = resultRecord?.hasMore === false;
      }
      if (name === 'getLowStockProducts') {
        // Keep only the last low-stock page. A business-wide page and a location-scoped
        // page are two different scopes, so appending both would count a product twice
        // and measure one page against the other page's total.
        lowStockFacts.length = 0;
        const total = Number(resultRecord?.count);
        lowStockTotal = Number.isFinite(total) && total >= 0 ? total : 0;
      }
      if (name === 'getInventory') {
        for (const raw of resultItems) {
          const fact = factFrom(raw);
          if (fact) inventoryFacts.push(fact);
        }
      } else if (name === 'getStockValue') {
        const top = Array.isArray(resultRecord?.topByValue) ? (resultRecord.topByValue as unknown[]) : [];
        for (const raw of top) {
          const fact = factFrom(raw);
          if (fact) productFacts.push(fact);
        }
        const total = resultRecord?.totalValue;
        const unpriced = resultRecord?.unpricedProducts;
        const totals = Array.isArray(resultRecord?.totalsByCurrency)
          ? (resultRecord.totalsByCurrency as Array<Record<string, unknown>>).map((entry) => ({
              currency: typeof entry.currency === 'string' ? entry.currency : null,
              totalValue: typeof entry.totalValue === 'number' ? entry.totalValue : null,
            }))
          : [];
        stockValueSummary = {
          totalValue: typeof total === 'number' && Number.isFinite(total) ? total : null,
          currency: typeof resultRecord?.currency === 'string' ? resultRecord.currency : null,
          mixedCurrency: resultRecord?.mixedCurrency === true,
          totalsByCurrency: totals,
          unpricedProducts: typeof unpriced === 'number' && Number.isFinite(unpriced) ? unpriced : 0,
        };
      } else if (
        name === 'findProducts' ||
        name === 'searchProducts' ||
        name === 'getLowStockProducts' ||
        name === 'getOutOfStockProducts' ||
        name === 'getProductsByLocation' ||
        name === 'getProductsNeverSold' ||
        name === 'getReorderNeededProducts'
      ) {
        if (name === 'getReorderNeededProducts') {
          // Same per-scope rule as the low-stock rows above: the last page and its total
          // are the only pair that describe the same read.
          reorderFacts.length = 0;
          const total = Number(resultRecord?.count);
          reorderTotal = Number.isFinite(total) && total >= 0 ? total : 0;
        }
        for (const raw of resultItems) {
          const fact = factFrom(raw);
          if (!fact) continue;
          productFacts.push(fact);
          if (name === 'getLowStockProducts') lowStockFacts.push(fact);
          if (name === 'getReorderNeededProducts') reorderFacts.push(fact);
          if (name === 'getProductsByLocation') locationFacts.push(fact);
        }
      }
      if (name === 'researchInventoryProducts' || name === 'researchMarketPrices') {
        const research = (output as { result?: unknown }).result;
        if (research && typeof research === 'object') {
          const result = research as { available?: unknown; sources?: unknown };
          if (result.available === true && Array.isArray(result.sources)) {
            for (const raw of result.sources) {
              if (!raw || typeof raw !== 'object') continue;
              const source = raw as { title?: unknown; url?: unknown };
              if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) continue;
              if (researchSources.some((existing) => existing.url === source.url)) continue;
              let title = typeof source.title === 'string' ? source.title.trim() : '';
              if (!title) {
                try {
                  title = new URL(source.url).hostname;
                } catch {
                  continue;
                }
              }
              researchSources.push({ title, url: source.url });
            }
          }
        }
      }
      // AI-13: cap the PAYLOAD the model reads, never the JSON text. A raw string cut
      // leaves invalid JSON, so the model would read a broken document instead of a
      // shortened one — and the tool result then says "truncated" in a way it can use.
      // The note rides INSIDE the result object when there is one, so a tool message stays
      // parseable JSON for every reader (tests, logs, a model that formats the result).
      const repeatNotice = repeated
        ? `This exact ${name} call already ran earlier in this turn and this is its current result. Do not call it again; answer with the data you have or make a different, narrower call.`
        : null;
      if (repeatNotice) {
        output =
          output && typeof output === 'object' && !Array.isArray(output)
            ? { ...(output as Record<string, unknown>), repeatNotice }
            : { result: output, repeatNotice };
      }
      const payload = capToolResult(output, cfg.maxToolResultChars);
      messages.push({
        role: 'tool',
        name,
        toolCallId: String(call?.id ?? `call-${i + 1}`),
        content: payload,
      });
    }
    // AI-74 — text streamed alongside a tool call is narration, not the answer: the next model
    // call writes the answer, so the draft is cleared instead of left above it.
    resetStreamedText('a tool round replaced the draft');
  }

  if (finalText === null) {
    // No answer after the loop's own exits: either the model kept returning nothing
    // or it spent every step on tool rounds. The two are different faults, so they
    // keep different reasons and different sentences.
    degraded = lastWasEmpty ? 'EMPTY_COMPLETION' : 'ITERATION_LIMIT';
    finalText = DEGRADED[degraded];
  }
  // Deterministic finalizers for the row-shaped answers the model is least reliable at:
  // a restock list, a low-stock subtotal, the maximum price, the highest stock value, the
  // top stock-out product, and a product-level range. They only use rows returned in this
  // turn; when the rows cannot support the answer they leave the model's text alone. A
  // computed low-stock answer is allowed to rescue an OUTPUT_LIMIT turn because the value
  // is already known from the rows.
  if (asksForLowStockValue(message)) {
    // A restock read also returns the low-stock rows. Treating only the dedicated
    // low-stock tool as evidence made the same rows answer PHP 72,460 instead of the
    // five-row subtotal, so use whichever complete set this turn actually read.
    const fromRestock = lowStockFacts.length === 0 && reorderFacts.length > 0;
    const lowStockRows = fromRestock ? reorderFacts : lowStockFacts;
    const lowStockRowsTotal = fromRestock ? reorderTotal : lowStockTotal;
    // A page shorter than the read's own count is partial: its subtotal cannot be called
    // the total of the low-stock set. Same rule as the restock list finalizer.
    const complete = lowStockRowsTotal <= 0 || lowStockRows.length >= lowStockRowsTotal;
    const computed = lowStockValueAnswer(lowStockRows, cfg.maxMessageChars, { complete });
    if (computed) {
      finalText = computed;
      degraded = null;
      console.warn('[ai] low-stock value computed from the returned rows');
    }
  }
  if (!degraded && locationPageComplete && asksForLocationTotals(message)) {
    const computed = locationTotalsAnswer(locationFacts, message, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] location product/unit total computed from the complete page');
    }
  }
  if (!degraded && asksForProductStockByLocation(message)) {
    const computed = productStockByLocationAnswer(inventoryFacts, message, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] product stock by location computed from the returned rows');
    }
  }
  if (!degraded && stockOutMovements !== null && asksForStockOutCount(message)) {
    const computed = stockOutCountAnswer(stockOutMovements, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] stock-out movement count read from the ledger totals');
    }
  }
  if (!degraded && asksForProductsUnderPrice(message)) {
    const computed = productsUnderPriceAnswer(productFacts, message, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] price-threshold products computed from the returned rows');
    }
  }
  if (!degraded && asksForMostExpensive(message)) {
    const computed = mostExpensiveProductAnswer(productFacts, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] maximum recorded price computed from the returned rows');
    }
  }
  if (!degraded && asksForHighestStockValue(message)) {
    const computed = highestStockValueAnswer(
      productFacts,
      cfg.maxMessageChars,
      asksForTotalStockValue(message) ? (stockValueSummary ?? undefined) : undefined,
    );
    if (computed) {
      finalText = computed;
      console.warn('[ai] highest stock value computed from the returned rows');
    }
  }
  if (!degraded && asksForTopOut(message)) {
    const computed = topOutAnswer(historyTopOutFacts, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] top stock-out product computed from the returned rows');
    }
  }
  if (!degraded && asksForBrandStockRange(message)) {
    const rangeRows = productFacts.length > 0 ? productFacts : inventoryFacts;
    const computed = brandStockRangeAnswer(rangeRows, message, cfg.maxMessageChars);
    if (computed) {
      finalText = computed;
      console.warn('[ai] product-level stock range computed from the returned rows');
    }
  }
  if (!degraded && asksForRestockList(message)) {
    // The restock tool is the direct answer (it flags each row), but a plain "what is low on
    // stock" turn reads getLowStockProducts instead. Use whichever rows this turn actually
    // returned, together with that read's own total.
    const fromRestock = reorderFacts.length > 0;
    const rows = fromRestock ? reorderFacts : lowStockFacts;
    const total = fromRestock ? reorderTotal : lowStockTotal;
    const count = total > 0 ? total : rows.length;
    // `page()` counts every product the filters matched, so a shorter row set is a partial
    // page. Naming those rows "the full list" would be the false-completeness failure this
    // finalizer exists to prevent, so a partial page is left to the model and its total.
    const complete = rows.length >= count;
    let completed = finalText;
    if (fromRestock && asksForThreeRestockNames(message)) {
      const exact = restockThreeAnswer(rows, count, cfg.maxMessageChars);
      if (exact) {
        completed = exact;
        console.warn('[ai] exact restock names taken from the returned rows');
      }
    }
    completed = withCompleteRestockNames(completed, rows, cfg.maxMessageChars, {
      label: fromRestock ? 'restock' : 'low-stock',
      complete,
    });
    if (rows.length > 0) {
      completed = completed
        .replace(/\b\d+\s+products? need restocking\b/i, `${count} products need restocking`)
        .replace(
          /\b\d+\s+(?:products?|items?)\s+(?:are\s+)?(?:low(?:\s+on)?\s+stock|running low)\b/i,
          `${count} ${count === 1 ? 'product is' : 'products are'} low on stock`,
        );
    }
    if (completed !== finalText) {
      finalText = completed;
      console.warn('[ai] restock answer completed from the returned rows');
    }
  }
  if (degraded) {
    // AI-2 — the first time a degraded turn is visible anywhere. Before this, a turn
    // that produced no usable answer returned HTTP 201 and left NO trace, so the
    // failure rate could not be measured, let alone fixed. One line, so it is
    // greppable and countable: `grep -c 'degraded turn'`.
    console.warn(
      `[ai] degraded turn reason=${degraded} attempts=${steps} empty=${emptyResponses}` +
        ` trimmed=${trimmedChars}` +
        ` model=${model ?? 'unknown'} tools=${[...toolsUsed].join(',') || 'none'}`,
    );
  }
  // The healthy path's report, and the last of the six: a turn that answered, or
  // one that degraded into a canned sentence (which keeps its own AI-2 warning
  // above, so a degraded turn stays countable exactly as it was).
  reportTurn(degraded ? 'degraded' : 'ok');
  // AI-75 — a reversed stock range is a wording defect, not a fact the member should have to
  // untangle. The prompt asks for the true minimum and maximum; this guard makes any slip
  // read in ascending order before the answer is stored or replayed.
  // AI-77 — a stock-range answer must not volunteer a low-stock section the member did not
  // ask for. The measured Samsung answer named 242- and 307-unit rows as low while only the
  // two 0-unit rows were at or below their minimums. Removing the unrequested section is
  // safer than rewriting its count, because the rows it named were not the low ones.
  finalText = stripUnrequestedLowStockTail(finalText, message);
  // AI-75 — a reversed stock range is a wording defect, not a fact the member should have to
  // untangle. The prompt asks for the true minimum and maximum; this guard makes any slip
  // read in ascending order before the answer is stored or replayed.
  finalText = normaliseReversedQuantityRange(finalText);
  // AI-93/AI-94 — deterministic cleanup for two measured process/evidence claims. Both
  // run only on a grounded answer and only change text when the forbidden claim is present.
  if (!degraded && toolsUsed.size > 0) {
    const cleaned = replaceFalseToolClaims(finalText);
    if (cleaned !== finalText) {
      console.warn('[ai] removed a false no-tool claim from a grounded answer');
      finalText = cleaned;
    }
  }
  if (!degraded && !toolsUsed.has('getInventoryHistory')) {
    const cleaned = stripUnsupportedSalesClaims(finalText);
    if (cleaned !== finalText) {
      console.warn('[ai] removed a sales-ranking claim without a sales read');
      finalText = cleaned;
    }
  }
  // AI-76 — a brand-list answer must name every brand its own tool returned.
  if (!degraded && brandRows.length > 0 && asksForBrandList(message)) {
    const names = brandRows.map((row) => row.brand);
    const completed = withCompleteBrandList(finalText, names, cfg.maxMessageChars);
    if (completed !== finalText) {
      if (asksForBrandListOnly(message)) {
        console.warn('[ai] brand-list answer omitted a returned brand — replacing with the complete list');
        finalText = canonicalBrandListAnswer(brandRows, cfg.maxMessageChars);
      } else {
        console.warn('[ai] brand-list answer omitted a returned brand — complete list appended');
        finalText = completed;
      }
    }
  }
  finalText = truncate(finalText, cfg.maxMessageChars);
  if (!degraded && researchSources.length > 0) {
    finalText = appendMissingSourceUrls(finalText, researchSources);
  }
  // AI-74 — the screen must never keep a version the server replaced.
  //
  // Deltas are written as the model speaks, but the stored answer is a different string: a
  // status constant is humanised, markup is normalised, a false place label is relabelled, a
  // revenue qualifier is appended, a cut-off unit is trimmed, or the whole draft is replaced by
  // the honest sentence after the re-asks are spent. Until `done` arrived the member could read
  // that replaced version (measured 2026-11-05 7:32 PM: half a minute of a draft the server had
  // already thrown away). The reset clears what was shown, then the stored text is replayed so
  // the bubble holds the answer rather than waiting on a blank bubble for the `done` frame.
  if (onTextDelta) {
    if (displayedText && displayedText !== finalText && onTextReset) {
      resetStreamedText('the answer changed after it was streamed');
      emitText(finalText);
    } else if (finalText.length > displayedText.length && finalText.startsWith(displayedText)) {
      // Nothing was replaced — the server only added text after the model stopped (source URLs),
      // so the addition is sent instead of the whole answer again.
      emitText(finalText.slice(displayedText.length));
    }
  }

  return {
    content: finalText,
    model: model ?? undefined,
    toolsUsed: [...toolsUsed],
    usage: usage ?? undefined,
    iterations: steps,
    degraded: degraded ?? undefined,
  };
}

export const aiService = { runAiChat, systemPrompt };

export default aiService;
