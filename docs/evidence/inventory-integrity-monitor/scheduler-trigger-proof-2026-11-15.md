# Scheduler trigger proof — 2026-11-15

**Purpose.** Prove that Windows Task Scheduler itself can launch the inventory-integrity wrapper,
without waiting for the next daily 07:30 run and without changing the permanent task.

## Setup

A temporary current-user task, `InventoryAI Integrity Audit - Trigger Proof`, was registered with a
**single one-off trigger at 2026-11-15 19:11:35 +08:00**. Its action was the same wrapper the daily
task uses:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\jeffe\inventory-ai\scripts\run-integrity-audit.ps1
```

The permanent task was not modified.

## Observed

| Check | Result |
| --- | --- |
| Temporary task state before the trigger | Ready |
| `LastRunTime` | **2026-11-15 19:11:35 local** |
| `LastTaskResult` | **0** |
| Monitor history entry | `2026-11-15T11:11:36.859Z` |
| Status | `UNCHANGED` |
| New findings | **0** |
| Resolved findings | **1** |
| `STOCK_IN` rows scanned | **4,896** |
| Scheduler log | `finished with exit 0` |

The run was launched by the task trigger, not by a person or `Start-ScheduledTask`.

## Cleanup

The temporary task was removed with `Unregister-ScheduledTask`. It no longer exists. The permanent
task remains:

| Check | Result |
| --- | --- |
| `InventoryAI Inventory Integrity Audit` | **Ready** |
| Last run | 2026-11-15 12:46:21 local (the earlier manual verification) |
| Last result | **0** |
| Next run | **2026-11-16 07:30:00 local** |

No duplicate task was left behind.

## The one resolved finding

The proof run detected a real change since the earlier scan:

- Resolved id: `ORPHAN_STOCK_IN:6aef380db94b2abdac698af8`
- Transaction: `6aef380db94b2abdac698af8` — SteelSeries, `DEMO-8-8`, `Seeded movement`, quantity 14,
  created 2026-10-07
- The matching inventory row was created at **2026-11-15T09:43:59.735Z** with quantity **90**
- Five `STOCK_IN` rows were written between 09:40:45Z and 09:44:00Z, four of them `PO receipt`
  references; the matching one is `PO-DEMO-00006`

This was **not** a repair or deletion by this monitor. It is a real inventory/PO write in the
SteelSeries demo tenant. The audit correctly stopped reporting that old orphan. The accepted
baseline was **not** modified, as instructed; the monitor will continue to report one resolved row
until a future, explicitly approved baseline refresh.

## Limit

This proves the scheduler **mechanism** works now. It does not replace the first daily 07:30
automatic run, which is still pending on 2026-11-16.
