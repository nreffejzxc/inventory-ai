# Device run — draft-resume

- started: 2026-11-23T06:38:55.758Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: FAIL (exit 1)
- steps: 13/14 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 987 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2322 | seen after 2322ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11263 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11263 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2341 | seen after 2341ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3243 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3170 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| scroll down | pass | 1140 | scrolled down |
| expect "Create draft order (2 items)" | pass | 12328 | seen after 12328ms |
| tap "Create draft order (2 items)" | pass | 13280 | tapped Create draft order (2 items) at 540,1639 |
| force-stopped com.inventoryai.app after its Draft PO request | pass | 207 | com.inventoryai.app stopped; captured op-mwswbsww-tqxh22gwmpw8szmr with the exact 251-byte body |
| cold relaunch and open inventoryai://purchase-orders/from-restock | pass | 31682 | cold-started the bundle, then opened inventoryai://purchase-orders/from-restock (retry 1) |
| expect "An unfinished draft attempt was restored" | pass | 12373 | seen after 12373ms |
| expect "Resume draft creation (2 items)" | FAIL | 25569 | expected "Resume draft creation (2 items)" within 15000ms; screen showed: Tools \| Navigate up \| Draft From Restock \| Draft purchase order from restock \| Select the products to replenish. Quantities are calculated by the server from the selected location's current availability and each product's minimum stock. \| Order details \| Supplier * \| Draft Proof Supplier 1795403412084, ▾ \| Draft Proof Supplier 1795403412084 \| ▾ |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-38Z/journey
