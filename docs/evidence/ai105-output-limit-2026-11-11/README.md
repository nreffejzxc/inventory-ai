# AI-105 output-limit retry production drill — 2026-11-11

## What was proved

Production Render commit `c3bd692` (PR #237) executed a real empty-output-limit retry against an
existing conversation with **12 stored messages**. The retry trimmed **8 prior messages**, kept the
current turn, made real provider calls, and returned a normal answer.

- **Turn:** `2d856074`
- **HTTP status:** `201`
- **Model:** `openai/gpt-oss-20b`
- **Tools:** `getInventorySummary`, `getStockValue`
- **Degraded:** `none`
- **Answer:** “The value of all on‑hand inventory is 266,383,708.”

The answer used inventory context rather than the literal greeting requested by the drill message;
the purpose of this turn was the reliability path, not answer content.

## The production log sequence

Render's last-hour log for the drill shows, at `01:29:44 AM`:

```text
AI output-limit drill armed: user=<owner> model=openai/gpt-oss-20b
AI output-limit drill: simulating an empty max_tokens response model=openai/gpt-oss-20b
AI output limit retry: trimmed 8 prior message(s), kept the current turn
```

The closing turn record, filtered by turn id, is:

```text
AI turn outcome=ok status=ok duration=5.41s total=5410ms providerMs=5168ms toolMs=231ms
calls=3 attempts=3 empty=1 retries=1 failovers=0 reasks=0
tools=getInventorySummary,getStockValue toolRuns=2 ... turn=2d856074
```

`empty=1` is the injected empty limit; `retries=1` is the real retry. The trim line confirms that
the compact-history path ran in production.

## Simulated versus real

The empty `max_tokens` completion was **simulated** by the request-scoped, owner-only drill header
`x-ai-output-limit-drill: retry`. The drill throws `AiOutputLimit` once before the first provider
call. Everything after that throw was the production path: the retry, the larger output cap, the
reasoning budget, the compact-history trim, the provider calls, and the persisted normal turn.

This is intentionally not a user-facing AI feature. The header is accepted only for the owner and
only with the value `retry`; it exists to make the otherwise intermittent reliability path
deterministically testable. It should not be described as evidence that an organic empty completion
was observed.

## Evidence

- [`render-drill-simulated.png`](render-drill-simulated.png) — Render filtered to the simulated
  empty `max_tokens` line (no user id is shown).
- [`render-trimmed.png`](render-trimmed.png) — Render filtered to `trimmed`, showing the exact
  eight-message trim.
- [`drill-response.txt`](drill-response.txt) — the one-off request result summary (no token or
  credential).

## Deployment and checks

- PR #237 passed all four required CI checks: `server`, `mobile`, `secret-guard`,
  `attribution-guard` (run `43067882255`).
- Squash-merged as `c3bd692`; Render `/api/health` reported that commit after deploy.
- The focused AI-105/AI-106 regression suite passed 15/15; the full unit suite passed
  **1,991 / 0 failed / 62 skipped**; typecheck and lint were clean.
