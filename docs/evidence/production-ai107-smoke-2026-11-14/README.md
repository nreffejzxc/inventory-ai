# AI-107 production smoke — exact total (2026-11-14)

**Result: PASS.** One authorized production turn on the synthetic `PERF SEED` tenant returned the
exact business-wide total computed by `productService.stockValue`, with `getStockValue`, no second
large number, and no degraded state.

## Ground truth

Read directly from the production database through the same service the tool calls:

| Field | Value |
| --- | --- |
| Business-wide total | **46,922,439,210** |
| Currency | none recorded (`null`) |
| Products counted | **10,000** |
| Units on hand | **2,446,801** |
| Unpriced products | **0** |

The production tenant's total differs from the staging P6 tenant's **49,991,557,115** because the
two tenants hold different data. The expected value was computed live, not hard-coded.

## Turn

- **Question:** “What is the total stock value of all my inventory?”
- **Answer:** “The total stock value at the recorded selling price is 46,922,439,210.”
- **Model:** `openai/gpt-oss-20b` (paid)
- **Tools:** `getStockValue`
- **Turn:** `c103afad`; conversation `6af8723aa860111ff47c31bc`
- **Duration:** **9,304 ms**
- **Usage:** 18,641 input tokens / 244 output tokens
- **Degraded:** `null`
- **Deployed commit:** `cd4efcc7a9db3b39b55d3400eabf10debe32466f`

## Checks

| Check | Result |
| --- | --- |
| HTTP 201 | passed |
| `getStockValue` present | passed |
| Exact total present | passed |
| No other large total | passed |
| Non-empty answer | passed |

Raw result: [`result.json`](result.json).

## Limits

This is one paid turn on one synthetic production tenant, not a production-wide evaluation. It
verifies AI-107's total-only finalizer against live tool data; it does not establish multi-instance
behavior or the scoped/mixed-currency paths. The turn created the ordinary conversation/message and
quota records; inventory was not modified. No configuration, model order or data was changed. Cost
was not separately measured; the model and token counts are recorded.
