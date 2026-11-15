/**
 * AI-112 — the actions that follow a read answer.
 *
 * The assistant may show only a page. The member still needs the whole list and a way to keep
 * reading without asking the model again. These actions are built from the tool call the server
 * actually executed, never from the model's prose: the route and filters are known, and every
 * product row keeps the id the read returned.
 *
 * This is navigation only. It cannot write, cannot query another tenant and cannot turn a name
 * into an id. The mobile client is given a bounded page of already-read rows plus a route to the
 * screen that owns the complete list.
 */

export type AnswerListKind = 'restock' | 'inventory' | 'products';

export interface AnswerListRow {
  productId?: string;
  title: string;
  detail?: string;
}

export interface AnswerList {
  kind: AnswerListKind;
  label: string;
  path: string;
  total: number;
  rows: AnswerListRow[];
}

export interface AnswerScreen {
  kind: string;
  label: string;
  path: string;
}

export interface AnswerActions {
  list?: AnswerList;
  screens: AnswerScreen[];
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resultOf(output: unknown): RecordValue | null {
  const outer = record(output);
  if (!outer) return null;
  return record(outer.result) ?? outer;
}

function pathWith(base: string, params: Record<string, unknown>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

function screen(kind: string, label: string, path: string): AnswerScreen {
  return { kind, label, path };
}

function restockRows(result: RecordValue): AnswerListRow[] {
  const items = Array.isArray(result.items) ? result.items : [];
  const rows: AnswerListRow[] = [];
  for (const raw of items) {
    const row = record(raw);
    if (!row) continue;
    const title = text(row.name);
    if (!title) continue;
    const available = number(row.availableQuantity);
    const minimum = number(row.minimumStock);
    const below = number(row.unitsBelowMinimum);
    const detail = [
      row.sku ? `SKU ${text(row.sku)}` : null,
      available !== null ? `${available} available` : null,
      minimum !== null ? `minimum ${minimum}` : null,
      below !== null && below > 0 ? `${below} below minimum` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    rows.push({ productId: text(row.id) || undefined, title, ...(detail ? { detail } : {}) });
  }
  return rows;
}

function inventoryRows(result: RecordValue): AnswerListRow[] {
  const items = Array.isArray(result.items) ? result.items : [];
  const rows: AnswerListRow[] = [];
  for (const raw of items) {
    const row = record(raw);
    const product = record(row?.product);
    const location = record(row?.location);
    const title = text(product?.name);
    if (!title) continue;
    const available = number(row?.availableQuantity);
    const detail = [
      location?.name ? text(location.name) : null,
      available !== null ? `${available} available` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    rows.push({
      productId: text(product?.id) || undefined,
      title,
      ...(detail ? { detail } : {}),
    });
  }
  return rows;
}

function productRows(result: RecordValue): AnswerListRow[] {
  const items = Array.isArray(result.items) ? result.items : [];
  const rows: AnswerListRow[] = [];
  for (const raw of items) {
    const row = record(raw);
    if (!row) continue;
    const title = text(row.name);
    if (!title) continue;
    const available = number(row.availableQuantity);
    const detail = [
      row.sku ? `SKU ${text(row.sku)}` : null,
      row.stockStatus ? text(row.stockStatus).replaceAll('_', ' ').toLowerCase() : null,
      available !== null ? `${available} available` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    rows.push({ productId: text(row.id) || undefined, title, ...(detail ? { detail } : {}) });
  }
  return rows;
}

function pageTotal(result: RecordValue): number {
  const total = number(result.count) ?? number(result.total) ?? 0;
  return Math.max(0, total);
}

/**
 * One tool's action, or null when the call has no member-facing list.
 *
 * The filters below are the ones the destination screen actually accepts. A filter the screen
 * cannot apply is omitted rather than invented, so the button never claims a narrower or wider
 * list than it will show.
 */
export function answerActionsForTool(
  name: string,
  input: unknown,
  output: unknown,
): { list?: AnswerList; screen?: AnswerScreen } | null {
  const args = record(input) ?? {};
  const result = resultOf(output);
  if (!result) return null;

  if (name === 'getReorderNeededProducts') {
    const path = pathWith('/restock', {
      q: args.q,
      categoryId: args.categoryId,
      category: args.category,
    });
    return {
      list: {
        kind: 'restock',
        label: 'Restock',
        path,
        total: pageTotal(result),
        rows: restockRows(result),
      },
      screen: screen('restock', 'Restock', path),
    };
  }

  if (name === 'getLowStockProducts') {
    const scoped = text(args.locationId) || text(args.location)
      ? pathWith('/inventory', { status: 'low', locationId: args.locationId, location: args.location })
      : '/restock';
    return {
      list: {
        kind: scoped.startsWith('/restock') ? 'restock' : 'inventory',
        label: scoped.startsWith('/restock') ? 'Restock' : 'Inventory',
        path: scoped,
        total: pageTotal(result),
        rows: restockRows(result),
      },
      screen: screen(scoped.startsWith('/restock') ? 'restock' : 'inventory', scoped.startsWith('/restock') ? 'Restock' : 'Inventory', scoped),
    };
  }

  if (name === 'getOutOfStockProducts') {
    const path = pathWith('/inventory', {
      status: 'out',
      locationId: args.locationId,
      location: args.location,
    });
    return {
      list: { kind: 'inventory', label: 'Inventory', path, total: pageTotal(result), rows: restockRows(result) },
      screen: screen('inventory', 'Inventory', path),
    };
  }

  if (name === 'getInventory') {
    const first = Array.isArray(result.items) ? record(result.items[0]) : null;
    const firstProduct = record(first?.product);
    // The Inventory screen's search box is a product search, not an id filter. When the tool
    // was given a product id, open the screen on that product's recorded name; when it was
    // given a query, keep the query. `status` is deliberately not carried because the screen
    // has no ACTIVE/ARCHIVED control, and a filter the destination cannot apply is worse than
    // no filter at all.
    const search = text(args.q) || text(args.exactSku) || (args.productId ? text(firstProduct?.name) : '');
    const path = pathWith('/inventory', {
      q: search,
      locationId: args.locationId,
      location: args.location,
      lowStock: args.lowStock === true ? 'true' : undefined,
      outOfStock: args.outOfStock === true ? 'true' : undefined,
    });
    return {
      list: { kind: 'inventory', label: 'Inventory', path, total: pageTotal(result), rows: inventoryRows(result) },
      screen: screen('inventory', 'Inventory', path),
    };
  }

  if (name === 'filterPreviousResults') {
    const kind = text(result.listKind);
    const categoryId = text(result.categoryId);
    const category = text(result.categoryName);
    const locationId = text(result.locationId);
    const location = text(result.locationName);
    let path = '';
    if (kind === 'restock' && !locationId && !location) {
      path = pathWith('/restock', { categoryId, category });
    } else if (kind === 'products') {
      path = pathWith('/products', { categoryId, category, locationId, location });
    } else if (kind === 'inventory' && !categoryId && !category) {
      path = pathWith('/inventory', {
        locationId,
        location,
        status: result.lowStock === true ? 'low' : result.outOfStock === true ? 'out' : undefined,
      });
    }
    // A filtered list the destination cannot represent gets no link. A button that
    // opens a wider list than the answer just described is worse than no button.
    if (!path) return null;
    const label = kind === 'restock' ? 'Restock' : kind === 'products' ? 'Products' : 'Inventory';
    return {
      list: {
        kind: kind as AnswerListKind,
        label,
        path,
        total: pageTotal(result),
        rows: kind === 'products' ? productRows(result) : restockRows(result),
      },
      screen: screen(kind, label, path),
    };
  }

  if (name === 'findProducts' || name === 'searchProducts') {
    const path = pathWith('/products', {
      q: name === 'findProducts' ? text(args.keywords) : text(args.q),
      categoryId: args.categoryId,
      category: args.category,
      status: args.status,
    });
    return {
      list: { kind: 'products', label: 'Products', path, total: pageTotal(result), rows: productRows(result) },
      screen: screen('products', 'Products', path),
    };
  }

  if (name === 'getProductsByLocation') {
    const path = pathWith('/products', { locationId: args.locationId, location: args.location });
    return {
      list: { kind: 'products', label: 'Products', path, total: pageTotal(result), rows: productRows(result) },
      screen: screen('products', 'Products', path),
    };
  }

  if (name === 'getInventoryHistory') {
    const path = pathWith('/history', {
      type: args.type,
      productId: args.productId,
      locationId: args.locationId,
      locationName: args.location,
    });
    return { screen: screen('history', 'Inventory History', path) };
  }

  if (name === 'listLocations') return { screen: screen('locations', 'Locations', '/locations') };
  if (name === 'listCategories') return { screen: screen('categories', 'Categories', '/categories') };

  return null;
}

/**
 * A ranking answer owns its rows. The model may also read one product's inventory to explain
 * where that stock sits; that auxiliary read is not the complete list behind the ranking, and
 * advertising it under the answer says "Showing 5 of 12" about the wrong twelve products.
 * Drop only Inventory actions, so an unrelated but genuinely useful screen survives.
 */
export function withoutInventoryActions(actions: AnswerActions): AnswerActions {
  const list = actions.list?.kind === 'inventory' ? undefined : actions.list;
  const screens = actions.screens.filter((entry) => entry.kind !== 'inventory');
  return { ...(list ? { list } : {}), screens };
}

/** Merge one tool's action into the turn's actions, keeping the most specific list. */
export function mergeAnswerActions(
  current: AnswerActions,
  next: { list?: AnswerList; screen?: AnswerScreen },
): AnswerActions {
  const rank: Record<AnswerListKind, number> = { restock: 3, inventory: 2, products: 1 };
  const list =
    next.list && (!current.list || rank[next.list.kind] > rank[current.list.kind])
      ? next.list
      : current.list;
  const screens = [...current.screens];
  if (next.screen && !screens.some((entry) => entry.path === next.screen!.path)) {
    screens.push(next.screen);
  }
  return { ...(list ? { list } : {}), screens: screens.slice(0, 3) };
}