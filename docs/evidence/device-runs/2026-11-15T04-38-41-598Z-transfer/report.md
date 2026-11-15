# Device run — transfer

- started: 2026-11-15T04:38:41.598Z
- device: CPH1969 · Android 11 (API 30) · PV4DDMIZZLTCIVSK
- overall: pass (exit 0)
- steps: 60/60 passed

| step | result | ms | what was seen |
|---|---|---|---|
| find the product with SKU PHONE-SMOKE-20261115 through the products search | pass | 62363 | opened Phone Smoke Product (SKU PHONE-SMOKE-20261115) through the products search in 62362ms |
| tap "Stock In" | pass | 27506 | tapped Stock In at 204,2091 after 1 scroll |
| choose "Phone Smoke Location" from the "Location" picker | pass | 13210 | chose "Phone Smoke Location" |
| type into the focused field | pass | 22605 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 23510 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T04-38-41-598Z-IN, keyboard closed |
| tap "Add stock" | pass | 4553 | tapped Add stock at 540,1824 |
| check the movement arithmetic (1) | pass | 2366 | 3 → 4 (1) |
| tap "OK" | pass | 3980 | tapped OK at 873,1303 |
| open inventoryai://transfer | pass | 1027 | inventoryai://transfer |
| expect "From location" | pass | 2245 | seen after 2245ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 12345 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 22499 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location 2" from the "To location" picker | pass | 31769 | chose "Phone Smoke Location 2" |
| type into the focused field | pass | 42621 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 42930 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T04-38-41-598Z-F, keyboard closed |
| tap "Transfer stock" | pass | 14119 | tapped Transfer stock at 540,1899 |
| check the movement arithmetic (-1, 1) | pass | 2230 | 4 → 3, 0 → 1 (-1, 1) |
| tap "OK" | pass | 4124 | tapped OK at 873,1385 |
| open inventoryai://transfer | pass | 1028 | inventoryai://transfer |
| expect "From location" | pass | 2280 | seen after 2280ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 12681 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location 2" from the "From location" picker | pass | 21995 | chose "Phone Smoke Location 2" |
| choose "Phone Smoke Location" from the "To location" picker | pass | 31833 | chose "Phone Smoke Location" |
| type into the focused field | pass | 42113 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 42522 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T04-38-41-598Z-R, keyboard closed |
| tap "Transfer stock" | pass | 13956 | tapped Transfer stock at 540,1899 |
| check the movement arithmetic (-1, 1) | pass | 2373 | 1 → 0, 3 → 4 (-1, 1) |
| tap "OK" | pass | 3935 | tapped OK at 873,1385 |
| open inventoryai://transfer | pass | 1045 | inventoryai://transfer |
| expect "From location" | pass | 2715 | seen after 2715ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 12300 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 23127 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location" from the "To location" picker | pass | 32156 | chose "Phone Smoke Location" |
| type into the focused field | pass | 44020 | "Quantity" now reads 1, keyboard closed |
| scroll up | pass | 2286 | scrolled up |
| expect "Choose two different locations" | pass | 12594 | seen after 12594ms |
| scroll down | pass | 1867 | scrolled down |
| expect "Transfer stock" to be disabled | pass | 13273 | "Transfer stock" is disabled |
| open inventoryai://dashboard | pass | 1041 | inventoryai://dashboard |
| wait 700ms | pass | 700 | 700ms |
| open inventoryai://transfer | pass | 1013 | inventoryai://transfer |
| expect "From location" | pass | 2260 | seen after 2260ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 12741 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 22428 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location 2" from the "To location" picker | pass | 31674 | chose "Phone Smoke Location 2" |
| type into the focused field | pass | 42748 | "Quantity" now reads 999999, keyboard closed |
| scroll up | pass | 2005 | scrolled up |
| expect "available to move" | pass | 12423 | seen after 12423ms |
| scroll down | pass | 2215 | scrolled down |
| expect "Transfer stock" to be disabled | pass | 12518 | "Transfer stock" is disabled |
| find the product with SKU PHONE-SMOKE-20261115 through the products search | pass | 62985 | opened Phone Smoke Product (SKU PHONE-SMOKE-20261115) through the products search in 62985ms |
| tap "Stock Out" | pass | 28496 | tapped Stock Out at 540,2091 after 1 scroll |
| choose "Phone Smoke Location" from the "Location" picker | pass | 23706 | chose "Phone Smoke Location" |
| type into the focused field | pass | 31579 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 32949 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T04-38-41-598Z-OUT, keyboard closed |
| tap "Remove stock" | pass | 13763 | tapped Remove stock at 540,1899 |
| check the movement arithmetic (-1) | pass | 2443 | 4 → 3 (-1) |
| tap "OK" | pass | 4249 | tapped OK at 873,1303 |
| screenshot "transfer-done" | pass | 828 | C:\Users\jeffe\inventory-ai\docs\evidence\device-runs\2026-11-15T04-38-41-598Z-transfer\transfer-done.png |
| verify the six movements and final stock against MongoDB | pass | 2115 | 6 row(s) reconcile; source 3, destination 0; nothing was modified |

evidence: C:\Users\jeffe\inventory-ai\docs\evidence\device-runs\2026-11-15T04-38-41-598Z-transfer
