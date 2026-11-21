/**
 * Stock-status vocabulary (V1). See SYSTEM_SPECIFICATION.md §19.
 *
 * Availability = quantity − reservedQuantity (summed across a business unless a
 * location is selected). The same three-way classification is used by the
 * "products that need restocking" list and the inventory-health dashboard so
 * every surface agrees on what is healthy, low, and out.
 */
export const STOCK_STATUSES = Object.freeze({
  /** Healthy: available > minimum stock. */
  IN_STOCK: 'IN_STOCK',
  /** Still on hand (available > 0) but at or below the product's minimum stock. */
  LOW_STOCK: 'LOW_STOCK',
  /** Nothing sellable left: available ≤ 0. */
  OUT_OF_STOCK: 'OUT_OF_STOCK',
});

/** The three statuses as a validated list-filter enum. */
export const STOCK_STATUS_VALUES = Object.freeze(Object.values(STOCK_STATUSES));

/**
 * Classify a product's stock position from its summed availability and its
 * configured minimum stock:
 *   OUT_OF_STOCK  -> available <= 0            (nothing available)
 *   LOW_STOCK     -> 0 < available <= minimum  (still available, at/below min)
 *   IN_STOCK      -> available > minimum       (healthy)
 *
 * OUT takes precedence, so the three sets are mutually exclusive and their
 * counts sum to the active catalogue. A zero-stock product is never also low:
 * that mixing made the Overview's low card overlap its out card.
 *
 * A product with no inventory row has availability 0, so it classifies OUT
 * (consistent with the dashboard/product low/out filters, which count such
 * products the same way). Negative availability (should not occur under normal
 * V1 rules) is treated as out of stock.
 */
export function classifyStockStatus(
  available: number | null | undefined,
  minimumStock = 0,
) {
  // `Number.isFinite` rejects a non-number as well as a non-finite one, so the
  // `typeof` test is what lets the checker see the fallback below — it narrows
  // exactly the same inputs and never changes which branch is taken.
  const avail =
    typeof available === 'number' && Number.isFinite(available) ? available : 0;
  const min = Number.isFinite(minimumStock) ? minimumStock : 0;
  if (avail <= 0) return STOCK_STATUSES.OUT_OF_STOCK;
  if (avail <= min) return STOCK_STATUSES.LOW_STOCK;
  return STOCK_STATUSES.IN_STOCK;
}

export default { STOCK_STATUSES, STOCK_STATUS_VALUES, classifyStockStatus };
