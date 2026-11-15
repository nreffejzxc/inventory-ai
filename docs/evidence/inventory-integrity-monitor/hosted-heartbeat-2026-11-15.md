# Hosted freshness — 2026-11-15

**Purpose.** Make a stopped laptop visible without reading the laptop's logs. The audit remains
read-only; one operational metadata document is written after each run.

## Deployed endpoint

| Check | Result |
| --- | --- |
| Production commit | `7ebc9a395bcc55a94494fc892d489292abc15a64` (PR #293) |
| Endpoint | `https://ai-inventory-l1mi.onrender.com/api/health/integrity` |
| Response | **HTTP 200** |
| Body | `state: fresh`, `fresh: true`, `auditStatus: UNCHANGED`, `newCount: 0`, `resolvedCount: 1`, `scannedStockIns: 4896`, `ageSeconds: 1157`, `maxAgeSeconds: 93600` |
| Legacy health | `status: ok`, `db: connected`, `environment: production`, 0 `5xx` |

The 26-hour threshold is deliberately longer than the daily 07:30 interval: a late start is still
healthy, while a whole missed day is stale. Missing, malformed, future-dated, stale and `NOT CHECKED`
heartbeats all return **503**; the branch is pinned by unit tests.

## Production heartbeat document

`inventoryai_prod_db.integrity_monitor_heartbeats`, `_id: "production"`:

```json
{
  "checkedAt": "2026-11-15T11:11:36.859Z",
  "status": "UNCHANGED",
  "scannedStockIns": 4896,
  "orphanStockIns": 2516,
  "unreceiptedPoStockIns": 0,
  "newCount": 0,
  "resolvedCount": 1,
  "database": "inventoryai_prod_db",
  "source": "windows-task",
  "updatedAt": "2026-11-15T11:18:27.841Z"
}
```

This document was written by `server/scripts/write-integrity-heartbeat.mjs` and read back unchanged.
No inventory, ledger, purchase-order, product, location, user or baseline row was touched.

## Independent monitor

| Setting | Value |
| --- | --- |
| Provider | UptimeRobot (free plan) |
| Monitor | `Inventory AI integrity freshness` |
| Monitor ID | **804681164** |
| URL | `https://ai-inventory-l1mi.onrender.com/api/health/integrity` |
| Type | HTTP/S |
| Interval | 5 minutes |
| Current status | **Up**, 100% over 24h/7d/30d, 0 incidents |
| Alert contact | Account e-mail, attached; **test notification sent** |
| Dashboard | `https://dashboard.uptimerobot.com/monitors/804681164` |

The first check completed after the monitor was created; it then reported **Up**. No production
heartbeat was altered to force a 503, so the live stale transition has not been observed on the
hosted endpoint. The 503 branches are unit-tested, and the 26-hour threshold is the production
setting.

## Read-only boundary

- `server/scripts/monitor-inventory-integrity.mjs` still never opens a database; its source guard
  refuses a write call.
- `server/scripts/audit-inventory-integrity.mjs` still runs with `autoIndex`/`autoCreate` disabled.
- `server/scripts/write-integrity-heartbeat.mjs` is the only writer. It updates one document in
  `integrity_monitor_heartbeats`, imports no inventory/ledger/PO/business model, and has no repair
  path.
- The accepted 2,517-id baseline was not modified.

## Still pending

The first **automatic daily** run is due **2026-11-16 07:30 local**. This record proves the endpoint
and monitor, not that daily run.
