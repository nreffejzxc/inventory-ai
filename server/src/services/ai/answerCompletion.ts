/**
 * AI-26 — an answer that hit the output cap must not end mid-word or mid-row.
 *
 * THE DEFECT. `AI_MAX_OUTPUT_TOKENS` bounds a turn, and when the model reaches it the
 * provider says so (`stop_reason: max_tokens` → `truncated: true`). AI-8 kept that partial
 * answer and marked the turn `OUTPUT_LIMIT`, which is right — the first rows ARE what was
 * asked for — but the text stored and drawn was the model's raw prefix. Read out of the
 * development database on 2026-10-19, all four stored `OUTPUT_LIMIT` answers ended inside
 * a Markdown table cell:
 *
 *     … | Professional Battery 10051 |      ("| 6ad49" — a cut id)
 *     … | 2026‑10‑18 01:48:51 | Professional Towel 1   (no closing pipe)
 *     … | Pro Cable 19871 |                (one cell under a four-column header)
 *
 * The bubble then rendered a row with a name and no quantities, or a name cut in half,
 * with the "may be incomplete" note underneath. The note explains the truncation; it does
 * not make a half-row readable. A member reading "Professional Towel 1" cannot tell whether
 * the product is called that or whether the name was cut.
 *
 * WHAT THIS DOES, AND WHY IT IS DETERMINISTIC RATHER THAN ANOTHER MODEL CALL. The turn has
 * already spent its output budget; asking the model to continue costs another provider
 * request (the free tier allows ~50 a day, measured on 2026-10-19), can duplicate the last
 * sentence, and cannot be bounded by the turn's remaining deadline. Removing the ONE
 * incomplete unit at the end is a string operation with no quota, no latency and a result
 * that can be asserted exactly: a complete table row is kept, an incomplete one is dropped,
 * and prose is cut back to its last finished sentence. Nothing in the middle of the answer
 * is touched, and nothing is invented.
 *
 * THE SAFETY RULE. When no complete unit can be identified the text is returned unchanged.
 * Dropping text is only justified when what remains is demonstrably whole; guessing would
 * silently delete a correct answer, which is worse than a visibly cut one — the member at
 * least sees the note in that case.
 */

/** A line that is part of a Markdown table row (leading pipe). */
function isRowStart(line: string): boolean {
  return /^\s*\|/.test(line);
}

/** The separator row between a header and its body: `|---|---|`. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
}

/**
 * Cells in a row, counting only the ones the pipes delimit.
 *
 * A row must both start and end with a pipe to be complete: `| Pro Cable 19871 |` is two
 * cells (an empty first and last are how a table is written, so the count is
 * `pipes - 1`), while `| Professional Towel 1` has no closing pipe at all and is a row the
 * model never finished.
 */
function cellCount(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return null;
  return trimmed.split('|').length - 2;
}

function lastNonEmpty(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? '').trim()) return i;
  }
  return -1;
}

/**
 * The number of columns the table ending at `end` declares.
 *
 * Taken from the FIRST row of the contiguous block, because that is where the header is;
 * the separator row is skipped when it is the first thing found. `null` when the block has
 * no complete row to measure against, in which case a trailing partial row cannot be
 * judged and is left alone.
 */
function tableColumns(lines: string[], end: number): number | null {
  let start = end;
  while (start - 1 >= 0 && isRowStart(lines[start - 1] ?? '')) start -= 1;
  for (let i = start; i <= end; i += 1) {
    const line = lines[i] ?? '';
    if (isSeparatorRow(line)) continue;
    const cells = cellCount(line);
    if (cells !== null) return cells;
  }
  return null;
}

/** Drop the trailing table rows that are not whole rows, mutating `lines` in place. */
function trimTrailingRows(lines: string[]): void {
  let last = lastNonEmpty(lines);
  while (last >= 0 && isRowStart(lines[last] ?? '')) {
    const cells = cellCount(lines[last] ?? '');
    const expected = tableColumns(lines, last);
    const incomplete = cells === null || (expected !== null && cells < expected);
    if (!incomplete) break;
    lines[last] = '';
    last = lastNonEmpty(lines);
  }
  // A table left with only its header (or header + separator) says nothing: a heading with
  // no rows is a promise the truncation broke, so remove the stub too.
  last = lastNonEmpty(lines);
  if (last >= 0) {
    let start = last;
    while (start - 1 >= 0 && isRowStart(lines[start - 1] ?? '')) start -= 1;
    const rows = lines.slice(start, last + 1).filter((line) => line.trim() && !isSeparatorRow(line));
    if (rows.length <= 1 && isRowStart(lines[last] ?? '')) {
      for (let i = start; i <= last; i += 1) lines[i] = '';
    }
  }
}

/** Closing marks that may follow a terminator and still leave the sentence finished. */
const CLOSERS = new Set([')', ']', '"', "'", '*', '_', '`']);

/** Is this character a sentence terminator, rather than part of a number or an initial? */
function endsSentence(text: string, index: number): boolean {
  const ch = text[index];
  if (ch !== '.' && ch !== '!' && ch !== '?') return false;
  const prev = text[index - 1] ?? '';
  // A decimal point (`6.09`) and a thousands separator (`8,976.5`) are inside a number.
  if (/[0-9]/.test(prev) && /[0-9]/.test(text[index + 1] ?? '')) return false;
  // The terminator may be followed by closing punctuation/markdown and must then be at a
  // word boundary. `app.)*` ends a sentence; `v1.2` and `SKU.59980` do not.
  let next = index + 1;
  while (next < text.length) {
    const closing = text[next];
    if (closing === undefined || !CLOSERS.has(closing)) break;
    next += 1;
  }
  if (next < text.length && !/\s/.test(text[next] ?? '')) return false;
  return true;
}

/**
 * A list item, whose last line is left alone rather than cut.
 *
 * A list item carries no full stop, so a complete item and a cut one look alike at the end
 * of the string: `5. **Professional Mug 60936** – SKU SEEDSKU‑59936 – 0 units available` is
 * whole, while `5. **Professional Mug 60936** – SKU SEEDSKU‑59` is not, and no cheap test
 * separates them. Removing a complete item to rescue a cut one trades a visible truncation
 * for silently missing data, so the note — which is already drawn — is the honest answer
 * here. Tables are the measured case and are handled above.
 */
function isListItem(line: string): boolean {
  return /^\s*(\d+[.)]|[-*+])\s+/.test(line);
}

/**
 * Return `raw` without the one incomplete unit at its end, or unchanged if it already ends
 * cleanly (or if nothing whole can be identified).
 *
 * Kept pure and exported so both the reason it exists and its edge cases can be asserted
 * without a provider, a database or a key.
 */
/**
 * The stored status constants, in a member's words.
 *
 * Read off the device on 2026-10-19: a complete restock answer drew a table whose
 * Status column read `OUT_OF_STOCK` — the tool payload's enum copied straight onto the
 * screen. The prompt now forbids it (rule 14), but a prompt is a request, not a
 * guarantee: the model may still copy the value it was given, and the member sees
 * server vocabulary in their own answer. This is the deterministic half — the same
 * reason the trim above exists rather than a second model call.
 *
 * The match is word-bounded, so a longer token (`OUT_OF_STOCKED`) and an identifier
 * that merely contains a status (`LOW_STOCK_PRODUCTS`) are left alone rather than
 * half-rewritten.
 */
const STATUS_PHRASES: Record<string, string> = {
  OUT_OF_STOCK: 'Out of stock',
  LOW_STOCK: 'Low stock',
  IN_STOCK: 'In stock',
  // AI-62 — the movement types, measured on the device the same day: "538 STOCK_OUT events".
  // The words are the app's own TypeBadge labels, so the answer and the History screen agree.
  STOCK_IN: 'Stock in',
  STOCK_OUT: 'Stock out',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Transfer',
};

/**
 * AI-56 — the model's own markup, taken off the screen.
 *
 * Read off the phone on 2026-11-04: an answer comparing the ROG Strix G16's recorded price
 * with marketplace listings drew "(search-snippet) <br>• PC Express: ₱205,995" inside a table
 * cell, with the long product URLs wrapped three characters wide beside it. The chat bubble
 * renders markdown but not HTML, so `<br>` reached the member as literal characters — the
 * same class of defect as an unrendered status constant, and just as invisible to a text
 * assertion in the provider tests.
 *
 * The prompt forbids HTML (rule 26), but a prompt is a request: this is the deterministic
 * half that guarantees the member never reads a tag. `<br>` becomes a line break, every
 * other complete HTML tag is dropped, and the five character references a model actually
 * emits are decoded. A bare `<` stays untouched, since it is usually a comparison.
 */
const HTML_BREAK = /<br\s*\/?>/gi;
const HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi;
const HTML_ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/g, "'"],
  [/&amp;/gi, '&'],
];

export function normaliseAnswerMarkup(raw: string): string {
  if (!raw || !raw.includes('<')) {
    return HTML_ENTITIES.reduce((text, [pattern, value]) => text.replace(pattern, value), raw);
  }
  const broken = raw.replace(HTML_BREAK, '\n').replace(HTML_TAG, '');
  const decoded = HTML_ENTITIES.reduce((text, [pattern, value]) => text.replace(pattern, value), broken);
  // A dropped tag leaves its line's padding behind (`  \n`), which renders as a blank gap.
  return decoded.replace(/[ \t]+$/gm, '');
}

export function humaniseStatusConstants(raw: string): string {
  if (!raw) return raw;
  return raw.replace(/\b(OUT_OF_STOCK|LOW_STOCK|IN_STOCK|STOCK_IN|STOCK_OUT|ADJUSTMENT|TRANSFER)\b/g, (token) => STATUS_PHRASES[token] ?? token);
}

/**
 * AI-60 — does this answer state a figure that can only have come from recorded data?
 *
 * Used by the turn loop to decide whether an answer that ran NO tool should be sent back to
 * read one. It is a *detector*, not a validator: it says "this text makes a claim about the
 * business", which is exactly the case where a zero-tool answer cannot be trusted. It does not
 * try to check the figure itself, because a formatted total legitimately differs from a tool
 * payload (rounding, thousands separators, `PHP` versus `₱`, 12 versus 12.00).
 *
 * Money and quantity claims it catches:
 *  - a currency code in front of a digit (`PHP 383,426`, `USD 45`, `php139995`);
 *  - a currency symbol in front of a digit (`₱1,299`, `$45.00`) — the one the members use; plus
 *    a trailing peso marker, which is how some answers write it (`1,299 ₱`);
 *  - a thousands-grouped number anywhere (`383,426`, `1,299.00`), since a raw count that large
 *    is a total too, and a model inventing inventory figures writes one of these three;
 *  - AI-62 — a count of a business thing: a number in front of an inventory noun or a stock
 *    phrase (`2 units available`, `minimum 5`, `3 products`, `14 on hand`), a reorder
 *    threshold (`minimum 5`, `reorder point: 3`), or a markdown table row carrying digits.
 *    Added after a device turn (2026-11-05 5:13 PM, calls=1 toolRuns=0) answered *"What is
 *    running low at the Front Counter right now"* with an invented "Product A – 2 units
 *    available, minimum 5 … Product C", and none of the three money shapes matched, so the
 *    fabricated shelf passed the AI-60 guard untouched.
 *
 * Deliberately NOT matched: bare numbers with no unit or stock noun (`3`, `2 low`, `2026`),
 * because those appear in ordinary prose ("I can see 3 tools"), and a false positive costs a
 * whole re-ask round. A number that names a business noun is a claim about the business, so
 * a tool has to have produced it.
 */
const CURRENCY_CODE_AMOUNT = /\b(?:PHP|USD|EUR|GBP|JPY|AUD|CAD|SGD|HKD|INR|NZD|AED|MYR|THB|IDR|VND|KRW|CNY|CHF|SEK|NOK|DKK|BRL|MXN|ZAR)\s?\d/i;
const CURRENCY_SYMBOL_AMOUNT = /(?:₱|\$|€|£|¥)\s?\d|\d\s?(?:₱|€|£|¥)/;
const GROUPED_NUMBER = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/;
// AI-62 — the nouns a stock answer counts. Kept to business things the tools actually return,
// so "I can check 3 things for you" (no noun) still passes through untouched. Up to two
// qualifier words are allowed between the figure and its noun, because a measured answer wrote
// "538 stock-out movements" and a bare noun match would have read that as a quantity of
// movements with no number attached.
const COUNTED_NOUN =
  /\b\d+(?:\.\d+)?(?:\s+[\w'-]+){0,2}\s+(?:units?|items?|pcs\.?|pieces?|boxes|box|packs?|sets?|pairs?|orders?|sales|products?|skus?|variants?|locations?|suppliers?|categories?|shelves|shelf|transactions?|movements?|events?|transfers?|receipts?|shipments?|in stock|on hand)\b/i;
const REORDER_THRESHOLD = /\b(?:minimum|min\.?|reorder point|reorder level|reorder quantity|threshold|par level)\s*[:=]?\s*\d/i;
// AI-66 — an absence claim is a data claim, and it was the one shape with no digits in it.
//
// Measured on the phone 2026-11-05 5:50 PM: *"What moved out of the Store Room recently"*
// was answered a second time with no tool run at all (`toolRuns=0`) as "No stock-out
// movements were recorded for the Store Room in the last 7 days (2026-10-29 to 2026-11-05) …
// zero events for that location and period" — the answer of the PREVIOUS turn, replayed from
// the conversation. Every number in it was spelled or a date, so neither the currency nor the
// counted-noun pattern fired and the guard never ran. "No movements", "zero events" and
// "nothing came in" are exactly as much a read of the ledger as "538 movements" is.
const WORDED_ABSENCE =
  /\b(?:no|zero|none|not\s+a\s+single)\b(?:\s+[\w'-]+){0,3}\s+(?:units?|items?|sales?|movements?|events?|transactions?|transfers?|receipts?|deliver(?:y|ies)|products?|stock-?outs?|stock-?ins?)\b/i;
// A markdown table row with a digit in it is a data table: a no-tool run cannot have built one.
const NUMERIC_TABLE_ROW = /^\s*\|[^\n]*\|[^\n]*\d/m;

/**
 * AI-63 — is this a question about what the business has recorded?
 *
 * The companion to `statesRecordedFigure` above, and the same measured failure: on the device
 * (2026-11-05 5:19 PM) *"How many units did we sell this week"* was answered in 2.0 s with
 * `calls=1 toolRuns=0` — "538 stock-out movements across the business" — where the trail held
 * 7 movements and 13 units. That answer dodged the figure detector (no currency, no grouped
 * number, the count sat in front of a *qualified* noun), so the detector alone is one phrasing
 * behind the model every time.
 *
 * This asks the other half of the question instead: a member who asks about recorded stock,
 * sales or movements cannot be answered without reading them. When such a question runs NO tool,
 * the turn loop re-asks once. The vocabulary is deliberately narrow — the words inventory
 * members actually use — and an app/how-to question is excluded first, because "how do I record
 * a sale?" is answered from knowledge, not from the ledger, and re-asking it would cost a round
 * for nothing.
 */
// AI-75 — "brands" and "products" are data nouns too: on 2026-11-05 10:00 PM *"Do you carry
// Samsung products?"* was answered "No" with `toolRuns=0`, while nine Samsung products were
// ACTIVE in the same business. The brand tool was never called, so the previous answer's
// incomplete brand list became the truth.
const DATA_NOUN =
  /\b(?:stocks?|inventory|units?|items?|brands?|products?|headsets?|headphones?|earbuds?|keyboards?|mice|mouse|monitors?|webcams?|cameras?|ssds?|hard drives?|power banks?|speakers?|microphones?|controllers?|docks?|docking stations?|routers?|printers?|laptops?|tablets?|phones?|cables?|chargers?|accessories|peripherals|storage|compare|recommend(?:ation)?|sales?|sold|selling|revenue|worth|value|valued|prices?|priced|costs?|low|shortage|reorder|restock|movements?|moved|moving|transfers?|transferred|received|deliver(?:y|ies)|purchase orders?|suppliers?|categories|locations?|on hand|history|where (?:is|are|was|were)|(?:came|come|coming) (?:in|into)|arrived|(?:went|go|gone|going) out|(?:left|leaving))\b/i;
const HOW_TO_QUESTION =
  /\b(?:how (?:do|can|does|should|would) (?:i|we|you)|how to|where (?:do|can|should) (?:i|we)|what (?:can|do) you (?:do|help)|who are you|what are you|explain|meaning of|difference between)\b/i;
// "Where is the Stock In screen?" names a data noun but asks about the app, so a screen or
// control word wins: those answers come from knowledge, not from the ledger.
const APP_SURFACE =
  /\b(?:screen|button|tab|menu|form|field|settings?|dashboard|notification|app)\b/i;

export function asksForRecordedData(question: string): boolean {
  const text = String(question ?? '').trim();
  if (!text) return false;
  if (HOW_TO_QUESTION.test(text) || APP_SURFACE.test(text)) return false;
  return DATA_NOUN.test(text);
}

// AI-81 — the last-resort degradation is for an OPINION about the catalogue, not for every
// data question. A recommendation must not be invented without a read, but a partial answer
// to an output-limit or a simple healthy turn must survive; those are separate behaviours.
const PRODUCT_ADVICE =
  /\b(?:recommend(?:ation)?|best|better|which (?:one|.*?\s)?should|should (?:i|we) (?:buy|get|choose)|compare|comparison|versus|vs\.?)\b/i;

export function asksForProductAdvice(question: string): boolean {
  const text = String(question ?? '').trim();
  if (!text || !DATA_NOUN.test(text)) return false;
  return PRODUCT_ADVICE.test(text);
}

/**
 * AI-64 — is this text a plan to read something rather than an answer?
 *
 * Measured on the device 2026-11-05 5:29 PM: after the recorded-data guard asked for real data,
 * *"What moved out of the Store Room recently"* came back as a narration shown to the member as
 * the final answer — "I'll call getInventoryHistory with the location set to \"Store Room\" …
 * [awaiting tool response]" — with `toolRuns=0`. No tool ran, and the placeholder the model was
 * talking to itself with was rendered on the phone.
 *
 * Two shapes are a plan and cannot be an answer:
 *  - a bracketed placeholder the model writes while "waiting" (`[awaiting tool response]`);
 *  - a promise to call a tool, where the answer also names one, which the prompt forbids
 *    (`I'll call getInventoryHistory …`). Naming a tool at all is the tell: the member's
 *    vocabulary never includes `getInventoryHistory`, so only the model's own plan does.
 *
 * A bare "Let me check the records — the G304 has 3 left" is NOT matched: it has content and no
 * tool name, and a quantity claim is already caught by the detector above.
 */
const CALL_PLACEHOLDER = /\[[^\]\n]{0,60}\b(?:awaiting|pending|tool|response|executing|running)\b[^\]\n]{0,60}\]/i;
const ANNOUNCES_CALL = /\b(?:i'll|i will|i'm going to|i am going to|let me)\b[^\n]{0,40}\b(?:call|run|use|query|fetch|pull|look up|retrieve|invoke)\b/i;
const TOOL_NAME = /\b(?:get|list|search|resolve|find)[A-Z][A-Za-z]{2,}\b/;

export function looksUnanswered(raw: string): boolean {
  if (!raw) return false;
  if (CALL_PLACEHOLDER.test(raw)) return true;
  return ANNOUNCES_CALL.test(raw) && TOOL_NAME.test(raw);
}

/**
 * AI-75 — is this reply a model failure notice rather than an answer?
 *
 * Measured on the phone 2026-11-05 9:50 PM: *"Which gaming headset do you recommend and what
 * brands do you carry"* was answered, after one search, with the literal text
 * "[ERROR: Max turns exceeded]" — the turn had not hit any limit (3 of 6 steps used), so the
 * model invented the notice and the server stored and displayed it as the answer.
 *
 * Only a whole reply that is an error/limit notice is matched, and only when short: a real
 * answer may contain the word "error" ("Error rates are not recorded") and must pass through.
 */
const FAILURE_NOTICE = /^\s*\[?\s*(?:error|failure)\s*:[^\]\n]*\]?\s*$/i;
const TURN_LIMIT_NOTICE =
  /\b(?:max(?:imum)?|too many)\s+(?:turns?|steps?|iterations?|tool calls?)\b[^.\n]{0,40}\b(?:exceeded|reached|used|allowed)\b|\bmax(?:imum)?\s+(?:turn|step|iteration)\s+limit\b/i;

export function looksLikeFailureNotice(raw: string): boolean {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 240) return false;
  return FAILURE_NOTICE.test(text) || TURN_LIMIT_NOTICE.test(text);
}

export function statesRecordedFigure(raw: string): boolean {
  if (!raw) return false;
  return (
    CURRENCY_CODE_AMOUNT.test(raw) ||
    CURRENCY_SYMBOL_AMOUNT.test(raw) ||
    GROUPED_NUMBER.test(raw) ||
    COUNTED_NOUN.test(raw) ||
    WORDED_ABSENCE.test(raw) ||
    REORDER_THRESHOLD.test(raw) ||
    NUMERIC_TABLE_ROW.test(raw)
  );
}

/**
 * AI-67 — does the answer claim that SOMEWHERE ELSE has none?
 *
 * Measured on the phone 2026-11-05 5:58 PM: *"Where are the G304s"* called `getInventory`
 * once, which returned the first 15 of 17 rows (`hasMore: true`), and answered "at the Front
 * Counter with 6 units … No other location shows stock for this product." The Store Room was
 * holding 25 of them, in the two rows the page cut off. The word "no" in that sentence is a
 * claim about rows the model never read, so the shape is worth naming: it is only a lie when
 * the read was partial, which the turn loop knows from `hasMore` and this predicate does not.
 */
const CLAIMS_EMPTY_ELSEWHERE =
  /\b(?:no other (?:location|place|store|shop|warehouse|branch)s? (?:has|have|holds?|shows?|carries|stocks?|is stocked|keeps?)|nowhere else|only (?:at|in) (?:the|one)|not (?:stocked|held|available|sold) (?:at|in) (?:any )?(?:other|another))\b/i;

export function claimsEmptyElsewhere(raw: string): boolean {
  if (!raw) return false;
  return CLAIMS_EMPTY_ELSEWHERE.test(raw);
}

/**
 * AI-69 — does the answer stop at "the window was empty"?
 *
 * Measured on the phone 2026-11-05 6:08 PM: *"Which products sold the most this week"* ran
 * `getInventoryHistory`, which returned an empty window WITH the last real movements in
 * `mostRecentIgnoringType` and a note saying to name them — and the answer still ended at
 * "The history window is empty for that location and period, so there is nothing to report".
 * A page-window answer is only honest when it also says what did happen, so the turn loop
 * re-asks when the result carried earlier movements and the text does not name any of them.
 */
const CLAIMS_EMPTY_RESULT =
  /\b(?:window|period|range|history)\b[^.\n]{0,30}\b(?:is|was|stays?|remains?)\s+empty\b|\bnothing (?:to report|matched|moved|sold|left|was recorded|has (?:moved|sold|been recorded))\b|\bno (?:stock-?outs?|stock-?ins?|movements?|sales?|transactions?)\b[^.\n]{0,30}\b(?:were|was|have been|has been) recorded\b/i;

export function claimsEmptyResult(raw: string): boolean {
  if (!raw) return false;
  return CLAIMS_EMPTY_RESULT.test(raw);
}

/**
 * AI-70 — a revenue question needs a qualification, not just a number.
 *
 * Measured on the phone 2026-11-05 6:23 PM: *"How much revenue did we make this week"* was
 * answered "PHP 68,975 in revenue this week … the sum of recorded selling prices × units
 * sold". No sale price, invoice or customer is recorded anywhere in the product — a
 * STOCK_OUT may be a sale, usage, damage or a write-off — so that sentence invents a fact
 * about money out of a stock moving. Prompt rule 25 asks for the qualification and the model
 * dropped it under a number, so the turn is re-asked whenever a revenue question is answered
 * with money and no qualification at all.
 */
const ASKS_REVENUE =
  /\b(?:revenue|turnover|profit|margin|earnings?|income|sales? (?:value|total|amount|figure)|how much (?:did|have) we (?:make|made|earn|earned|sell|sold)|how much money)\b/i;

const MONEY = /(?:\bPHP\s?|\u20b1|\$)\s?[\d,]+/i;

const QUALIFIES_MONEY =
  /\b(?:estimate|estimated|approximation|approximate|roughly|indicative|not recorded|does not record|do not record|is not tracked|aren\u2019t tracked|are not tracked|no sale prices|not a sale|no revenue|assumption|cannot be calculated)\b/i;

export function asksForRevenue(question: string): boolean {
  if (!question) return false;
  return ASKS_REVENUE.test(question);
}

/**
 * AI-72 — a business-wide question answered inside last turn's shelf.
 *
 * Measured on the phone 2026-11-05 7:25 PM: after a Front Counter question, *"What has never
 * left the store at all?"* was answered "At the Front Counter there is no dead stock …" — the
 * scope word "at all" was read past and the stale location was carried over, so a member asking
 * about the whole business got one shelf. Prompt rule 30 already forbids carrying a location
 * over; this predicate supplies the evidence when it happens anyway.
 *
 * Deliberately narrow: only wording that names the whole business ("at all", "anywhere",
 * "everywhere", "all locations") counts. A question that merely omits a location — "what sold
 * the most this week" — is left alone, because the shelf from the previous turn is a fair
 * reading of that, and rule 30 already covers the plain case.
 */
const ASKS_BUSINESS_WIDE =
  /\b(?:at all|whole (?:business|store|shop)|entire (?:business|store|shop)|business[- ]wide|across (?:the )?(?:whole |entire )?(?:business|store)|all (?:the )?(?:locations|branches|places)|everywhere|anywhere|every location|in total|overall)\b/i;

export function asksBusinessWide(question: string): boolean {
  if (!question) return false;
  return ASKS_BUSINESS_WIDE.test(question);
}

/**
 * AI-72 — remove a dropped place's name from a business-wide answer.
 *
 * Dropping `location` before the call makes the read wide, but the model still narrates the
 * place it was about to use. Measured on the phone 2026-11-05 11:02 PM: the follow-up got the
 * right business-wide count (59) and introduced it as "at Main Warehouse", whose own count is
 * 92 — the number was right and the scope sentence was false, so the member would act on the
 * wrong shelf. The instrument, its column header and its note all named the place.
 *
 * The rewrite is deliberately literal: `at <place>` becomes `across all locations` (which also
 * repairs "Available at <place>"), and any bare leftover becomes `all locations`. It is only
 * applied to a place the turn itself removed from a read. `at the` is handled because members
 * and models both write "at the Main Warehouse".
 */
/**
 * AI-73 — everyday wording for "which products have never moved".
 *
 * Measured on the phone 2026-11-05 11:01 and 11:07 PM: *"Any dead stock at the Main Warehouse"*
 * (no question mark) routed to `getLowStockProducts`, and the turn shipped rows reading
 * "Stock-out count 1" under a dead-stock heading — the opposite of the definition. The same
 * phrase WITH a question mark routed correctly at 11:10 PM, so tool choice is not reliable for
 * this vocabulary and a prompt rule cannot be the guarantee.
 *
 * Deliberately excludes stock-level wording: "low stock", "out of stock", "reorder" and
 * "below minimum" are the low-stock question's own words, and treating them as dead stock would
 * break the commonest question there is.
 */
const ASKS_DEAD_STOCK =
  /\b(?:dead[ -]?stock|not selling|isn\u2019t selling|unsold|stale stock|zero sales|sitting on the shelf|never (?:been )?sold|never left|has(?:n\u2019t| not) moved|have not moved|has not moved)\b/i;

/** Wording that asks about shortage levels, which the dead-stock tool does not answer. */
const ASKS_STOCK_LEVEL =
  /\b(?:low(?:\s+(?:on|in))?\s+stock|out of stock|running low|run low|low|reorder|restock|below minimum|at minimum|shortage)\b/i;

export function asksForDeadStock(question: string): boolean {
  if (!question) return false;
  return ASKS_DEAD_STOCK.test(question);
}

export function asksForLowStock(question: string): boolean {
  return ASKS_STOCK_LEVEL.test(String(question ?? ''));
}

const NEVER_SOLD_TOOL = 'getProductsNeverSold';
const STOCK_LEVEL_TOOLS = new Set(['getLowStockProducts', 'getOutOfStockProducts', 'getReorderNeededProducts']);

/** The dead-stock tool's own arguments, taken from whatever read the model did ask for. */
function neverSoldArgs(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of ['location', 'locationId', 'from']) {
    if (typeof input[key] === 'string' && (input[key] as string).trim()) out[key] = input[key];
  }
  // The dead-stock tool caps `limit` at 25; carrying a low-stock page size of 50 straight over
  // would be rejected by the schema, so it is clamped rather than passed through.
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    out.limit = Math.min(Math.max(Math.trunc(input.limit), 1), 25);
  }
  return out;
}

/**
 * AI-73 — before the tools run, route a dead-stock question through the dead-stock tool.
 *
 * This is a rewrite of the CALLS, not a request in the prompt: the rows the model is about to
 * read are replaced, so an answer built from `getLowStockProducts` cannot be produced for a
 * dead-stock question. A mixed question ("what is dead stock and what is low on stock?") keeps
 * both reads, because dropping the low-stock answer there would be wrong in the other direction.
 * A question that already asks for the dead-stock tool is left untouched, so a correct turn is
 * never rewritten. When no location is named, the call is business-wide, which is what the
 * dead-stock tool already means by default.
 */
export function routeDeadStockReads<T extends { name?: string; input?: unknown }>(
  calls: T[],
  question: string,
): T[] {
  if (!asksForDeadStock(question)) return calls;
  if (calls.some((call) => String(call?.name ?? '') === NEVER_SOLD_TOOL)) return calls;

  const base = calls.map((call) => call?.input).find((input) => input && typeof input === 'object');
  const added = {
    id: 'call-ai73-dead-stock',
    name: NEVER_SOLD_TOOL,
    input: neverSoldArgs(base),
  } as unknown as T;

  if (ASKS_STOCK_LEVEL.test(question)) return [...calls, added];

  let replaced = false;
  const routed = calls.map((call) => {
    if (!STOCK_LEVEL_TOOLS.has(String(call?.name ?? ''))) return call;
    replaced = true;
    return { ...call, name: NEVER_SOLD_TOOL, input: neverSoldArgs(call?.input) };
  });
  return replaced ? routed : [...calls, added];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function relabelBusinessWideScope(answer: string, place: string): string {
  const name = (place ?? '').trim();
  if (!answer || !name) return answer;
  const escaped = escapeRegExp(name);
  return answer
    .replace(new RegExp(`\\bat\\s+(?:the\\s+)?${escaped}\\b`, 'gi'), 'across all locations')
    .replace(new RegExp(escaped, 'gi'), 'all locations');
}

/**
 * AI-72 — the place a business-wide answer treats as its scope when the turn never read it.
 *
 * The dropped-argument path only catches a place the model passed to a tool. A model can just as
 * easily carry a place over from the conversation without reading it, and then the answer's scope
 * sentence is the only evidence — measured on the phone 2026-11-05 11:02 PM, where the count was
 * right and every sentence around it said "at Main Warehouse".
 *
 * The construction is the check, not the mere presence of a name: `at <place>` (with or without
 * "the") is how a scope is stated. Exactly one such place is a false scope and is returned;
 * two or more is a per-location breakdown ("at Main Warehouse 40, at Shop Front 19") and is left
 * alone, as is a place the question itself names. The caller fetches the business's own location
 * names, so an ordinary product name can never be mistaken for a place.
 */
export function scopedPlaceIn(answer: string, places: string[], question: string): string | null {
  if (!answer || !Array.isArray(places) || places.length === 0) return null;
  const asked = String(question ?? '').toLowerCase();
  const unique = [...new Set(places.map((place) => String(place ?? '').trim()).filter(Boolean))];
  const scoped = unique.filter((name) => {
    if (asked.includes(name.toLowerCase())) return false;
    return new RegExp(`\\bat\\s+(?:the\\s+)?${escapeRegExp(name)}\\b`, 'i').test(answer);
  });
  return scoped.length === 1 ? (scoped[0] ?? null) : null;
}

/** Money stated as a fact about sales, with no wording that marks it as derived. */
export function statesUnqualifiedMoney(raw: string): boolean {
  if (!raw) return false;
  return MONEY.test(raw) && !QUALIFIES_MONEY.test(raw);
}

/**
 * AI-70 — attach the qualification without letting the cap cut it off.
 *
 * The note is composed here rather than by the model because asking the model to reword the
 * figure cost a whole step budget and produced no answer at all (measured 2026-11-05 6:27 PM).
 * Composing it server-side means it must survive the two things that happen AFTER the model
 * stops: the answer cap, and the ordering of "append" versus "truncate". Appending first and
 * capping afterwards would slice the note in half on a long answer — exactly the answer whose
 * money figure most needs explaining — so the note's room is reserved before the body is cut.
 * `note` already present in the answer is left alone, so a model that qualifies the figure
 * itself never gets the sentence twice.
 */
export function withRevenueQualifier(answer: string, note: string, maxChars: number): string {
  const body = (answer ?? '').trimEnd();
  if (!note) return body;
  if (/Note: this is an estimate, not recorded revenue/.test(body)) return body;
  const room = maxChars - note.length - 2; // the "\n\n" separator
  if (!body) return note;
  if (room <= 24) return note;
  const kept = body.length <= room ? body : `${body.slice(0, room - 1).trimEnd()}\u2026`;
  return `${kept}\n\n${note}`;
}

/**
 * AI-75 — put a reversed stock range back in ascending order.
 *
 * Measured on the phone 2026-11-05 10:05 PM: a Samsung answer said "others have between 596
 * and 242 units on hand" while the rows held 0, 0, 75, 147, 186, 238, 242, 307 and 596. The
 * prompt now asks for the true minimum and maximum; this is the deterministic backstop for a
 * model that still writes the larger number first. It only touches quantity ranges whose unit
 * is a stock unit, so price or product-count ranges are not rewritten.
 */
const QUANTITY_RANGE =
  /\b(between|from)\s+([\d,]+)\s+(and|to)\s+([\d,]+)\s+(units?|pcs\.?|pieces?|items?)\b/gi;

export function normaliseReversedQuantityRange(raw: string): string {
  if (!raw) return raw;
  return raw.replace(QUANTITY_RANGE, (match, lead, a, joiner, b, unit) => {
    const first = Number(String(a).replace(/,/g, ''));
    const second = Number(String(b).replace(/,/g, ''));
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= second) return match;
    return `${lead} ${b} ${joiner} ${a} ${unit}`;
  });
}

/**
 * AI-77 — remove a low-stock section the member did not ask for.
 *
 * Measured on the phone 2026-11-05 10:24 PM: a Samsung stock-range answer appended
 * "The most urgent low-stock items ... are: 242-unit, 307-unit and 0-unit rows (the two that
 * are at or below their configured minimums)." Only the two 0-unit SKUs were at or below
 * their minimums; 242 and 307 were above theirs. The section was unrequested (rule 12), and
 * its count contradicted the rows it named. Removing the whole tail is safer than rewriting
 * the count, because the rows it named were not the low ones.
 */
const LOW_STOCK_TAIL = /\s*(?:The\s+)?most urgent low[\s\u2010\u2011-]stock items\b[\s\S]*$/i;

export function stripUnrequestedLowStockTail(raw: string, question: string): string {
  if (!raw || asksForLowStock(question)) return raw;
  return raw.replace(LOW_STOCK_TAIL, '').trimEnd();
}

/**
 * AI-76 — does the member want the brands the business carries?
 *
 * Measured on the phone 2026-11-05: *"What brands do you carry?"* named eleven of the
 * twelve brands returned by `listBrands`, and Samsung disappeared. The tool result was
 * complete; the omission happened while the model wrote prose. This predicate identifies
 * the question shape so the turn loop can check the finished answer against the rows.
 *
 * A genuine brand-list question names brands and either a carrying verb or an explicit
 * list request. A recommendation question ("which brand do you recommend?") is excluded:
 * appending the whole catalogue to an opinion would be noise, not completeness.
 */
const HAS_BRAND_WORD = /\bbrands?(?:\s+names?)?\b/i;
const BRAND_LIST_QUESTION =
  /\b(?:what|which|list|name|show|tell me|give me)\b[^\n?]{0,60}\bbrands?(?:\s+names?)?\b/i;
const BRAND_LIST_CARRY =
  /\b(?:do|does)\s+(?:you|we|they)\s+(?:carry|have|stock|sell|offer)\b[^\n?]{0,40}\bbrands?(?:\s+names?)?\b/i;
const BRAND_LIST_HAVE =
  /\bbrands?(?:\s+names?)?\b[^\n?]{0,40}\b(?:carry|carries|have|has|stock|stocks|sell|sells|offer|offers|available|recorded|listed|there|exist)\b/i;
const BRAND_LIST_COMMAND = /\b(?:list|name|show|tell me|give me)\b[^\n?]{0,40}\bbrands?(?:\s+names?)?\b/i;
const BRAND_QUALITY_QUESTION =
  /\b(?:recommend|best|better|quality|good|trusted|prefer|favorite|favourite|choose|top)\b/i;

export function asksForBrandList(question: string): boolean {
  const text = String(question ?? '').trim();
  if (!text || !HAS_BRAND_WORD.test(text)) return false;
  if (BRAND_LIST_COMMAND.test(text)) return true;
  if (BRAND_LIST_CARRY.test(text) || BRAND_LIST_HAVE.test(text)) return true;
  // A generic "what brands …" is a list request unless it is asking for an opinion.
  return BRAND_LIST_QUESTION.test(text) && !BRAND_QUALITY_QUESTION.test(text);
}

/** A question that asks only for the brand list, with no second request to preserve. */
const BRAND_LIST_EXTRA_REQUEST =
  /\b(?:recommend|best|better|quality|good|trusted|prefer|favorite|favourite|choose|top|headset|products?|stock|price|prices|count|how many|specs?|specifications?|reviews?|compare|cheapest|in stock|on hand)\b/i;

export function asksForBrandListOnly(question: string): boolean {
  return asksForBrandList(question) && !BRAND_LIST_EXTRA_REQUEST.test(String(question ?? ''));
}

/**
 * AI-76 — put every brand the tool returned into a brand-list answer.
 *
 * The prompt asks for the complete list, but prompt compliance was measured to fail by one
 * row (Samsung, 2026-11-05). This is the deterministic backstop: if any returned name is
 * absent from the answer, a complete list is appended with room reserved inside the answer
 * cap. It does not invent a brand; it only repeats names from `listBrands`.
 */
export function withCompleteBrandList(
  answer: string,
  brands: readonly string[],
  maxChars: number,
): string {
  const body = String(answer ?? '').trimEnd();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of brands) {
    const name = String(raw ?? '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) return body;
  const complete = names.every((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(body));
  if (complete) return body;

  const line = `Complete recorded brand list: ${names.join(', ')}.`;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : line.length;
  if (line.length >= limit) return line.slice(0, limit);
  if (!body) return line;
  const room = limit - line.length - 2; // the "\n\n" separator
  if (body.length <= room) return `${body}\n\n${line}`;
  const kept = body.slice(0, Math.max(0, room - 1)).trimEnd();
  return kept ? `${kept}\u2026\n\n${line}` : line;
}

/**
 * AI-76 — a clean brand-list answer assembled only from the tool rows.
 *
 * A pure "what brands do you carry?" answer cannot safely be repaired by appending a
 * second list: measured on the phone 2026-11-05, the model's numbered list contained an
 * invented Roccat and omitted Samsung, while the appended list contained Samsung. Two
 * lists that disagree are worse than one deterministic list, so a pure list question is
 * answered from the rows themselves. Every name here came from `listBrands`; no model
 * prose and no outside brand enters it.
 */
export function canonicalBrandListAnswer(
  rows: readonly { brand: string; productCount?: number }[],
  maxChars: number,
): string {
  const unique: Array<{ brand: string; productCount?: number }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const brand = String(row?.brand ?? '').trim();
    const key = brand.toLowerCase();
    if (!brand || seen.has(key)) continue;
    seen.add(key);
    unique.push({ brand, productCount: row?.productCount });
  }
  if (unique.length === 0) return '';
  const lines = unique.map((row, index) => {
    const count = Number(row.productCount);
    const suffix = Number.isFinite(count) && count > 0 ? ` — ${count} ${count === 1 ? 'product' : 'products'}` : '';
    return `${index + 1}. **${row.brand}**${suffix}`;
  });
  const text = `The catalogue carries ${unique.length} recorded ${unique.length === 1 ? 'brand' : 'brands'}:\n\n${lines.join('\n')}`;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : text.length;
  return text.length <= limit ? text : text.slice(0, limit);
}

export interface CatalogueFact {
  id?: string;
  name: string;
  brand?: string | null;
  sellingPrice?: number | null;
  /** The ISO-4217 code recorded on the product, or null when none was recorded. */
  currency?: string | null;
  availableQuantity?: number | null;
  /** The location whose inventory row supplied availableQuantity, when known. */
  locationName?: string | null;
  /** The recorded on-hand value when the stock-value tool supplied it. */
  stockValue?: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A recorded amount, in the currency the row itself carries.
 *
 * This helper used to always write `PHP`. Production data measured on 2026-11-06 has
 * `currency: null` on every product, so every computed total invented a currency the
 * record never stated — and a product recorded in USD would have been mislabelled the
 * other way. A recorded ISO code is shown beside the amount; with no code the bare number
 * is shown, which is the same rule the prompt gives the model (rules 23 and 28).
 */
function money(value: number, currency?: string | null): string {
  const amount = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(value);
  const code = currencyKey(currency);
  return code ? `${code} ${amount}` : amount;
}

/** The normalized currency a row carries, or '' when none was recorded. */
function currencyKey(currency?: string | null): string {
  return typeof currency === 'string' ? currency.trim().toUpperCase() : '';
}

function uniqueFacts(rows: readonly CatalogueFact[]): CatalogueFact[] {
  const byKey = new Map<string, CatalogueFact>();
  for (const raw of rows) {
    if (typeof raw?.name !== 'string') continue;
    const name = raw.name.trim();
    if (!name) continue;
    const key = raw.id ? `id:${raw.id}` : `name:${name.toLowerCase()}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...raw, name });
      continue;
    }
    byKey.set(key, {
      ...prior,
      brand: prior.brand ?? raw.brand ?? null,
      sellingPrice: prior.sellingPrice ?? raw.sellingPrice ?? null,
      currency: prior.currency ?? raw.currency ?? null,
      availableQuantity: prior.availableQuantity ?? raw.availableQuantity ?? null,
      stockValue: prior.stockValue ?? raw.stockValue ?? null,
    });
  }
  return [...byKey.values()];
}

function appendWithRoom(body: string, line: string, maxChars: number): string {
  const text = String(body ?? '').trimEnd();
  if (!line) return text;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : line.length;
  if (line.length >= limit) return line.slice(0, limit);
  if (!text) return line;
  const room = limit - line.length - 2;
  if (text.length <= room) return `${text}\n\n${line}`;
  const kept = text.slice(0, Math.max(0, room - 1)).trimEnd();
  return kept ? `${kept}\u2026\n\n${line}` : line;
}

/**
 * AI-90 — does the member want the rows that need buying again?
 *
 * The restock tool answers "what should I reorder", but members ask the same question in
 * stock-level words. Measured on the phone 2026-11-06: *"What is low on stock at the Front
 * Counter"* read `getLowStockProducts`, and the completion step never ran because the
 * original predicate only matched `restock|reorder` — so a 19-product answer stayed at the
 * five rows the model happened to type.
 *
 * Two shapes are excluded. A low-stock VALUE question ("what is the total value of low
 * stock?") is answered by `lowStockValueAnswer`, and appending a name list to a peso total
 * would answer a different question. A pure count ("how many products are low on stock?")
 * asked for a number, not a list; it only counts as a list request when it also asks which
 * products those are.
 */
const RESTOCK_LIST_WORDING =
  /\b(?:restock(?:ing)?|reorder(?:ing)?|low(?:\s+on)?\s+stock|running low|run low|shortages?|below\s+(?:the\s+|their\s+)?(?:reorder\s+)?minimum)\b/i;
const ASKS_ONLY_FOR_A_COUNT = /^\s*how\s+(?:many|much)\b/i;
const ALSO_ASKS_WHICH_ONES = /\b(?:list|name|show|which|what\s+are|who)\b/i;

export function asksForRestockList(question: string): boolean {
  const text = String(question ?? '');
  if (!text || !RESTOCK_LIST_WORDING.test(text)) return false;
  if (ASKS_ONLY_FOR_A_COUNT.test(text) && !ALSO_ASKS_WHICH_ONES.test(text)) return false;
  return !asksForLowStockValue(text);
}

/** "How many need restocking and name three" — a count plus a short exact list. */
export function asksForThreeRestockNames(question: string): boolean {
  return (
    asksForRestockList(question) &&
    /\b(?:name|list|show|give)\b[\s\S]{0,20}\b(?:three|3)\b/i.test(String(question ?? ''))
  );
}

export function asksForLowStockValue(question: string): boolean {
  const text = String(question ?? '');
  return /\blow[\s-]?stock\b/i.test(text) && /\b(?:total|value|worth)\b/i.test(text);
}

export function asksForMostExpensive(question: string): boolean {
  return /\b(?:most expensive|highest (?:recorded )?(?:price|price per unit))\b/i.test(String(question ?? ''));
}

export interface TopOutFact {
  name: string;
  unitsOut: number;
}

/** A question that ranks products by units leaving stock. */
export function asksForTopOut(question: string): boolean {
  const text = String(question ?? '');
  return (
    /\b(?:which|what)\s+(?:item|product|sku)\b[\s\S]{0,100}\b(?:most|highest|largest|top)\b[\s\S]{0,100}\b(?:units?|quantity|qty|stock)\b[\s\S]{0,120}\b(?:leave|left|out|move|moved|sold)\b/i.test(text) ||
    /\b(?:most|highest|largest|top)\b[\s\S]{0,60}\b(?:units?|quantity|qty)\b[\s\S]{0,60}\b(?:leave|left|out|move|moved|sold)\b/i.test(text)
  );
}

/** A question about which product is worth the most at the recorded selling price. */
export function asksForHighestStockValue(question: string): boolean {
  const text = String(question ?? '');
  return (
    /\b(?:highest|largest|greatest|most|top)\b[\s\S]{0,60}\b(?:stock|inventory)\s+value\b/i.test(text) ||
    /\b(?:stock|inventory)\s+value\b[\s\S]{0,60}\b(?:highest|largest|greatest|most|top)\b/i.test(text)
  );
}

export function asksForBrandStockRange(question: string): boolean {
  return /\bstock range\b/i.test(String(question ?? '')) && !/\bacross\s+skus?\b/i.test(String(question ?? ''));
}

function locationFromTotalsQuestion(question: string): string | null {
  const match = String(question ?? '').match(
    /\bhow many products and units are (?:at|in)\s+(?:the\s+)?(.+?)\s*[?.!]*$/i,
  );
  const name = match?.[1]?.trim() ?? '';
  return name || null;
}

export function asksForLocationTotals(question: string): boolean {
  return locationFromTotalsQuestion(question) !== null;
}

/** Sum a COMPLETE product page for one location, never a partial page. */
export function locationTotalsAnswer(
  rows: readonly CatalogueFact[],
  question: string,
  maxChars: number,
): string | null {
  const location = locationFromTotalsQuestion(question);
  const facts = uniqueFacts(rows);
  if (!location || facts.length === 0) return null;
  let units = 0;
  for (const row of facts) {
    const quantity = finiteNumber(row.availableQuantity);
    if (quantity === null || quantity < 0) return null;
    units += quantity;
  }
  const answer = `${location} has ${facts.length} ${facts.length === 1 ? 'product' : 'products'} and ${units} units on hand.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** A question that asks for one named product's quantity at every location. */
export function asksForProductStockByLocation(question: string): boolean {
  const text = String(question ?? '');
  return (
    /\b(?:on[-\s]?hand|stock|quantity|qty|units?|available)\b/i.test(text) &&
    /\b(?:each|every|all|per)\b[\s\S]{0,40}\b(?:locations?|branches?|stores?|warehouses?|shelves|shelf)\b/i.test(
      text,
    )
  );
}

function formatUnits(value: number): string {
  return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(value);
}

/**
 * Answer a single-product location question from the inventory rows themselves.
 *
 * The model was measured on 2026-11-09 returning 1,029 and 904 units for a product
 * whose production product screen held 149 at each of two locations. The tool rows are
 * authoritative; this finalizer refuses to choose when the read contains more than one
 * candidate product, so it cannot turn an unrelated page into a confident answer.
 */
export function productStockByLocationAnswer(
  rows: readonly CatalogueFact[],
  question: string,
  maxChars: number,
): string | null {
  const products = new Map<
    string,
    { name: string; locations: Map<string, number> }
  >();
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const location = typeof row?.locationName === 'string' ? row.locationName.trim() : '';
    const quantity = finiteNumber(row?.availableQuantity);
    if (!name || !location || quantity === null || quantity < 0) continue;
    const key = row.id ? `id:${row.id}` : `name:${name.toLowerCase()}`;
    const product = products.get(key) ?? { name, locations: new Map<string, number>() };
    product.locations.set(location, quantity);
    products.set(key, product);
  }

  const candidates = [...products.values()].filter((product) => product.locations.size >= 2);
  if (candidates.length === 0) return null;
  const text = String(question ?? '').toLowerCase();
  const named = candidates.filter((product) =>
    text.includes(product.name.toLowerCase()),
  );
  // A comparison question naming two products is not a single-product answer, and a page
  // with several products and no name in the question is not evidence about any one of them.
  const product =
    named.length === 1
      ? named[0]
      : named.length === 0 && candidates.length === 1
        ? candidates[0]
        : null;
  if (!product) return null;

  const locations = [...product.locations.entries()];
  const total = locations.reduce((sum, [, quantity]) => sum + quantity, 0);
  const lines = locations.map(
    ([location, quantity]) => `- ${location}: **${formatUnits(quantity)}**`,
  );
  const answer = `**${product.name}** on hand:\n\n${lines.join('\n')}\n\nTotal: **${formatUnits(total)}** units.`;
  return answer.length <= maxChars ? answer : null;
}

export function asksForStockOutCount(question: string): boolean {
  return /\bhow many\b[\s\S]*\bstock[-\s]?out\b[\s\S]*\bmovements?\b/i.test(
    String(question ?? ''),
  );
}

export function stockOutCountAnswer(count: number, maxChars: number): string | null {
  if (!Number.isFinite(count) || count < 0) return null;
  const answer = `There ${count === 1 ? 'is' : 'are'} ${count} stock-out ${count === 1 ? 'movement' : 'movements'} recorded.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

interface PriceCeiling {
  amount: number;
  /** The currency the member named, or null when they named none. */
  currency: string | null;
}

function priceCeilingFromQuestion(question: string): PriceCeiling | null {
  // The symbol matters: "under $500" is not a peso ceiling, so it is captured rather than
  // read as a bare number and formatted as PHP.
  const match = String(question ?? '').match(
    /\b(?:less than|under|below|cheaper than|up to|within)\s+(?:(php|usd|eur|gbp)\s*|([₱$€£])\s*)?([\d,]+(?:\.\d+)?)\s*(k)?\b/i,
  );
  if (!match) return null;
  const amount = Number((match[3] ?? '').replace(/,/g, '')) * (match[4] ? 1000 : 1);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = match[2] ?? '';
  const currency =
    (match[1] ?? '').toUpperCase() ||
    (symbol === '₱' ? 'PHP' : symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : symbol === '£' ? 'GBP' : null);
  return { amount, currency };
}

export function asksForProductsUnderPrice(question: string): boolean {
  const text = String(question ?? '');
  return (
    priceCeilingFromQuestion(text) !== null &&
    /\b(?:which|what|list|show)\b[\s\S]*\b(?:products?|items?)\b[\s\S]*\b(?:cost|costs|priced|price)\b[\s\S]*\b(?:less than|under|below)\b/i.test(
      text,
    )
  );
}

/** List only the rows whose RECORDED selling price is below the asked ceiling. */
export function productsUnderPriceAnswer(
  rows: readonly CatalogueFact[],
  question: string,
  maxChars: number,
): string | null {
  const ceiling = priceCeilingFromQuestion(question);
  if (ceiling === null) return null;
  const priced = uniqueFacts(rows)
    .map((row) => ({ row, price: finiteNumber(row.sellingPrice) }))
    .filter((entry): entry is { row: CatalogueFact; price: number } =>
      entry.price !== null && entry.price > 0 && entry.price < ceiling.amount,
    )
    .sort((a, b) => a.price - b.price || a.row.name.localeCompare(b.row.name));
  // A currency named in the question excludes rows recorded in another currency — and a
  // row whose currency was never recorded cannot be compared with a stated amount either.
  const facts = ceiling.currency
    ? priced.filter(({ row }) => currencyKey(row.currency) === ceiling.currency)
    : priced;
  if (facts.length === 0) return null;
  const currencies = new Set(facts.map(({ row }) => currencyKey(row.currency)));
  // A ceiling is only meaningful inside one currency: 5,000 is a different amount in PHP
  // and USD, so rows recorded in different currencies are not ranked against one number.
  if (currencies.size > 1) return null;
  const currency = ceiling.currency ?? [...currencies][0] ?? '';
  const shown = facts.slice(0, 8);
  const list = shown.map(({ row, price }) => `**${row.name}** (${money(price, row.currency)})`).join(', ');
  const remainder = facts.length > shown.length ? `, and ${facts.length - shown.length} more` : '';
  const answer = `The products with a recorded selling price under ${money(ceiling.amount, currency)} are ${list}${remainder}.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

export interface RestockListOptions {
  /** What to call the list, so a low-stock answer does not say "restock". */
  label?: string;
  /**
   * False when the rows are only one page of a larger result. A partial page cannot be
   * presented as the full list — that was the measured failure (AI-90: five of nineteen
   * rows labelled complete) — so the model's answer is left untouched instead.
   */
  complete?: boolean;
}

/** Add every product this turn returned, not just the ones the model typed. */
export function withCompleteRestockNames(
  answer: string,
  rows: readonly CatalogueFact[],
  maxChars: number,
  options: RestockListOptions = {},
): string {
  const body = String(answer ?? '').trimEnd();
  if (options.complete === false) return body;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row?.name !== 'string') continue;
    const name = row.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) return body;
  if (names.every((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(body))) return body;
  const label = String(options.label ?? 'restock').trim() || 'restock';
  return appendWithRoom(body, `The full ${label} list is: ${names.join(', ')}.`, maxChars);
}

/** A count plus three exact names, in the order the restock tool returned them. */
export function restockThreeAnswer(
  rows: readonly CatalogueFact[],
  total: number,
  maxChars: number,
): string | null {
  const facts = uniqueFacts(rows).slice(0, 3);
  if (facts.length < 3) return null;
  const count = Number.isFinite(total) && total > 0 ? total : rows.length;
  const list = facts.map((row) => {
    const quantity = finiteNumber(row.availableQuantity);
    const status = quantity === null ? 'needs restocking' : quantity <= 0 ? 'out of stock' : 'low stock';
    return `**${row.name}** (${status})`;
  });
  const answer = `${count} products need restocking; the 3 most urgent are ${list.join(', ')}.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** Compute a low-stock subtotal only from the rows the low-stock tool returned. */
export function lowStockValueAnswer(
  rows: readonly CatalogueFact[],
  maxChars: number,
): string | null {
  const facts = uniqueFacts(rows);
  if (facts.length === 0) return null;
  // Subtotals are kept apart by currency. A single total across PHP and USD would be a
  // number in no currency; when the rows span currencies the sentence names each part.
  const groups = new Map<string, { total: number; count: number }>();
  for (const row of facts) {
    const price = finiteNumber(row.sellingPrice);
    const quantity = finiteNumber(row.availableQuantity);
    if (price === null || quantity === null) return null;
    const key = currencyKey(row.currency);
    const group = groups.get(key) ?? { total: 0, count: 0 };
    group.total += Math.max(quantity, 0) * Math.max(price, 0);
    group.count += 1;
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
  );
  const head = `The total recorded value of the ${facts.length} low-stock ${facts.length === 1 ? 'item' : 'items'} is`;
  const answer =
    ordered.length === 1
      ? `${head} ${money(ordered[0]![1].total, ordered[0]![0])}.`
      : `${head} ${ordered
          .map(([code, group]) => {
            const note = code ? '' : ', currency not recorded';
            return `${money(group.total, code)} (${group.count} ${group.count === 1 ? 'item' : 'items'}${note})`;
          })
          .join(', ')}.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** The maximum recorded selling price, independent of stock value or page order. */
export function mostExpensiveProductAnswer(
  rows: readonly CatalogueFact[],
  maxChars: number,
): string | null {
  const facts = uniqueFacts(rows).filter((row) => {
    const price = finiteNumber(row.sellingPrice);
    return price !== null && price > 0;
  });
  if (facts.length === 0) return null;
  const currencies = new Set(facts.map((row) => currencyKey(row.currency)));
  // A maximum across currencies would compare numbers that mean different things.
  if (currencies.size > 1) return null;
  const max = Math.max(...facts.map((row) => finiteNumber(row.sellingPrice) ?? 0));
  const winners = facts.filter((row) => finiteNumber(row.sellingPrice) === max);
  const names = winners.map((row) => `**${row.name}**`).join(', ');
  const answer = `The product with the highest recorded selling price is ${names} at ${money(max, winners[0]?.currency)}.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** The product with the greatest recorded quantity × sellingPrice, never a currency guess. */
export function highestStockValueAnswer(
  rows: readonly CatalogueFact[],
  maxChars: number,
): string | null {
  const facts = uniqueFacts(rows)
    .map((row) => {
      const price = finiteNumber(row.sellingPrice);
      const quantity = finiteNumber(row.availableQuantity);
      const value = finiteNumber(row.stockValue) ?? (price !== null && quantity !== null ? price * quantity : null);
      return { row, price, quantity, value };
    })
    .filter(
      (entry): entry is { row: CatalogueFact; price: number; quantity: number; value: number } =>
        entry.value !== null &&
        entry.value > 0 &&
        entry.price !== null &&
        entry.price > 0 &&
        entry.quantity !== null,
    );
  if (facts.length === 0) return null;
  const currencies = new Set(facts.map(({ row }) => currencyKey(row.currency)));
  // Totals in different currencies cannot be ranked against one another.
  if (currencies.size > 1) return null;
  const max = Math.max(...facts.map(({ value }) => value));
  const winners = facts.filter(({ value }) => value === max);
  const currency = winners[0]!.row.currency;
  const names = winners.map(({ row }) => `**${row.name}**`).join(' and ');
  const detail =
    winners.length === 1
      ? ` (recorded selling price ${money(winners[0]!.price, currency)} × ${new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(winners[0]!.quantity)} units on hand)`
      : '';
  const answer = `The item with the highest stock value is ${names} at ${money(max, currency)}${detail}.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** The top stock-out product, using the exact recorded name returned by the history tool. */
export function topOutAnswer(rows: readonly TopOutFact[], maxChars: number): string | null {
  const facts = rows
    .map((row) => ({ name: String(row?.name ?? '').trim(), unitsOut: finiteNumber(row?.unitsOut) }))
    .filter((row): row is { name: string; unitsOut: number } => Boolean(row.name) && row.unitsOut !== null && row.unitsOut > 0)
    .sort((a, b) => b.unitsOut - a.unitsOut || a.name.localeCompare(b.name));
  if (facts.length === 0) return null;
  const max = facts[0]!.unitsOut;
  const winners = facts.filter((row) => row.unitsOut === max);
  const names = winners.map((row) => `**${row.name}**`).join(' and ');
  const units = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(max);
  const answer =
    winners.length === 1
      ? `The item with the most units out is ${names}, with **${units} units** moved out.`
      : `The items with the most units out are ${names}, with **${units} units** each moved out.`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

/** Range of per-product totals, not the individual location rows. */
export function brandStockRangeAnswer(
  rows: readonly CatalogueFact[],
  question: string,
  maxChars: number,
): string | null {
  const facts: CatalogueFact[] = [];
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const brand = typeof row?.brand === 'string' ? row.brand.trim() : '';
    if (!name || !brand) continue;
    facts.push({ ...row, name, brand });
  }
  const brand = [...new Set(facts.map((row) => String(row.brand).trim()))].find((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(question),
  );
  if (!brand) return null;
  const byProduct = new Map<string, { name: string; quantity: number }>();
  for (const row of facts) {
    if (String(row.brand).trim().toLowerCase() !== brand.toLowerCase()) continue;
    const quantity = finiteNumber(row.availableQuantity);
    if (quantity === null) continue;
    const key = row.id ? `id:${row.id}` : `name:${String(row.name).toLowerCase()}`;
    const prior = byProduct.get(key);
    byProduct.set(key, {
      name: String(row.name),
      // Product-level reads can repeat a product (findProducts plus getStockValue); use
      // the largest total rather than adding the same shelf twice. The router supplies a
      // product-level read for a brand range, so this is not a location-row sum.
      quantity: Math.max(prior?.quantity ?? 0, quantity),
    });
  }
  const totals = [...byProduct.values()];
  if (totals.length < 2) return null;
  const values = totals.map((row) => row.quantity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const answer = `The recorded stock range across ${brand} products is **${min} to ${max} units** (product totals across all locations).`;
  return answer.length <= maxChars ? answer : answer.slice(0, maxChars);
}

export function trimIncompleteAnswer(raw: string): string {
  if (!raw) return raw;
  const lines = raw.replace(/\s+$/, '').split('\n');
  trimTrailingRows(lines);

  const last = lastNonEmpty(lines);
  if (last < 0) return raw;
  const lastLine = lines[last] ?? '';

  // A complete trailing row is a finished unit even without a full stop.
  if (isRowStart(lastLine) && cellCount(lastLine) !== null) {
    return lines.slice(0, last + 1).join('\n');
  }

  // A finished sentence is a finished unit.
  if (endsSentence(lastLine, lastLine.trimEnd().length - 1)) {
    return lines.slice(0, last + 1).join('\n');
  }

  if (isListItem(lastLine)) {
    return lines.slice(0, last + 1).join('\n').trimEnd();
  }

  // A paragraph cut mid-sentence: cut it back to its last finished sentence, and only if
  // that leaves something with more than a fragment in it.
  const tail = lastLine.trimEnd();
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (!endsSentence(tail, i)) continue;
    // Keep the closing marks that belong to the sentence: cutting `app.)*` at `app.)`
    // would leave an unterminated `*` and change how the whole bubble renders.
    let end = i + 1;
    while (end < tail.length) {
      const ch = tail[end];
      if (ch === undefined || !CLOSERS.has(ch)) break;
      end += 1;
    }
    const cut = tail.slice(0, end).trimEnd();
    if (cut.length < 24) continue;
    const kept = [...lines.slice(0, last), cut].join('\n').trimEnd();
    if (kept.length >= 24) return kept;
  }

  // Nothing in this paragraph is whole. Keep the previous finished line, if there is one.
  if (last > 0) {
    const previous = lastNonEmpty(lines.slice(0, last));
    if (previous >= 0) {
      const prevText = (lines[previous] ?? '').trimEnd();
      if (isRowStart(prevText) && cellCount(prevText) !== null) {
        return lines.slice(0, previous + 1).join('\n').trimEnd();
      }
      if (endsSentence(prevText, prevText.length - 1)) {
        return lines.slice(0, previous + 1).join('\n').trimEnd();
      }
    }
  }

  // No identifiable whole unit — keep the answer exactly as it arrived.
  return raw;
}

export default { trimIncompleteAnswer, humaniseStatusConstants };
