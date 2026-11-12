import { useCallback, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { TypeBadge } from '../../components/Badge';
import { PressableCard } from '../../components/Card';
import Chip from '../../components/Chip';
import { Icon } from '../../components/icons';
import type { IconName } from '../../components/icons';
import ListRow from '../../components/ListRow';
import ListScreen from '../../components/ListScreen';
import SelectField from '../../components/SelectField';
import { activityRouteParams } from '../../lib/activity';
import { inventoryApi, locationsApi, productsApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { useSession } from '../../lib/auth';
import type { QueryParams } from '../../lib/client';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useActiveRef } from '../../hooks/useReferences';
import usePagedList from '../../hooks/usePagedList';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const TYPE_FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'STOCK_IN', label: 'Stock in' },
  { value: 'STOCK_OUT', label: 'Stock out' },
  { value: 'ADJUSTMENT', label: 'Adjust' },
  { value: 'TRANSFER', label: 'Transfer' },
];

const TYPE_ICONS: Record<string, IconName> = {
  STOCK_IN: 'stockIn',
  STOCK_OUT: 'stockOut',
  ADJUSTMENT: 'adjust',
  TRANSFER: 'transfer',
};

function deltaText(item: ApiResponse): string {
  if (item.type === 'STOCK_IN') return `+${formatNumber(item.quantity)}`;
  if (item.type === 'STOCK_OUT') return `−${formatNumber(item.quantity)}`;
  const d = (item.newQuantity ?? 0) - (item.previousQuantity ?? 0);
  return d >= 0 ? `+${d}` : `−${Math.abs(d)}`;
}
function deltaTone(colors: Palette, item: ApiResponse): string {
  if (item.type === 'STOCK_IN') return colors.success;
  if (item.type === 'STOCK_OUT') return colors.danger;
  return colors.textSecondary;
}

function HistoryRow({ item }: { item: ApiResponse }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tone = deltaTone(colors, item);
  return (
    <PressableCard
      onPress={() => router.push({ pathname: '/history/[id]', params: activityRouteParams(item) })}
      style={styles.rowCard}
      accessibilityRole="button"
      accessibilityLabel={`${item.product?.name ?? 'Unknown product'} ${deltaText(item)}`}
    >
      <ListRow
        leading={<Icon name={TYPE_ICONS[item.type] ?? 'adjust'} color={tone} size={22} />}
        title={item.product?.name ?? 'Unknown product'}
        subtitle={`${item.location?.name ?? 'No location'} · ${formatNumber(item.previousQuantity)} → ${formatNumber(item.newQuantity)}`}
        right={
          <View style={styles.right}>
            <Text style={[styles.delta, { color: tone }]}>{deltaText(item)}</Text>
            <Icon name="chevronRight" color={colors.textMuted} size={16} />
          </View>
        }
        footer={
          <View>
            <View style={styles.footerTop}>
              <TypeBadge type={item.type} />
              <Text style={styles.time}>{formatDateTime(item.createdAt)}</Text>
            </View>
            {item.reason ? <Text style={styles.reason}>Reason: {item.reason}</Text> : null}
            {item.reference ? <Text style={styles.reason}>Ref: {item.reference}</Text> : null}
          </View>
        }
      />
    </PressableCard>
  );
}

export default function HistoryScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut } = useSession();
  const p = useLocalSearchParams();
  const paramProductId = str(p.productId);
  const paramProductName = str(p.productName);
  const paramLocationId = str(p.locationId);
  const paramLocationName = str(p.locationName);

  const products = useActiveRef(token, productsApi);
  const locations = useActiveRef(token, locationsApi);

  const [type, setType] = useState('ALL');
  const [productId, setProductId] = useState(paramProductId ?? '');
  const [locationId, setLocationId] = useState(paramLocationId ?? '');

  const productOptions = useMemo(() => {
    const list = products.items.map((x) => ({ value: x.id, label: x.name }));
    if (paramProductId && paramProductName && !list.some((o) => o.value === paramProductId)) {
      list.unshift({ value: paramProductId, label: paramProductName });
    }
    return list;
  }, [products.items, paramProductId, paramProductName]);

  const locationOptions = useMemo(() => {
    const list = locations.items.map((l) => ({ value: l.id, label: l.name }));
    if (paramLocationId && paramLocationName && !list.some((o) => o.value === paramLocationId)) {
      list.unshift({ value: paramLocationId, label: paramLocationName });
    }
    return list;
  }, [locations.items, paramLocationId, paramLocationName]);

  const queryParams = useCallback((): QueryParams => {
    const q: QueryParams = { page: undefined };
    if (type !== 'ALL') q.type = type;
    if (productId) q.productId = productId;
    if (locationId) q.locationId = locationId;
    return q;
  }, [type, productId, locationId]);

  const fetcher = useCallback(
    (page: number, limit: number) => inventoryApi.history(token as string, { ...queryParams(), page, limit }),
    [token, queryParams]
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });

  const header = (
    <View>
      <View style={styles.chipRow}>
        {TYPE_FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} selected={type === f.value} onPress={() => setType(f.value)} />
        ))}
      </View>
      <SelectField label="Product" placeholder="All products…" options={productOptions} value={productId} onChange={setProductId} searchable />
      <SelectField label="Location" placeholder="All locations…" options={locationOptions} value={locationId} onChange={setLocationId} searchable />
      {list.total > 0 ? <Text style={styles.count}>{formatNumber(list.total)} movement{list.total === 1 ? '' : 's'}, newest first</Text> : null}
    </View>
  );

  return (
    <ListScreen
      items={list.items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <HistoryRow item={item} />}
      header={header}
      loading={list.loading}
      error={list.error}
      onRetry={list.reload}
      errorTitle="Couldn't load history"
      refreshing={list.refreshing}
      onRefresh={list.refresh}
      onEndReached={list.loadMore}
      loadingMore={list.loadingMore}
      loadingLabel="Loading history…"
      emptyTitle="No movements yet"
      emptyMessage="Stock in, stock out and adjustments will be listed here."
    />
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
    count: { ...type.caption, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.lg },
    rowCard: { paddingVertical: spacing.md },
    right: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    delta: { ...type.h3 },
    footerTop: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    time: { ...type.caption, color: colors.textMuted },
    reason: { ...type.bodySmall, color: colors.textMuted, marginTop: spacing.xs },
  });
