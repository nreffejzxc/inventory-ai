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

import { trimIncompleteAnswer, humaniseStatusConstants } from './answerCompletion.ts';
import { aiConfig } from './aiConfig.ts';
import {
  AiAbandoned,
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
import { executeTool, AI_TOOL_DEFS } from './tools.ts';
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
   * The member's IANA time zone, as reported by the client. Untrusted and
   * display-only: it changes the dates the model is told and the `localTime`
   * on tool rows, and it never participates in an authorization decision.
   * Absent or unusable values fall back to UTC (`resolveTimeZone`).
   */
  timeZone?: string;
}

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
type CannedReason = 'EMPTY_COMPLETION' | 'ITERATION_LIMIT';

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
  { timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {},
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
    '9. When the member names a location, pass its exact name to a tool that accepts one (getInventory, getProductsByLocation and getInventoryHistory do). When the member names a category, pass its exact name to searchProducts or getReorderNeededProducts, which accept one. Pass the name straight through — do NOT call listLocations or listCategories first to confirm it exists; the tool answers a name it cannot match with the name it needs, and only then is a lookup useful. Never guess an id.',
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
  timeZone: requestedTimeZone,
}: ChatParams): Promise<ChatResult> {
  const cfg = aiConfig();
  // Resolved once per turn: the prompt and every tool row in this turn must use
  // the same zone, and a turn's 60 s budget cannot span enough time to matter.
  const timeZone = resolveTimeZone(requestedTimeZone);
  const prompt = systemPrompt({ timeZone });
  const provider = selectProvider();

  const messages: ProviderMessage[] = history
    .slice(-cfg.contextMessages)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  messages.push({ role: 'user', content: message });

  let finalText: string | null = null;
  const toolsUsed = new Set<string>();
  // AI-28 — seeded from the provider's CONFIGURED model, so a turn whose every call failed still
  // names what it was trying. Before this, a provider-side 404 (a withdrawn or broken model,
  // 2026-10-21) produced `model=unknown` on the one line an operator reads to find out which model
  // to change. A successful response still overwrites this with the model the provider reported.
  let model: string | null = provider.model ?? null;
  let usage: ProviderUsage | null = null;
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
  const emitText = (text: string): void => {
    if (!onTextDelta || !text) return;
    emittedChars += text.length;
    onTextDelta(text);
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
        ` in=${usage?.inputTokens ?? 0} out=${usage?.outputTokens ?? 0}` +
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
   * The full ordered chain this turn may use: the primary first, then the operator's
   * candidates, de-duplicated. Two exclusions, both paid for already: a candidate that is
   * the primary (the same refusal spent twice) and one the provider's catalogue says cannot
   * call tools (it would answer an inventory question without reading the inventory). The
   * PRIMARY is never excluded for tool support — it is what the deployment chose, and a
   * catalogue read must not become a configuration veto.
   *
   * Excluded ids are named on ONE line per turn rather than left silent, because a candidate
   * that is never used is exactly the kind of configuration mistake nobody notices until the
   * day it is needed.
   */
  const orderedChain: string[] = (() => {
    const primaryIds = new Set([provider.model, cfg.openrouterModel].filter((id): id is string => Boolean(id)));
    const out: string[] = [];
    const seen = new Set<string>();
    const skipped: string[] = [];
    for (const [index, id] of [primaryModel, ...cfg.fallbackModels].entries()) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const isPrimarySlot = index === 0;
      // A candidate that IS the configured model is the same refusal spent twice, whichever
      // of its two names (`provider.model` or the environment's id) it was written as.
      if (!isPrimarySlot && primaryIds.has(id)) continue;
      if (!isPrimarySlot && declaresToolSupport(id) === false) {
        skipped.push(id);
        continue;
      }
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
  const configuredActive = activeModel(primaryModel);
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
  const callProvider = async (attemptCapMs = 0): Promise<ProviderResponse> => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new AiTimeout();
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
          tools: AI_TOOL_DEFS as ToolDefinition[],
          timeoutMs: budget,
          signal,
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

  const completeWithFailover = async (): Promise<ProviderResponse> => {
    const attempted = currentModel ?? primaryModel;
    // The first attempt gets a slice only when there is a candidate behind it (AI-38).
    const attemptCap = cfg.attemptMaxMs > 0 && walkRemaining.length > 0 ? cfg.attemptMaxMs : 0;
    try {
      const response = await callProvider(attemptCap);
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
      if (attempted && (isModelAvailabilityFailure(err) || timedOut)) {
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
          const response = await callProvider(candidateCap);
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

  for (let i = 0; i < cfg.maxToolIterations; i += 1) {
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
    let response: ProviderResponse;
    try {
      response = await completeWithFailover();
    } catch (err) {
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
        if (spent.usage) usage = spent.usage;
        reportTurn((err as { code?: string }).code ?? 'AI_ERROR');
        throw err;
      }
      console.error('[ai] provider call failed', (err as { message?: unknown })?.message ?? err);
      reportTurn('AI_UNAVAILABLE');
      throw new AiProviderError('The AI service failed unexpectedly. Please try again.');
    }

    model = response?.model || model;
    usage = response?.usage || usage;
    const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];

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
        finalText = humaniseStatusConstants(text);
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

    messages.push({
      role: 'assistant',
      content: String(response?.text ?? ''),
      toolCalls: calls.map((call, i) => ({
        id: String(call?.id ?? `call-${i + 1}`),
        name: String(call?.name ?? ''),
        input: call?.input,
      })),
    });

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const name = String(call?.name ?? '');
      if (name) toolsUsed.add(name);
      const toolStartedAt = Date.now();
      const countTool = (): void => {
        toolMs += Date.now() - toolStartedAt;
        toolRuns += 1;
      };
      let output: unknown;
      try {
        output = await executeTool(name, call?.input, { businessId, userId, role, timeZone });
      } catch (err) {
        // The one exit none of the explicit sites covers: a tool that THROWS
        // rather than returning an error result. It reports and rethrows, so a
        // future failure mode cannot become a silent gap in the log — and it counts
        // the attempt before reporting, for the same reason the provider call does.
        countTool();
        reportTurn('ERROR');
        throw err;
      }
      countTool();
      // AI-13: cap the PAYLOAD the model reads, never the JSON text. A raw string cut
      // leaves invalid JSON, so the model would read a broken document instead of a
      // shortened one — and the tool result then says "truncated" in a way it can use.
      const payload = capToolResult(output, cfg.maxToolResultChars);
      messages.push({
        role: 'tool',
        name,
        toolCallId: String(call?.id ?? `call-${i + 1}`),
        content: payload,
      });
    }
  }

  if (finalText === null) {
    // No answer after the loop's own exits: either the model kept returning nothing
    // or it spent every step on tool rounds. The two are different faults, so they
    // keep different reasons and different sentences.
    degraded = lastWasEmpty ? 'EMPTY_COMPLETION' : 'ITERATION_LIMIT';
    finalText = DEGRADED[degraded];
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
  finalText = truncate(finalText, cfg.maxMessageChars);

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
