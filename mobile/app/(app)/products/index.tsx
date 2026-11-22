import { useCallback, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItem } from 'react-native';

import { StatusBadge } from '../../../components/Badge';
import Button from '../../../components/Button';
import { PressableCard } from '../../../components/Card';
import Chip from '../../../components/Chip';
import { Icon } from '../../../components/icons';
import ListRow from '../../../components/ListRow';
import ListScreen from '../../../components/ListScreen';
import SearchField from '../../../components/SearchField';
import SelectField from '../../../components/SelectField';
import { categoriesApi, locationsApi, productsApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import type { QueryParams } from '../../../lib/client';
import { formatNumber } from '../../../lib/format';
import useDebounced from '../../../hooks/useDebounced';
import { useActiveRef } from '../../../hooks/useReferences';
import usePagedList from '../../../hooks/usePagedList';
import useRefetchOnFocus from '../../../hooks/useRefetchOnFocus';
import { canManageProducts } from '../../../lib/permissions';
import { spacing } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

const STOCK_FILTERS = [
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'LOW_STOCK', label: 'Low stock' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
] as const;

const STOCK_FILTER_LABELS = {
  IN_STOCK: 'in stock',
  LOW_STOCK: 'low stock',
  OUT_OF_STOCK: 'out of stock',
} as const;

type StockFilter = keyof typeof STOCK_FILTER_LABELS;

function parseStockFilter(value: string): StockFilter | '' {
  return value === 'IN_STOCK' || value === 'LOW_STOCK' || value === 'OUT_OF_STOCK' ? value : '';
}

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** "SKU x · Category · Barcode" — only the parts this product actually has. */
function productMeta(item: ApiResponse): string {
  return [item.brand, item.sku ? `SKU ${item.sku}` : null, item.category?.name, item.barcode ? `Barcode ${item.barcode}` : null]
    .filter(Boolean)
    .join(' · ');
}

export default function ProductsScreen() {
  const { colors } = useTheme();
  const { token, user, signOut } = useSession();
  const manage = canManageProducts(user);
  const categories = useActiveRef(token, categoriesApi);
  const locations = useActiveRef(token, locationsApi);
  const params = useLocalSearchParams();
  const paramCategoryName = str(params.category);
  const paramLocationName = str(params.location);

  const [q, setQ] = useState(() => str(params.q));
  const debouncedQ = useDebounced(q, 300);
  const requestedStatus = str(params.status).toUpperCase();
  const [status, setStatus] = useState(() =>
    requestedStatus === 'ACTIVE' || requestedStatus === 'ARCHIVED' ? requestedStatus : 'ALL',
  );
  // The Overview cards deep-link with a canonical, mutually exclusive product
  // status. It is applied together with ACTIVE so the list's total is exactly
  // the card's count (the old links opened per-location inventory rows). While
  // it is active the status stays pinned to ACTIVE, otherwise switching to
  // Archived would apply the stock filter to a different population and the
  // count beside the filter would no longer be the card's count.
  const requestedStockStatus = parseStockFilter(str(params.stockStatus).toUpperCase());
  // Older links used the broad lowStock/outOfStock flags. They still open a
  // visible canonical filter instead of silently doing nothing: OUT wins when
  // both were present, matching the old intersection and §19's precedence.
  const legacyStockStatus = parseStockFilter(
    str(params.outOfStock) === 'true'
      ? 'OUT_OF_STOCK'
      : str(params.lowStock) === 'true'
        ? 'LOW_STOCK'
        : '',
  );
  const stockStatus = requestedStockStatus || legacyStockStatus;
  const stockStatusLabel = stockStatus ? STOCK_FILTER_LABELS[stockStatus] : '';
  const effectiveStatus = stockStatus ? 'ACTIVE' : status;
  const [categoryId, setCategoryId] = useState(() => str(params.categoryId));
  const [locationId, setLocationId] = useState(() => str(params.locationId));
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [locationTouched, setLocationTouched] = useState(false);

  // Named filters arrive from assistant links before the reference lists do.
  // Resolve them during render rather than writing state from an effect; once
  // the person touches a selector, that choice (including "All") wins.
  const effectiveCategoryId = useMemo(() => {
    if (categoryTouched || categoryId || !paramCategoryName) return categoryId;
    return (
      categories.items.find(
        (category) => category.name.toLowerCase() === paramCategoryName.toLowerCase(),
      )?.id ?? ''
    );
  }, [categories.items, categoryId, categoryTouched, paramCategoryName]);

  const effectiveLocationId = useMemo(() => {
    if (locationTouched || locationId || !paramLocationName) return locationId;
    return (
      locations.items.find(
        (location) => location.name.toLowerCase() === paramLocationName.toLowerCase(),
      )?.id ?? ''
    );
  }, [locations.items, locationId, locationTouched, paramLocationName]);

  const queryParams = useCallback((): QueryParams => {
    const p: QueryParams = {
      page: undefined,
      q: debouncedQ || undefined,
      status: effectiveStatus === 'ALL' ? undefined : effectiveStatus,
      categoryId: effectiveCategoryId || undefined,
      locationId: effectiveLocationId || undefined,
      stockStatus: stockStatus || undefined,
    };
    // The old lowStock/outOfStock query flags are deliberately not sent from
    // this screen: they are broad at-or-below-minimum filters and can contradict
    // the canonical, mutually exclusive status selected here. The API keeps them
    // for existing clients; the product UI uses only stockStatus.
    return p;
  }, [debouncedQ, effectiveStatus, effectiveCategoryId, effectiveLocationId, stockStatus]);

  const fetcher = useCallback(
    (page: number, limit: number) => productsApi.list(token as string, { ...queryParams(), page, limit }),
    [token, queryParams]
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });
  // Reload when returning from /products/new or a product detail/edit screen.
  useRefetchOnFocus(list.reload);

  /** Selecting a stock status pins the population to ACTIVE and replaces any other status. */
  const selectStockFilter = (next: StockFilter) => {
    const value = stockStatus === next ? '' : next;
    setStatus('ACTIVE');
    router.setParams({ status: 'ACTIVE', stockStatus: value });
  };

  const catOptions = [{ value: '', label: 'All categories' }, ...categories.items.map((c) => ({ value: c.id, label: c.name }))];
  const locOptions = [{ value: '', label: 'All locations' }, ...locations.items.map((l) => ({ value: l.id, label: l.name }))];

  const header = (
    <View>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search by name, brand, SKU or barcode…"
        onScanPress={() => router.push('/scan')}
        style={styles.search}
      />
      {!list.loading && (stockStatus || status !== 'ALL') ? (
        <View style={styles.stockBanner}>
          <Text
            testID={stockStatus ? 'product-stock-count' : 'product-status-count'}
            style={[styles.stockCount, { color: colors.text }]}
          >
            {stockStatus
              ? `${formatNumber(list.total)} ${list.total === 1 ? 'product' : 'products'} ${stockStatusLabel}`
              : `${formatNumber(list.total)} ${status === 'ACTIVE' ? 'active' : 'archived'} ${list.total === 1 ? 'product' : 'products'}`}
          </Text>
          {stockStatus ? (
            <Pressable
              onPress={() => {
                setStatus('ACTIVE');
                router.setParams({ status: 'ACTIVE', stockStatus: '' });
              }}
              accessibilityRole="button"
              accessibilityLabel="Clear stock status filter"
              style={styles.clearStock}
            >
              <Text style={[styles.clearStockText, { color: colors.primary }]}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.filterRow}>
        {stockStatus ? (
          <Text style={[styles.stockScope, { color: colors.textMuted }]}>Active products</Text>
        ) : (
          <>
            <Chip label="All" selected={status === 'ALL'} onPress={() => setStatus('ALL')} />
            <Chip label="Active" selected={status === 'ACTIVE'} onPress={() => setStatus('ACTIVE')} />
            <Chip label="Archived" selected={status === 'ARCHIVED'} onPress={() => setStatus('ARCHIVED')} />
          </>
        )}
        {manage ? (
          <Button
            title="New product"
            icon="add"
            onPress={() => router.push('/products/new')}
            style={styles.newBtn}
          />
        ) : null}
      </View>
      <View style={styles.chipRow}>
        {STOCK_FILTERS.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            tone={value === 'OUT_OF_STOCK' ? 'danger' : 'primary'}
            selected={stockStatus === value}
            onPress={() => selectStockFilter(value)}
          />
        ))}
      </View>
      <SelectField
        label="Category"
        placeholder="Filter by category…"
        options={catOptions}
        value={effectiveCategoryId}
        onChange={(id) => {
          setCategoryTouched(true);
          setCategoryId(id);
        }}
      />
      <SelectField
        label="Location"
        placeholder="Filter by location…"
        options={locOptions}
        value={effectiveLocationId}
        onChange={(id) => {
          setLocationTouched(true);
          setLocationId(id);
        }}
      />
    </View>
  );

  const renderItem: ListRenderItem<ApiResponse> = ({ item }) => (
    <PressableCard onPress={() => router.push(`/products/${item.id}`)} accessibilityRole="button">
      <ListRow
        leading={<Icon name="pricetags" color={colors.primary} size={22} />}
        title={item.name}
        subtitle={productMeta(item)}
        right={<StatusBadge status={item.status} />}
      />
    </PressableCard>
  );

  return (
    <ListScreen
      items={list.items}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      header={header}
      loading={list.loading}
      error={list.error}
      onRetry={list.reload}
      refreshing={list.refreshing}
      onRefresh={list.refresh}
      onEndReached={list.loadMore}
      loadingMore={list.loadingMore}
      loadingLabel="Loading products…"
      emptyTitle="No products found"
      emptyMessage={
        q
          ? `Nothing matches “${q}”.`
          : stockStatus
            ? `No active products are ${stockStatusLabel} right now.`
            : 'Add your first product to start tracking stock.'
      }
      emptyAction={manage && !q ? <Button title="Add product" onPress={() => router.push('/products/new')} /> : null}
    />
  );
}

const styles = StyleSheet.create({
  stockBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  stockCount: { flexShrink: 1, fontWeight: '700' },
  stockScope: { fontWeight: '700' },
  clearStock: { minHeight: 44, justifyContent: 'center', paddingLeft: spacing.md },
  clearStockText: { fontWeight: '700' },
  search: { marginBottom: spacing.lg },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  newBtn: { marginLeft: 'auto' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
