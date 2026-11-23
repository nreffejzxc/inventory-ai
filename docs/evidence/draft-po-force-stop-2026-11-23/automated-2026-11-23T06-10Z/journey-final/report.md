# Device run — draft-resume

- started: 2026-11-23T06:28:31.606Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: FAIL (exit 1)
- steps: 12/13 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 978 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2394 | seen after 2394ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11242 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11295 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2349 | seen after 2349ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3136 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3169 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| scroll down | pass | 1121 | scrolled down |
| expect "Create draft order (2 items)" | pass | 12221 | seen after 12221ms |
| tap "Create draft order (2 items)" | pass | 13160 | tapped Create draft order (2 items) at 540,1639 |
| force-stopped com.inventoryai.app after its Draft PO request | pass | 217 | com.inventoryai.app stopped; captured op-mwsvyf3u-kqzkv4j7wjeprrn3 with the exact 251-byte body |
| cold relaunch and open inventoryai://purchase-orders/from-restock | pass | 12521 | cold-started the bundle, then opened inventoryai://purchase-orders/from-restock |
| expect "An unfinished draft attempt was restored" | FAIL | 17289 | expected "An unfinished draft attempt was restored" within 15000ms; screen showed: Tools \| INVENTORY AI \| Draft Proof Owner \| Owner \| Switch to dark mode \|  \| Sign out \|  \| Good morning, Draft \| Last updated Nov 23, 2026 · 06:29 |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-10Z/journey-final
