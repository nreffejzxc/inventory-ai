import { useCallback, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItem } from 'react-native';

import Badge from '../../components/Badge';
import Button, { ButtonRow } from '../../components/Button';
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
  const { token, signOut } = useSession();
  const locations = useActiveRef(token, locationsApi);

  // Dashboard stat cards deep-link here with ?status=low|out. The backend's
  // inventory endpoint filters via lowStock/outOfStock flags, so the navigation
  // shorthand is mapped onto those flags here (UI concern only).
  const statusParam = str(useLocalSearchParams().status);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 300);
  const [locationId, setLocationId] = useState('');
  const [low, setLow] = useState(statusParam === 'low');
  const [out, setOut] = useState(statusParam === 'out');

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

  const header = (
    <View>
      <ButtonRow style={styles.actionRow}>
        <Button title="Scan" icon="scan" variant="secondary" style={styles.flexBtn} onPress={() => router.push('/scan')} />
        <Button
          title="Purchase Orders"
          icon="receipt"
          variant="secondary"
          style={styles.flexBtn}
          onPress={() => router.push('/purchase-orders')}
        />
      </ButtonRow>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search by product name, SKU or barcode…"
        style={styles.search}
      />
      <View style={styles.chipRow}>
        {/* NOTE (MOD-02): tone="warning" is not a ChipTone — Chip renders
            anything other than 'danger' as primary, so the prop was already
            inert. Omitted (default is 'primary') to keep the chip identical. */}
        <Chip label="Low stock" selected={low} onPress={() => setLow((v) => !v)} />
        <Chip label="Out of stock" tone="danger" selected={out} onPress={() => setOut((v) => !v)} />
      </View>
      <SelectField label="Location" placeholder="Filter by location…" options={locOptions} value={locationId} onChange={setLocationId} />
      {/* §27CR — this screen lists stock ROWS (per location); the restock list is the
          product-level one, and STAFF land here after sign-in with no dashboard to
          reach it from. Without this line the newest screen had no route in for the
          role that does the restocking. */}
      <Pressable onPress={() => router.push('/restock')} accessibilityRole="button" style={styles.restockRow}>
        <Text style={styles.restockLink}>Restock list →</Text>
      </Pressable>
    </View>
  );

  function emptyMessage(): string {
    if (low && !out) return 'No low-stock rows match your filters right now.';
    if (out) return 'Nothing is out of stock right now.';
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
    actionRow: { marginBottom: spacing.lg },
    flexBtn: { flex: 1 },
    search: { marginBottom: spacing.lg },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
    quantity: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    restockRow: { alignSelf: 'flex-start', marginBottom: spacing.lg },
    restockLink: { ...type.body, color: colors.primary, fontWeight: '700' },
    badges: { alignItems: 'flex-end', gap: spacing.xs },
  });
