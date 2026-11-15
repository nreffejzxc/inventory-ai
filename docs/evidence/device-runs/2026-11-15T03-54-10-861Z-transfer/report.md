# Device run — transfer

- started: 2026-11-15T03:54:10.861Z
- device: CPH1969 · Android 11 (API 30) · PV4DDMIZZLTCIVSK
- overall: pass (exit 0)
- steps: 60/60 passed

| step | result | ms | what was seen |
|---|---|---|---|
| find the product with SKU PHONE-SMOKE-20261115 through the products search | pass | 56212 | opened Phone Smoke Product (SKU PHONE-SMOKE-20261115) through the products search in 56210ms |
| tap "Stock In" | pass | 24920 | tapped Stock In at 204,2091 after 1 scroll |
| choose "Phone Smoke Location" from the "Location" picker | pass | 11094 | chose "Phone Smoke Location" |
| type into the focused field | pass | 19324 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 19835 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T03-54-10-861Z-IN, keyboard closed |
| tap "Add stock" | pass | 3396 | tapped Add stock at 540,1824 |
| check the movement arithmetic (1) | pass | 1933 | 3 → 4 (1) |
| tap "OK" | pass | 3426 | tapped OK at 873,1303 |
| open inventoryai://transfer | pass | 1000 | inventoryai://transfer |
| expect "From location" | pass | 2003 | seen after 2003ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 10970 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 19737 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location 2" from the "To location" picker | pass | 28506 | chose "Phone Smoke Location 2" |
| type into the focused field | pass | 36943 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 37487 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T03-54-10-861Z-F, keyboard closed |
| tap "Transfer stock" | pass | 12173 | tapped Transfer stock at 540,1899 |
| check the movement arithmetic (-1, 1) | pass | 1931 | 4 → 3, 0 → 1 (-1, 1) |
| tap "OK" | pass | 3408 | tapped OK at 873,1385 |
| open inventoryai://transfer | pass | 991 | inventoryai://transfer |
| expect "From location" | pass | 1984 | seen after 1984ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 11145 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location 2" from the "From location" picker | pass | 19798 | chose "Phone Smoke Location 2" |
| choose "Phone Smoke Location" from the "To location" picker | pass | 28585 | chose "Phone Smoke Location" |
| type into the focused field | pass | 37096 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 38328 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T03-54-10-861Z-R, keyboard closed |
| tap "Transfer stock" | pass | 12233 | tapped Transfer stock at 540,1899 |
| check the movement arithmetic (-1, 1) | pass | 1952 | 1 → 0, 3 → 4 (-1, 1) |
| tap "OK" | pass | 3430 | tapped OK at 873,1385 |
| open inventoryai://transfer | pass | 1002 | inventoryai://transfer |
| expect "From location" | pass | 1973 | seen after 1973ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 11073 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 20455 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location" from the "To location" picker | pass | 28645 | chose "Phone Smoke Location" |
| type into the focused field | pass | 38512 | "Quantity" now reads 1, keyboard closed |
| scroll up | pass | 1715 | scrolled up |
| expect "Choose two different locations" | pass | 10847 | seen after 10847ms |
| scroll down | pass | 1732 | scrolled down |
| expect "Transfer stock" to be disabled | pass | 10801 | "Transfer stock" is disabled |
| open inventoryai://dashboard | pass | 1014 | inventoryai://dashboard |
| wait 700ms | pass | 715 | 700ms |
| open inventoryai://transfer | pass | 988 | inventoryai://transfer |
| expect "From location" | pass | 1997 | seen after 1997ms |
| choose "Phone Smoke Product" from the "Product" picker | pass | 12242 | chose "Phone Smoke Product" |
| choose "Phone Smoke Location" from the "From location" picker | pass | 19700 | chose "Phone Smoke Location" |
| choose "Phone Smoke Location 2" from the "To location" picker | pass | 28425 | chose "Phone Smoke Location 2" |
| type into the focused field | pass | 36826 | "Quantity" now reads 999999, keyboard closed |
| scroll up | pass | 1742 | scrolled up |
| expect "available to move" | pass | 10635 | seen after 10635ms |
| scroll down | pass | 1742 | scrolled down |
| expect "Transfer stock" to be disabled | pass | 10671 | "Transfer stock" is disabled |
| find the product with SKU PHONE-SMOKE-20261115 through the products search | pass | 54427 | opened Phone Smoke Product (SKU PHONE-SMOKE-20261115) through the products search in 54427ms |
| tap "Stock Out" | pass | 25069 | tapped Stock Out at 540,2091 after 1 scroll |
| choose "Phone Smoke Location" from the "Location" picker | pass | 19791 | chose "Phone Smoke Location" |
| type into the focused field | pass | 27924 | "Quantity" now reads 1, keyboard closed |
| type into the focused field | pass | 28550 | "Reference (optional)" now reads PHONE-TRF-2026-11-15T03-54-10-861Z-OUT, keyboard closed |
| tap "Remove stock" | pass | 12235 | tapped Remove stock at 540,1899 |
| check the movement arithmetic (-1) | pass | 1926 | 4 → 3 (-1) |
| tap "OK" | pass | 3406 | tapped OK at 873,1303 |
| screenshot "transfer-done" | pass | 613 | C:\Users\jeffe\inventory-ai\docs\evidence\device-runs\2026-11-15T03-54-10-861Z-transfer\transfer-done.png |
| verify the six movements and final stock against MongoDB | pass | 3252 | 6 row(s) reconcile; source 3, destination 0; nothing was modified |

evidence: C:\Users\jeffe\inventory-ai\docs\evidence\device-runs\2026-11-15T03-54-10-861Z-transfer
