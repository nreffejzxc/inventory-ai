# Staging P4 concurrency and single-flight — 2026-11-13

**Status.** PASS. Two users, four conversations, two simultaneous waves, one duplicate
same-conversation request, no `5xx`, no server errors, and no duplicate persisted messages. The run
also exposed a free-provider concurrency limit; the staging server’s production-like paid fallback
handled it for **$0.004131** total. No production configuration or production data was touched.

## Setup

- Isolated loopback server: `NODE_ENV=development`, `MONGODB_DB_NAME=inventoryai_dev_db`,
  `http://127.0.0.1:4000`
- Disposable PERF SEED tenant: `6af75b052d094477c666284f`, 10,000 products / 20,006 inventory rows /
  1,535 products needing restocking
- Two active users: the seeded OWNER and a temporary MANAGER created by the drill
- Staging paid budget: **`$0.10`** for this process only. This is deliberately production-like:
  the free provider was observed to rate-limit concurrent requests, and production would use the
  paid fallback rather than fail the member’s turn. Production’s budget and configuration were not
  changed.
- Workload: `How many products need restocking?` — the free-route question that reliably called
  `getReorderNeededProducts` in the 25-question gate. The ground-truth total was read from
  `productService.listReorder`, not from the model answer.

## What happened

**Same-conversation duplicate.** The first turn was admitted and ran for 4,559 ms. 500 ms later, a
second request for the same conversation was refused:

```text
firstStatus=201
duplicateStatus=409
duplicateCode=AI_TURN_IN_PROGRESS
persistedUserMessages=1
persistedAssistantMessages=1
followUpStatus=201
messagesAfterFollowUp=4
```

The duplicate did not create a second USER or ASSISTANT message. After the first turn finished, the
follow-up ran normally, proving the slot was released.

**Concurrent waves.** Four requests ran at once in wave 1 and four in wave 2, split across the OWNER
and MANAGER and four distinct conversations.

| Measure | Result |
| --- | --- |
| Admitted turns | **8 / 8** |
| Distinct turn IDs | **8 / 8** |
| Correct answers | **8 / 8** |
| Free-served | 6 |
| Paid fallback-served | 2 |
| Median | **4,313 ms** |
| p95 | **4,990 ms** |
| Max | **4,990 ms** |
| `5xx` delta | **0** |
| Server-error delta | **0** |

All eight concurrent turns answered `1,535 products need restocking.` with
`getReorderNeededProducts`. The separate duplicate request was the intentionally refused one.

**Free-provider limit found.** The free model (`nvidia/nemotron-3.5-lightning:free`) returned
upstream HTTP `429` on the second concurrent wave. With a `$0` budget the staging server correctly
returned `429 AI_QUOTA_EXCEEDED`; with a `$0.10` budget the production-like fallback moved those turns
to `openai/gpt-oss-20b` and they completed correctly. This is a free-provider throughput limit, not
a concurrency defect in the turn path. It is also why the final run is **6 free / 2 paid**, not
free-only.

## Failed attempts and why

1. **$0 budget:** wave 1 passed; wave 2 had three provider `429`s and no paid fallback. The system
   behaved as designed for a zero budget, but this could not complete the concurrency test.
2. **$0.01 budget:** one paid fallback reserved the entire `$0.01`, so the remaining provider `429`s
   were blocked by the reservation. The first paid turn settled at `$0.001914`.
3. **$0.10 budget:** two paid fallbacks settled at **$0.003011** and **$0.001120**; all eight
   concurrent turns completed. Total staging paid cost **$0.004131**.

The free-provider rate limit is an important finding for capacity planning: four concurrent free
turns can exhaust the free route’s per-minute allowance. Production’s configured paid fallback is
what keeps those turns reliable.

## Evidence

- [`result.json`](result.json) — full per-turn results, models, tools, timings, answers, health deltas
- [`drill.txt`](drill.txt) — pass output and both wave timings
- [`server.txt`](server.txt) — server log showing the free `429`s, paid reservations, settled costs,
  `failovers=1` on the two fallback turns, and zero server errors
- [`seed.txt`](seed.txt) — disposable tenant creation

The tenant was shared with the advanced-task evaluation and the sustained-503 drill, then removed
with the guarded cleanup command; the removal and **0 remaining** verification are recorded in
[`staging-ai-reliability-cleanup-2026-11-13`](../staging-ai-reliability-cleanup-2026-11-13/README.md).

## Limits

- Four concurrent requests is a small burst, not a load test. It does not establish a maximum safe
  concurrency or test multiple server instances.
- The single-flight guard is process-local by design; this run used one process.
- The paid fallback was enabled for this test only. The earlier staging gate separately proved the
  25-question free-only path at `$0`.
- The free-provider `429` is a real capacity constraint and must not be confused with a duplicate
  turn or a local single-flight failure.
