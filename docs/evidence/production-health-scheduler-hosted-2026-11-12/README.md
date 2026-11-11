# Hosted production-health scheduler attempts — 2026-11-11

## Outcome

**No cutover. The Windows Task Scheduler job remains the only automatic trigger.** GitHub has not
emitted an `event=schedule` run for any of the hosted paths attempted here, through
**2026-11-11T19:21Z**. A manual hosted run succeeds, but that is not continuous monitoring and does
not justify disabling the laptop task.

The 10K gate rerun is a separate, completed result: **24/25 written, 25/25 semantically correct, 0
errors, 0 degraded, $0.000000**. See
[`../deployed-gate-2026-11-12/README.md`](../deployed-gate-2026-11-12/README.md).

## Attempts

| Attempt | Commit / run | Result |
| --- | --- | --- |
| v2 cron corrected from `2-59/5` to `*/5` | PR #239, merged as `83a9f26` | Workflow active; **0** `event=schedule` runs through 19:01Z |
| Hosted dispatcher in the main repository | PR #240, merged as `66b0929`; workflow `415018961` | Manual run [`43078454582`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43078454582) succeeded and dispatched v2 [`43078473387`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43078473387); v2 succeeded. **0** scheduled dispatcher runs |
| Separate private watch repository | `nreffejzxc/inventory-ai-health-watch`, commit `1d627de` | Manual run [`43080451330`](https://github.com/nreffejzxc/inventory-ai-health-watch/actions/runs/43080451330) succeeded; **0** scheduled runs |
| Shared schedule in the working TypeScript watch | PR #242, merged as `8a89a53` | Added a `*/5` schedule and guarded dispatch job; the workflow's previous weekly schedule had fired 2026-11-09, but **0** fresh scheduled runs appeared through 19:21Z |

The separate repository runs the same read-only probe as the main workflow and opens/closes a GitHub
issue on the two-consecutive-failure rule. Its manual run reported:

- `/api/health/ready`: `200`
- `/api/health`: `200`, `status: ok`, `db: connected`
- no open alert issue was created

## Why the laptop stays enabled

| Check | State |
| --- | --- |
| Windows task | `InventoryAI Production Health Watch`, state `Ready` |
| Latest fallback v2 run | [`43085684883`](https://github.com/nreffejzxc/inventory-ai/actions/runs/43085684883), `workflow_dispatch`, success at 19:16:40Z |
| Hosted scheduled run | none observed |
| GitHub Actions status | operational during the checks |
| New repository workflow | active, default branch `main`, Actions enabled |

Disabling the laptop task now would leave production without an automatic health check. The task
remains active until a hosted scheduled run is actually observed and successful.

## Next action

An independent hosted monitor is still required. GitHub Actions scheduling did not fire in either
repository, including a newly created repository with a minimal `*/5` workflow. The practical next
step is a hosted uptime service that checks `/api/health/ready` and `/api/health` on a five-minute
interval and sends an alert outside this laptop; its account/API credential is not present in this
workspace. Do not store that credential in the repository.

No credentials, tokens, tenant data, prompts or answers are included in this record.
