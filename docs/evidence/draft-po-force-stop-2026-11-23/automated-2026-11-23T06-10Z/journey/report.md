# Device run — draft-resume

- started: 2026-11-23T06:25:21.035Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: FAIL (exit 1)
- steps: 7/8 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 988 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2297 | seen after 2297ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11091 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11086 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2337 | seen after 2337ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3111 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3117 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| expect "Create draft order (2 items)" | FAIL | 16930 | expected "Create draft order (2 items)" within 15000ms; screen showed: Tools \| Navigate up \| Draft From Restock \| Draft purchase order from restock \| Select the products to replenish. Quantities are calculated by the server from the selected location's current availability and each product's minimum stock. \| Order details \| Supplier * \| Draft Proof Supplier 1795403412084, ▾ \| Draft Proof Supplier 1795403412084 \| ▾ |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-10Z/journey
