# Inventory and Overview action review — 2026-11-22

Design review of the Scan and Purchase Orders actions, the Low/Out filters, and the Dashboard
Overview tiles. Development build on the CPH1969; demo fixture tenant. No server or production
change.

The Inventory four-chip layout and its saved/deep-linked filters were re-captured at 360 dp on
2026-11-22; that follow-up is recorded below.

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
| `04-inventory-360dp-counts.png` | All four server-backed chips at 360 dp: **All · 622**, **Needs attention · 311**, **Low stock · 311**, **Out of stock · 0**, wrapped two per row |

Also checked on the device: Low tile → **4 products low stock**, Out tile → **1 product out of stock**,
and the search barcode action opens **Scan Barcode**.

The floating gear in the screenshots is the Expo development-client overlay, not app UI. The
demo tenant's out-of-stock product has no stock row, which is why the Inventory out filter is empty while
the Dashboard reports one out-of-stock product.

## 360 dp and filter-state follow-up (2026-11-22)

The CPH1969 is 1080 px wide at 480 dpi, so the app viewport is exactly **360 dp** without an
override. All four chips rendered in two rows, each with fully visible counts and a 44 dp target:
-the measured node bounds were 588–720 px (44 dp) tall. Tap checks opened 311 rows for Low, 311 for
-Needs attention, and the empty explanation for Out; each chip's selected state and banner total
-matched its server count.

- **Saved filters:** after choosing Demo Shop + Low, a real force-stop and dev-client relaunch
  restored Demo Shop and Low stock (8 all / 6 needs attention / 6 low / 0 out). After Reset, a
  second force-stop/relaunch stayed at All / All locations with no Reset control.
- **Deep-link precedence:** while the screen was already mounted with Demo Shop + Low, a
  `?needsAttention=true` link changed the status to Needs attention and kept the saved Demo Shop
  location (6 rows). A `?location=Demo%20Warehouse&stockStatus=OUT_OF_STOCK` link changed both the
  location and the status (612 all / 303 needs attention / 303 low / 0 out).
- **Bug fixed:** the first deep-link attempt while mounted did nothing because the screen only read
  route parameters when it mounted. Route-supplied status/location are now derived until the user
  acts, and a new `q` route replaces the search field; the focused mobile tests cover both
  mounted-screen transitions. A device check changed an open screen from “Import Verify” to “Demo”
  with a second `?q=` link.
- **Saved location removed:** if the stored location is absent from the loaded active list, the
  screen opens at All locations and offers Reset instead of querying the stale id. This is covered
  by the focused screen test; the device check did not delete a location.
- **Reset:** removed both filters, deleted the saved record, and left no Reset button.
- **Dashboard route:** **View stock rows needing attention** opened Inventory at All locations with
  Needs attention selected and **311** rows. The action is now omitted when the restock preview is
  empty, so it is not offered beside "All caught up".

The device fixture has no inventory row that is out of stock (the product-level Dashboard count is
1, but that product has no row), so the Out chip was verified at zero and its empty state, not with
a non-zero row. Server fixtures cover the non-zero Out case.
