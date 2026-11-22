import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItem } from 'react-native';

import Badge from '../../components/Badge';
import { PressableCard } from '../../components/Card';
import Chip from '../../components/Chip';
import { Icon } from '../../components/icons';
import ListRow from '../../components/ListRow';
import ListScreen from '../../components/ListScreen';
import SearchField from '../../components/SearchField';
import SelectField from '../../components/SelectField';
import { inventoryApi, locationsApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { useSession } from '../../lib/auth';
import type { QueryParams } from '../../lib/client';
import { formatNumber } from '../../lib/format';
import { canViewPurchaseOrders } from '../../lib/permissions';
import useDebounced from '../../hooks/useDebounced';
import { useActiveRef } from '../../hooks/useReferences';
import usePagedList from '../../hooks/usePagedList';
import useRefetchOnFocus from '../../hooks/useRefetchOnFocus';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export default function InventoryScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, user, signOut } = useSession();
  const locations = useActiveRef(token, locationsApi);

  // Dashboard stat cards deep-link here with ?status=low|out. The backend's
  // inventory endpoint filters via lowStock/outOfStock flags, so the navigation
  // shorthand is mapped onto those flags here (UI concern only).
  const params = useLocalSearchParams();
  const statusParam = str(params.status);
  const paramLocationName = str(params.location);
  const [q, setQ] = useState(() => str(params.q));
  const debouncedQ = useDebounced(q, 300);
  const [locationId, setLocationId] = useState(() => str(params.locationId));
  const resolvedNamedLocation = useRef(false);
  const [low, setLow] = useState(statusParam === 'low');
  const [out, setOut] = useState(statusParam === 'out');

  // A tool may know a location by its exact name rather than its id. Resolve that name once the
  // active-location list arrives, so the screen opens with the same filter the answer used.
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
    const p: QueryParams = { page: undefined, q: debouncedQ || undefined, locationId: locationId || undefined };
    if (low) p.lowStock = true;
    if (out) p.outOfStock = true;
    return p;
  }, [debouncedQ, locationId, low, out]);

  const fetcher = useCallback(
    (page: number, limit: number) => inventoryApi.list(token as string, { ...queryParams(), page, limit }),
    [token, queryParams]
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });
  // Reload when returning from an inventory row detail / stock movement screen.
  useRefetchOnFocus(list.reload);

  const locOptions = [{ value: '', label: 'All locations' }, ...locations.items.map((l) => ({ value: l.id, label: l.name }))];

  const clearFilters = () => {
    setLow(false);
    setOut(false);
  };

  // The row-level flags are mutually exclusive in the API: a row is either low
  // (0 < available <= minimum) or out (0 available), so asking for both returns
  // nothing. The chips therefore act as one choice, with the Restock list as the
  // combined product-level view.
  const selectLow = () => {
    if (low) {
      setLow(false);
      return;
    }
    setLow(true);
    setOut(false);
  };

  const selectOut = () => {
    if (out) {
      setOut(false);
      return;
    }
    setOut(true);
    setLow(false);
  };

  const filterLabel = low ? 'low on stock' : 'out of stock';

  const header = (
    <View>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search by product name, SKU or barcode…"
        onScanPress={() => router.push('/scan')}
        style={styles.search}
      />
      <View style={styles.chipRow}>
        <Chip label="All" selected={!low && !out} onPress={clearFilters} />
        {/* NOTE (MOD-02): tone="warning" is not a ChipTone — Chip renders
            anything other than 'danger' as primary, so the prop was already
            inert. Omitted (default is 'primary') to keep the chip identical. */}
        <Chip label="Low stock" selected={low} onPress={selectLow} />
        <Chip label="Out of stock" tone="danger" selected={out} onPress={selectOut} />
      </View>
      {low || out ? (
        <View style={styles.filterBanner}>
          <Text testID="inventory-filter-count" style={styles.filterCount}>
            {list.loading
              ? 'Checking stock…'
              : `${formatNumber(list.total)} stock ${list.total === 1 ? 'row' : 'rows'} ${filterLabel}`}
          </Text>
          <Pressable
            onPress={clearFilters}
            accessibilityRole="button"
            accessibilityLabel="Clear stock filters"
            style={styles.clearFilters}
          >
            <Text style={styles.clearFiltersText}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
      <SelectField label="Location" placeholder="Filter by location…" options={locOptions} value={locationId} onChange={setLocationId} />
      {/* Shortcuts keep the routes STAFF need from their home screen; the restock
          list is product-level while this screen lists per-location stock ROWS. */}
      <Text style={styles.shortcutLabel}>Shortcuts</Text>
      <View style={styles.shortcutList}>
        <PressableCard
          onPress={() => router.push('/restock')}
          accessibilityRole="button"
          accessibilityLabel="Open restock list"
          style={styles.shortcutCard}
        >
          <ListRow
            leading={<Icon name="warning" color={colors.warning} size={22} />}
            title="Restock list"
            subtitle="Products at or below minimum"
            right={<Icon name="chevronRight" color={colors.textMuted} size={18} />}
          />
        </PressableCard>
        {canViewPurchaseOrders(user) ? (
          <PressableCard
            onPress={() => router.push('/purchase-orders')}
            accessibilityRole="button"
            accessibilityLabel="Open purchase orders"
            style={styles.shortcutCard}
          >
            <ListRow
              leading={<Icon name="receipt" color={colors.primary} size={22} />}
              title="Purchase orders"
              subtitle="Receive and manage orders"
              right={<Icon name="chevronRight" color={colors.textMuted} size={18} />}
            />
          </PressableCard>
        ) : null}
      </View>
    </View>
  );

  function emptyMessage(): string {
    if (low) return 'No stock rows are low on stock right now.';
    if (out) {
      return 'No stock rows are out of stock. A product with no stock at any location has no row here — open Products → Out of stock to review it.';
    }
    if (q) return `Nothing matches “${q}”.`;
    return 'No stock records yet — stock in a product at a location to create one.';
  }

  const renderItem: ListRenderItem<ApiResponse> = ({ item }) => {
    const archived = item.product?.status === 'ARCHIVED';
    return (
      <PressableCard onPress={() => router.push(`/inventory/${item.id}`)} accessibilityRole="button">
        <ListRow
          leading={<Icon name="cube" color={colors.primary} size={22} />}
          title={item.product?.name ?? 'Unknown product'}
          subtitle={[item.location?.name ?? 'No location', archived ? 'Archived' : null].filter(Boolean).join(' · ')}
          footer={
            // Key quantities stay at body size (never the smaller subtitle size).
            <Text style={styles.quantity}>
              {formatNumber(item.availableQuantity)} available · {formatNumber(item.quantity)} on hand
            </Text>
          }
          right={
            item.isLowStock || item.isOutOfStock ? (
              <View style={styles.badges}>
                {item.isOutOfStock ? (
                  <Badge text="Out" tone="danger" />
                ) : item.isLowStock ? (
                  <Badge text="Low" tone="low" />
                ) : null}
              </View>
            ) : null
          }
        />
      </PressableCard>
    );
  };

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
      loadingLabel="Loading inventory…"
      emptyTitle="Nothing to show"
      emptyMessage={emptyMessage()}
    />
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    search: { marginBottom: spacing.lg },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
    filterBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    filterCount: { ...type.body, color: colors.text, fontWeight: '700', flexShrink: 1 },
    clearFilters: { minHeight: 44, justifyContent: 'center', paddingLeft: spacing.md },
    clearFiltersText: { ...type.body, color: colors.primary, fontWeight: '700' },
    shortcutLabel: { ...type.label, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.sm, marginBottom: spacing.sm },
    shortcutList: { gap: spacing.sm, marginBottom: spacing.lg },
    shortcutCard: { paddingVertical: spacing.md },
    quantity: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    badges: { alignItems: 'flex-end', gap: spacing.xs },
  });
