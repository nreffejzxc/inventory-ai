# Scheduled read-only inventory-integrity monitor

**Status:** installed, run and merged as `9d09962` on 2026-11-15; hosted freshness added in
`7ebc9a3` (PR #293). The audit is still read-only: no inventory row, ledger row, purchase order or
index was changed.

## Why this exists

The one-shot `audit:integrity` command reports the 2,517 known synthetic seed findings every time.
Repeating that alert daily would train a reader to ignore it. The monitor keeps an **accepted
baseline** of those findings and reports only findings that are not in it. It also records a local
history and opens one GitHub issue when a new candidate appears.

## What runs

| Part | Value |
| --- | --- |
| Trigger | Windows Task Scheduler task `InventoryAI Inventory Integrity Audit` |
| Schedule | Daily at 07:30 local; `StartWhenAvailable` after a missed run |
| Wrapper | `scripts/run-integrity-audit.ps1` |
| Registration | `scripts/register-integrity-audit-scheduler.ps1` |
| Command | `node server/scripts/monitor-inventory-integrity.mjs --with-production --notify` |
| Audit child | `server/scripts/audit-inventory-integrity.mjs --with-production --format=json` |
| Baseline | [`baseline.json`](baseline.json) — 2,517 known ids accepted 2026-11-15T04:45:59Z |
| Local history | `%LOCALAPPDATA%\InventoryAI\integrity-audit\` (`latest.json`, `latest.md`, `history.jsonl`) |
| Scheduler log | `%LOCALAPPDATA%\InventoryAI\integrity-audit-scheduler.log` |
| Hosted freshness | One document in `integrity_monitor_heartbeats`; `GET /api/health/integrity` returns 200 only while it is at most 26 hours old |
| Independent check | UptimeRobot `Inventory AI integrity freshness` (id **804681164**) on the freshness endpoint, every five minutes, currently **Up** |
| Alert | One open GitHub issue titled `[inventory-integrity] New findings detected`; updated only when the new set changes, closed on recovery |

The 07:30 task ran at 12:46 local on 2026-11-15 as a manual verification. Task result was **0**, the
history recorded **UNCHANGED / 0 new**, and no issue was created (there was nothing new). After the
GitHub CLI fallback guard was added, the same wrapper was run manually at 04:59:55Z and again
returned **UNCHANGED / 0 new**, exit **0**. A one-off Task Scheduler trigger at 19:11:35 local then
proved the scheduler mechanism itself: task result **0**, **UNCHANGED**, 0 new, 1 resolved, 4,896
rows; the temporary task was removed and the daily task untouched. See
[`scheduler-trigger-proof-2026-11-15.md`](scheduler-trigger-proof-2026-11-15.md).

That proof run also observed a real change: one old SteelSeries orphan was resolved when a matching
inventory row was created by a new PO receipt (`PO-DEMO-00006`) at 09:43:59Z. This was an external
write, not a monitor repair. The baseline was **not** modified, as instructed, so the resolved count
remains 1 until an explicitly approved baseline refresh.

The first automatic daily run is still scheduled for 2026-11-16 07:30 local.

The deployed endpoint, production heartbeat and independent monitor are recorded in
[`hosted-heartbeat-2026-11-15.md`](hosted-heartbeat-2026-11-15.md).

## How the baseline works

The baseline is an **acceptance of known candidates**, not a statement that they are correct
inventory. It contains the transaction ids of the 2,517 triaged seed findings. A normal run:

1. runs the audit read-only;
2. compares every current finding id with the baseline;
3. reports `NEW_FINDINGS` when an id is not in the baseline, and `UNCHANGED` when it is;
4. writes the result to local history and, only with `--notify`, updates the issue.

The baseline is not auto-updated. After reviewing a new finding, the owner can promote it by running:

```bash
cd server
node scripts/monitor-inventory-integrity.mjs --with-production --accept-baseline
```

That writes only `baseline.json`; it never deletes or repairs inventory. Do not run it merely to make
an alert disappear.

## Manual commands

```bash
cd server
npm run audit:integrity:monitor -- --with-production --format=json   # read-only check, no alert
npm run audit:integrity:monitor -- --with-production --notify        # check and update the issue
node scripts/write-integrity-heartbeat.mjs --with-production        # publish freshness only
node scripts/monitor-inventory-integrity.mjs --with-production --accept-baseline
```

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-integrity-audit-scheduler.ps1
Get-ScheduledTask -TaskName 'InventoryAI Inventory Integrity Audit'
Get-ScheduledTaskInfo -TaskName 'InventoryAI Inventory Integrity Audit'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-integrity-audit.ps1
```

## First run

- [`first-run-2026-11-15.json`](first-run-2026-11-15.json) — the monitor summary from the verified
  task run.
- [`first-run-2026-11-15.md`](first-run-2026-11-15.md) — the same result in its operator-readable
  form.
- The full history stays on the operator machine; it is intentionally not committed every day.

## Triage and approval gate

The 2,517 baseline rows were investigated in
[`../inventory-integrity-2026-11-15/TRIAGE.md`](../inventory-integrity-2026-11-15/TRIAGE.md). They are
synthetic seed fixtures in two demo/perf tenants. **No deletion or repair is approved.** Cleaning up a
synthetic tenant requires its own backup, written approval, and the existing whole-tenant cleanup
commands.

## Limits

- **The audit is not hosted.** The task runs only while this Windows user is signed in and the
  laptop is awake, online, and able to reach MongoDB. A missed run starts when the laptop next
  becomes available. The **freshness signal** is hosted, so a stopped task becomes a 503 and an
  UptimeRobot alert instead of silence. GitHub's own `schedule` trigger has never fired for this
  repository, so a workflow cron was not used.
- **The alert is GitHub, not a pager.** A new finding opens/updates one issue; it does not send a
  separate email. The issue is visible to the repository owner.
- **The baseline is an accepted candidate list.** It does not make the underlying seed rows correct.
- **The monitor does not repair.** There is no `--fix` flag in either the monitor or the audit.
