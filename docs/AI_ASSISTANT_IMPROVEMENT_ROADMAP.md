# AI Assistant Improvement Roadmap

**What this file is.** The living plan for the Inventory AI assistant, newest review first. It
records the eight improvements the owner asked for, what already exists in the code, what is
missing, and the order in which the gaps should be closed. It is a **status and planning**
document, not a specification: behaviour is still owned by
[`SYSTEM_SPECIFICATION.md`](SYSTEM_SPECIFICATION.md), limits by
[`guides/18-ai-assistant-limits.md`](guides/18-ai-assistant-limits.md), and what shipped by the
roadmap records in [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md).

**Last reviewed:** 2026-11-20, against the read-only AI-118 audit, the bounded run-out read, the
DB-backed Phase 06 run-out turns, the approved six-paraphrase live run and the deterministic
coverage follow-up. The live run selected coverage somewhere in **5/6**, first in **0/6**, corrected
one wrong-tool draft, left one corrected turn ungrounded, and exposed one turn where coverage was
selected but the answer omitted the estimate. The follow-up now adds exact-name resolution with
ambiguity refusal and a finalizer that rebuilds a successful coverage answer with the estimate and
proxy caveat; model configuration is unchanged. The live run remains one sample; its full result is
in the audit §10 and roadmap §27KO, and the implementation is §27KQ. The earlier 2026-11-16 baseline was AI-114
merged as `e5c1c1d`, AI-115/AI-116 in the working tree, the production server at `e5c1c1d`, and the
production Android app on runtime `1.0.2` with OTA
`9d759ee5-82c5-4fbe-afe0-3a0ea2c44f6c`. AI-114 renders an explicit complete restock/low-stock
list deterministically, including an `OUTPUT_LIMIT` turn whose rows were complete; the production
phone returned **19 products / 721 units**, copied all 19, and returned **9 products / 272 units**
for the filtered list. AI-115 adds member ratings and the OWNER/ADMIN review queue. AI-116 adds the
bounded previous-result follow-up and the per-answer freshness/Inspect panel. Both are implemented
and covered by focused tests; deployment and the mirrored-phone pass are pending at this review.

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
| 4 | Better follow-up conversations | 4 | **Implemented — production-verified** | The server replays the last 20 USER/ASSISTANT messages (`AI_CONTEXT_MESSAGES`) and now stores a bounded membership set from the immediately previous answer. An explicit referent offers `filterPreviousResults`, whose first provider call is named as the required tool, and which re-reads current stock for exactly those products with the new category/location/stock filter; an old list-tool call is rewritten to it. A new question never inherits the old scope. Device proof: the fresh 19 products narrowed to **9** with `Filtered previous results` and `Category: Keyboards and Mice`. | The set is a flat product-id list capped at 100, not a general query cursor or a signed cross-turn query. A follow-up cannot add a filter the tool does not expose (for example a free-text search inside the previous set). |
| 5 | Inventory comparison | 5 | **Partial** | `getLocationBreakdown` compares all locations in one read; `getProduct` returns per-location stock; product-stock-by-location, history totals and the one-product coverage rate have deterministic answers; history rows distinguish direction and transfer legs. | No deterministic two-product comparison, no compare-to-minimum table, and no “decreasing inventory” verdict. A two-product trend must still be assembled by the model from movements; only `getProductStockCoverage` estimates one product's run-out. |
| 6 | Inventory insights and recommendations | High, sequence 6 | **Partial — run-out read added** | Reorder-needed, low/out-of-stock, never-sold and history tools support restock priorities and dead-stock observations. `getProductStockCoverage` adds a one-product, windowed run-out estimate from recorded stock-out movements (AI-118). Recommendations are explicitly read-only; no write tool exists. | No catalogue-wide velocity forecast, no configured excess-stock rule and no monitoring score. Stock-out is a movement proxy, not confirmed sales; supplier lead time and seasonality are not recorded. |
| 7 | Better error handling and transparency | 7 (cross-cutting) | **Implemented — residual hardening** | Grounding re-asks, degraded reasons, output-limit annotations, partial-list totals and the final restock completeness guard; AI-60 is 64/64. AI-116 adds retrieval time, sources, tools, product count and filters to every new answer, with Inspect for the details; an answer that read nothing says `No data read`. | Not every list shape gets a generic completeness marker; the 4,000-character trim does not add its own degraded marker; an unavailable service and a genuinely zero result rely on the answer copy. These are UX contracts to finish, not new AI writes. |
| 8 | Inventory report summaries | 8 | **Partial** | `getInventorySummary` returns active products, healthy/low/out counts, total on-hand quantity and recent activity; `getCatalogOverview` adds category counts; `getLocationBreakdown` adds per-location totals. | No single deterministic report read that guarantees one summary containing catalogue totals, low/out counts, category split, location split and the reporting window. The model currently composes it from up to three reads. |

**Important reading of the priority table.** Items 3 and 7 are marked high priority, but they are also
release gates for every slice: no new answer shape ships without grounded numbers, and no incomplete
answer ships without saying so. Their remaining dedicated work still follows the owner's sequence.
The sequence is a dependency order, not permission to defer correctness.

**Member feedback (delivered 2026-11-16).** Every assistant answer can be rated UP or DOWN. A
DOWN rating requires one of four reasons and accepts a bounded optional note; a member can change
their rating, which updates the one row per answer/member. OWNER and ADMIN review the
business-scoped queue through the existing `ai.metrics.view` capability, see bounded question and
answer excerpts, and mark an item REVIEWED. The message list returns only the caller's own
rating. Feedback is not a write to inventory, and it is deleted with its author's account and with
the tenant. The server coverage is `AI115-ai-feedback.test.mjs`; the footer and review UI are
covered by `ai115-answer-footer.test.tsx` and `ai115-feedback-review.test.tsx`.

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

**Implemented.** The controller loads the immediately previous assistant message's
`answerContext.resultProductIds` — a bounded membership set, never a quantity snapshot. Only an
explicit referent (`which of those`, `among them`, `narrow that list`) offers the read-only
`filterPreviousResults` tool, the follow-up's first provider call names it as the required tool,
and a model call to an old list tool on such a turn is rewritten to it before execution. The tool
re-reads current stock for those ids under the authenticated
business and applies only an exact category, location, low-stock/out-of-stock filter and a bounded
limit. A question without a referent gets a fresh read; an ambiguous referent has no set and falls
back to ordinary scoped retrieval. No raw tool JSON is replayed.

**Bound.** At most 100 ids, only the previous answer, only same-conversation, only with `ai.use`;
page and output limits are unchanged. Product ids stay server-side: the API returns provenance and
freshness, never `resultProductIds`.

**Accepted when.** A two-turn test proves a filter is retained only on an explicit referent; a new
question with a different scope does not inherit the old one; stale ids are re-read; an ambiguous
follow-up asks rather than answers the wrong set; tenant scoping remains server-derived.

### 5. Inventory comparison — priority 5

**Already working.** `getLocationBreakdown` answers “compare my locations” in one read, including
zero-stock locations and archived locations. `getProduct` plus per-location rows answers a named
product's distribution. History totals and top-out findings are computed over the matched set.

**Missing.** Two-product comparison and product-versus-minimum comparison are composed by the model.
History records movements and signed deltas, and `getProductStockCoverage` now computes one
product's windowed stock-out rate; there is still no two-product comparison object and no
catalogue-wide decreasing-inventory verdict. A model must not turn one movement into a trend.

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

**Implemented for the bounded case.** `getProductStockCoverage` (AI-118) returns current
availability, stock-out units and movement count for one identified product, the simple average
daily stock-out rate over a 7–365 day window, days of cover and a 30-day run-rate projection. It
states that stock-out is a movement proxy (sale, usage, damage or write-off), excludes transfers,
stock-in and adjustments, returns `daysOfCover: null` when the window has no movement, and refuses
a foreign or missing product/location instead of reporting a plausible zero.

**Still missing.** Catalogue-wide velocity/run-out ranking, a configured excess-stock rule and a
monitoring score. “Needs closer monitoring” remains a human judgement, not a computed fact. Treat
excess stock as a configurable rule, not a guess; every output is a recommendation with its
evidence, and every action remains the member's. The 2026-11-21 stock-coverage candidate ranking
(evidence gate, days-to-minimum, catalogue-wide run-out and six further items) is in
[`BACKLOG.md`](BACKLOG.md) §5; none is implemented.

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

**Implemented for answer provenance.** Every new stored answer carries `answerContext` with the
retrieval time, tool names, source classes, product count, total/hasMore, the filters the tool
actually applied, and up to ten cited web sources — never tool payloads or result ids. The compact
footer line names the sources and count; **Inspect** shows the timestamp, tools, filters and URLs.
An answer that read no data says `No data read`. Legacy messages keep the old `Read:` label.

**Residual.** Transparency is still shape-specific. A generic list answer does not always state that
it is a page. The final 4,000-character trim does not add its own notice. “Zero” and “unavailable”
can still be confused in prose, and a service failure's copy depends on the error path. The
provenance line describes what was read; it does not by itself prove completeness.

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

As of 2026-11-20, **slices A, B and C are implemented, merged, deployed and device-verified**;
**slice D (follow-up result context)** and the answer-provenance part of item 7 are implemented with
focused tests, and the member-feedback slice is implemented end to end. The bounded run-out read in
slice F (`getProductStockCoverage`) is implemented with focused tests; catalogue-wide forecasting,
excess-stock rules and monitoring remain open. Deployment, OTA and the
mirrored-phone pass for AI-115/AI-116 are the remaining gate.
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
- Forecasts presented as facts. `getProductStockCoverage` is the one permitted run-out estimate:
  it labels its window, input movement type and estimate boundary, and returns no estimate when
  the window has no recorded movement. A catalogue-wide forecast or an excess-stock verdict still
  requires an approved rule.

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

## 6. Ranked follow-up opportunities (2026-11-20)

This list is research only except the bounded evaluation harness added for item 1: **no feature,
model, provider or production setting is changed by that harness**, and the remaining items are not
implemented in this increment. It ranks work by member value, evidence in the current
code and the dependency that must be cleared first. Priority `P0` is a verification gate rather than
a product feature; `P1` is the next high-value tranche; `P2` needs a policy, data or mobile decision;
`P3` needs a new data model or delivery surface.

| Rank | Improvement | Priority | Benefit | Dependency / gate |
|---:|---|---|---|---|
| 1 | **Live-model coverage paraphrase evaluation.** The bounded `eval:stock-coverage` harness runs six run-out/cover/“how long” paraphrases against the configured model and records the first and all tools used, plus whether the corrective re-ask fired. The 2026-11-20 run captured **0/6 first-choice, 5/6 anywhere, 1 corrected draft, 1 ungrounded**, plus one selected-but-unused estimate; see below and audit §10. | P0 | The DB-backed `Q7`/`Q8` turn proves the offer → correction → execution → persistence path with a scripted provider; it cannot prove a live model picks the right tool. The 2026-11-20 result supplies the missing evidence: 5/6 anywhere and 0/6 first for these six name questions, with one selected-but-unused answer. It does not establish a production selection rate. The follow-up (§27KQ) implements the finalizer and exact-name path; repeat live runs remain. | An explicitly approved live run with the existing key/model and the six-question cap. Keep it out of default CI; never change the production model to make it pass. |
| 2 | **Deterministic two-product comparison and current-versus-minimum comparison.** One scoped read or finalizer labels both sides, missing fields and the comparison basis. | P1 | Removes the last common model-composed arithmetic shape; makes “compare A and B” and “how far below minimum?” exact and testable. | Existing `getProduct`, inventory availability and `unitsBelowMinimum`; currency values must stay separate unless a verified rate exists. |
| 3 | **Catalogue-wide run-out ranking.** Rank ACTIVE products by days of cover or projected need using one bounded aggregate, with an explicit stock-out-proxy rule. | P1 | Turns the one-product coverage read into a restock-priority list without N+1 product reads; answers “what will run out first?” with evidence. | A product/business-wide aggregation, a fixed window and a minimum-movement rule so a single stock-out cannot define a trend. Do not add seasonality or lead time. |
| 4 | **One consistent inventory report snapshot.** Return catalogue totals, low/out counts, category and location splits, the as-of time and definitions in one object. | P1 | Prevents sections read at different moments from disagreeing and gives report questions one deterministic source. | Existing dashboard/inventory aggregates; an agreed definition of low versus out and a stated snapshot boundary. |
| 5 | **Generic completeness and degraded marker.** Every paged, trimmed or partial answer says so, not only the shapes with a dedicated finalizer. | P1 | Closes a trust gap: a truncated page or a 4,000-character trim must not read as complete. | A shared answer-completion seam and tests for every list/finalizer path; the marker must not turn a complete answer into a partial one. |
| 6 | **Search within a previous answer / bounded cursor.** Let a follow-up search or page the captured result set instead of re-reading the catalogue. | P2 | Makes “search those results” and “show the next rows” work after the turn; keeps context small and avoids repetition. | The stored `answerActions`/result-set shape, a server-side re-read, and a bounded cursor or query. Never resolve names or ids on the client. |
| 7 | **Currency-safe product comparison.** Compare recorded prices only within one currency, or through the existing verified rate provenance. | P2 | Prevents a plausible but wrong cheapest/dearest answer across currencies; makes the limitation visible when no rate exists. | Product currency is required, but many legacy values may still be unresolved; the FX path must keep its rate date and source. |
| 8 | **Supplier and purchase-order-aware restock recommendation.** Show open commitments and recorded supplier terms beside the shortage, with no order creation. | P2 | A recommendation becomes actionable without double-ordering; the assistant can explain what is already on the way. | Read-only supplier terms and open-PO reads; AI V1 must stay write-free, and a missing term must be stated, not guessed. |
| 9 | **Configurable excess-stock rule.** A tenant-set threshold or days-of-cover ceiling, stated with every overstock observation. | P2 | Adds the missing counterweight to restock advice without inventing a rule from a ranking. | A product/business configuration and an owner-approved default; no recommendation may silently use a guessed threshold. |
| 10 | **Scheduled digest or proactive alert.** A bounded daily/weekly summary delivered through an approved channel. | P3 | Moves the assistant from pull to timely attention for owners and managers. | A scheduler, a delivery surface, consent and deduplication; no AI write and no unbounded cross-tenant scan. |
| 11 | **Confirmed sales reason on stock-out.** Record a reason (sale, usage, damage, write-off) so demand and loss can be separated. | P3 | Stock-out is currently a proxy; this would make true demand and shrink analysis possible without statistical guesses. | A schema/migration and a member-facing reason field; historical rows remain unknown and must not be relabelled. |
| 12 | **Voice input and bounded file export.** Speech-to-text for the member's question and CSV/PDF export of the stored answer or captured rows. | P3 | Improves field use and sharing; neither changes the read-only answer logic. | A mobile dependency and privacy review for voice; a file/share and PDF path for export. Not server-side AI features. |

### 2026-11-20 live result and revised order

The approved run used the configured `openai/gpt-oss-20b` primary with two fallbacks and a
disposable development tenant. It is one six-question sample, not a benchmark, and the harness
exited 1 by design because coverage was not selected in every turn. The important outcomes are
behavioural, not a score: at the time, a name question could not select coverage first because the
tool accepted only id/SKU/barcode (now fixed by the exact-name path); one corrected turn still failed
to select it and correctly degraded; and one
turn selected coverage but stored only a quantity, so the member never saw the estimate. Only one
of the five grounded answers explicitly explained that stock-out is not confirmed sales.

**Implemented in the 2026-11-20 follow-up (§27KQ):** the deterministic coverage finalizer builds
the days-of-cover answer (or the explicit no-rate outcome) and proxy caveat from a successful tool
result; `getProductStockCoverage` now accepts an exact recorded product name and refuses ambiguous
or partial names; and the evaluator separates selected, succeeded and finalized/used coverage and
judges the caveat semantically. The model configuration was not changed. Q7/Q8 remain in place,
with Q7b/Q7c retained and Q7d/Q7e added for the missing-estimate and missing-caveat paths.

**Revised remaining priorities:**

1. **Catalogue-wide run-out ranking (existing #3, P1).** One bounded aggregate with an explicit
   minimum-movement rule. Why: “what will run out first?” is the operational question; N+1 product
   reads are not.
2. **Two-product and current-versus-minimum comparison (existing #2, P1).** Both labelled sides,
   missing fields and the comparison basis from one read. Why: comparison remains the last common
   model-composed arithmetic shape and must keep currencies separate.
3. **Repeated bounded selection ledger (new, P2).** The harness now records selected, succeeded,
   finalized/used and selected-but-unused outcomes with semantic caveat judgement. Repeat approved
   runs outside CI without changing the model; one sample cannot establish a trend.
4. **Search/page within the previous answer (existing #6, P2).** A bounded cursor or query over the
   captured result set. Why: follow-ups currently re-read the catalogue they already saw.
5. **Supplier/PO-aware restock (existing #8, P2).** Read-only commitments and recorded terms beside
   the shortage. Why: prevents double-ordering without adding a write path.
6. **Confirmed stock-out reason (existing #11, P3).** Sale/usage/damage/write-off needs a schema;
   historical rows stay unknown.
7. **Scheduled digest or proactive alert (existing #10, P3).** Needs a scheduler, delivery surface,
    consent and deduplication.

**Sequencing rule.** The live evaluation is complete; it does not prove production selection or
answer quality. The finalizer, exact-name route and semantic evaluator are implemented and focused
tests pass. Catalogue-wide ranking and comparison follow the remaining accuracy/transparency gates;
the repeated ledger, supplier/PO work and the P3 items need a product/data-boundary decision, a
schema or a delivery surface. None is a reason to weaken the read-only rule, tenant isolation or the
existing permission gates.
