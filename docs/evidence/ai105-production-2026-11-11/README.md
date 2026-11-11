# AI-105 same-thread retry and the live “Correcting the answer…” label (2026-11-11)

This report records the production deployment of the AI-105 retry fix and the exact same-thread
count-then-compound test on the OPPO `CPH1969` (Android 11), running `com.inventoryai.app` 1.0.2
(versionCode 10). No OpenRouter, Render, token-limit or model setting was changed.

## Deployment

- PR [#232](https://github.com/nreffejzxc/inventory-ai/pull/232) squash-merged as
  `3b275df57b590dd4e5edab2690f5387589b10d11` at 2026-11-11T15:48:49Z.
- CI run `43051417184` passed all four required checks: `server`, `mobile`, `secret-guard` and
  `attribution-guard`.
- `GET /api/health` reported `commit=3b275df`, `status: ok`, `db: connected`, environment
  `production`, and `serverErrors: 0`; `GET /api/health/ready` returned 200 with
  `status: ready`, `db: connected`.
- The change is server-only. The installed 1.0.2 app already carries the reset-label OTA
  `58f75323`; no new OTA was published.

The empty output-limit retry now keeps at most the four most recent prior messages and preserves
the current question plus every tool call/result from the current turn. The normal 1,200-token
output cap is unchanged; the retry keeps the existing larger cap and paid reasoning budget. A
regression test uses the 20-message count-then-compound history and proves the old thread is not
replayed while the immediate count exchange is retained.

## Exact same-thread production test

Both questions were sent in one new chat, in this order:

| # | Question | Rendered answer | Ref |
| --- | --- | --- | --- |
| 1 | `How many low-stock products are there in total?` | **“19 products need restocking.”** | `bf777146` |
| 2 | `How many products are low on stock and what is their total value?` | **“The total recorded value of the 19 low-stock items is 1,633,025.”** | `e4570da9` |

Screenshots: [`low-stock-count.png`](low-stock-count.png) and
[`compound-same-thread.png`](compound-same-thread.png).

### Render log — `bf777146`

The count turn used the simple/free route and hit its own reset/re-ask before the final answer:

```text
11:51:43 PM AI request intent=inventory:restock_count route=simple
  model=nvidia/nemotron-3.5-lightning:free tier=free ... turn=bf777146
11:51:44 PM AI simple route (restock_count) answered without its shortage read — asking again
  turn=bf777146
11:51:50 PM AI turn outcome=ok status=ok duration=7.34s total=7343ms calls=3 attempts=3
  empty=0 retries=1 failovers=0 reasks=1 tools=getReorderNeededProducts toolRuns=1
  in=38251 out=57 cost=$0.000000 ... turn=bf777146
```

### Render log — `e4570da9`

The compound turn exercised the output-limit retry and recovered without showing the error
sentence:

```text
11:52:58 PM AI request intent=inventory route=default model=openai/gpt-oss-20b tier=paid
  ... turn=e4570da9
11:53:13 PM AI model hit its output limit with nothing usable ... maxTokens=1200, stop=max_tokens
  ... turn=e4570da9
11:53:17 PM AI turn outcome=ok status=ok duration=18.79s total=18785ms calls=3 attempts=3
  empty=1 retries=1 failovers=0 reasks=0 tools=getLowStockProducts toolRuns=1
  in=21945 out=879 cost=$0.001340 ... turn=e4570da9
```

The final answer contains both the count **19** and the recorded value **1,633,025**. The first
attempt still reached its 1,200-token limit, so the retry was genuinely exercised; it recovered on
the second attempt.

**Scope note.** This conversation had only the count exchange before the compound turn, so the
new four-message trim kept the whole two-message history (`trimmed` did not appear in Render). The
20-message regression test is the focused proof of the trim itself; the production turn proves the
retry path and the user-visible result. The same compact-history rule applies to longer threads.

## Live “Correcting the answer…” label

A separate fresh count chat was sent to reproduce the reset/re-ask that the Render log showed.
The live tree and screenshot contained:

```text
Correcting the answer…
The earlier draft was replaced with the final answer.
```

Evidence: [`correcting-answer.png`](correcting-answer.png). The turn completed at 11:56:46 with
**19 products need restocking**, `Ref: 008a1583`; the post-correction state is in
[`count-after-correction.png`](count-after-correction.png).

Render matched the same token and the reset that produced the label:

```text
11:56:41 PM AI request intent=inventory:restock_count route=simple
  model=nvidia/nemotron-3.5-lightning:free tier=free ... turn=008a1583
11:56:43 PM AI simple route (restock_count) answered without its shortage read — asking again
  turn=008a1583
11:56:46 PM AI turn outcome=ok status=ok duration=5.02s total=5018ms calls=3 attempts=3
  empty=0 retries=1 failovers=0 reasks=1 tools=getReorderNeededProducts toolRuns=1
  in=38251 out=63 cost=$0.000000 ... turn=008a1583
```

This is a live reset/re-ask, not a truncation: the draft was replaced deliberately and the final
count still matches the Restock screen.

## Checks

- Focused AI-105 suite: **3/3 pass**, including the 20-message same-thread regression.
- Full server unit suite: **2,047 tests, 1,985 pass, 62 intentionally skipped, 0 fail**.
- Server `typecheck` and targeted ESLint: exit 0.
- The four required PR checks passed before merge.
- Android only; iOS was not tested. No tenant data, credential, token or provider configuration was
  changed.
