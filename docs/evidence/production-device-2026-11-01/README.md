# Local-time answer and movement checks on a production build — 2026-11-01

A production-channel APK built from `deploy/ai-local-time` (commit `452c329`), installed over the
production app on the owner's phone, driven against the production API. This directory holds the
screenshots the claims below refer to.

- Device: OPPO `PV4DDMIZZLTCIVSK`, Android 11 (API 30), time zone `Asia/Manila` (UTC+8)
- App before: `1.0.0` (runtime `1.0.0`), production channel
- App after: `1.0.1` (runtime `1.0.1`), versionCode 7, EAS build
  `64958ea2-7419-463a-a145-c9c2780b3b15`, commit `452c329`
- Server: `https://ai-inventory-l1mi.onrender.com`, `GET /api/health` reported commit `28840f9`
  (the AI-41 merge), environment `production`
- Account on the phone: `jaffy royal kludge` (`jaffy`), tenant **royal kludge**. The `inplay`
  owner used for the "before" reading was not the session the new APK restored, so the two halves
  are different tenants; that does not affect the clock comparison, which is against the phone.
- Database: `inventoryai_prod_db` (production), read-only queries except the app's own writes

## 1. The assistant's "today" — before and after

The same question, "what moved today?", on the same phone, before and after the build:

| | Installed 1.0.0 (before) | Installed 1.0.1 (after) |
|---|---|---|
| Phone clock | 2026-11-01 07:29 | 2026-11-01 08:48 |
| "today" named by the answer | **2026-10-31** | **2026-11-01** |
| A movement made at 06:17 local | quoted as **2026-10-31 22:17**, labelled "Local time" | quoted as **08:42** for the stock-in actually made at 08:42 local |
| Ledger rows in the local day | 15 (tenant `inplay`) | 4 (tenant `royal kludge`, created by this run) |

The before half is quoted from the on-screen answer; it was not screenshotted. The after half is
[`ai-local-time.png`](ai-local-time.png): four movements, `08:47`, `08:47`, `08:45`, `08:42`, all
matching the phone's clock and the ledger instants (`00:42Z` → `08:42` Manila).

The two `08:47` lines are the two legs of **one** transfer (source and destination), which is what
the ledger records. They are not a duplicated operation; the Recent Activity card renders the same
transfer once.

## 2. Fast check of the two new movement behaviours

Test product: **ZZ Sprint1 Verify** (`6ae68ab977a69bebb915be7b`), created in the royal-kludge tenant
through the app. Main Warehouse `6ae38bbf3010605a8eb7b538`; Shop Front
`6ae38bbf3010605a8eb7b539`.

| Step | On screen | Database after |
|---|---|---|
| Stock In 10 at Main Warehouse | `Done. … 0 → 10` | one `STOCK_IN`, quantity 10, reason `ZZ sprint1 stock in` |
| Adjust → 7, reason `ZZ sprint1 adjust`, first press **CANCEL** | confirmation named `from 10 to 7 (-3)` and the reason; form stayed open | **no row**, on-hand still 10 |
| Press again → **ADJUST** | `Done. … 10 → 7` | exactly one `ADJUSTMENT`, previous 10, new 7, reason recorded |
| Row screen → **Transfer to another location** | form opened with product and `From location` already Main Warehouse, available 7 | — |
| Transfer 2 to Shop Front | `Done. … Main Warehouse: 7 → 5`, `Shop Front: 0 → 2` | two `TRANSFER` legs under one reference; inventory rows 5 and 2 |

Total ledger rows for the product: **4** (one stock-in, one adjustment, two transfer legs). Recent
Activity shows **3** entries: transfer 08:47, adjustment 08:45 (−3), stock-in 08:42 (+10) — see
[`recent-activity.png`](recent-activity.png). No duplicate row, and no second write when the
adjustment was cancelled.

## 3. What this does not prove

- The installed APK was built from a temporary branch (`deploy/ai-local-time`) so one build could
  carry AI-41 and the two Sprint 1 fixes. AI-41 is on `main` (`28840f9`); the Sprint 1 mobile and
  server changes were merged separately through PR #112. The APK's mobile files match that PR.
- The single-location default was not observed on this phone: the tenant has two locations. It is
  covered by `mobile/__tests__/movement-workflow-guards.test.tsx`.
- The server-side "reason is required" gate was not deployed when the phone run was made; the
  client enforced the reason in the form. The gate and its test were merged in PR #112, and the
  deployment that followed serves `ad8426e`. The refusal itself is proven in the test database, not
  by a raw production request.
- The test tenant keeps the product and its four ledger rows. Nothing was deleted.

## 4. Repeating the check

The screenshots were taken with `adb exec-out screencap -p`. The run used `uiautomator dump` for
coordinates and text; it is a manual pass, not the automated harness in
[`../device-runs/`](../device-runs/README.md). A repeat needs the phone unlocked (the six-digit
passcode cannot be supplied over adb) and a build whose `appVersion` matches its runtime.
