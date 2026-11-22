# Inventory and Overview action review — 2026-11-22

Design review of the Scan and Purchase Orders actions, the Low/Out filters, and the Dashboard
Overview tiles. Development build on the CPH1969; demo fixture tenant. No server or production
change.

## Decisions

| Question | Decision |
| --- | --- |
| Should Scan/Purchase Orders be buttons inside the Dashboard Overview? | No. The Overview is five count tiles; Scan and New PO already live in **Quick actions**, and Purchase orders has its own **Procurement** section. Adding them to the Overview would duplicate those actions and crowd the counts. Low/Out tiles remain drill-downs to product lists, now with a chevron, an accessibility hint and an action subtitle. |
| Should the Scan and Purchase Orders buttons stay on Inventory? | Yes, but not as a top button row. STAFF land on Inventory and have no Dashboard, so both routes must remain reachable. Scan moved into the search field (a barcode action where a member is already looking for a product); Restock and Purchase orders became a **Shortcuts** section with subtitles. |
| Should Low stock / Out of stock remain? | Yes — they are useful row-level triage filters. Added an **All** choice, a live count with **Clear**, and made the two statuses mutually exclusive. The API's row flags cannot both be true (a row is low when 0 < available ≤ minimum, out at 0), so selecting both used to return an empty list. The combined product-level view remains the Restock list. |
| Products screen consistency | The standalone "Scan a barcode" button was replaced by the same in-search scan action, so both list screens behave the same. |

## Device evidence

| File | Shows |
| --- | --- |
| `00-dashboard-overview.png` | Overview tiles with chevrons; Low "Review products", Out "Restock products" |
| `01-inventory-default.png` | Search with barcode action, All/Low/Out chips, Shortcuts rows |
| `02-inventory-low-filter.png` | "11 stock rows low on stock" with Clear |
| `03-inventory-out-empty.png` | Out filter with no rows, and the explanation that a zero-stock product has no inventory row — Products → Out of stock is the product-level view |

Also checked on the device: Low tile → **4 products low stock**, Out tile → **1 product out of stock**,
and the search barcode action opens **Scan Barcode**.

The floating gear in the screenshots is the Expo development-client overlay, not app UI. The demo
tenant's out-of-stock product has no stock row, which is why the Inventory out filter is empty while
the Dashboard reports one out-of-stock product.
