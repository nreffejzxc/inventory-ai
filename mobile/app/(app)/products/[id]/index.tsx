import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { printAsync, printToFileAsync } from 'expo-print';
import * as Sharing from 'expo-sharing';

import Badge, { StatusBadge } from '../../../../components/Badge';
import Button from '../../../../components/Button';
import Card from '../../../../components/Card';
import Ean13Barcode from '../../../../components/Ean13Barcode';
import { Icon } from '../../../../components/icons';
import ListRow from '../../../../components/ListRow';
import { CenterLoader, EmptyState, ErrorState, errorText } from '../../../../components/ListState';
import Screen from '../../../../components/Screen';
import SectionHeader from '../../../../components/SectionHeader';
import { inventoryApi, productsApi } from '../../../../lib/api';
import type { ApiResponse } from '../../../../lib/api';
import { useSession } from '../../../../lib/auth';
import { confirm } from '../../../../lib/confirm';
import { barcodeLabelHtml, isEan13 } from '../../../../lib/ean13';
import type { BarcodeLabel } from '../../../../lib/ean13';
import { formatDateTime, formatMoney, formatNumber } from '../../../../lib/format';
import { canAdjustStock, canManageProducts } from '../../../../lib/permissions';
import { useProductDetail } from '../../../../hooks/useProductDetail';
import useRefetchOnFocus from '../../../../hooks/useRefetchOnFocus';
import { radius, spacing, type } from '../../../../lib/theme';
import type { Palette } from '../../../../lib/theme';
import { useTheme } from '../../../../lib/theme-context';

function Field({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '' || value === false) return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function StockRow({ row }: { row: ApiResponse }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Card>
      <ListRow
        leading={<Icon name="location" color={colors.primary} size={22} />}
        title={row.location?.name ?? 'Unknown location'}
        footer={
          // Availability stays at body size (never the smaller subtitle size).
          <Text style={styles.stockQty}>{formatNumber(row.availableQuantity)} available</Text>
        }
        right={
          row.isLowStock || row.isOutOfStock ? (
            <View style={styles.stockBadges}>
              {row.isLowStock ? <Badge text="Low" tone="low" /> : null}
              {row.isOutOfStock ? <Badge text="Out" tone="danger" /> : null}
            </View>
          ) : null
        }
      />
    </Card>
  );
}

export default function ProductDetailScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, token } = useSession();
  const manage = canManageProducts(user);
  const canAdjust = canAdjustStock(user);

  const { product, loading, error, reload } = useProductDetail(id);

  const [stock, setStock] = useState<ApiResponse[]>([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [busyArchive, setBusyArchive] = useState(false);
  const [busyGen, setBusyGen] = useState(false);
  const [busyLabel, setBusyLabel] = useState(false);

  const loadStock = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    setStockLoading(true);
    try {
      const res = await inventoryApi.list(token, { productId: id, page: 1, limit: 100 });
      setStock(res?.items ?? []);
    } catch (err) {
      const e = err as { message?: string; status?: number } | null;
      if (e?.message) {
        // Stock list is secondary; keep silent failures non-blocking.
        if (e.status === 403) Alert.alert('Inventory', 'You do not have permission to view stock.');
      }
    } finally {
      setStockLoading(false);
    }
  }, [token, id]);

  useEffect(() => {
    // `loadStock` sets stockLoading synchronously before its first await on
    // purpose: stock is also reloaded on focus and after archive/restore, so the
    // spinner must be able to be true while `stock` is already populated; deriving
    // it from `stock` would also turn a real "No stock yet" list into a spinner.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStock();
  }, [loadStock]);

  // Reload when returning from edit or a stock movement screen pushed from here.
  useRefetchOnFocus(() => {
    reload();
    loadStock();
  });

  async function onToggleArchive(): Promise<void> {
    if (!product || busyArchive) return;
    const restoring = product.status === 'ARCHIVED';
    if (!restoring) {
      const ok = await confirm(
        'Archive product?',
        `"${product.name}" is kept for history but hidden from new stock movements.`,
        { confirmText: 'Archive', destructive: true }
      );
      if (!ok) return;
    }
    setBusyArchive(true);
    try {
      if (restoring) await productsApi.restore(token as string, product.id);
      else await productsApi.archive(token as string, product.id);
      await reload();
      await loadStock();
    } catch (err) {
      Alert.alert('Could not update the product', errorText(err));
    } finally {
      setBusyArchive(false);
    }
  }

  async function onGenerateBarcode(): Promise<void> {
    if (!product || busyGen) return;
    setBusyGen(true);
    try {
      // Server issues an internal EAN-13 onto Product.barcode (never overwrites
      // an existing code, refuses ARCHIVED products). Reload to show it.
      await productsApi.generateBarcode(token as string, product.id);
      await reload();
    } catch (err) {
      Alert.alert('Could not generate a barcode', errorText(err));
    } finally {
      setBusyGen(false);
    }
  }

  function labelHtml(): BarcodeLabel {
    return barcodeLabelHtml(product.barcode, { productName: product.name, sku: product.sku });
  }

  /**
   * Open the OS print dialog with the label as its own page (no printer config).
   *
   * The page geometry comes from the same `barcodeLabelHtml` result the PDF path
   * uses, so printing and sharing produce **one** layout instead of two. Passing
   * only `html` would page the label at `expo-print`'s default (US Letter, 612×792),
   * which is a different document from the 595×340 label the share sheet offers.
   *
   * MEASURED 2026-10-15 (Android, OPPO CPH1969, expo-print 57.0.2) — and the reason the
   * note above is about the DOCUMENT while this one is about the PAGE: the print dialog's
   * paper size is the print service's, not this app's. Saving this action's output gave
   * `MediaBox [0 0 612 792]`, and so did a deliberate experiment that generated the label
   * PDF first and printed THAT file (`printAsync({ uri })`), which means the page size is
   * not something expo-print can set here: `getAttributesFromOptions` builds the print job
   * from `orientation` and margins alone, and `UNKNOWN_PORTRAIT` is precisely "let the
   * service or the user choose". What carries the geometry is the file `Share PDF` writes
   * (`MediaBox [0 0 594.96 339.12]`, measured on the same device), so a label printer wants
   * that PDF, or a media size chosen in the dialog. Recorded in roadmap §27CE.
   */
  async function onPrintLabel(): Promise<void> {
    if (busyLabel) return;
    setBusyLabel(true);
    try {
      const { html, width, height } = labelHtml();
      await printAsync({ html, width, height });
    } catch (err) {
      Alert.alert('Could not print the label', errorText(err));
    } finally {
      setBusyLabel(false);
    }
  }

  /** Render the label to a PDF file, then open the OS share/save sheet. */
  async function onShareLabel(): Promise<void> {
    if (busyLabel) return;
    let available = false;
    try {
      available = await Sharing.isAvailableAsync();
    } catch {
      available = false;
    }
    if (!available) {
      Alert.alert('Sharing is not available on this device.');
      return;
    }
    setBusyLabel(true);
    try {
      const { html, width, height } = labelHtml();
      const { uri } = await printToFileAsync({ html, width, height });
      if (!uri) throw new Error('The app could not create a PDF of this label.');
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Save or share the barcode label',
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      Alert.alert('Could not save or share the label', errorText(err));
    } finally {
      setBusyLabel(false);
    }
  }

  if (loading && !product) return <CenterLoader label="Loading product…" />;
  if (error && !product) return <ErrorState title="Couldn't load the product" message={errorText(error)} onRetry={reload} />;
  if (!product) return null;

  const moveParams = { productId: product.id, productName: product.name };
  const canMove = product.status === 'ACTIVE';

  return (
    <Screen scroll contentStyle={{}}>
      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>
          <StatusBadge status={product.status} />
        </View>
        {product.description ? (
          <Text style={styles.description}>{product.description}</Text>
        ) : null}
        {product.specifications ? (
          <View style={styles.specificationsBlock}>
            <Text style={styles.specificationsLabel}>Specifications</Text>
            <Text style={styles.description}>{product.specifications}</Text>
          </View>
        ) : null}

        <View style={styles.divider} />
        <Field label="SKU" value={product.sku} mono />
        <Field label="Barcode" value={product.barcode} mono />
        <Field label="Brand" value={product.brand} />
        <Field label="Category" value={product.category?.name} />
        <Field label="Unit" value={product.unit} />
        <Field label="Cost price" value={product.costPrice != null ? formatMoney(product.costPrice) : null} mono />
        <Field label="Selling price" value={product.sellingPrice != null ? formatMoney(product.sellingPrice) : null} mono />
        <Field label="Minimum stock" value={product.minimumStock != null ? formatNumber(product.minimumStock) : null} mono />
        <Field label="Updated" value={formatDateTime(product.updatedAt)} />
      </Card>

      {product.barcode && isEan13(product.barcode) ? (
        <Card style={styles.barcodeCard}>
          <SectionHeader
            title="Barcode label"
            action={product.barcode.startsWith('2') ? <Badge text="Internal" tone="info" /> : null}
          />
          <Ean13Barcode code={product.barcode} />
          <Text style={styles.barcodeHint}>
            EAN-13 preview. Print it or save/share a PDF, then scan the printed code with the scanner to verify it.
          </Text>
          <View style={styles.barcodeActions}>
            <Button title="Print label" variant="secondary" style={styles.flexBtn} loading={busyLabel} onPress={onPrintLabel} />
            <Button title="Share PDF" variant="secondary" style={styles.flexBtn} loading={busyLabel} onPress={onShareLabel} />
          </View>
        </Card>
      ) : null}

      {manage && product.status === 'ACTIVE' && !product.barcode ? (
        <Card style={styles.barcodeCard}>
          <Text style={styles.barcodeTitle}>No barcode yet</Text>
          <Text style={styles.barcodeHint}>
            Generate an internal EAN-13 so this product can be scanned and looked up from the scanner. An existing
            manufacturer barcode is never replaced.
          </Text>
          <Button title="Generate internal barcode" full style={styles.genBtn} loading={busyGen} onPress={onGenerateBarcode} />
        </Card>
      ) : null}

      {manage ? (
        <View style={styles.actions}>
          <Button title="Edit" variant="secondary" style={styles.flexBtn} onPress={() => router.push(`/products/${product.id}/edit`)} />
          <Button
            title={product.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
            variant={product.status === 'ARCHIVED' ? 'secondary' : 'danger'}
            style={styles.flexBtn}
            loading={busyArchive}
            onPress={onToggleArchive}
          />
        </View>
      ) : null}

      <SectionHeader title="Stock" style={styles.section} />
      {stockLoading ? (
        <Card>
          <CenterLoader label="Loading stock…" />
        </Card>
      ) : stock.length === 0 ? (
        <Card>
          <EmptyState title="No stock yet" message="Stock in this product at a location to create a record." />
        </Card>
      ) : (
        <View style={styles.stockList}>
          {stock.map((row) => (
            <StockRow key={row.id} row={row} />
          ))}
        </View>
      )}

      {canMove ? (
        <>
          <SectionHeader title="Move stock" style={styles.section} />
          <View style={styles.actions}>
            <Button title="Stock In" style={styles.flexBtn} onPress={() => router.push({ pathname: '/stock-in', params: moveParams })} />
            <Button title="Stock Out" variant="secondary" style={styles.flexBtn} onPress={() => router.push({ pathname: '/stock-out', params: moveParams })} />
            {canAdjust ? (
              <Button title="Adjust" variant="secondary" style={styles.flexBtn} onPress={() => router.push({ pathname: '/adjust', params: moveParams })} />
            ) : null}
          </View>
        </>
      ) : null}

      {canMove ? null : (
        <Pressable style={styles.archivedNote} onPress={manage ? onToggleArchive : undefined}>
          <Text style={styles.archivedText}>
            {manage
              ? 'This product is archived. Restore it to use it in stock movements.'
              : 'This product is archived and cannot be used in stock movements.'}
          </Text>
        </Pressable>
      )}
    </Screen>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  name: { ...type.h2, color: colors.text, flex: 1 },
  description: { ...type.body, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 22 },
  specificationsBlock: { marginTop: spacing.md },
  specificationsLabel: { ...type.bodySmall, color: colors.textMuted, fontWeight: '700', marginBottom: spacing.xs },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
  barcodeCard: { marginTop: spacing.lg },
  barcodeTitle: { ...type.h3, color: colors.text },
  barcodeHint: { ...type.bodySmall, color: colors.textSecondary, lineHeight: 19, marginTop: spacing.sm },
  barcodeActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  genBtn: { marginTop: spacing.md },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  fieldLabel: { ...type.body, color: colors.textMuted },
  fieldValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1, marginLeft: spacing.lg },
  fieldMono: { fontVariant: ['tabular-nums'] },
  // SectionHeader brings its own bottom margin; sections keep the top gap.
  section: { marginTop: spacing.xxl },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  flexBtn: { flex: 1 },
  stockList: { gap: spacing.sm },
  // Availability is a key quantity: body size with tabular figures.
  stockQty: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  stockBadges: { flexDirection: 'row', gap: 6 },
  archivedNote: {
    marginTop: spacing.xxl,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  archivedText: { ...type.bodySmall, color: colors.warning, textAlign: 'center', fontWeight: '600' },
});
