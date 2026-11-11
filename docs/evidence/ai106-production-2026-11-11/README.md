# AI-106 production deployment and live verification (2026-11-11)

This report records the production deployment of the AI-106 finalizer fix and the live verification
on the OPPO `CPH1969`, Android 11, `com.inventoryai.app` 1.0.2 (versionCode 10). No OpenRouter or
Render environment configuration, provider setting, or AI model was changed.

## Deployment

- PR [#229](https://github.com/nreffejzxc/inventory-ai/pull/229) squash-merged as
  `26eb0d4ab363fbe66be185c4b3e10c310790f071` at 2026-11-11T14:20:04Z.
- Render served the merge commit: `/api/health` reported `commit=26eb0d4...`, `status: ok`,
  `db: connected`, environment `production`, and `serverErrors: 0`; `/api/health/ready` returned
  200.
- CI run `43036926984` passed all four required checks: server, mobile, secret-guard and
  attribution-guard.
- The deployed changes were the AI-106 finalizer fixes, the focused regression suite, and the
  type-only `server/tsconfig.json` DOM lib compatibility entry.

## Live phone turns

Each question was sent from a fresh chat.

| # | Question | Rendered answer | Ref |
| --- | --- | --- | --- |
| 1 | `How many low-stock products are there in total?` | **“19 products need restocking.”** | `4cef1383` |
| 2 | `How many products are low on stock and what is their total value?` | **“The total recorded value of the 19 low-stock items is 1,633,025.”** | `771dc31f` |

The first answer contains the count **19** and no monetary value. The second contains both the
count (**19 low-stock items**) and their total recorded value (**1,633,025**).

Screenshots:

- [`low-stock-count.png`](low-stock-count.png) — first answer and `Ref: 4cef1383`.
- [`compound-clean.png`](compound-clean.png) — compound answer and `Ref: 771dc31f`.
- [`production-launch.png`](production-launch.png),
  [`dashboard-scrolled.png`](dashboard-scrolled.png),
  [`workspace-list.png`](workspace-list.png), [`ai-screen.png`](ai-screen.png) and
  [`new-chat.png`](new-chat.png) — production app and signed-in workspace smoke.

## Render log matching

The Render application logs identify the same eight-character turn token shown on the phone.

For `4cef1383`:

```text
AI request intent=inventory:restock_count route=simple model=nvidia/nemotron-3.5-lightning:free
  tier=free ... tools=inventory turn=4cef1383
AI turn outcome=ok status=ok ... tools=getReorderNeededProducts toolRuns=1 ... turn=4cef1383
```

For `771dc31f`:

```text
AI request intent=inventory route=default model=openai/gpt-oss-20b tier=paid ... turn=771dc31f
AI low-stock value computed from the returned rows
AI turn outcome=ok status=ok duration=12.54s ... tools=getLowStockProducts toolRuns=1 ...
  turn=771dc31f
```

The log view was filtered for the first ref (`q=4cef1383` in the dashboard URL), and the same
application-log view showed `771dc31f` in the live tail. The excerpts omit request IDs, user IDs and
other session data.

## Output-limit observation

The first compound attempt, sent in the same conversation immediately after the count answer,
returned the app’s **“The assistant ran out of room before it could answer.”** message. Render
logged `turn=c6d62a6a`, `AI_OUTPUT_LIMIT`, `maxTokens=1200`, `attempts=2`, `retries=1`,
`tools=none`. This is the existing AI-105 output-budget path; it did not produce a wrong count or
value. A clean compound turn in a fresh chat then passed as shown above. No model, token limit or
provider setting was changed.

## Checks and limits

- The finalizer regression suite is **6/6 pass**; CI’s server and mobile jobs are green.
- `node scripts/check-docs.mjs` (exit 0), the focused docs drift suite (**9/9 pass**) and
  `git diff --check` (exit 0) passed with this record.
- Android only; iOS was not tested. The **“Correcting the answer…”** label remains unobserved live,
  as recorded in the OTA evidence.
- The same-thread compound output-limit failure is a separate, pre-existing limitation, not a
  finalizer pass. The clean fresh-chat compound turn is the acceptance turn for this report.

## Follow-up — 2026-11-11

The same-thread output-limit retry was fixed in PR [#232](https://github.com/nreffejzxc/inventory-ai/pull/232)
(`3b275df`). The exact count-then-compound sequence then passed in one thread (`bf777146` and
`e4570da9`), and the “Correcting the answer…” label was observed live at `008a1583`. See
[`../ai105-production-2026-11-11/README.md`](../ai105-production-2026-11-11/README.md). This
addendum supersedes the two limits above; the original observations remain as recorded.
