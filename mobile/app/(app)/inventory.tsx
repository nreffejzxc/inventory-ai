import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItem } from 'react-native';

import Badge from '../../components/Badge';
import { PressableCard } from '../../components/Card';
import Chip from '../../components/Chip';
import { Icon } from '../../components/icons';
import ListRow from '../../components/ListRow';
import ListScreen from '../../components/ListScreen';
import { CenterLoader } from '../../components/ListState';
import Screen from '../../components/Screen';
import SearchField from '../../components/SearchField';
import SelectField from '../../components/SelectField';
import { inventoryApi, locationsApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { useSession } from '../../lib/auth';
import type { QueryParams } from '../../lib/client';
import { formatNumber } from '../../lib/format';
import {
  clearInventoryFilters,
  loadInventoryFilters,
  saveInventoryFilters,
} from '../../lib/inventoryFilters';
import type { InventoryFilterSnapshot, InventoryStatusFilter } from '../../lib/inventoryFilters';
import { canViewPurchaseOrders } from '../../lib/permissions';
import useDebounced from '../../hooks/useDebounced';
import { referenceAvailability, useActiveRef } from '../../hooks/useReferences';
import usePagedList from '../../hooks/usePagedList';
import useRefetchOnFocus from '../../hooks/useRefetchOnFocus';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

type RouteSeed = InventoryFilterSnapshot & {
  /** True when the URL supplied this dimension; then the saved value is not used. */
  hasStatus: boolean;
  hasLocation: boolean;
  /** A saved id or an explicit locationId pins the selector; a name still resolves. */
  locationTouched: boolean;
  q: string;
  locationName: string;
};

function routeSeed(params: ReturnType<typeof useLocalSearchParams>): RouteSeed {
  const locationId = str(params.locationId);
  const locationName = str(params.location);
  const needsAttention = str(params.needsAttention) === 'true';
  const stockStatus = str(params.stockStatus).toUpperCase();
  const legacyStatus = str(params.status).toLowerCase();
  const low = str(params.lowStock) === 'true' || legacyStatus === 'low';
  const out = str(params.outOfStock) === 'true' || legacyStatus === 'out';
  // Canonical status wins over the legacy flags; a more specific Low/Out flag
  // also narrows a needsAttention link, matching the API's intersection rule. A
  // legacy low/out link opens the same visible canonical chip as the Products
  // screen rather than a hidden broad flag.
  const canonical = stockStatus === 'LOW_STOCK' ? 'low' : stockStatus === 'OUT_OF_STOCK' ? 'out' : '';
  const status: InventoryStatusFilter =
    canonical || (out ? 'out' : low ? 'low' : needsAttention ? 'needsAttention' : '');
  return {
    locationId,
    status,
    hasStatus: Boolean(status),
    hasLocation: Boolean(locationId || locationName),
    locationTouched: Boolean(locationId),
    q: str(params.q),
    locationName,
  };
}

type ChipCounts = {
  all: number;
  needsAttention: number;
  low: number;
  out: number;
};

/** Validate the server contract before a malformed count can reach the chips. */
function readCounts(raw: Record<string, number> | null): ChipCounts | null {
  if (!raw) return null;
  const all = raw.all;
  const needsAttention = raw.needsAttention;
  const low = raw.low;
  const out = raw.out;
  if (![all, needsAttention, low, out].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return { all, needsAttention, low, out };
}

type InventoryInitial = InventoryFilterSnapshot & { locationTouched: boolean };

/**
 * Resolve saved filters before the list mounts. Route parameters win per
 * dimension: an explicit location or status is never replaced by a saved choice,
 * while the unspecified dimension still restores. Doing this above the list means
 * there is no unfiltered request followed by a filtered one.
 */
export default function InventoryScreen() {
  const params = useLocalSearchParams();
  const { user } = useSession();
  const route = useMemo(() => routeSeed(params), [params]);
  const routeKey = `${route.locationId}|${route.locationName}|${route.status}|${route.q}`;
  const [initial, setInitial] = useState<InventoryInitial | null>(() =>
    route.hasStatus && route.hasLocation
      ? { locationId: route.locationId, status: route.status, locationTouched: route.locationTouched }
      : null,
  );

  useEffect(() => {
    if (initial) return;
    let active = true;
    void loadInventoryFilters(user?.id).then((saved) => {
      if (!active) return;
      setInitial({
        locationId: route.hasLocation ? route.locationId : saved.locationId,
        status: route.hasStatus ? route.status : saved.status,
        locationTouched: route.hasLocation ? route.locationTouched : false,
      });
    });
    return () => {
      active = false;
    };
    // `routeKey` names the stable route values; the object itself is recreated by
    // the router on every render and must not re-run the restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, routeKey, user?.id]);

  if (!initial) {
    return (
      <Screen>
        <CenterLoader label="Loading inventory…" />
      </Screen>
    );
  }

  return (
    <InventoryList
      initial={initial}
      routeQuery={route.q}
      paramLocationName={route.locationName}
      route={route}
    />
  );
}

function InventoryList({
  initial,
  routeQuery,
  paramLocationName,
  route,
}: {
  initial: InventoryInitial;
  routeQuery: string;
  paramLocationName: string;
  route: RouteSeed;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, user, signOut } = useSession();
  // The saved location is judged against the COMPLETE active list. The endpoint
  // pages at 100 rows, so the first page alone cannot prove that a saved id was
  // deleted. `complete` also stays false when the read fails, which preserves the
  // saved filter until a later load can confirm the location is gone.
  const locations = useActiveRef(token, locationsApi, { allPages: true });

  // A q-only route can also arrive after mount. Keep the last applied route in
  // the draft so a new non-empty route query replaces the field while ordinary
  // typing (and a route without q) leaves it alone.
  const [queryDraft, setQueryDraft] = useState({ routeQuery, value: routeQuery });
  const q = routeQuery && routeQuery !== queryDraft.routeQuery ? routeQuery : queryDraft.value;
  const changeQuery = (value: string) => setQueryDraft({ routeQuery, value });
  const debouncedQ = useDebounced(q, 300);
  const [locationChoice, setLocationChoice] = useState(initial.locationId);
  const [locationTouchedChoice, setLocationTouchedChoice] = useState(initial.locationTouched);
  const [statusChoice, setStatusChoice] = useState<InventoryStatusFilter>(initial.status);

  // The screen can already be mounted when a new deep link arrives. The first
  // navigation is handled by `initial` above (before the list mounts); after
  // that, a supplied route dimension stays authoritative until the person acts.
  // Deriving it during render avoids an effect that would write state again.
  const status = route.hasStatus ? route.status : statusChoice;
  const locationId = route.hasLocation ? route.locationId : locationChoice;
  const locationTouched = route.hasLocation ? route.locationTouched : locationTouchedChoice;

  // A tool may know a location by its exact name rather than its id. Resolve that
  // name from the active-location list during render; once the person touches the
  // selector, their choice (including "All locations") wins.
  // A saved id and a deep-linked id can both outlive the location they name.
  // Resolve a name only from the active list, then judge the resulting id against
  // the COMPLETE list. A failed or unfinished read resolves to `checking`, never
  // `missing`, so it cannot hide rows on a transient error.
  const resolvedParamLocationId = useMemo(() => {
    if (!paramLocationName || locationTouched || locationId) return '';
    return (
      locations.items.find(
        (location) => location.name.toLowerCase() === paramLocationName.toLowerCase(),
      )?.id ?? ''
    );
  }, [locationId, locationTouched, locations.items, paramLocationName]);

  const selectedLocationId = locationId || resolvedParamLocationId;
  const locationAvailability = referenceAvailability(selectedLocationId, locations);
  const locationMissing = locationAvailability === 'missing';
  const locationNameUnresolved = Boolean(
    paramLocationName &&
      !locationTouched &&
      !locationId &&
      locations.complete &&
      !resolvedParamLocationId,
  );
  const effectiveLocationId = locationMissing ? '' : selectedLocationId;

  const persist = useCallback(
    (next: InventoryFilterSnapshot) => {
      void saveInventoryFilters(user?.id, next);
    },
    [user?.id],
  );

  const queryParams = useCallback((): QueryParams => {
    const p: QueryParams = {
      page: undefined,
      q: debouncedQ || undefined,
      locationId: effectiveLocationId || undefined,
    };
    if (status === 'needsAttention') p.needsAttention = true;
    if (status === 'low') p.stockStatus = 'LOW_STOCK';
    if (status === 'out') p.stockStatus = 'OUT_OF_STOCK';
    return p;
  }, [debouncedQ, effectiveLocationId, status]);

  const fetcher = useCallback(
    (page: number, limit: number) =>
      inventoryApi.list(token as string, {
        ...queryParams(),
        // Counts describe the filter state, not the page; ask once per reload.
        includeCounts: page === 1,
        page,
        limit,
      }),
    [token, queryParams],
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });
  const counts = readCounts(list.counts);
  // Reload when returning from an inventory row detail / stock movement screen.
  useRefetchOnFocus(list.reload);

  const locOptions = [{ value: '', label: 'All locations' }, ...locations.items.map((l) => ({ value: l.id, label: l.name }))];

  /** Drop the deep-link status params once the person makes their own choice. */
  const clearStatusRoute = () => {
    router.setParams({ needsAttention: '', lowStock: '', outOfStock: '', status: '', stockStatus: '' });
  };

  const selectStatus = (next: Exclude<InventoryStatusFilter, ''>) => {
    const value = status === next ? '' : next;
    setStatusChoice(value);
    clearStatusRoute();
    persist({ locationId: effectiveLocationId, status: value });
  };

  const clearStatus = () => {
    setStatusChoice('');
    clearStatusRoute();
    persist({ locationId: effectiveLocationId, status: '' });
  };

  const changeLocation = (id: string) => {
    setLocationTouchedChoice(true);
    setLocationChoice(id);
    router.setParams({ locationId: '', location: '' });
    persist({ locationId: id, status });
  };

  const resetFilters = () => {
    setStatusChoice('');
    setLocationChoice('');
    setLocationTouchedChoice(true);
    clearStatusRoute();
    router.setParams({ locationId: '', location: '' });
    void clearInventoryFilters(user?.id);
  };

  const filterLabel =
    status === 'needsAttention' ? 'needing attention' : status === 'low' ? 'low on stock' : 'out of stock';
  const resetVisible = Boolean(
    status || effectiveLocationId || locationMissing || locationNameUnresolved || (paramLocationName && !locationTouched),
  );

  const header = (
    <View>
      <SearchField
        value={q}
        onChangeText={changeQuery}
        placeholder="Search by product name, SKU or barcode…"
        onScanPress={() => router.push('/scan')}
        style={styles.search}
      />
      <View style={styles.chipRow}>
        <Chip
          label="All"
          count={counts?.all}
          selected={!status}
          onPress={clearStatus}
          accessibilityHint="Shows every stock row"
        />
        <Chip
          label="Needs attention"
          count={counts?.needsAttention}
          selected={status === 'needsAttention'}
          onPress={() => selectStatus('needsAttention')}
          accessibilityHint="Shows rows that are low or out of stock"
        />
        <Chip
          label="Low stock"
          count={counts?.low}
          selected={status === 'low'}
          onPress={() => selectStatus('low')}
          accessibilityHint="Shows rows above zero but at or below their minimum stock"
        />
        <Chip
          label="Out of stock"
          tone="danger"
          count={counts?.out}
          selected={status === 'out'}
          onPress={() => selectStatus('out')}
          accessibilityHint="Shows rows with no available stock"
        />
      </View>
      {status ? (
        <View style={styles.filterBanner}>
          <Text
            testID="inventory-filter-count"
            style={styles.filterCount}
            accessibilityLiveRegion="polite"
          >
            {list.loading
              ? 'Checking stock…'
              : `${formatNumber(list.total)} stock ${list.total === 1 ? 'row' : 'rows'} ${filterLabel}`}
          </Text>
          <Pressable
            onPress={clearStatus}
            accessibilityRole="button"
            accessibilityLabel="Clear stock status filter"
            style={styles.clearFilters}
          >
            <Text style={styles.clearFiltersText}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
      <SelectField
        label="Location"
        placeholder="Filter by location…"
        options={locOptions}
        value={effectiveLocationId}
        onChange={changeLocation}
      />
      {locationMissing || locationNameUnresolved ? (
        <View style={styles.filterBanner} testID="inventory-location-unavailable">
          <Text style={styles.filterCount}>
            {locationMissing
              ? 'That location is archived or unavailable. Showing all locations.'
              : 'That location name is no longer active. Showing all locations.'}
          </Text>
        </View>
      ) : null}
      {resetVisible ? (
        <Pressable
          onPress={resetFilters}
          accessibilityRole="button"
          accessibilityLabel="Reset location and stock filters"
          testID="inventory-reset-filters"
          style={styles.resetFilters}
        >
          <Text style={styles.resetFiltersText}>Reset filters</Text>
        </Pressable>
      ) : null}
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
    if (status === 'needsAttention') {
      return 'No stock rows currently need attention at this location.';
    }
    if (status === 'low') return 'No stock rows are low on stock right now.';
    if (status === 'out') {
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
    resetFilters: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginBottom: spacing.sm },
    resetFiltersText: { ...type.body, color: colors.primary, fontWeight: '700' },
    shortcutLabel: { ...type.label, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.sm, marginBottom: spacing.sm },
    shortcutList: { gap: spacing.sm, marginBottom: spacing.lg },
    shortcutCard: { paddingVertical: spacing.md },
    quantity: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    badges: { alignItems: 'flex-end', gap: spacing.xs },
  });
