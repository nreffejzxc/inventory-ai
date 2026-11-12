import type { ApiResponse } from './api';

/**
 * The route params for `/history/[id]`.
 *
 * A ledger movement is immutable, so the detail screen can render the selected
 * row without another fetch. Both the dashboard's logical transfer event and the
 * History list's individual transfer leg use the same route; a transfer carries
 * `from`/`to` in the dashboard DTO and a single `location` in a ledger row.
 */
export function activityRouteParams(item: ApiResponse): Record<string, string> {
  const params: Record<string, string> = {};
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    params[key] = String(value);
  };

  add('id', item?.id);
  add('type', item?.type);
  add('quantity', item?.quantity);
  add('previousQuantity', item?.previousQuantity);
  add('newQuantity', item?.newQuantity);
  add('reason', item?.reason);
  add('reference', item?.reference);
  add('createdAt', item?.createdAt instanceof Date ? item.createdAt.toISOString() : item?.createdAt);
  add('productId', item?.product?.id);
  add('productName', item?.product?.name);
  add('productSku', item?.product?.sku);
  add('locationId', item?.location?.id);
  add('locationName', item?.location?.name);
  add('fromId', item?.from?.id);
  add('fromName', item?.from?.name);
  add('toId', item?.to?.id);
  add('toName', item?.to?.name);
  return params;
}
