import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { TypeBadge } from '../../../components/Badge';
import Card from '../../../components/Card';
import Screen from '../../../components/Screen';
import { formatDateTime, formatNumber } from '../../../lib/format';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function Field({ label, value, mono, tone }: { label: string; value?: ReactNode; mono?: boolean; tone?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '') return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldMono, tone ? { color: tone } : null]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export default function ActivityDetailScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const p = useLocalSearchParams();
  const type = str(p.type);
  const isTransfer = type === 'TRANSFER';
  const productName = str(p.productName) || 'Unknown product';
  const productSku = str(p.productSku);
  const locationName = str(p.locationName);
  const fromName = str(p.fromName);
  const toName = str(p.toName);
  const quantity = num(str(p.quantity));
  const previous = num(str(p.previousQuantity));
  const next = num(str(p.newQuantity));
  const reason = str(p.reason);
  const reference = str(p.reference);
  const createdAt = str(p.createdAt);

  const change = previous != null && next != null ? next - previous : null;
  const changeTone = change == null ? undefined : change < 0 ? colors.danger : change > 0 ? colors.success : colors.textSecondary;

  return (
    <Screen scroll>
      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={2}>
            {productName}
          </Text>
          <TypeBadge type={type} />
        </View>
        <Text style={styles.time}>{formatDateTime(createdAt)}</Text>
        <View style={styles.divider} />
        {productSku ? <Field label="SKU" value={productSku} mono /> : null}
        {isTransfer && (fromName || toName) ? (
          <>
            <Field label="From" value={fromName || 'Unknown location'} />
            <Field label="To" value={toName || 'Unknown location'} />
          </>
        ) : (
          <Field label={isTransfer ? 'Location (leg)' : 'Location'} value={locationName || 'No location'} />
        )}
        <Field label={isTransfer ? 'Units moved' : 'Quantity'} value={quantity != null ? formatNumber(quantity) : undefined} mono />
        <Field label="Previous quantity" value={previous != null ? formatNumber(previous) : undefined} mono />
        <Field label="New quantity" value={next != null ? formatNumber(next) : undefined} mono />
        <Field
          label="Change"
          value={change != null ? `${change > 0 ? '+' : change < 0 ? '−' : ''}${formatNumber(Math.abs(change))}` : undefined}
          mono
          tone={changeTone}
        />
        <View style={styles.divider} />
        <Field label="Reason" value={reason || 'Not recorded'} />
        <Field label="Reference" value={reference || 'Not recorded'} mono />
      </Card>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
    name: { ...type.h2, color: colors.text, flex: 1 },
    time: { ...type.bodySmall, color: colors.textMuted, marginTop: spacing.sm },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
    fieldRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg, paddingVertical: 5 },
    fieldLabel: { ...type.body, color: colors.textMuted },
    fieldValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
    fieldMono: { fontVariant: ['tabular-nums'] },
  });
