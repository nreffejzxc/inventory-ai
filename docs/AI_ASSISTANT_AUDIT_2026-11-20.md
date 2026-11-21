# Inventory AI Assistant — audit and status, 2026-11-20

**Status:** audited and implemented in the working tree; the scripted turn regressions and one
approved six-paraphrase live run were completed on 2026-11-20. **Not committed or deployed.** The
assistant remains read-only under `CLAUDE.md` §AI V1. `Q7` now starts with a wrong `getProduct`
choice and proves the single corrective re-ask before the answer; `Q7b` covers a no-tool first
draft and `Q7c` covers a second miss, while Q8 keeps the no-history null-cover behaviour. The live
run selected coverage somewhere in 5/6 paraphrases, first in 0/6, corrected one draft and exposed
one selected-but-unused estimate. The follow-up adds Q7d/Q7e for missing estimates/caveats, exact-name
coverage resolution with ambiguity refusal, and a deterministic coverage finalizer; see §10. This
record is the evidence behind the feature matrix;
`SYSTEM_SPECIFICATION.md` owns behaviour and
[`guides/18-ai-assistant-limits.md`](guides/18-ai-assistant-limits.md) owns limits.

## 1. Method

The audit read the actual request path rather than relying on the feature list:

- HTTP/SSE and persistence: `server/src/routes/ai.routes.ts`, `controllers/ai.controller.ts`,
  `models/aiConversation.model.ts`, `models/aiMessage.model.ts`.
- Turn loop, routing, model selection, grounding and finalizers: `services/ai/ai.service.ts`,
  `simpleInventory.ts`, `aiConfig.ts`, `answerContext.ts`, `answerCompletion.ts`, `language.ts`,
  `webCapabilities.ts`, `webResearch.ts`, `marketPrices.ts`, `freeWeb.ts`.
- Every tool definition and executor: `services/ai/tools.ts`.
- The services each tool calls: `product.service.ts`, `inventory.service.ts`,
  `transactions.service.ts`, `dashboard.service.ts`, `reference.service.ts`.
- Mobile entry points and presentation: `components/AiChat.tsx`,
  `components/AssistantPromptCard.tsx`, `app/(app)/ai/index.tsx`, `app/(app)/ai/new.tsx`.
- The existing AI regression suites, including AI-2 (read-only scan), AI-14/AI-15/AI-16
  (references), AI-18 (paging), AI-60 (grounding), AI-113 (ranking), AI-116 (follow-up context).

No production data was read. The database-backed tests ran against `inventoryai_test_db`.

## 2. Tool inventory

Every tool receives the authenticated context `{ businessId, userId, role }`; `businessId` is never a
model argument. Every schema sets `additionalProperties: false`. A refused or failed call is a
structured soft result, not a crash. No tool writes.

| Tool | Purpose | Read / scope | Permission |
| --- | --- | --- | --- |
| `searchProducts` | Find a product by name, brand, SKU or barcode; description/specification fallback | Business products; optional category/status; page bounded to 25 | `products.view` |
| `findProducts` | Discovery across everyday synonyms, stock included; price ranking/ceiling | Business products; ACTIVE only; page bounded to 25 | `products.view` |
| `getProduct` | One product by **exactly one** of id/SKU/barcode, full description and per-location stock | Business product; inventory rows capped at 20 with a partial-page note | `products.view` |
| `getInventory` | Inventory rows with on-hand, reserved and available; product/location/stock filters | Business inventory; page bounded to 25; archived rows retain status | `inventory.view` |
| `getProductStockCoverage` | **AI-118:** one-product run-out estimate from recorded `STOCK_OUT` | Business product, optional location, 7–365 day window; whole-set aggregate | `inventory.history.view` |
| `filterPreviousResults` | Narrow the immediately previous answer’s product set | Only server-captured product ids; re-reads current stock; max 100 ids/50 rows | `inventory.view` |
| `getHighestStockProducts` | Server ranking by available quantity | ACTIVE products; all locations or one; top 25 plus whole-set count | `inventory.view` |
| `getLowStockProducts` | ACTIVE products at/below configured minimum | All locations or one; whole-set count; computed gaps | `inventory.view` |
| `getOutOfStockProducts` | ACTIVE products with available ≤ 0 | All locations or one; whole-set count | `inventory.view` |
| `getProductsNeverSold` | Dead-stock question: no stock-out in the requested scope | ACTIVE products minus the whole ledger’s stock-out ids; optional location/from | `inventory.view` |
| `getReorderNeededProducts` | Restock list with stock status and whole-set shortfall | ACTIVE products; whole-set count and summed gap | `inventory.view` |
| `getStockValue` | Value at recorded selling price, grouped by currency | ACTIVE products; optional location/category; unpriced reported separately | `inventory.view` |
| `getCatalogOverview` | Active catalogue, category counts and brand/description coverage | Business products; no stock or price | `products.view` |
| `getInventorySummary` | Dashboard health counts and recent logical movements | Business dashboard; one grouped transfer event | `dashboard.view` |
| `getLocationBreakdown` | Products/units per location, including empty/archived locations | Business inventory and locations; one aggregate | `dashboard.view` |
| `getInventoryHistory` | Movements, transfers, window totals, top-out ranking and out-of-window fallback | Business ledger; product/location/type/time filters; page 50 | `inventory.history.view` |
| `getProductsByLocation` | **ACTIVE** products stocked at one location | Business products/stock; one location; page 50 | `inventory.view` |
| `listLocations` | Location ids/names; ACTIVE by default | Business locations; optional archived/query | `inventory.view` |
| `listCategories` | Category ids/names; ACTIVE by default | Business categories; optional archived/query | `products.view` |
| `listBrands` | Brands recorded on ACTIVE products with counts/samples | Business products; optional category/query | `products.view` |
| `researchInventoryProducts` | Web evidence for 1–8 recorded, active products | Business product ids only; external sources are cited | `products.view` |
| `researchMarketPrices` | Cited marketplace prices for 1–3 recorded, active products | Business product ids only; no invented price or conversion | `products.view` |

### Validation and isolation

- Unknown keys (including `businessId`, role and Mongo operators) are rejected before execution.
- ObjectId patterns, enums, string lengths, integer ranges and ISO date-times are checked at the
  boundary. `days` is 7–365; page limits are those in Guide 18.
- Reference names resolve only as EXACT, ACTIVE records of the caller’s business; an ambiguous name
  returns both candidates, and passing both id and name is refused.
- Product identifiers in research tools are loaded through the business-scoped product read and
  archived/foreign/missing products are refused before any external request.
- Every service query is scoped by `ctx.businessId`; a foreign id is an empty/`found:false` result,
  never another tenant’s row.
- Errors are logged without payloads or secrets and become `TOOL_ERROR` for the model. An aborted
  turn is rethrown instead of being offered another provider round.

### Selection and use

The prompt distinguishes the overlapping reads rather than leaving the model to guess:
`searchProducts`/`findProducts` for discovery, `getProduct` for one identified product, `getInventory`
for raw rows and `getProductStockCoverage` for one product's run-out. The list tools carry the
whole-set count and a partial-page marker, and the prompt requires that marker to be quoted instead
of calling a page complete. References (`location`, `category`) are accepted by name so the model
does not have to spend a round trip on `listLocations`/`listCategories`; an ambiguous name returns
the candidates. Deterministic routing and finalizers cover the highest-stock, restock and
dead-stock shapes and render their figures from the tool payload rather than asking the model to
re-add a page; coverage is a structured payload with its window and basis, and the prompt requires
both to be quoted.

This is verified at four levels: the wire-level catalogue test (the exact 22 tool names and strict
schemas), the executor tests (arguments, isolation, arithmetic), the prompt tests (coverage rule
present, proxy boundary stated), and the DB-backed Phase 06 turn regressions (`Q7`, `Q7b`, `Q7c`,
`Q8`). Those turns go through the real HTTP route, tool loop, MongoDB reads, answer persistence and
provenance: the provider is offered `getProductStockCoverage`, the turn executes it, and the stored
answer keeps the proxy caveat; a no-history product keeps `daysOfCover: null` and refuses to invent
a rate. **The provider is scripted**, so this proves the offer → correction → execution →
persistence contract, not that a live model chooses coverage for every paraphrase. `Q7` first asks
for `getProduct`; `Q7b` writes a forecast-shaped sentence with no tool call; both receive the one
corrective re-ask and then execute coverage. `Q7c` proves a second miss ships the honest ungrounded
sentence. The free simple route deliberately does not recognise run-out wording, so it escalates to
the tool-capable route instead of answering from the free prompt. `npm run eval:stock-coverage` is
the bounded, opt-in live selection check; the 2026-11-20 run is recorded in §10. It records
first/all tool choices without changing model configuration and is not part of default CI.

## 3. Defects found and fixed

| Finding | Why it mattered | Fix |
| --- | --- | --- |
| `getProductsByLocation` listed archived products as current stock | A member could be told a retired product was available on a shelf; the Restock screen and other stock lists are ACTIVE-only | Added `status: 'ACTIVE'` and stated the exclusion in the tool description; AI-118 covers it |
| `getProduct` accepted several identifiers and `getByIdentifier` silently preferred the id | A call carrying both a stale id and the SKU the member named could return a different product | The executor now requires exactly one non-empty identifier; AI-118 and the Phase 06 tool suite cover it |
| `getProductsNeverSold` said “no stock-out at all” while supporting a bounded `from` window | Wording could make a period-scoped answer sound whole-ledger | Description now distinguishes the period scope from the ledger-wide default |

No write path, new provider, model configuration or production migration was added.

## 4. Feature status

| Area | Feature | Status | Evidence / remaining boundary |
| --- | --- | --- | --- |
| Core | Smart Inventory Query | **Fully implemented** | Free simple route plus paid tool-capable route; grounded tools and deterministic finalizers. Not every phrasing has a finalizer. |
| Core | Product Lookup | **Fully implemented** | Name/brand/SKU/barcode search, exact one-product read, current stock per location. |
| Core | Low Stock and Restock Assistant | **Fully implemented** | ACTIVE-only lists, location scope, computed `unitsBelowMinimum`, whole-set count/shortfall, Restock navigation. |
| Core | Inventory Analytics | **Partially implemented** | Summary, value, location, category/brand and movement analytics exist. Revenue/profit/margin are unavailable because the system records neither. |
| Core | Conversation Context / Memory | **Fully implemented** | Conversations and messages are owner/business scoped; last 20 messages replayed; previous result set bounded to 100 ids. |
| Core | Suggested Questions | **Fully implemented** | Five static prompt chips and contextual product/stock entry cards. They are not personalised by live inventory. |
| Core | Follow-up Questions | **Fully implemented** | Explicit anaphora only; category/place/low/out-of-stock filters; current stock re-read; no quantities travel. |
| Operations | Inventory Transaction Assistant | **Partial — read-only by design** | History, movement totals, transfers and window fallback. Creating/adjusting stock is deliberately unavailable under AI V1, so “confirmation before a write” has no write path to protect. |
| Operations | Inventory Audit / Discrepancy Assistant | **Not implemented; not applicable to AI V1** | The write model refuses negative stock and duplicate rows; the internal integrity monitor is an operator-only rule set, not a tenant-facing discrepancy source. Exposing it needs an approved product definition. |
| Operations | Stock Movement Analysis | **Fully implemented** | Whole-set totals, top-out, logical transfer folding, type/window filters and honest empty-window fallback. |
| Operations | Purchase Recommendations | **Partial** | Minimum-gap restock recommendations only. Supplier terms, lead times, open purchase-order commitments and order optimisation are not AI tools. |
| Operations | Automatic Inventory Reports | **Not implemented** | No scheduler or single report object; summaries are composed from reads per question. |
| Predictive | Demand Forecasting | **Partial — bounded run-out added** | `getProductStockCoverage` estimates one product’s days of cover from recorded stock-out. No catalogue-wide forecast, confirmed-sales history, seasonality or lead time. |
| Predictive | Dead Stock Detection | **Fully implemented** | ACTIVE products without stock-out; optional period and location; stock-out is explicitly not proof of a sale. |
| Predictive | Overstock Detection | **Not implemented** | No configured excess threshold or approved rule. `getHighestStockProducts` is a ranking, not an overstock verdict. |
| Predictive | Proactive Alerts | **Not implemented in AI** | Operational integrity/health alerting exists outside the assistant; there is no AI alert delivery or subscription. |
| Predictive | Anomaly Detection | **Not implemented** | No statistical baseline or trained rule; the existing integrity monitor is deterministic operations tooling, not an AI anomaly claim. |
| Advanced | Multi-Warehouse Intelligence | **Fully implemented (read-only)** | Per-location breakdown, location-filtered low/out/restock/coverage/history and transfer-aware events. No transfer optimisation or write action. |
| Advanced | Product Comparison | **Partial** | The model can call `getProduct` for each named product and compare recorded fields/stock; no deterministic two-product comparison object. |
| Advanced | Report Export | **Partial** | Copy Answer exports the complete stored answer as plain text. No CSV/PDF/file attachment or scheduled delivery. |
| Advanced | Voice Input | **Not implemented** | The app has no speech-recognition dependency or in-app microphone path; keyboard dictation is OS-level only. |
| Advanced | Multilingual Support | **Partial** | Prompt enforces English, Tagalog/Filipino and Bisaya/Cebuano and preserves recorded names/numbers. No UI locale or verified coverage of other languages. |

## 5. Reliability and safety

- **Source of truth:** stock, products and movements come from tenant-scoped Mongo reads through the
  same services as the app. Calculations use database aggregates or a single service read, not page
  addition.
- **No fabricated results:** missing/foreign/ambiguous records are soft refusals; empty windows return
  an explanatory note; stock-out is labelled a movement proxy, never sales.
- **Permissions:** the route requires `ai.use`; each tool repeats its own read permission before its
  executor. STAFF may read inventory/history but not dashboard-only summary/breakdown; the refusal is
  a normal tool result.
- **Tenant isolation:** `businessId` comes only from the authenticated session; no tool schema has a
  tenant field. Research is restricted to loaded product ids.
- **Writes:** no tool writes, and AI-2 scans the table for write-shaped service calls. AI V1 has no
  confirmation flow because it has no mutating operation.
- **Model strategy:** unchanged. Simple inventory questions may start on the configured free route;
  complex analysis uses the configured primary; web research is gated separately. No model id,
  fallback or reasoning setting changed in this pass.
- **Persistence:** SSE `done` is authoritative; the stored message and answer context are written only
  after a successful turn. Conversations/messages are loaded by conversation id plus business/user
  scope.

## 6. Verification

Executed during this pass:

```text
cd server && npm run typecheck
cd server && TEST_MODE=unit node --test test/AI2-ai-readonly-tools.test.mjs test/AI118-stock-coverage.test.mjs
cd server && TEST_MODE=db node --test test/AI118-stock-coverage.test.mjs
cd server && TEST_MODE=db node --test test/phase06-ai-tools.test.mjs
cd server && TEST_MODE=db node --test test/phase06-ai-behavior.test.mjs
cd server && npm run eval:stock-coverage -- --validate-only
cd server && npm test -- --test-concurrency=4
```

The complete run after the OpenRouter catalogue fix and the new turn regression completed **3,297
tests / 537 suites: 3,296 passed, 1 failed**. The one failure was PLAT-8’s race fixture: its child
process could not connect to MongoDB (`MongooseServerSelectionError` after 15 s), so the suite
reported `race fixture failed (code 1)` before its assertions ran. There were no AI or
stock-coverage assertion failures and no code failures. The fixture passed **1/1** when rerun alone.
The earlier run completed **3,277 tests / 535 suites: 3,274 passed, 3 failed**.
One failure was a real omission — the all-tools OpenRouter test still listed the old 20 callable
tools; adding `getProductStockCoverage` to that workload makes the focused rerun pass. The other two
were remote MongoDB connection timeouts (`DEMO-4` and `PLAT-8`); `DEMO-4` passed on an individual
rerun, while `PLAT-8` failed on two reruns because its child fixture could not establish a
connection (an Atlas replica set temporarily reporting no primary, then TLS socket timeouts).
Neither touches the AI code path.

A follow-up review added the narrow run-out intent guard and one corrective re-ask; `Q7` now starts
with a wrong `getProduct` choice and proves coverage is executed before the answer. The bounded
`eval:stock-coverage` harness was added and its `--validate-only` path passed for all six paraphrases
without a provider or database call. Focused AI-118 results were **5/6 unit with the DB suite
skipped** and **8/9 DB with the unit suite skipped**; Phase 06 behaviour passed **14/14**. The
complete server suite then passed **3,311/3,311 tests across 538 suites**, with **0 failures, 0
skips and 0 cancelled** (exit 0, `--test-concurrency=2`, 1,840,452.9 ms).

**2026-11-20 follow-up.** Added Q7b (no-tool first draft) and Q7c (second miss); Phase 06 now passes
**16/16**; AI-118 unit mode passed **5 with 1 skipped** and DB mode **8 with 1 skipped**; typecheck,
focused ESLint and documentation tests **31/31** passed. The approved six-paraphrase live run
completed against the configured `openai/gpt-oss-20b` primary with two fallbacks, a disposable
development tenant, and no configuration change. Coverage was selected somewhere in **5/6**, first
in **0/6**; one corrected turn stayed ungrounded; one selected turn stored only a quantity. The
harness exited **1 by design** for the incomplete selection, with **0 errors** and **0 infinite-cover
claims**. Full detail and the limitation that this is one sample are in §10. The feature was still
**not** exercised against production or the installed phone.

## 7. Files changed in this audit

| Area | File | Change |
| --- | --- | --- |
| Tool | `server/src/services/ai/tools.ts` | Coverage tool with exact id/SKU/barcode/name resolution and ambiguity refusal; active-only location stock; corrected dead-stock wording |
| Service | `server/src/services/inventory.service.ts` | `productAvailability` whole-set aggregate |
| Product lookup | `server/src/services/product.service.ts` | Business-scoped, anchored exact-name lookup (at most two candidates) |
| Prompt/context | `server/src/services/ai/ai.service.ts` | Coverage prompt rule, exact-name guidance, inline coverage capture, one corrective re-ask and deterministic finalizer |
| Intent guard/finalizer | `server/src/services/ai/answerCompletion.ts` | Narrow run-out detector plus the deterministic estimate/caveat answer |
| Provenance | `server/src/services/ai/answerContext.ts` | Coverage source labeling and `days` Inspect filter |
| Tests | `server/test/AI118-stock-coverage.test.mjs` | New unit + DB regression suite |
| Tests | `server/test/phase06-ai-behavior.test.mjs` | DB-backed run-out turns: wrong first tool, no-tool first draft, second miss, missing estimate, missing caveat, corrective re-ask, and no-history turn |
| Tests | `server/test/AI118-stock-coverage.test.mjs` | Exact-name resolution, partial/duplicate/foreign refusal, plus the original coverage arithmetic |
| Tests | `server/test/eval-stock-coverage-metrics.test.mjs` | Pure semantic-caveat and selected/succeeded/used metric tests; no paid call |
| Evaluation | `server/scripts/eval-stock-coverage.mjs`, `server/scripts/eval-stock-coverage-metrics.mjs`, `server/package.json` | Bounded opt-in live evaluator with separate selection/success/use and semantic caveat metrics; no model/config change |
| Tests | `server/test/AI2-ai-readonly-tools.test.mjs` | Read-only allowlist for the new service methods |
| Tests | `server/test/phase06-ai-tools.test.mjs` | 22-tool catalogue and exact-identifier error |
| Tests | `server/test/phase-openrouter-provider.test.mjs` | 22-tool wire workload |
| Test runner | `server/scripts/run-tests.mjs` | Classifies AI-118 as mixed |
| Docs | `docs/AI_ASSISTANT_AUDIT_2026-11-20.md` | This record |
| Docs | `docs/SYSTEM_SPECIFICATION.md`, `docs/guides/18-ai-assistant-limits.md`, `CLAUDE.md` | Tool contract, limits and AI V1 inventory |
| Docs | `docs/AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`, `docs/README.md`, `docs/DEVELOPMENT_LOG.md` | Status, index/review dates and session record |

No mobile file, provider configuration, model id, dependency or database migration was changed for
this audit.

## 8. Manual checks

Start the API with `cd server && npm run dev` and the app with `cd mobile && npm start`; sign in as
an OWNER on a tenant that already has products, stock and at least one stock-out movement. The
provider key/model must be the one already configured for the environment — this change adds no
model or key.

1. Open **AI Assistant** and ask **“How long will [product name] last?”** (or by SKU). Expect a current
   available quantity, the lookback window, stock-out units, an estimate of days of cover and the
   proxy caveat. Cross-check the figures in **Inventory History**.
2. Ask the same question **“at [location]”**. Expect the location’s own availability and stock-out
   rate, not the business-wide values.
3. Ask about a product with no stock-out in the window. Expect “no rate can be estimated” and no
   infinite or invented forecast.
4. Open **Products**, archive a stocked product, then ask what is at that shelf. Expect it to be
   absent from the location answer and still readable through an explicit archived-product lookup.
5. Ask for a product using a SKU and an obsolete id in the same request. Expect a refusal rather than a
   silent product substitution.
6. Ask in Tagalog or Bisaya, then **“which of those are low?”** Expect the previous set to be re-read
   at current stock and the language to remain the member’s.

## 9. Remaining work

The live evaluation is captured in §10; the ranked follow-up list, with benefits, dependencies and
priorities, is kept in
[`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) §6. The deterministic
coverage finalizer, exact-name resolution and semantic evaluator are implemented in the follow-up
recorded in §10; the remaining accuracy work is catalogue-wide run-out ranking, two-product
comparison and a repeated selection ledger.
A deterministic two-product comparison, a catalogue-wide run-out ranking with an explicit rule, and
a single consistent report object remain the next accuracy tranche. Supplier lead time, confirmed
sales, cost basis, revenue and true demand history are not recorded, so the assistant must continue
to say so rather than infer them. Voice input and file export require a separate mobile/product
decision; automatic reports and proactive alerts require a scheduler and a delivery surface that do
not exist. The original audit did not implement the ranked ideas; the 2026-11-20 follow-up
implements the first three (finalizer, exact-name coverage and semantic evaluator).

## 10. Live coverage evaluation — 2026-11-20

**Configuration and boundary.** `AI_TEST_ALLOW_PAID_MODELS=true npm run eval:stock-coverage` used
the configured OpenRouter primary `openai/gpt-oss-20b` and its two configured fallbacks. It changed
no model, fallback, reasoning or web setting. It ran against the development database with a
disposable tenant seeded from the demo fixture (14 products, 22 stock rows, 30 movements), then
removed that tenant in `finally`. The six questions are fixed run-out paraphrases; no question
invoked web research. The process exited **1 by design** because coverage was not selected in all
six turns; there were **0 errors** and no infinite-cover claims. The recorded turn cost was about
**$0.007846**.

| Question | First tool | All tools | Coverage | Corrected | Outcome |
| --- | --- | --- | --- | --- | --- |
| `how-long` | `searchProducts` | `searchProducts` | not selected | yes | **ungrounded** after one correction; no coverage call |
| `days-of-cover` | `findProducts` | `findProducts`, `getProductStockCoverage` | later | no | 45 days from the 30-day stock-out window |
| `run-out-soon` | `findProducts` | `findProducts`, `getInventory`, `getProductStockCoverage` | later | no | 10 pcs, 3 units out / 30 days, about 100 days |
| `stock-coverage` | `searchProducts` | `searchProducts`, `getProductStockCoverage`, `getInventory` | later | no | **12 units on hand only; estimate and caveat omitted** |
| `until-runs-out` | `searchProducts` | `searchProducts`, `getProductStockCoverage` | later | no | 32 units, 0.27 units/day, about 120 days |
| `longer-at-rate` | `findProducts` | `findProducts`, `getProductStockCoverage` | later | no | 8 units, 0.067 units/day, about 120 days; explicit stock-out caveat |

Harness summary: **first-read coverage 0/6; coverage anywhere 5/6; corrected by re-ask 1; errors
0; exact proxy-caveat phrase 0/6; infinite-cover claims 0.** The exact-phrase metric is narrower
than the answers. Manual reading found **1 of the 5 grounded answers** explicitly stating that
stock-out includes sales, usage, damage or write-offs; three named the stock-out/outflow basis
without that boundary, and `stock-coverage` omitted the estimate entirely. The new evaluator
uses a semantic detector: on this artifact it counts that one Samsung answer as a proxy caveat,
while preserving the recorded exact-phrase figure above. The artifact predates the new
succeeded/used row fields, so those are unknown/null when it is recomputed; only selection and the
semantic caveat are reconstructable. Calls per turn were 3–5 and latency was 5.6–45.8 seconds.

**Findings.** At the time of the run, first-choice selection was structurally unlikely for name
questions because `getProductStockCoverage` accepted only an id, SKU or barcode; every live question
named a product, so the model had to search first. Coverage selection is not answer utilization: `stock-coverage`
read the tool and then stored a quantity-only answer. One correction can fail (`how-long`) and the
turn then correctly degrades. The movement-proxy caveat is not reliably repeated by the model. The
run is one six-question sample, not a selection-rate guarantee or a statistical benchmark.

**Resulting priorities.** (1) deterministic coverage answer/finalizer — **implemented in the
follow-up**; (2) a name-resolving one-call coverage path — **implemented**; (3) enforced proxy
caveat at the answer boundary — **implemented**; (4) catalogue-wide run-out ranking; (5) two-product
and current-versus-minimum comparison; (6) repeated bounded selection ledger — the harness now
records selected/succeeded/finalized-used and semantic caveats, but repeat runs remain pending;
(7) search/page within the previous answer; (8) supplier/PO-aware restock. Confirmed sale reasons
and scheduled digests remain later because they need a schema, scheduler or delivery surface. The full reasoning and benefit statement is in
[`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md) §6.

**Follow-up implementation (working tree, not deployed).** The recorded artifact remains unchanged;
re-reading it confirms 0/6 first, 5/6 anywhere, 1 correction, 0 errors, 14/22/30 fixture counts,
$0.007846 cost and 5.6–45.8 s latency. `getProductStockCoverage` now accepts exactly one id, SKU,
barcode or exact recorded name; `productService.listByExactName` is business-scoped and anchored,
returns at most two candidates, and reports ambiguity instead of choosing. A successful coverage
result is captured by the turn loop and rebuilt by `stockCoverageAnswer`, so the stored answer
states the estimate (or explicit no-rate outcome), window and proxy caveat; a later failed coverage
call clears the earlier summary. Q7b/Q7c remain, Q8 remains the null-cover case, and Q7d/Q7e cover
missing-estimate and missing-caveat drafts. The evaluator records selected, succeeded and
finalized/used coverage separately and uses a semantic caveat detector; no paid run was made. The
full implementation record is §27KQ.
