# Device run — draft-resume

- started: 2026-11-23T06:26:58.059Z
- device: sdk_gphone64_x86_64 · Android 15 (API 35) · emulator-5554
- overall: FAIL (exit 1)
- steps: 8/9 passed

| step | result | ms | what was seen |
|---|---|---|---|
| open inventoryai://purchase-orders/from-restock | pass | 981 | inventoryai://purchase-orders/from-restock |
| expect "Draft purchase order from restock" | pass | 2336 | seen after 2335ms |
| choose "Draft Proof Supplier 1795403412084" from the "Supplier" picker | pass | 11291 | chose "Draft Proof Supplier 1795403412084" |
| choose "Draft Proof Bay 1795403412084" from the "Receiving location" picker | pass | 11259 | chose "Draft Proof Bay 1795403412084" |
| expect "Draft Proof Gadget 1795403412084" | pass | 2419 | seen after 2419ms |
| tap "Draft Proof Gadget 1795403412084" | pass | 3101 | tapped Draft Proof Gadget 1795403412084, SKU DP-B-1795403412084 · 0 available · minimum 3 · out of stock at 540,1625 |
| tap "Draft Proof Widget 1795403412084" | pass | 3132 | tapped Draft Proof Widget 1795403412084, SKU DP-A-1795403412084 · 0 available · minimum 5 · out of stock at 540,1805 |
| scroll down | pass | 1009 | scrolled down |
| expect "Create draft order (2 items)" | FAIL | 15153 | expected "Create draft order (2 items)" within 15000ms; screen showed: At a glance \| Mon, Nov 23 \| Home \| Phone \| Messages \| Inventory AI \| Chrome \| Camera \| Google search \| Google app |

evidence: C:/Users/jeffe/inventory-ai/docs/evidence/draft-po-force-stop-2026-11-23/automated-2026-11-23T06-10Z/journey-success
