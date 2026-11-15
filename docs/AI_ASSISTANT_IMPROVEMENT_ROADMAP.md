# AI Assistant Improvement Roadmap

**What this file is.** The living plan for the Inventory AI assistant, newest review first. It
records the eight improvements the owner asked for, what already exists in the code, what is
missing, and the order in which the gaps should be closed. It is a **status and planning**
document, not a specification: behaviour is still owned by
[`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md), limits by
[`guides/18-ai-assistant-limits.md`](guides/18-ai-assistant-limits.md), and what shipped by the
roadmap records in [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md).

**Last reviewed:** 2026-11-16, against AI-114 merged as `e5c1c1d`, the production server at
`e5c1c1d`, and the production Android app on runtime `1.0.2` with OTA
`9d759ee5-82c5-4fbe-afe0-3a0ea2c44f6c`. AI-114 renders an explicit complete restock/low-stock
list deterministically, including an `OUTPUT_LIMIT` turn whose rows were complete; the production
phone returned **19 products / 721 units**, copied all 19, and returned **9 products / 272 units**
for the filtered list.

**The rule that outranks every item below:** the assistant is **read-only**. It may read, compare,
summarise and recommend from tenant-scoped records. It may never write stock, create a product, a
movement or a transaction, change a minimum, or execute a purchase order. “Recommended” is always a
suggestion for a member to review, never an automatic action.

## Status legend

| Status | Meaning |
| --- | --- |
| **Implemented** | The capability exists and has automated coverage and/or a recorded production proof. |
| **Partial** | Some of the capability exists, but a named part of the requested outcome is missing. |
| **Planned** | Not built. The next slice is described, but no code has been written. |
| **Not started** | No design or implementation work yet. |

## 1. Audit summary

The table uses the owner's priority order. “What exists” is deliberately evidence-based; a missing
piece is not implied to work because a related tool exists.

| # | Improvement | Priority | Status | What exists now | Main gap |
|---|---|---|---|---|---|
| 1 | Copy Answer, Restock Navigation, Product Navigation | 1 | **Implemented — production-verified** | Copy Answer copies the complete stored answer as plain text. Product names named by the final answer are inline links, using only ids captured from the turn's read tools. Restock navigation remains, and every paged list answer now also carries filter-preserving screen links. `ai111-answer-actions.test.tsx`, `ai112-answer-navigation.test.tsx` and the server AI-111/AI-112 suites cover the actions. Device proof: Copy pasted the full answer; the Razer link opened SKU `DEMOSKU-73`; the filtered Restock link carried **9 products** and **Keyboards & Mice**. | No functional gap in the three actions. The Copy control uses React Native core `Clipboard`, whose deprecation warning is expected. |
| 2 | Complete list and pagination | 2 | **Implemented — production-verified** | Every paged tool answer now carries its total, a bounded page of the rows already read, and a screen link built from the filters the tool actually used. The mobile thread reveals those rows five at a time with “Showing X of Y” and keeps the screen link for the complete set. Inventory, Restock, Products and History initialize their filters from the link. Device proof: **5 of 19 → 10 of 19**, and Restock opened with **19 products**. | No search-within-results and no tool page cursor: “next 5” reveals only rows captured in this answer; a new tool read still requires a new turn. A destination filter that the screen cannot represent is omitted rather than claimed. |
| 3 | Smarter inventory answers | High, sequence 3 | **Partial — strong** | Deterministic finalizers cover restock counts and explicit complete restock/low-stock lists, stock-value totals, product/location totals, most-expensive, top stock-out and several ranking shapes; tools compute counts over the whole matched set. AI-113 adds a server-ranked highest-stock read and answer, and the whole-set `totalUnitsBelowMinimum` replaces page-row addition. AI-114 renders every complete restock row in a bounded answer and can rescue an output-limited turn from those rows. AI-2/AI-60 tests guard grounding and partial lists. Device proof: **19 / 721**, Copy all 19, and the filtered **9 / 272**. | Coverage is still shape-by-shape: other comparisons, trends and report combinations can remain model-composed. Correctness must be proved per question shape, not inferred from the tool list. |
| 4 | Better follow-up conversations | 4 | **Partial** | The server replays the last 20 USER/ASSISTANT messages (`AI_CONTEXT_MESSAGES`), so ordinary conversational context exists. | Tool rows are not replayed, and prompt rule 30 tells the model every question sets its own scope. A follow-up such as “which ones are from Samsung?” can re-query Samsung but is not guaranteed to preserve the previous “low stock” result set. There is no structured result-set handle. |
| 5 | Inventory comparison | 5 | **Partial** | `getLocationBreakdown` compares all locations in one read; `getProduct` returns per-location stock; product-stock-by-location and history totals have deterministic answers; history rows distinguish direction and transfer legs. | No deterministic two-product comparison, no compare-to-minimum table, and no “decreasing inventory” verdict. A trend read must be assembled by the model from movements; the tool reports movement, not a forecast. |
| 6 | Inventory insights and recommendations | High, sequence 6 | **Partial** | Reorder-needed, low/out-of-stock, never-sold and history tools support restock priorities and dead-stock observations. Recommendations are explicitly read-only; no write tool exists. | No run-out-soon calculation (no sales-velocity forecast), no excess-inventory rule, and no monitoring score. These need defined data rules and disclosed windows, not model intuition. |
| 7 | Better error handling and transparency | 7 (cross-cutting) | **Implemented — residual hardening** | Grounding re-asks, degraded reasons, output-limit annotations, partial-list totals and the final restock completeness guard; AI-60 is 64/64; the integrity endpoint was last recorded fresh. | Not every list shape gets a generic completeness marker; the 4,000-character trim does not add its own degraded marker; an unavailable service and a genuinely zero result rely on the answer copy. These are UX contracts to finish, not new AI writes. |
| 8 | Inventory report summaries | 8 | **Partial** | `getInventorySummary` returns active products, healthy/low/out counts, total on-hand quantity and recent activity; `getCatalogOverview` adds category counts; `getLocationBreakdown` adds per-location totals. | No single deterministic report read that guarantees one summary containing catalogue totals, low/out counts, category split, location split and the reporting window. The model currently composes it from up to three reads. |

**Important reading of the priority table.** Items 3 and 7 are marked high priority, but they are also
release gates for every slice: no new answer shape ships without grounded numbers, and no incomplete
answer ships without saying so. Their remaining dedicated work still follows the owner's sequence.
The sequence is a dependency order, not permission to defer correctness.

## 2. Item-by-item review and next slice

### 1. Copy Answer, Restock Navigation, Product Navigation — priority 1

**Implemented.** `restockPathForTools` recognises the stock-list tools and still renders the
legacy Restock action for old messages. New answers carry **Copy Answer**, inline product links and
screen links. `answerPlainText` converts the complete stored answer to plain text, including table
cells, so the copied result can be pasted into a supplier message. `mentionedProductLinks` keeps
only products the final answer names, only with ids a read tool returned, and drops an ambiguous
duplicate name; `AssistantMarkdown` and the result rows open `/products/<id>` from that id. The
client never resolves a display name against a local catalogue.

**Residual.** No functional gap in the three actions. Production device checks on the installed
app confirmed Copy Answer, the exact product link, the unfiltered Restock link and the
filter-preserving Restock link. The copy path uses React Native's bundled `Clipboard`, which emits
a deprecation warning but needs no native dependency or rebuild.

**Accepted when.** Tests prove: copy contains the full answer and not just the visible part; the
Restock action still opens the complete Restock screen; a product action opens the exact product
id; no action appears on a user message or on an answer with no product/provenance data; the AI-2
read-only scan stays green.

### 2. Complete list and pagination — priority 2

**Already working.** Tools return pages with totals and `hasMore`, and oversized payloads are
structurally truncated with a note. The app's Inventory, Restock, History, Products and Locations
screens already hold the complete lists with their own filters. The assistant's restock answer now
states a total and directs the member to the Restock screen rather than calling a page complete.

**Implemented.** Every paged list answer now stores a bounded `answerActions.list` with the tool's
total and the rows that answer already read, plus up to three filter-preserving `screens`
destinations. The mobile thread shows the total, reveals the captured rows five at a time, and
keeps the screen link for the complete set. Inventory, Restock, Products and History initialize
`q`, location, category, status and stock filters from the link; a name the screen knows how to
resolve is resolved against the business's own active references, not matched on the client as an
id.

**Residual.** There is still no tool page cursor and no search-within-results. “Show next 5”
reveals only rows captured in the answer; it cannot fetch rows the turn never read. A filter the
destination screen cannot represent (for example an ARCHIVED status in Inventory) is omitted
rather than claimed.

**Accepted when.** A list with more rows than one page has a path to every match; the total and page
range are visible; a search can narrow the complete set; tenant isolation is unchanged; a page
boundary cannot duplicate or silently drop a match.

### 3. Smarter inventory answers — high priority, sequence 3

**Already working.** The assistant reads tenant-scoped tools; several question shapes are finalised
deterministically from captured tool rows instead of trusting prose. This includes restock counts
and lists, total stock value, product and location quantity totals, low-stock value, most-expensive
and several top-out shapes. Counts are computed over the whole matched set, not by adding page rows.
AI-60 covers partial-page and false-completeness cases.

**Implemented for the named gaps.** AI-113 adds the read-only `getHighestStockProducts` tool, which
ranks ACTIVE products by availability over the whole matching set (or one location) and returns
the positive-stock count. `highestStockQuantityAnswer` rebuilds the ranking from the returned rows,
deduplicates duplicate names, honors singular and top-N wording, states the location scope, and
never trusts page order. The restock read now also returns `totalUnitsBelowMinimum` over every
matching product, and a unit-shortfall question is no longer answered by the product-count
finalizer.

**Residual.** Not every numerical question has a finalizer. Lowest quantity, two-product
comparisons, category/brand stock totals beyond the existing value read, trends and combined
reports can still be model-composed. A shape without a finalizer is treated as unverified. An
explicit complete restock/low-stock list no longer relies on the model; partial sets still use
the existing count-plus-qualification path.

**Accepted when.** Each covered question has a fixture with known database rows and an exact
expected figure; an empty/partial/ambiguous result produces an explicit limitation; no finalizer
invents a product or quantity; no matching product is silently excluded.

### 4. Better follow-up conversations — priority 4

**Already working.** Recent USER/ASSISTANT text is sent as context, so “what about the other one?”
can sometimes work. The assistant can call a tool again with a narrower filter.

**Missing.** The previous structured result is not available to the next turn. Prompt rule 30
deliberately prevents carrying a location/product/category/period from an earlier question unless
this question names it. That protects against stale scope, but it means “which ones are from
Samsung?” does not necessarily preserve the earlier low-stock filter. Replaying raw tool output is
not safe or bounded.

**Next slice.** Define a small, server-owned **previous result context** for follow-ups: a bounded,
signed/validated summary of the last answer's scope and ids, used only when the new question clearly
refers to it (“those”, “which ones”, “the same list”). The model must still re-read current data for
fresh quantities; cached ids are not evidence of current stock. If the referent is ambiguous, ask a
short clarifying question instead of guessing. Do not replay unbounded tool JSON.

**Accepted when.** A two-turn test proves a filter is retained only on an explicit referent; a new
question with a different scope does not inherit the old one; stale ids are re-read; an ambiguous
follow-up asks rather than answers the wrong set; tenant scoping remains server-derived.

### 5. Inventory comparison — priority 5

**Already working.** `getLocationBreakdown` answers “compare my locations” in one read, including
zero-stock locations and archived locations. `getProduct` plus per-location rows answers a named
product's distribution. History totals and top-out findings are computed over the matched set.

**Missing.** Two-product comparison, product-versus-minimum comparison, and “decreasing inventory”
are composed by the model. History records movements and signed deltas, but the assistant has no
computed trend/velocity object. A model must not turn one movement into a trend.

**Next slice.** Add deterministic comparison helpers for named products and for
current-versus-minimum. For “decreasing”, define an explicit window and use only recorded
outflows/transfers; state the window, the movement count and the fact that it is a recent-movement
observation, not a forecast. Never compare values in different currencies without keeping them
separate.

**Accepted when.** Comparisons use a single scoped read where possible; both sides are labelled;
missing fields are said to be missing; a decrease is reported only from recorded movements, with
its window; no cross-tenant or cross-currency arithmetic.

### 6. Inventory insights and recommendations — high priority, sequence 6

**Already working.** Reorder-needed, low/out-of-stock and dead-stock tools provide the facts for
restock priorities. The prompt forbids inventing a reason, a supplier or a quality claim, and the
assistant has no write tool.

**Missing.** Run-out-soon and excess-inventory insights require rules that do not exist yet. There
is no sales velocity, no configured excess threshold, and no monitoring score. “Needs closer
monitoring” is currently a human judgement, not a computed fact.

**Next slice.** Start with **restock priority** using facts already recorded: units below minimum,
out-of-stock status, and recent recorded outflow. Label the basis and the window. Add a run-out
estimate only when both stock and a defined outflow rate exist; otherwise say the data is
insufficient. Treat excess stock as a configurable rule, not a guess. Every output is a
recommendation with its evidence, and every action remains the member's.

**Accepted when.** No insight is generated from a missing field; a run-out estimate states its
window and does not pretend to be a guarantee; an excess recommendation states its rule; no
automatic stock change, purchase order or transaction is created; tests cover the
insufficient-data path.

### 7. Better error handling and transparency — priority 7, every release

**Already working.** Grounding re-asks stop an answer that has no read; a failed grounding becomes a
canned honest sentence. `OUTPUT_LIMIT` is annotated rather than hidden. Partial restock pages carry
a total and a qualification; the final text-only guard catches a false “full list” claim. Provider
errors map to member-facing copy through the error-code guide. Integrity monitoring is separate
from the assistant and currently fresh.

**Missing.** Transparency is shape-specific. A generic list answer does not always state that it is
a page. The final 4,000-character trim does not add its own notice. “Zero” and “unavailable” can
still be confused in prose, and a service failure's copy depends on the error path.

**Next slice.** Make completeness a renderable property of every list answer, not a sentence the
model must remember. Distinguish **zero matches**, **not recorded**, **not authorised**, and
**service unavailable** in the copy and tests. Mark a trimmed answer; never silently trim. Keep the
server-computed total authoritative when a page is shown.

**Accepted when.** Each degraded/partial/empty path has a test and member-facing copy; no path
shows an invented quantity; a page never claims to be complete; a failure says what failed without
exposing internal fields or secrets.

### 8. Inventory report summaries — priority 8

**Already working.** The assistant can read dashboard counts, catalogue/category counts and
location totals. A sentence such as “500 products, 25 low, 8 out” is possible from
`getInventorySummary`.

**Missing.** There is no single deterministic report object combining catalogue totals, low/out
counts, category split, location split and a stated reporting window. Multiple reads can disagree
if one is stale or scoped differently, and the model can omit a section.

**Next slice.** Define one bounded summary read or finalizer that returns the agreed sections from
one consistent snapshot. State the as-of time and the definitions (low = available at or below
minimum; out = available at or below zero). Do not add revenue or cost: the system records neither.
Keep category/location sections optional and explicit when empty.

**Accepted when.** A report fixture proves every count against known rows; counts reconcile
(healthy + low = active; low includes out where defined by the domain rule); the as-of time and
window are visible; a missing section is stated, not silently dropped; no revenue or cost is
invented.

## 3. Delivery order and release gates

The order below follows the owner's recommendation. Each slice is separately planned, tested,
documented and production-verified; do not merge two slices just because their code touches the
same file.

| Slice | Scope | Why now | Gate before the next slice |
|---|---|---|---|
| A | Answer actions: Copy Answer, verified Restock navigation, product navigation from server ids | The member already has the answer; they need to use it without retyping or hunting | Copy/navigation tests, AI-2 read-only scan, device proof |
| B | Complete-list paths and one paging pattern | Prevents the assistant from looking complete when it only saw a page | Boundary/total/search tests, no hidden matches |
| C | Remaining high-value deterministic answers | Accuracy is the product's trust boundary | Fixture-backed counts/rankings, partial-data refusal |
| D | Follow-up result context | Removes repetition without replaying stale facts | Two-turn scope/isolation tests |
| E | Comparisons and trends | Makes distribution questions actionable | Windowed, recorded-movement-only tests |
| F | Insights and recommendations | Turns facts into priorities, never writes | Insufficient-data tests, no write path |
| G | Report summaries | A consistent, explainable snapshot | Reconciliation and as-of tests |

As of 2026-11-16, **slices A, B and C are implemented, merged, deployed and device-verified**.
PR #304 merged as `af366c1`; OTA group `9d759ee5-82c5-4fbe-afe0-3a0ea2c44f6c` runs on the
installed app; production serves `e5c1c1d` after the auxiliary-list correction and AI-114. A and B
share the stored answer-actions shape and the mobile action controls; C adds the highest-stock
ranking, the whole-set restock shortfall and the deterministic complete restock list. The verbose
full-list limitation recorded in §27IE is closed.

**Cross-cutting gates, every slice:**

1. **Read-only:** no new write tool, no automatic stock change, no transaction or purchase-order
   creation. The AI-2 scan must stay green.
2. **Tenant isolation:** `businessId` comes from the authenticated server context, never from model
   arguments, a URL or the client.
3. **Grounding:** every number, name, id and location traces to a tool row from this turn or a
   server-owned current read. No model arithmetic when the server can compute it.
4. **Bounded work:** page sizes, output, context, iterations and payloads stay bounded; a new read
   must not turn one question into an unbounded catalogue scan.
5. **Honest failure:** empty, partial, unavailable and degraded are different states and have
   different copy.
6. **Tests:** unit coverage for the helper/finalizer, route/controller coverage where relevant, and
   a production/device check for user-visible navigation or copy.
7. **Documentation:** update this file's status, the owning specification or limit guide, the
   development log and a dated roadmap record.

## 4. Explicit non-goals

These stay out unless the owner separately approves a change to the read-only contract:

- AI-created or AI-edited products, stock, minimums, locations or suppliers.
- Automatic stock adjustments, transfers, purchase orders or transaction creation.
- A general-purpose SQL/query tool, arbitrary filters, or a model-supplied business id.
- Sending an entire catalogue to the model to “let it decide”.
- Revenue, profit, cost-of-goods or supplier-lead-time claims from data the system does not record.
- Forecasts presented as facts. A run-out estimate may be labelled as an estimate only after its
  input window and rule are defined.

## 5. Review checklist for the next increment

Before writing code for any item:

- [ ] Name the exact user outcome and the current evidence that it is missing.
- [ ] Confirm no existing tool or UI already delivers it; reuse before adding.
- [ ] Write the failure/empty/partial cases before the happy path.
- [ ] Decide what the server computes and what the model is allowed to phrase.
- [ ] Confirm the change adds no write capability and no client-side id/name matching.
- [ ] Add the smallest focused test set, then run the affected typecheck/lint.
- [ ] Record the slice in `DEVELOPMENT_LOG.md` and a dated `DEVELOPMENT_ROADMAP.md` record.
- [ ] After deployment, verify the member-visible path on the installed app, not only the API.
