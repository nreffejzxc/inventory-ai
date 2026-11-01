# A transfer's direction in a live assistant answer — 2026-11-02

The assistant's `getInventoryHistory` tool had returned the two ledger legs of a transfer without
saying which location sent stock and which received it. §27HH added a note beside the rows; the
first post-deploy answer still put the source on the wrong side. §27HI folds a complete pair into
one event with explicit `from` and `to`. This is the device check of that fix.

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android 11 (API 30), `Asia/Manila` (UTC+8), mirrored with
  `scrcpy` over USB while the check ran
- App: preview build `5500e6be`, versionName `1.0.1`, runtime `1.0.1`, versionCode 8
- Server: `https://ai-inventory-l1mi.onrender.com`, `GET /api/health` reported commit `1c1734b`,
  environment `production`, database `connected`, **0** server errors
- Account: `jaffy royal kludge`, tenant **royal kludge**
- Product: **ZZ Sprint1 Verify**

## Ground truth

The dashboard's Recent Activity row for the movement reads:

```text
ZZ Sprint1 Verify     Transfer  2
Main Warehouse → Shop Front · Nov 1, 2026 · 08:47
```

That row is rendered from the grouped activity, which already knew both ends. The ledger has two
`TRANSFER` legs under one reference: Main Warehouse lost 2 (7 → 5), Shop Front gained 2 (0 → 2).

## The answer, after the fix

[`answer.png`](answer.png) is the screen after asking:

> Show the latest transfer: which location sent it and which location received it?

```text
The most recent transfer was:
• From: Main Warehouse
• To: Shop Front

The move was 2 units of the product ZZ Sprint1 Verify, logged at 2026-11-01 08:47 local time.
Read: Stock movements
```

The direction matches the dashboard, the destination is present, and the transfer is reported once.
The earlier answer against `be28464` had said `From: Shop Front` and named no destination.

## What this does not prove

- Model compliance is not deterministic. One answer on one tenant is evidence that the folded
  event carries the direction; the tool boundary is pinned separately by
  `server/test/AI42-transfer-event.test.mjs`.
- No EAS build or OTA was needed: this is a server change, and the installed preview build already
  points at production.
