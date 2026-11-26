# Device run — draft-resume

- started: 2026-11-23T06:41:51.555Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: FAIL (exit 1)
- steps: 16/17 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 995 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2358 | seen after 2358ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11399 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11155 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2369 | seen after 2369ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3112 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3253 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| scroll down | pass | 1091 | scrolled down |
| expect "Create draft order (2 items)" | pass | 12298 | seen after 12298ms |
| tap "Create draft order (2 items)" | pass | 13200 | tapped Create draft order (2 items) at 540,1639 |
| force-stopped com.inventoryai.app after its Draft PO request | pass | 200 | com.inventoryai.app stopped; captured op-mwswfkh3-pqtihff6ksqcn3qc with the exact 251-byte body |
| cold relaunch and open inventoryai://purchase-orders/from-restock | pass | 32408 | cold-started the bundle, then opened inventoryai://purchase-orders/from-restock |
| expect "An unfinished draft attempt was restored" | pass | 12413 | seen after 12413ms |
| scroll down | pass | 1018 | scrolled down |
| expect "Resume draft creation (2 items)" | pass | 12627 | seen after 12627ms |
| tap "Resume draft creation (2 items)" | pass | 13614 | tapped Resume draft creation (2 items) at 540,1519 |
| expect "Draft PO-" | FAIL | 27487 | expected "Draft PO-" within 15000ms; screen showed: Tools \| Navigate up \| Purchase Order \| PO-0004 \| Draft \| Supplier \| Draft Proof Supplier 1795403412084 \| Location \| Draft Proof Bay 1795403412084 \| Created |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-38Z/journey2
