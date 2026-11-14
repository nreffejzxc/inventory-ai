# Staging advanced-task evaluation — 2026-11-13

**Status.** 4/4 turns answered, 4/4 automated checks passed, **3 fully correct and 1 partial**.
Research used the paid 120B model with live web search/fetch and returned Keychron sources, but could
not retrieve Royal Kludge RK61 review content, so it said so instead of inventing a comparison. The
other three tasks were correct: a two-location value comparison, an exact-SKU stock-coverage
calculation, and a Tagalog restock count. Staging paid cost for this run was **$0.029522**; production
configuration was not changed.

## Setup

- Isolated loopback server: `NODE_ENV=development`, `MONGODB_DB_NAME=inventoryai_dev_db`,
  `http://127.0.0.1:4000`
- Same disposable PERF SEED tenant used for P4: `6af75b052d094477c666284f`
- Staging paid budget **$0.25** for this process only. The run was sequential in one conversation, so
  it did not test concurrency (P4 did that).
- Four turns, one conversation, so the later questions could use the preceding context. The
  conversation was created and the temporary session removed by the drill. The shared tenant was
  removed after the sequence; the **0 remaining** verification is in
  [`staging-ai-reliability-cleanup-2026-11-13`](../staging-ai-reliability-cleanup-2026-11-13/README.md).

## Results

| Task | Model | Tool(s) | Latency | Verdict |
| --- | --- | --- | ---: | --- |
| Research/review comparison | `openai/gpt-oss-120b` | `findProducts` + native `search,fetch` | 27.3 s | **Partial** |
| Two-location stock value | `openai/gpt-oss-20b` | `getStockValue` ×2 | 11.9 s | **Correct** |
| Exact-SKU coverage calculation | `openai/gpt-oss-20b` | `getInventory` ×2 | 6.2 s | **Correct** |
| Tagalog restock count | `openai/gpt-oss-20b` (free attempt timed out) | `getReorderNeededProducts` | 19.6 s | **Correct** |

Total wall time **64.9 s**; median turn **15.7 s**; p95 **26.6 s**; max **27.3 s**. No `5xx` and no
server errors. The turn log recorded no retries except the research turn’s one transient provider
retry, and one free-model timeout that correctly fell back to the paid primary for the Tagalog turn.

**Research.** The model used the native web tools (`used=search`, then `used=fetch`) and cited
`blog.jonsdocs.org.uk` and `keyboardslab.com` for the Keychron K8 Pro. It reported concrete review
pros and cons from those pages. For the Royal Kludge RK61 it said *“the provided URLs did not include
any review content for this model, so no sourced statements can be given”* — it returned no invented
RK61 claims. This is a partial answer, not a full comparison. It also listed several returned source
URLs at the end, including RK61 sources, even though their article content was not retrieved; the
source list is therefore broader than the claims it supports. That is a presentation weakness, not a
fabricated fact.

**Two-location value.** `getStockValue` ran twice, once per location. The answer reported:
Main Warehouse **30,365,156,925**, Shop Front **14,024,388,565**, and correctly said Main is worth
more than twice Shop Front at the recorded selling price. Those are tool-computed totals, not model
arithmetic.

**Exact-SKU coverage.** With SKU `SEEDSKU-0` made explicit, the answer reported Main Warehouse **200**,
Shop Front **201**, total **401**, and correctly concluded that 401 cannot cover **500** and that 99
more units are needed. This is the exact ground truth from the seed.

**Tagalog.** The answer *“May 1,535 na produktong mababa ang stock.”* matched the dynamic restock
total from `getReorderNeededProducts` and stayed in the member’s language. The free model did not
produce a usable answer within the route’s timeout, so the paid primary answered; this is a
successful bounded failover, not a free-route success.

## Test-design finding: duplicate product names

The first advanced pass asked by product name only:

> “Do we have enough Logitech MX Keys S stock to cover 100 units, and where is it located?”

The seed contains **179 ACTIVE products named exactly “Logitech MX Keys S”**. A name-only inventory
page is capped at 25 rows, and the model summed a partial page (3,737 units) and presented it as the
total. The true total across all 179 matching products is **40,682**; the single SKU asked about in
the final run is **401**. The model also wrote “100 units are more than available” while answering
“Yes,” which is contradictory.

This is a real ambiguity risk: when a product name is not unique, a partial inventory page must not
become a presented total. The final test deliberately used an exact SKU, which is how a member who
knows the SKU should ask. A follow-up product fix should make the assistant ask which SKU (or use
`findProducts`) when a name maps to many products and the answer would be a total. That is outside
this test-only change.

The first research prompt (“Compare … for me”) was also too ambiguous: the model treated it as a
catalogue comparison, used only `findProducts`, and answered specifications from model knowledge
without a web source. The revised question explicitly asked for current reviews and source URLs,
which correctly triggered the paid research model and native web search. The initial output is kept
as evidence of why explicit research wording matters; it is not counted as the research result.

## Evidence

- [`result.json`](result.json) — final per-turn answer, model, tools, latency and checks
- [`drill.txt`](drill.txt) — final pass output
- [`server.txt`](server.txt) — route decisions, web usage, provider/fallback and settled costs
- [`initial-ambiguous-drill.txt`](initial-ambiguous-drill.txt) — the name-only and vague-research
  attempt that exposed the ambiguity

## Limits

- One synthetic run; this is not a statistically stable capability benchmark.
- Research source quality was not independently fact-checked beyond the URLs the tools returned.
  The RK61 review content was unavailable, so the comparison is incomplete.
- The staging tenant has many deliberately duplicated product names, which is useful for this
  ambiguity test but not representative of a clean production catalogue.
- The final run was paid (`$0.029522`); the earlier free-only 25-question gate remains the separate
  free-route proof.
- No screenshots or mobile rendering were checked.
