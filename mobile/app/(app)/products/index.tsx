import { useCallback, useEffect, useRef, useState } from 'react';
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
  // the card's count (the old links opened per-location inventory rows).
  const requestedStockStatus = str(params.stockStatus).toUpperCase();
  const stockStatus =
    requestedStockStatus === 'IN_STOCK' ||
    requestedStockStatus === 'LOW_STOCK' ||
    requestedStockStatus === 'OUT_OF_STOCK'
      ? requestedStockStatus
      : '';
  const stockStatusLabel =
    stockStatus === 'IN_STOCK'
      ? 'in stock'
      : stockStatus === 'LOW_STOCK'
        ? 'low stock'
        : stockStatus === 'OUT_OF_STOCK'
          ? 'out of stock'
          : '';
  const [categoryId, setCategoryId] = useState(() => str(params.categoryId));
  const [locationId, setLocationId] = useState(() => str(params.locationId));
  const [low, setLow] = useState(() => str(params.lowStock) === 'true');
  const [out, setOut] = useState(() => str(params.outOfStock) === 'true');
  const resolvedNamedCategory = useRef(false);
  const resolvedNamedLocation = useRef(false);

  useEffect(() => {
    if (resolvedNamedCategory.current || categoryId || !paramCategoryName) return;
    const match = categories.items.find(
      (category) => category.name.toLowerCase() === paramCategoryName.toLowerCase(),
    );
    if (!match) return;
    resolvedNamedCategory.current = true;
    setCategoryId(match.id);
  }, [categories.items, categoryId, paramCategoryName]);

  useEffect(() => {
    if (resolvedNamedLocation.current || locationId || !paramLocationName) return;
    const match = locations.items.find(
      (location) => location.name.toLowerCase() === paramLocationName.toLowerCase(),
    );
    if (!match) return;
    resolvedNamedLocation.current = true;
    setLocationId(match.id);
  }, [locationId, locations.items, paramLocationName]);

  const queryParams = useCallback((): QueryParams => {
    const p: QueryParams = {
      page: undefined,
      q: debouncedQ || undefined,
      status: status === 'ALL' ? undefined : status,
      categoryId: categoryId || undefined,
      locationId: locationId || undefined,
      stockStatus: stockStatus || undefined,
    };
    if (low) p.lowStock = true;
    if (out) p.outOfStock = true;
    return p;
  }, [debouncedQ, status, categoryId, locationId, stockStatus, low, out]);

  const fetcher = useCallback(
    (page: number, limit: number) => productsApi.list(token as string, { ...queryParams(), page, limit }),
    [token, queryParams]
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });
  // Reload when returning from /products/new or a product detail/edit screen.
  useRefetchOnFocus(list.reload);

  const catOptions = [{ value: '', label: 'All categories' }, ...categories.items.map((c) => ({ value: c.id, label: c.name }))];
  const locOptions = [{ value: '', label: 'All locations' }, ...locations.items.map((l) => ({ value: l.id, label: l.name }))];

  const header = (
    <View>
      <Button
        title="Scan a barcode"
        icon="scan"
        variant="secondary"
        full
        onPress={() => router.push('/scan')}
        style={styles.scanBtn}
      />
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search by name, brand, SKU or barcode…"
        style={styles.search}
      />
      {stockStatus && !list.loading ? (
        <View style={styles.stockBanner}>
          <Text testID="product-stock-count" style={[styles.stockCount, { color: colors.text }]}>
            {formatNumber(list.total)} {list.total === 1 ? 'product' : 'products'} {stockStatusLabel}
          </Text>
          <Pressable
            onPress={() => router.setParams({ stockStatus: '' })}
            accessibilityRole="button"
            accessibilityLabel="Clear stock status filter"
            style={styles.clearStock}
          >
            <Text style={[styles.clearStockText, { color: colors.primary }]}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.filterRow}>
        <Chip label="All" selected={status === 'ALL'} onPress={() => setStatus('ALL')} />
        <Chip label="Active" selected={status === 'ACTIVE'} onPress={() => setStatus('ACTIVE')} />
        <Chip label="Archived" selected={status === 'ARCHIVED'} onPress={() => setStatus('ARCHIVED')} />
        {manage ? (
          <Button
            title="New product"
            icon="add"
            onPress={() => router.push('/products/new')}
            style={styles.newBtn}
          />
        ) : null}
      </View>
      {/* The legacy low/out flags are broad at-or-below-minimum filters (low
          includes out). They would contradict an exact Overview status, so they
          are hidden while that status is active. */}
      {!stockStatus ? (
        <View style={styles.chipRow}>
          {/* NOTE (MOD-02): this chip carried tone="warning", which is not a
              ChipTone — Chip renders anything other than 'danger' as primary, so
              the prop was already inert. Omitted (default is 'primary') to keep
              the rendered chip identical. */}
          <Chip label="Low stock" selected={low} onPress={() => setLow((v) => !v)} />
          <Chip label="Out of stock" tone="danger" selected={out} onPress={() => setOut((v) => !v)} />
        </View>
      ) : null}
      <SelectField label="Category" placeholder="Filter by category…" options={catOptions} value={categoryId} onChange={setCategoryId} />
      <SelectField label="Location" placeholder="Filter by location…" options={locOptions} value={locationId} onChange={setLocationId} />
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
  clearStock: { minHeight: 44, justifyContent: 'center', paddingLeft: spacing.md },
  clearStockText: { fontWeight: '700' },
  scanBtn: { marginBottom: spacing.lg },
  search: { marginBottom: spacing.lg },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  newBtn: { marginLeft: 'auto' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
