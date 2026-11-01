import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Badge, { StatusBadge } from '../../../components/Badge';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import { CenterLoader, ErrorState, errorText } from '../../../components/ListState';
import Screen from '../../../components/Screen';
import SectionHeader from '../../../components/SectionHeader';
import StatCard from '../../../components/StatCard';
import { inventoryApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { isSessionError, useSession } from '../../../lib/auth';
import { formatDateTime, formatNumber } from '../../../lib/format';
import { canAdjustStock, canTransferStock } from '../../../lib/permissions';
import useRefetchOnFocus from '../../../hooks/useRefetchOnFocus';
import { radius, spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

function Row({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '') return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function InventoryRowScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, token, signOut } = useSession();
  const canAdjust = canAdjustStock(user);
  const canTransfer = canTransferStock(user);

  const [row, setRow] = useState<ApiResponse>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await inventoryApi.get(token, id);
      setRow(data);
    } catch (err) {
      setError(err);
      if (isSessionError(err)) await signOut();
    } finally {
      setLoading(false);
    }
  }, [token, id, signOut]);

  // First load only. `load` sets `loading`/`error` synchronously before its first
  // await on purpose: loading must be true at request start, and it cannot be
  // derived from `row` — a refresh keeps the previous row visible, so a missing
  // row is not a loading state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Refetch whenever the screen regains focus, so stock moved from this record
  // (Stock In / Stock Out / Adjust are pushed on top of it) is reflected. The
  // hook skips the mount focus, so the initial load above is not duplicated.
  useRefetchOnFocus(load);

  if (loading && !row) return <CenterLoader label="Loading stock record…" />;
  if (error && !row) return <ErrorState title="Couldn't load the stock record" message={errorText(error)} onRetry={load} />;
  if (!row) return null;

  const productActive = row.product?.status === 'ACTIVE';
  const moveParams = {
    productId: row.product?.id,
    productName: row.product?.name,
    locationId: row.location?.id,
    locationName: row.location?.name,
  };

  return (
    <Screen scroll>
      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={2}>
            {row.product?.name ?? 'Unknown product'}
          </Text>
          <StatusBadge status={row.product?.status} />
        </View>
        <View style={styles.badgeRow}>
          {row.isLowStock ? <Badge text="Low stock" tone="low" /> : null}
          {row.isOutOfStock ? <Badge text="Out of stock" tone="danger" /> : null}
        </View>

        <View style={styles.divider} />
        <Row label="Location" value={row.location?.name} />
        <Row label="Product SKU" value={row.product?.sku} mono />
        <Row label="Unit" value={row.product?.unit} />
        <Row label="Minimum stock" value={row.product?.minimumStock != null ? formatNumber(row.product.minimumStock) : null} mono />
        <Row label="Reserved" value={formatNumber(row.reservedQuantity)} mono />
        <Row label="Updated" value={formatDateTime(row.updatedAt)} />
      </Card>

      {/* Key quantities lead the screen; Reserved stays in the definition list. */}
      <View style={styles.statGrid}>
        <View style={styles.statCell}>
          <StatCard
            label="Available"
            value={formatNumber(row.availableQuantity)}
            tone={row.isOutOfStock ? 'danger' : 'default'}
          />
        </View>
        <View style={styles.statCell}>
          <StatCard label="On hand" value={formatNumber(row.quantity)} />
        </View>
      </View>

      {productActive ? (
        <>
          <SectionHeader title="Move stock" style={styles.section} />
          <View style={styles.actions}>
            <Button title="Stock In" style={styles.flexBtn} onPress={() => router.push({ pathname: '/stock-in', params: moveParams })} />
            <Button title="Stock Out" variant="secondary" style={styles.flexBtn} onPress={() => router.push({ pathname: '/stock-out', params: moveParams })} />
            {canAdjust ? (
              <Button title="Adjust" variant="secondary" style={styles.flexBtn} onPress={() => router.push({ pathname: '/adjust', params: moveParams })} />
            ) : null}
          </View>
          {/* Transfer used to be reachable only from the dashboard, so moving the
              row you are looking at meant leaving it and finding the product again.
              The source location travels with the params; the form still enforces
              that the destination differs. */}
          {canTransfer ? (
            <Button
              title="Transfer to another location"
              icon="transfer"
              variant="secondary"
              onPress={() => router.push({ pathname: '/transfer', params: moveParams })}
              style={styles.transferBtn}
              full
            />
          ) : null}
        </>
      ) : (
        <View style={styles.archivedNote}>
          <Text style={styles.archivedText}>This product is archived and cannot be used in new stock movements.</Text>
        </View>
      )}
    </Screen>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  name: { ...type.h2, color: colors.text, flex: 1 },
  badgeRow: { flexDirection: 'row', gap: 6, marginTop: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  fieldLabel: { ...type.body, color: colors.textMuted },
  fieldValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1, marginLeft: spacing.lg },
  fieldMono: { fontVariant: ['tabular-nums'] },
  // SectionHeader brings its own bottom margin; sections keep the top gap.
  section: { marginTop: spacing.xxl },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg },
  statCell: { flexGrow: 1, flexBasis: '46%', minWidth: '46%' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  flexBtn: { flex: 1 },
  transferBtn: { marginTop: spacing.sm },
  archivedNote: {
    marginTop: spacing.xxl,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  archivedText: { ...type.bodySmall, color: colors.warning, textAlign: 'center', fontWeight: '600' },
});
