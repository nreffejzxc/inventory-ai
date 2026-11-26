# Overview stock filters and Products action clarity — device evidence (2026-11-22)

**Scope:** local development build only. No deployment, OTA, APK publication or production
database access. The backend used `inventoryai_dev_db`; the phone reached it through
`adb reverse tcp:4000 tcp:4000` and Metro through `adb reverse tcp:8081 tcp:8081`.

## Device and tenant

- Physical device `PV4DDMIZZLTCIVSK` (CPH1969), development build `com.inventoryai.app`,
  version **1.0.2**, versionCode **10**.
- Signed in as `demo-preview@example.invalid` (OWNER of the demo tenant).
- Current PR #364 branch (`fix/overview-stock-filters`) served by the local backend and Metro.

## Four Overview tiles

| Tile | Overview count | Products list opened | Scope shown |
| --- | ---: | ---: | --- |
| In stock | **309** | **309 products in stock** | Active products |
| Low stock | **4** | **4 products low stock** | Active products |
| Out of stock | **1** | **1 product out of stock** | Active products |
| Active products | **314** | **314 active products** | Active products |
| Total on-hand qty | **436** | — | — |

The three stock tiles partition the active catalogue: **309 + 4 + 1 = 314**. The Active
products tile opens the ACTIVE list and now shows its total above the status chips; previously
it opened the same list without a count.

## Filter behavior checked on the device

1. **Visible chips.** Products shows **In stock**, **Low stock** and **Out of stock** under the
   search field. Selecting **Low stock** highlighted that chip, pinned the scope to **Active
   products**, showed **4 products low stock**, and removed the All/Active/Archived switch.
2. **Clear.** Pressing **Clear** on the low list returned to **314 active products** with the
   status chips available again.
3. **Canonical deep links.** `products?status=ACTIVE&stockStatus=IN_STOCK` → **309 products in
   stock**; `OUT_OF_STOCK` → **1 product out of stock**. Both displayed **Active products**, not
   Archived.
4. **Legacy flags with a canonical status.** `products?status=ARCHIVED&stockStatus=LOW_STOCK&lowStock=true&outOfStock=true`
   → **4 products low stock**, scope **Active products**, no Archived option. The legacy flags did
   not override the canonical status or the ACTIVE pin.
5. **Legacy-only link.** `products?lowStock=true` → **4 products low stock**, scope **Active
   products**, with the **Low stock** chip selected. The old broad flag now maps to the visible
   canonical filter instead of silently applying an invisible filter.
6. **Clear after a legacy link.** Pressing **Clear** on the legacy-only list returned to **314
   active products**, so the old flags did not survive the clear.

## Screenshots

- [`00-dashboard-overview.png`](00-dashboard-overview.png) — all four tiles and on-hand total.
- [`01-products-active.png`](01-products-active.png) — Active products tile list with **314
  active products** and visible In/Low/Out chips.
- [`02-products-in-selected.png`](02-products-in-selected.png) — In stock selected, **309**,
  Active products.
- [`03-products-low-selected.png`](03-products-low-selected.png) — Low stock selected, **4**,
  Active products.
- [`04-products-out-selected.png`](04-products-out-selected.png) — Out of stock selected, **1**,
  Active products.
- [`05-legacy-low-link.png`](05-legacy-low-link.png) — legacy-only `lowStock=true` mapped to the
  visible Low stock filter.
- [`06-products-active-after-clear.png`](06-products-active-after-clear.png) — Clear returned to
  **314 active products**.

The floating gear in the screenshots is the Expo development-client overlay, not app UI.

## Limits

- The run used the local development backend, not production or a hosted deployment.
- The stock-status list is pinned to ACTIVE by the mobile route. A direct API request that sends
  `stockStatus` without `status=ACTIVE` still uses the server's default population; the mobile
  client always sends the pin.
- This evidence does not cover a fresh install, sign-in or a production build.
