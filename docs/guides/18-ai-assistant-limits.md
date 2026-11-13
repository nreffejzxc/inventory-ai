# 18. AI Assistant limits and safeguards

This is the reference for every limit the assistant enforces today. It describes the code, not
a plan or a target. Defaults are the values shipped in source; a deployment can change the ones
marked **env**. Values marked **fixed** are source constants and cannot be changed from `.env`.
Production values were checked against the live Render service on **2026-11-13** and are listed in
§0. Values that are not set there use the source defaults in the tables below.

The assistant is deliberately bounded in four places: **who may ask**, **how often**, **how long
and how much one turn may use**, and **what the answer is allowed to claim**.

Source of truth: `server/src/services/ai/aiConfig.ts`, `ai.service.ts`, `tools.ts`,
`webCapabilities.ts`, `webResearch.ts`, `marketPrices.ts`, `freeWeb.ts`, `quota.ts`,
`modelBreaker.ts`, `modelHealthGate.ts`, `simplePaidBudget.ts`, `server/src/controllers/ai.controller.ts`,
`server/src/routes/ai.routes.ts`, `mobile/lib/config.ts`, and `mobile/lib/sse.ts`.

## 0. Production snapshot (verified 2026-11-13)

Read from the Render API for the live `ai-inventory` service on branch `main`, at commit
`705d192` — the same commit as the local `main` tree when this was written. Secret values were
not read. The service has these non-secret AI settings; everything not listed is absent and uses
the source default.

| Variable | Production value | Source default | Effect in production |
|---|---|---|---|
| `AI_PROVIDER` | `openrouter` | unset (disabled) | The assistant is enabled through OpenRouter. |
| `AI_MODEL_OPENROUTER` | `openai/gpt-oss-20b` | required, no default | Ordinary turns start on this non-`:free` model. |
| `AI_RESEARCH_MODEL_OPENROUTER` | `openai/gpt-oss-120b` | unset (primary) | Research turns start on the larger model, then fall back to the primary. |
| `AI_FALLBACK_MODELS_OPENROUTER` | `nvidia/nemotron-3.5-lightning:free` | unset (none) | One free fallback after the primary/research route. |
| `AI_WEB_SEARCH` | `enable` | `disable` | Native OpenRouter web search is offered on qualifying research turns. |
| `AI_WEB_FETCH` | `enable` | `disable` | Native OpenRouter web fetch is offered on qualifying research turns. |
| `AI_REASONING_PAID_MODELS` | `enable` | unset | Paid-class models use their own reasoning default (no reasoning field is sent). |
| `AI_REASONING_FREE_MODELS` | `disable` | `disable` | Free models receive `thinking: { type: 'disabled' }`. |
| `AI_REASONING` | `enable` | unset | Deprecated alias; ignored because the new paid switch is set. Rename it at the next deploy. |
| `AI_MODEL_FAILURE_THRESHOLD` | `5` | `5` | Same as the source default. |
| `AI_MODEL_COOLDOWN_MS` | `30000` | `30000` | Same as the source default. |
| `TRUST_PROXY` | `1` | unset | Express trusts the proxy. The AI limiter is user-keyed, so this only affects its no-user IP fallback. |

**Not set, so the source defaults in this guide are the production values:** `AI_MAX_MESSAGE_CHARS`
`4,000`; `AI_MAX_OUTPUT_TOKENS` `1,200`; `AI_CONTEXT_MESSAGES` `20`; `AI_MAX_TOOL_ITERATIONS` `6`;
`AI_MAX_TOOL_RESULT_CHARS` `12,000`; `AI_TURN_DEADLINE_MS` `60,000`; `AI_REQUEST_TIMEOUT_MS`
`60,000`; `AI_RESEARCH_BUDGET_MS` `30,000`; `AI_RATE_LIMIT_MAX` `20`; `AI_RATE_LIMIT_WINDOW_MS`
`60,000`; `AI_EMPTY_RETRY_MAX` `1`; `AI_ATTEMPT_MAX_MS` `0`; `AI_SIMPLE_FREE_ATTEMPT_MS`
`15,000`; `AI_SIMPLE_PAID_DAILY_BUDGET_USD` `0.25`; `AI_SIMPLE_PAID_TURN_RESERVE_USD` `0.01`;
`AI_ALLOW_PAID_WEB_SEARCH` `false`; `AI_QUOTA_BLOCK_MS` `30,000`; `AI_MODEL_HEALTH_TTL_MS`
`1,860,000`; `JSON_BODY_LIMIT` `100kb`. The health watchdog is on because `NODE_ENV=production`.

**Differences that matter:** production is **native-web-first**, because both switches are enabled.
That makes the native caps in §9 the production research path and withholds the local research
tools. Production also starts ordinary turns on the 20B model and research turns on the 120B model,
with one free fallback. No timeout, request-rate, context, output, iteration or budget override is
present. Environment values can change without a source change; re-read them before treating this
snapshot as current.

## 1. Access and data scope

| Limit | Value | Type | How it works and why |
|---|---|---|---|
| Authentication | Required | fixed | `/api/ai/chat` and all conversation routes require a valid session. The assistant never runs anonymously. |
| Permission | `ai.use` | fixed | All four roles (OWNER, ADMIN, MANAGER, STAFF) hold it. A user without it gets `403`. |
| Metrics access | `ai.metrics.view` | fixed | Only OWNER and ADMIN can read aggregate AI turn metrics. Metrics are operational data, not member chat. |
| Conversation ownership | Same user **and** business | fixed | A conversation is looked up by `businessId` + `userId`; another user in the same business gets `404`. |
| Tool data scope | Caller's business only | fixed | `businessId` comes from the authenticated user, never from the model or request body. Tool schemas reject unknown arguments, so a model cannot supply a different tenant id. |
| Tool permissions | Existing role permissions | fixed | Every tool checks its declared permission again at execution time. A STAFF user can use product/inventory reads but not dashboard-only reads such as `getInventorySummary` or `getLocationBreakdown`. |
| Write capability | None | fixed | The tool catalogue is read-only. There is no stock adjustment, price change, purchase-order, supplier, or delete tool. |
| Request body | `100kb` | **env** `JSON_BODY_LIMIT` | Global Express JSON cap, applied before AI route logic. Oversized bodies get `413`. |
| Message length | `4,000` characters | **env** `AI_MAX_MESSAGE_CHARS` | Trimmed; blank is rejected. This is also the model-answer character cap before source URLs are appended. |
| Model configuration | `AI_MODEL_OPENROUTER` required | fixed | No model id is hard-coded and there is no default. Missing model/provider configuration makes chat answer `503 AI_NOT_CONFIGURED` rather than guessing a model. |
| Provider | OpenRouter only | fixed | OpenRouter is the only shipped provider. `AI_PROVIDER` must be `openrouter`; an empty value leaves the assistant disabled. `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL` are also required, and the same `503 AI_NOT_CONFIGURED` applies when they are missing. |

**Purpose:** bound the assistant to the same tenant and role rules as the rest of the app, and make
it impossible for a prompt to reach another business or change inventory.

## 2. Request throttling

| Limit | Value | Type | How it works and why |
|---|---|---|---|
| Chat rate limit | `20` requests per `60,000` ms, per user | **env** `AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_MS` | In-memory timestamps in a trailing window, keyed by authenticated user id (IP only if no user is present). Every chat attempt that reaches the route counts, including invalid fields and failed turns. Over the limit: `429 AI_RATE_LIMITED` with `Retry-After` set to the full window. |
| Rate-limit scope | One process | fixed | State is a `Map`; it resets on restart and is not shared by multiple server instances. Pruned on each request, so it does not grow without bound. |
| Global concurrency | None | — | There is no queue, semaphore, or in-flight cap. A user can run several turns at once up to the rate limit; provider quota and the per-turn deadline are the remaining brakes. |
| Other AI routes | No AI limiter | fixed | Conversation list/create/history and metrics are authenticated but do not consume the chat limiter. |
| Subscription quota | None enforced | fixed | The plan catalog's AI numbers are illustrative only; the AI path does not call a plan resolver. Foundation is effectively unlimited, and there is no monthly AI quota for any tier. |

**Purpose:** stop one account from burning the provider allowance or the server's time in a burst.
The limiter is intentionally per-user, so one busy member cannot throttle another member. The
full-window `Retry-After` is conservative; the actual wait may be shorter because the window
slides.

## 3. Time limits and transport behaviour

| Limit | Value | Type | How it works and why |
|---|---|---|---|
| Whole turn | `60,000` ms | **env** `AI_TURN_DEADLINE_MS` | One absolute deadline is created at turn start. Every provider call and tool call is raced against the time remaining. Running out gives `504 AI_TIMEOUT`. This replaced the old accidental ceiling of per-call timeout × iterations. |
| One provider call | `60,000` ms | **env** `AI_REQUEST_TIMEOUT_MS` | Clamped to the remaining turn budget. A call can never outlive the turn. |
| Per-attempt cap | `0` (disabled) | **env** `AI_ATTEMPT_MAX_MS` | When above zero, only cuts short an attempt when another candidate model remains; the last candidate always gets the remaining turn. A capped attempt gets a fixed `50` ms grace before the loop moves on. |
| Simple free attempt | `15,000` ms | **env** `AI_SIMPLE_FREE_ATTEMPT_MS` | Only the free start model on the simple-inventory route. `0` disables the shorter cap. This keeps a stalled free model from consuming the paid model's share of the turn. |
| Research tool budget | `30,000` ms | **env** `AI_RESEARCH_BUDGET_MS` | Caps local review/price research inside the turn. |
| Research answer reserve | `15,000` ms | **fixed** | Research stops at the smaller of its own budget and `turn deadline − 15 s`, leaving a provider round to write the answer. Without it, evidence collection consumed the whole turn and produced a timeout. |
| Tool call | Remaining turn time | fixed | Each tool is raced against the turn budget and receives an abort signal; a hung tool cannot hold the request after the deadline. |
| Mobile AI budget | `75,000` ms | **fixed** | The AI route uses its own client budget, above the 60 s server deadline, so the response and two persistence writes still fit. Other routes keep the normal 15 s budget. |
| Stream silence | `20,000` ms | **fixed** `STREAM_IDLE_MS` | If no bytes arrive for 20 s, the client treats the stream as broken instead of waiting for the whole 75 s. |
| Server heartbeat | `15,000` ms | **fixed** | An SSE comment line keeps proxies and mobile networks from closing an idle but live turn. |
| Client cancellation | `499 AI_ABANDONED` | fixed | If the phone disconnects or the member presses Stop, the server aborts the in-flight turn; a turn that has not completed writes no messages. This is why a stopped turn is not billed to completion. |

**No immediate retry after a client timeout.** A `NETWORK_TIMEOUT` is the client's own 75 s budget
expiring; the server may still be finishing that turn. Retrying immediately could start and bill a
second turn for the same question, so the timeout is final. A stream may fall back to ordinary
JSON only when nothing was shown and the failure is transport-like (`status 0`, 404, 405, or 501).
It never falls back after streamed text, after a quota/rate/auth refusal, or after a timeout.

## 4. Context, output, and retry limits

| Limit | Value | Type | How it works and why |
|---|---|---|---|
| Conversation context | Last `20` stored messages | **env** `AI_CONTEXT_MESSAGES` | Only USER and ASSISTANT rows are loaded; tool messages are not replayed. This keeps prompts bounded and avoids sending stale tool output as fresh evidence. |
| Input message | `4,000` characters | **env** `AI_MAX_MESSAGE_CHARS` | Same setting as the request validation cap. |
| Output tokens | `1,200` | **env** `AI_MAX_OUTPUT_TOKENS` | Per provider call. Limits generation time and prevents a runaway answer from consuming the turn. |
| Answer characters | `4,000` before source URLs | **env** `AI_MAX_MESSAGE_CHARS` | The final answer is trimmed to this length. Research source URLs are appended afterwards, so a sourced answer can be slightly longer. This trim does not add a separate degraded marker. |
| Output-limit retry | Up to `AI_EMPTY_RETRY_MAX` (default `1`) | **env** `AI_EMPTY_RETRY_MAX` | If an empty `AiOutputLimit` arrives after no text was shown, the first retry uses `max_tokens = base + max(base, 1200)` — `2,400` at the default. Paid models also get a reasoning budget of at least `1,024` tokens (the default cap supplies `1,200`); free models get no reasoning field. The retry keeps only the last **4 fixed** prior messages to avoid re-spending the same large context. Further retries allowed by the setting reuse that larger cap. It shares the same retry budget as an empty completion. |
| Empty-completion retry | Once | **env** `AI_EMPTY_RETRY_MAX` (`1`) | A 2xx with neither text nor a tool call is retried once. The retry consumes an iteration. |
| Grounding re-asks | `2` | **fixed** `MAX_GROUNDING_RETRIES` | If a recorded-data answer arrives with no successful read, the model is sent back at most twice. After that, a canned honest sentence is stored instead of the invented answer. |
| Simple-route re-asks | `1` free re-ask, then `1` paid escalation | fixed | A simple stock/restock answer must contain its required read. The first failure stays on the free model; the second escalates to the configured primary (subject to the daily budget). Both count toward the same two grounding retries. |
| Tool iterations | `6` default | **env** `AI_MAX_TOOL_ITERATIONS` | Provider calls per turn, not tool calls alone. The final iteration withholds tools so the model must answer from what it already gathered. |
| Research iterations | `min(default + 2, 8)` | fixed formula | Research questions get up to 8 provider calls. With the default this means 8 iterations; ordinary turns get 6. |
| Tool-result payload | `12,000` characters | **env** `AI_MAX_TOOL_RESULT_CHARS` | Oversized results are shortened structurally: rows are dropped from the largest array and a `truncated` flag/note is added, keeping valid JSON. A tool's nominal page size can therefore be reduced further by this cap. |
| Input-token cap | None separate | — | There is no prompt-token estimator. Context size is bounded indirectly by 20 messages and 4,000 characters each; provider-side context limits still apply. |

Every provider retry and grounding re-ask consumes the same iteration budget. A model cannot use
retries to buy extra provider calls beyond the 6/8 iteration ceiling.

**Purpose:** control generation cost and latency, keep one malformed/empty provider response from
becoming a failed turn, and give the model a bounded number of chances to ground an answer rather
than letting it guess.

## 5. Tool and data limits

All tools are read-only and business-scoped. Each call is schema-validated; unknown arguments are
rejected. The table shows the default page and the maximum the model may request. These per-tool
numbers are **fixed** in `tools.ts`; `AI_MAX_TOOL_RESULT_CHARS` is the separate configurable
payload cap.

| Tool | Default rows | Maximum rows |
|---|---:|---:|
| `searchProducts` | 15 | 25 |
| `findProducts` | 15 | 25 |
| `getInventory` | 15 | 25 |
| `getLowStockProducts` | 20 | 50 |
| `getOutOfStockProducts` | 20 | 50 |
| `getProductsNeverSold` | 15 | 25 |
| `getReorderNeededProducts` | 50 | 50 |
| `getStockValue` | 10 | 25 |
| `getInventoryHistory` | 15 | 50 |
| `getProductsByLocation` | 20 | 50 |
| `listLocations` | 25 | 50 |
| `listCategories` | 25 | 50 |
| `listBrands` | 20 | 50 |

Additional tool ceilings:

- `getProduct` returns one exact product and at most **20** location stock rows.
- `getCatalogOverview`, `getInventorySummary`, and `getLocationBreakdown` take no arguments and
  return fixed summaries.
- `researchInventoryProducts` accepts **1–8** product ids; `researchMarketPrices` accepts **1–3**
  product ids and **1–3** named stores.
- Most search text is limited to 100 characters; `findProducts` keywords allow 200, and brand
  search allows 80. Product ids and store text have their own 120/160/220-character schema limits.
- A repeated identical tool call is still executed, but the result carries a `repeatNotice` so
  the model is told not to repeat it.

**Purpose:** each page is sized to answer a normal question without flooding the model's context,
while the hard maximum stops a model from asking for the entire catalogue. The 12,000-character
cap is the final backstop; the `hasMore`/`truncated` flags tell the model it is looking at a page,
not the whole data set.

## 6. Model routing and model-specific limits

### Primary, research, and simple routes

| Route | Start model | When it is used | Production start (2026-11-13) |
|---|---|---|---|
| Default / moderate | Configured primary, or the currently promoted model | Every question that is neither a recognised simple read nor a research question. There is no hard-coded model id; `AI_MODEL_OPENROUTER` is required. | `openai/gpt-oss-20b` |
| Research | `AI_RESEARCH_MODEL_OPENROUTER`, then primary, then fallbacks | Only when a research model is configured, differs from the primary, and the question matches the research classifier. Explicit web research matches unless the message locks the answer to the business's own records; product/brand comparisons and buying advice match unless they are about recorded inventory fields. “Best-selling” is explicitly excluded and stays on the primary. | `openai/gpt-oss-120b`, then `openai/gpt-oss-20b`, then the free fallback |
| Simple inventory | First free, tool-capable fallback model | Only four narrow shapes: one product's stock, whether a product exists, a restock/low-stock list, and a restock count. The message must be ≤ **280 fixed** characters, contain at most **one** question mark, and avoid all advanced cues (price, value, sales, movement, comparison, brand, category, supplier, location breakdown, recommendation, etc.). It must differ from the configured primary. | `nvidia/nemotron-3.5-lightning:free`, then the paid primary subject to the daily budget |

**Model-specific facts:**

- The simple route is designed for a paid primary, but the code does **not** verify that the
  primary is paid. It requires a free fallback that is different from the configured primary; if
  the primary itself is free, the route can still run.
- The simple model is never promoted into the default slot. Its success applies to that turn only.
- The research model is never promoted into the primary slot. If it fails, the same turn falls
  back to the primary and then the configured fallbacks.
- Primary and research models are **not** filtered for declared tool support. Only fallback
  candidates are filtered. A primary that cannot call tools can produce ungrounded prose and
  eventually the honest “cannot read” answer.
- Paid models use `AI_REASONING_PAID_MODELS`; any id ending in `:free` uses
  `AI_REASONING_FREE_MODELS`, whose default is `disable`. A free model never inherits the paid
  reasoning setting. `enable` sends no reasoning field (the model's own default); `disable` sends
  `thinking: { type: 'disabled' }`. This prevents hidden reasoning from consuming the whole answer
  budget on the gateway.
- `AI_REASONING_PAID_MODELS` / `AI_REASONING_FREE_MODELS` accept only `enable` or `disable`.
  Invalid values fail production configuration; free reasoning defaults to off.
- The output-limit retry's extra reasoning budget is paid-only; a free model gets the larger
  token cap but no reasoning allowance.

### Fallback chain

- `AI_FALLBACK_MODELS_OPENROUTER` is trimmed, de-duplicated, and capped at **5 fixed**
  candidates. Extra ids are reported as ignored rather than silently used.
- The chain is built once per turn: start model, primary, then fallbacks. A research or simple
  turn can therefore reach up to **7** models; an ordinary turn up to **6**. Time, breaker,
  health gate, and the 5-second minimum can end the walk sooner.
- A fallback that declares it cannot call tools is skipped. Unknown tool support is allowed.
- The chain is walked **once per turn**. Once a model has answered any text, failover is forbidden
  because the member has already seen that answer.
- The configured primary may be replaced at the front of the chain by a promoted fallback after a
  confirmed outage, except on research and simple turns, which deliberately start where their
  route says.

### Failover conditions

Failover is attempted only for a **model-specific** failure: HTTP `404`, `410`, `500`, `502`,
`503`, `504`, or `529`. It is also allowed for a timeout caused by the optional per-attempt cap.
It is **not** attempted for `400`, `401`, `403`, `402`, `429`, an ordinary network failure, a
timeout without a cap, or a provider response that merely has no content. Those are either our
request shape, credentials, or an account-wide allowance that another model would share.

Failover also requires at least **5,000 ms fixed** remaining in the turn. Below that, the turn
returns the honest failure rather than starting a request that cannot finish.

## 7. Answer safeguards

These checks sit around the model, so a fluent answer cannot override the data boundary:

- **Recorded facts need a read.** When a guarded recorded-data question (stock, prices, simple
  reads, research) has no successful tool call, the model is sent back at most twice; after that
  the turn stores a fixed “cannot verify” sentence with a degraded reason instead of its text.
- **Simple reads need their specific read.** A simple stock/restock answer must contain the
  operation's own read; one free re-ask and one paid escalation are the only second chances.
- **Web claims need a web read.** A research answer with no returned source is not accepted as a
  finding; it becomes `UNVERIFIED_RESEARCH`. A draft citing URLs the turn did not return is sent
  back for a rewrite, and the real returned source URLs are appended to the stored answer.
- **Sales claims need sales evidence.** “Best-selling” or “fastest-moving” is removed unless the
  turn read a stock-out/sales ranking that supports it. A restock or stock-level read is not
  sales evidence.
- **Money is labelled as an estimate.** There is no revenue ledger, so a sales-value figure is
  presented as recorded selling price × units out, with a server-written qualification; it is
  never presented as recorded revenue.
- **The final round is tool-free.** It forces the model to answer from already-collected
  evidence rather than searching for one more fact. Repeated identical calls are marked, and a
  tool error is reported rather than replaced with invented data.

## 8. Health, breaker, quota, and cost safeguards

| Safeguard | Value | Type | How it works and why |
|---|---|---|---|
| Per-model breaker | `5` consecutive availability failures; `30,000` ms initial cooldown; doubles to `300,000` ms | **env** `AI_MODEL_FAILURE_THRESHOLD`, `AI_MODEL_COOLDOWN_MS`; max cooldown fixed | Counts model-specific statuses and classified transport failures. Once open, the model is skipped. A failed half-open trial re-opens immediately; only a success clears the count. This stops a dead model costing a failed request every turn. |
| Provider health gate | `unavailable` only; `31 min` TTL; 30-minute watchdog | **env** `AI_MODEL_HEALTH_TTL_MS`, `AI_HEALTH_WATCH_INTERVAL_MS`; verdict policy fixed | The provider's endpoint-health API marks a model unavailable without spending a completion. `degraded` and `unknown` do not remove a model. If every configured model would be blocked, the primary is released as a safety valve. Two consecutive healthy readings restore the primary after a promotion. |
| Quota fail-fast | `30,000` ms | **env** `AI_QUOTA_BLOCK_MS` | A `429`/`402` that reports zero remaining blocks further provider calls for 30 s instead of paying a round-trip per turn. Any success clears the block. Only an observed zero triggers it; a missing header does not. |
| Quota refusal | No retry, no failover | fixed | `429` and `402` become `429 AI_QUOTA_EXCEEDED`. Every model shares the account allowance, so trying another would only spend the refusal again. |
| Simple paid budget | `$0.25` per UTC day; `$0.01` reservation | **env** `AI_SIMPLE_PAID_DAILY_BUDGET_USD`, `AI_SIMPLE_PAID_TURN_RESERVE_USD` | Only for simple-route escalation to the paid primary. Money is reserved before the call and settled from the reported turn cost; a missing cost charges the reservation. `$0` disables simple paid fallback. Process-local; restart resets it. |
| General paid spend | No app cap | — | Primary, research, and ordinary fallback calls have no USD budget in this code. The provider account is the financial boundary. |
| Provider free allowance | Observed `50` requests/day at time of writing | external | Set and enforced by OpenRouter, not by this app. Shared across free models; can change. |

The breaker, health marks, promotion, quota block, and simple paid budget are **in-process**. A
restart resets them; multiple instances do not share them. They reduce repeated failures in the
process that saw them, but they are not a distributed circuit breaker or a billing ledger.

## 9. Web research restrictions

### Switches and intent

**Production note (2026-11-13):** both switches are `enable`, so the native-first path below is the
one production uses. The defaults still describe a fresh deployment.

- `AI_WEB_SEARCH` and `AI_WEB_FETCH` each default to **disabled** and accept only `enable` or
  `disable`. Invalid values keep the tool disabled and fail production configuration.
- Native web tools are the primary research path only when **both** switches are enabled on
  OpenRouter. If either is off, the local research tools remain available. Each enabled switch
  individually adds its native tool; “native-first” requires both.
- Web tools are offered only when the message clearly asks for public-web research. Plain
  inventory questions do not receive them.
- A price, supplier, cost, review, rating, or quality question is treated as **inventory-only**
  unless it contains an explicit external cue such as “online”, “market price”, a named
  marketplace, a URL, or “product reviews”. An explicit “use only my records / no web” request
  always wins.
- Source-locked or non-research turns do not receive `researchInventoryProducts` or
  `researchMarketPrices` at all; the model cannot reach them on a second attempt.
- The final answer round receives no tools, forcing an answer from evidence already collected.

### Native OpenRouter tools

These caps are **per provider request**, not per whole turn. The iteration cap and tool-free
answer round bound the turn.

| Tool | Per-request cap |
|---|---|
| Web Search | `max_uses: 2`, `max_total_results: 10` |
| Web Fetch | `max_uses: 2`, `max_content_tokens: 30,000` |

If the gateway refuses native tools with `400` or `403`, the turn retries once with the local
research tools and no native definitions. If a research answer arrives with no native read, the
model is re-asked once for the native tools; if that still has no read, the next re-ask switches
to the local research path. If that also fails, the turn stores `UNVERIFIED_RESEARCH`. These are
the same two grounding re-asks described above.

Native tools are billed separately by the provider, even on a `:free` model. The hard caps above
are the cost ceiling; there is no additional per-turn dollar cap.

### Local research (review / product evidence)

- Max **8** products, **6** recorded-brand groups, **4** concurrent groups.
- Max **8** findings and **8** sources; **3** sources per group; **600** characters per finding;
  **180** characters per source title; **320** per snippet.
- Search query timeout **8 s**; model request timeout **20 s**; research output **1,800** tokens.
- Overall budget **30 s**, plus the fixed **15 s** answer reserve.
- The local review model is `AI_WEB_RESEARCH_MODEL` (default
  `liquid/lfm-2.5-2.6b:free`), not the assistant's primary/research model. It is used only when
  `AI_ALLOW_PAID_WEB_SEARCH=true` and a key/base URL are configured; otherwise the keyless search
  fallback supplies result snippets and no paid plugin call is made.

### Local market-price research

- Max **3** products, **3** named stores, **5** listings per product, **12** total listings, **12**
  sources, **8** free search results, **3** page fetches per product search, **3** concurrent
  fetches.
- Request timeout **25 s**; free query timeout **8 s**; free page timeout **7 s**.
- Paid-plugin output is capped at **256** tokens.
- Uses `AI_WEB_PRICE_MODEL`, then the first configured fallback, then the primary, then
  `AI_WEB_RESEARCH_MODEL`. If none is configured, price research returns `NOT_CONFIGURED` rather
  than guessing.
- `allowPaidWebSearch` defaults to **false**, so the paid OpenRouter web plugin is off even when a
  free model is used.

### Keyless web fetch safety and throttling

- Search timeout **6 s**; whole search **12 s**; page fetch **9 s**.
- Search cache **10 minutes**, at most **100** entries.
- Search response cap **2 MB**; page cap **3.5 MB**; hard reject above **8 MB**; at most **3**
  redirects.
- Requests to localhost, private/link-local addresses, and URLs with embedded credentials are
  blocked; redirects and DNS answers are checked again. This is an SSRF guard.
- Searches from this process are spaced **350 ms** apart; a blocked search engine is skipped for
  **5 minutes**. These reduce burst throttling and repeated engine failures.

## 10. Persistence, UI, and operations limits

| Limit | Value | Type | Why |
|---|---|---|---|
| Persist only successful turns | One USER + one ASSISTANT row | fixed | A provider failure writes no conversation, no orphan question, and no empty answer. Retrying is a fresh, predictable attempt. A degraded but completed turn is stored with its `degraded` reason. |
| Conversation title | API request at most `120`; generated title `60` | fixed | Keeps list rows readable; long first messages are truncated with an ellipsis. |
| Conversation/message pagination | Default `20`, maximum `100` per page | fixed | Preview and history screens can page without loading an unbounded thread. |
| AI metrics window | Default `7`, maximum `90` UTC days | fixed | Operational reports cannot scan all history. Metrics are OWNER/ADMIN only and scoped to the caller's business. |
| Model health watchdog | First check after `60 s`, then every `30 min` | **env** interval/initial delay | Detects a dead or degraded model before the first member of the day; production only unless explicitly enabled in development. |

## 11. What is intentionally **not** limited

These are real gaps in enforcement, not permissions:

- No global or per-user concurrency cap. Rate limiting is requests per window, not simultaneous
  turns.
- No monthly AI quota for any subscription plan. The plan catalog values are not consulted by the
  AI route.
- No general USD spending cap for the primary, research model, or ordinary paid fallbacks.
- No distributed rate limiter, breaker, health gate, or budget. All are process-local.
- No separate input-token estimator or prompt-size guard beyond 20 messages and the 4,000-character
  message cap.
- No retry of a turn after the mobile client's 75 s timeout; this is deliberate to avoid duplicate
  billable turns.

## 12. The short version

1. **20 chat requests per user per 60 s**, in memory; no concurrency cap, no plan quota.
2. **60 s per turn**, **60 s per provider call**, **75 s client budget**, **20 s stream silence**.
3. **20 messages context**, **4,000-character input**, **1,200 output tokens**, **12,000-character
   tool result**.
4. **6 tool iterations** normally, **8** for research; final round has no tools.
5. **Simple questions** may start on the first free fallback; **research questions** on the
   configured research model; everything else on the primary or promoted model.
6. **5 fallback candidates max**, one chain walk, 5 s minimum remaining, no failover after text or
   on quota/auth/network failures.
7. **Web is off by default**; **production currently enables both switches**, so the native path
   is primary there, limited to 2 searches/10 results and 2 fetches/30k tokens per provider
   request, with conservative intent and source-lock gates.
8. **Only simple paid escalation** has a daily dollar budget ($0.25/UTC day). The provider account
   remains the limit for all other paid usage.
