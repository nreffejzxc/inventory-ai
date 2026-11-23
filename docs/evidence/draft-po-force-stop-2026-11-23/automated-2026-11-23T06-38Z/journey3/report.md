# Device run — draft-resume

- started: 2026-11-23T06:45:05.232Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: pass (exit 0)
- steps: 20/20 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 990 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2318 | seen after 2318ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11161 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11342 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2365 | seen after 2365ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3128 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3116 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| scroll down | pass | 1077 | scrolled down |
| expect "Create draft order (2 items)" | pass | 12189 | seen after 12189ms |
| tap "Create draft order (2 items)" | pass | 12953 | tapped Create draft order (2 items) at 540,1639 |
| force-stopped com.inventoryai.app after its Draft PO request | pass | 189 | com.inventoryai.app stopped; captured op-mwswjpgd-qxpii9119ib5in6h with the exact 251-byte body |
| cold relaunch and open inventoryai://purchase-orders/from-restock | pass | 31087 | cold-started the bundle, then opened inventoryai://purchase-orders/from-restock |
| expect "An unfinished draft attempt was restored" | pass | 12222 | seen after 12222ms |
| scroll down | pass | 1034 | scrolled down |
| expect "Resume draft creation (2 items)" | pass | 12326 | seen after 12326ms |
| tap "Resume draft creation (2 items)" | pass | 13298 | tapped Resume draft creation (2 items) at 540,1519 |
| expect "Purchase Order" | pass | 14028 | seen after 14028ms |
| expect "PO-" | pass | 12486 | seen after 12486ms |
| screenshot "draft-po-resumed" | pass | 424 | C:\Users\jeffe\inventory-ai\docs\evidence\draft-po-force-stop-2026-11-23\automated-2026-11-23T06-38Z\journey3\draft-po-resumed.png |
| verify exactly one DRAFT for the captured key/body | pass | 1192 | exactly one DRAFT (PO-0005) for op-mwswjpgd-qxpii9119ib5in6h |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-38Z/journey3
