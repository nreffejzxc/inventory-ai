import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from '../../../../components/Banner';
import { PoStatusBadge } from '../../../../components/Badge';
import Button from '../../../../components/Button';
import Card from '../../../../components/Card';
import { Icon } from '../../../../components/icons';
import ListRow from '../../../../components/ListRow';
import { CenterLoader, EmptyState, ErrorState, errorText } from '../../../../components/ListState';
import { poErrorMessage } from '../../../../components/PoForm';
import Screen from '../../../../components/Screen';
import SectionHeader from '../../../../components/SectionHeader';
import StatCard from '../../../../components/StatCard';
import AccessDenied from '../../../../components/AccessDenied';
import { purchaseOrdersApi } from '../../../../lib/api';
import type { ApiResponse } from '../../../../lib/api';
import { isSessionError, useSession } from '../../../../lib/auth';
import { alert, confirm } from '../../../../lib/confirm';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../../../../lib/format';
import {
  canManagePurchaseOrders,
  canReceivePurchaseOrders,
  canViewPurchaseOrders,
} from '../../../../lib/permissions';
import useRefetchOnFocus from '../../../../hooks/useRefetchOnFocus';
import { radius, spacing, type } from '../../../../lib/theme';
import type { Palette } from '../../../../lib/theme';
import { useTheme } from '../../../../lib/theme-context';

function Row({ label, value, mono, danger }: { label: string; value?: ReactNode; mono?: boolean; danger?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '') return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldMono, danger && styles.fieldDanger]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function statusNote(status: string): string | null {
  if (status === 'DRAFT') return 'This order has not been issued yet, so it cannot be received.';
  if (status === 'RECEIVED') return 'This order is fully received.';
  if (status === 'CANCELED') return 'This order was canceled and can no longer be received.';
  return null;
}

export default function PurchaseOrderDetailScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, token, signOut } = useSession();
  const canReceive = canReceivePurchaseOrders(user);
  const canManage = canManagePurchaseOrders(user);

  const [po, setPo] = useState<ApiResponse>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await purchaseOrdersApi.get(token, id);
      setPo(data);
    } catch (err) {
      setError(err);
      if (isSessionError(err)) await signOut();
    } finally {
      setLoading(false);
    }
  }, [token, id, signOut]);

  // First load only. `load` sets `loading`/`error` synchronously before its first
  // await on purpose: loading must be true at request start, and it cannot be
  // derived from `po` — a refresh keeps the previous order visible, so a missing
  // order is not a loading state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Refetch whenever the screen regains focus, so a receive completed from here
  // (or from the receive form pushed on top) is reflected immediately. The hook
  // skips the mount focus, so the initial load above is not duplicated. The
  // explicit `await load()` calls after issue/cancel are unaffected.
  useRefetchOnFocus(load);

  if (!canViewPurchaseOrders(user)) {
    return <AccessDenied message="Your role does not allow viewing purchase orders." />;
  }

  if (loading && !po) return <CenterLoader label="Loading purchase order…" />;
  if (error && !po) return <ErrorState title="Couldn't load the purchase order" message={errorText(error)} onRetry={load} />;
  if (!po) return null;

  const totals = po.totals ?? {};
  // Product names are read back by id in the receiving history below; the map's
  // key/value types are pinned because the pair is inferred from an untyped DTO.
  const nameById = new Map<string, string>(
    (po.items ?? []).map((i: ApiResponse): [string, string] => [i.productId, i.productName])
  );
  const pendingUnits = (po.pendingClaims ?? []).reduce((sum: number, c: ApiResponse) => sum + (c.quantity || 0), 0);
  const note = statusNote(po.status);

  async function onIssue(): Promise<void> {
    const ok = await confirm('Issue order', `${po.number} will be opened for receiving. This cannot be undone.`, {
      confirmText: 'Issue',
    });
    if (!ok) return;
    try {
      const updated = await purchaseOrdersApi.issue(token as string, po.id);
      await load();
      await alert('Order issued', `${updated?.number ?? po.number} is now open for receiving.`);
    } catch (err) {
      await alert('Could not issue', poErrorMessage(err));
      await load();
    }
  }

  async function onCancel(): Promise<void> {
    const ok = await confirm('Cancel order', `${po.number} will be marked canceled and can no longer be received or changed.`, {
      confirmText: 'Yes, cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      const updated = await purchaseOrdersApi.cancel(token as string, po.id);
      await load();
      await alert('Order canceled', `${updated?.number ?? po.number} was canceled.`);
    } catch (err) {
      await alert('Could not cancel', poErrorMessage(err));
      await load();
    }
  }

  return (
    <Screen scroll>
      {pendingUnits > 0 ? (
        <Banner
          type="warn"
          text={`${formatNumber(pendingUnits)} unit(s) are reserved by an interrupted receive and cannot be received until this order is canceled and re-created.`}
        />
      ) : null}

      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.number} numberOfLines={1}>
            {po.number}
          </Text>
          <PoStatusBadge status={po.status} />
        </View>
        {po.notes ? <Text style={styles.notes}>{po.notes}</Text> : null}

        <View style={styles.divider} />
        <Row label="Supplier" value={po.supplier?.name} />
        <Row label="Location" value={po.location?.name} />
        <Row label="Expected" value={po.expectedAt ? formatDate(po.expectedAt) : null} />
        <Row label="Created" value={formatDateTime(po.createdAt)} />
        {totals.estimatedCost ? <Row label="Est. cost" value={formatMoney(totals.estimatedCost)} mono /> : null}
      </Card>

      {/* Key progress figures lead; Ordered is preserved in the Received sub. */}
      <View style={styles.statGrid}>
        <View style={styles.statCell}>
          <StatCard
            label="Received"
            value={formatNumber(totals.quantityReceived)}
            sub={`of ${formatNumber(totals.quantityOrdered)} ordered`}
          />
        </View>
        <View style={styles.statCell}>
          <StatCard label="Remaining" value={formatNumber(totals.remainingQuantity)} />
        </View>
      </View>

      {canManage && (po.status === 'DRAFT' || po.status === 'OPEN') ? (
        <>
          <SectionHeader title="Manage" style={styles.section} />
          <View style={styles.manageRow}>
            {po.status === 'DRAFT' ? (
              <Button title="Edit" variant="secondary" onPress={() => router.push(`/purchase-orders/${po.id}/edit`)} style={styles.manageBtn} />
            ) : null}
            {po.status === 'DRAFT' ? (
              <Button title="Issue" onPress={onIssue} style={styles.manageBtn} />
            ) : null}
            <Button title="Cancel" variant="danger" onPress={onCancel} style={styles.manageBtn} />
          </View>
        </>
      ) : null}

      <SectionHeader title="Items" style={styles.section} />
      <Card>
        {(po.items ?? []).length === 0 ? (
          <EmptyState title="No items" message="This order has no product lines." />
        ) : (
          <View style={styles.itemList}>
            {(po.items ?? []).map((item: ApiResponse) => (
              <ListRow
                key={item.productId}
                style={styles.itemRow}
                leading={<Icon name="cube" color={colors.primary} size={22} />}
                title={item.productName ?? 'Unknown product'}
                subtitle={item.sku ? `SKU · ${item.sku}` : undefined}
                footer={
                  // Line progress stays at body size (never the smaller subtitle size).
                  <Text style={styles.itemQty}>
                    Ordered {formatNumber(item.quantityOrdered)} · Received {formatNumber(item.quantityReceived)} · Remaining{' '}
                    {formatNumber(item.remainingQuantity)}
                  </Text>
                }
              />
            ))}
          </View>
        )}
      </Card>

      <SectionHeader title="Receiving history" style={styles.section} />
      {(po.receipts ?? []).length === 0 ? (
        <Card>
          <EmptyState title="Nothing received yet" message="Stock received against this order will appear here." />
        </Card>
      ) : (
        <View style={styles.receiptList}>
          {(po.receipts ?? []).map((receipt: ApiResponse, idx: number) => {
            const units = (receipt.lines ?? []).reduce((sum: number, l: ApiResponse) => sum + (l.quantity || 0), 0);
            return (
              <Card key={`${receipt.receivedAt}-${idx}`} style={styles.receiptCard}>
                <ListRow
                  leading={<Icon name="stockIn" color={colors.success} size={22} />}
                  title={formatDateTime(receipt.receivedAt)}
                  right={
                    // Units received is a key quantity: body size, tabular figures.
                    <Text style={styles.receiptUnits}>{formatNumber(units)} unit(s)</Text>
                  }
                />
                {receipt.reference ? (
                  <Text style={styles.receiptRef} numberOfLines={1}>
                    Reference · {receipt.reference}
                  </Text>
                ) : null}
                <View style={styles.receiptLines}>
                  {(receipt.lines ?? []).map((line: ApiResponse) => (
                    <Text key={line.productId + String(idx)} style={styles.receiptLine} numberOfLines={1}>
                      {nameById.get(line.productId) ?? 'Unknown product'} +{formatNumber(line.quantity)}
                    </Text>
                  ))}
                </View>
              </Card>
            );
          })}
        </View>
      )}

      {canReceive ? (
        po.status === 'OPEN' ? (
          <>
            <SectionHeader title="Receive stock" style={styles.section} />
            <Button title="Receive Stock" full onPress={() => router.push(`/purchase-orders/${po.id}/receive`)} />
          </>
        ) : note ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>{note}</Text>
          </View>
        ) : null
      ) : null}
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    // PO number keeps its existing emphasis (bold, tabular figures) — the same
    // weight family the purchase-order list uses.
    number: { ...type.h2, color: colors.text, flex: 1, fontWeight: '800', fontVariant: ['tabular-nums'] },
    notes: { ...type.body, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 22 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
    fieldRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
    fieldLabel: { ...type.body, color: colors.textMuted },
    fieldValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1, marginLeft: spacing.lg },
    fieldMono: { fontVariant: ['tabular-nums'] },
    fieldDanger: { color: colors.danger },
    manageRow: { flexDirection: 'row', gap: spacing.md },
    manageBtn: { flex: 1 },
    // SectionHeader brings its own bottom margin; sections keep the top gap.
    section: { marginTop: spacing.xxl },
    statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg },
    statCell: { flexGrow: 1, flexBasis: '46%', minWidth: '46%' },
    itemList: { gap: spacing.lg },
    itemRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider, paddingBottom: spacing.lg },
    // Line progress is a key quantity: body size with tabular figures.
    itemQty: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    receiptList: { gap: spacing.sm },
    receiptCard: { padding: spacing.md },
    // Units received is a key quantity: body size with tabular figures.
    receiptUnits: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    receiptRef: { ...type.caption, color: colors.textMuted, marginTop: 4 },
    receiptLines: { marginTop: 6, gap: 2 },
    receiptLine: { ...type.caption, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    note: {
      marginTop: spacing.xxl,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    noteText: { ...type.bodySmall, color: colors.textSecondary, textAlign: 'center', fontWeight: '600' },
  });
