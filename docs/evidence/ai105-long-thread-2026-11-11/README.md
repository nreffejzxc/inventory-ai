# AI-105 long-thread production test — 2026-11-11

This was the live long-conversation follow-up to the AI-105 compact-history retry fix, run on the
production OPPO `CPH1969` against Render commit `3b275df`. The thread was built in one chat and
contains more than four prior messages before the compound questions, so a retry would have trimmed
older history.

## Turns

| Time (local) | User | Answer | Ref | Notes |
| --- | --- | --- | --- | --- |
| 11:56 PM | `How many low-stock products are there in total?` | **19 products need restocking** | `008a1583` | Reset/re-ask path; label captured here |
| 12:14 AM | partial `How` (typing accident) | clarification | `5bbc9560` | Not used as a clean sample |
| 12:15 AM | `How many active products are there in total` | **113 active products** | `0d4bbbf4` | History depth |
| 12:16 AM | `How many products are low on stock and what is their total value` | **19 / 1,633,025** | `283aaf89` | Render: `calls=2 attempts=2 empty=0 retries=0 tools=getReorderNeededProducts` |
| 12:22 AM | percentage/stock-value question | 41 rows / PHP 346,118,013 | `556ce731` | Partial inventory read; not used as an accuracy sample |
| 12:28–12:34 AM | the compound question repeated | **19 / 1,633,025** each time | `9100219d`, `1c4e64c2`, `a5cc6da5`, … | Repeated real turns; all returned the correct compound answer |

The compound answer kept both facts and used the expected restock read. The long thread therefore
demonstrates that the deployed server can answer the exact compound question correctly with a long
history present.

## What was **not** exercised

Render was searched for `trimmed` and `AI model hit its output limit` over the whole long-thread
window. **No `trimmed` line and no new output-limit event appeared**; the only output-limit line in
the last hour is the earlier `e4570da9` short-thread event. The empty-output-limit condition is
intermittent, and these live turns did not produce it. Therefore:

- The compact-history trim itself was **not exercised live** in this test.
- The live proof remains the 20-message regression test in
  `server/test/AI105-output-limit-retry.test.mjs`, not a production observation.
- AI-105 should not be described as fully reliability-resolved until a production turn actually
  logs the retry and `trimmed` together.

## Evidence

- [`long-thread-compound.png`](long-thread-compound.png) / `.xml` — the long chat with the count,
  active-product and compound turns (`0d4bbbf4`, `283aaf89`).
- [`long-thread-hard-question.png`](long-thread-hard-question.png) / `.xml` — the percentage turn
  (`556ce731`).
- [`render-no-trimmed.png`](render-no-trimmed.png) — Render's `trimmed` search returning no matching
  logs.
