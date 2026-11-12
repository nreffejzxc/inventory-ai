import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult, BarcodeType } from 'expo-camera';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Badge, { StatusBadge } from '../../components/Badge';
import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import { Icon } from '../../components/icons';
import ListRow from '../../components/ListRow';
import { CenterLoader, LoadingBlock, errorText } from '../../components/ListState';
import Screen from '../../components/Screen';
import SectionHeader from '../../components/SectionHeader';
import { inventoryApi, productsApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { isSessionError, useSession } from '../../lib/auth';
import { ApiError } from '../../lib/client';
import { formatMoney, formatNumber } from '../../lib/format';
import useRefetchOnFocus from '../../hooks/useRefetchOnFocus';
import { radius, spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/**
 * Camera barcode scanner (Phase 12B + 12C). Detects common retail barcodes, then
 * resolves the code through the authenticated business-scoped endpoint
 * GET /api/products/barcode (Phase 12A) and shows the matched product with its
 * per-location stock. For ACTIVE products it offers Stock In / Stock Out, which
 * push the existing movement screens with the scanned product pre-selected and
 * locked (Phase 12C). Stock is never mutated here — every movement goes through
 * the existing movement forms and inventory API.
 *
 * Screens inside a native stack stay mounted under a push, and only one camera
 * preview may be active at a time, so the CameraView is rendered ONLY while
 * actively scanning and is unmounted for every non-scanning state (resolving,
 * result, not-found, error, permission).
 */

/** Retail 1D symbologies this scanner enables (EAN/UPC/Code 39,93,128/ITF). */
const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code39', 'code93', 'code128', 'itf14', 'codabar'];

const TYPE_LABELS: Record<string, string> = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code39: 'Code 39',
  code93: 'Code 93',
  code128: 'Code 128',
  itf14: 'ITF-14',
  codabar: 'Codabar',
};

/** How long an identical re-scan is ignored after "Scan again" (item still in frame). */
const RESCAN_IGNORE_MS = 1500;

function Field({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '' || value === false) return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldMono]}>{value}</Text>
    </View>
  );
}

export default function ScanScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut } = useSession();
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  // Which surface is showing. Camera is mounted only while === 'scanning'.
  const [view, setView] = useState('scanning'); // scanning | looking | found | notFound | error
  const [product, setProduct] = useState<ApiResponse>(null);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [last, setLast] = useState<{ code: string; type: string } | null>(null); // { code, type } from the most recent capture

  // Synchronous latch so a burst of onBarcodeScanned callbacks from one frame
  // can only trigger one lookup, plus a cooldown so an identical code isn't
  // instantly re-captured right after "Scan again".
  const captureLocked = useRef(false);
  const lastScanned = useRef<{ code: string; at: number } | null>(null); // { code, at }

  const codeLabel = (type: string): string => TYPE_LABELS[type] ?? (type ? type.toUpperCase() : '');

  // Re-read permission when the screen regains focus so returning from the OS
  // Settings screen reflects the user's choice.
  useFocusEffect(
    useCallback(() => {
      if (getPermission && !permission?.granted) getPermission();
    }, [getPermission, permission?.granted])
  );

  async function lookup(code: string): Promise<void> {
    if (!token) {
      setView('error');
      setLookupError(new ApiError(401, 'AUTH_REQUIRED', 'Your session ended. Sign in again.'));
      return;
    }
    setProduct(null);
    setLookupError(null);
    setView('looking');
    try {
      const found = await productsApi.barcode(token, code);
      setProduct(found);
      setView('found');
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setView('notFound');
      } else {
        setLookupError(err);
        setView('error');
      }
    }
  }

  const onScanned = useCallback(
    ({ data, type }: BarcodeScanningResult): void => {
      const code = typeof data === 'string' ? data.trim() : '';
      if (!code || captureLocked.current) return;
      // Ignore a repeat of the immediately-previous code until the cooldown
      // elapses, so re-arming the scanner does not instantly re-fire on an item
      // that is still inside the frame.
      const now = Date.now();
      if (lastScanned.current?.code === code && now - lastScanned.current.at < RESCAN_IGNORE_MS) return;
      captureLocked.current = true;
      lastScanned.current = { code, at: now };
      setLast({ code, type });
      lookup(code);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  function rescan(): void {
    captureLocked.current = false;
    setProduct(null);
    setLookupError(null);
    setView('scanning');
  }

  // --- Camera permission ---------------------------------------------------
  if (!permission) {
    return (
      <Screen>
        <CenterLoader label="Preparing camera…" />
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen contentStyle={styles.centerCard}>
        <Icon name="camera" color={colors.primary} size={40} style={styles.bigIcon} />
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.message}>
          Inventory AI uses the camera to scan product barcodes. Your photos are never stored or uploaded — only the
          decoded barcode number is looked up.
        </Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera access" full onPress={requestPermission} style={styles.button} />
        ) : (
          <>
            <Banner
              type="warn"
              text="Camera access is turned off for this app in your device settings."
              style={styles.button}
            />
            <Button title="Open Settings" full variant="secondary" onPress={() => Linking.openSettings()} style={styles.button} />
          </>
        )}
      </Screen>
    );
  }

  // --- Actively scanning ----------------------------------------------------
  if (view === 'scanning') {
    return (
      <View style={styles.cameraShell}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={onScanned}
        />
        <View style={styles.reticle} pointerEvents="none">
          <View style={styles.scanFrame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
        </View>
        <SafeAreaView style={styles.bottomHintWrap} edges={['bottom']} pointerEvents="box-none">
          <View style={styles.bottomHint}>
            <Text style={styles.hintTitle}>Scan a product barcode</Text>
            <Text style={styles.hintText}>Point the camera at the code on the product or its label and hold steady.</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // --- Resolving / result states (camera unmounted) -------------------------
  return (
    <Screen scroll contentStyle={styles.resultContent}>
      {view === 'looking' ? (
        <View style={styles.looking}>
          <LoadingBlock label="Looking up barcode…" />
          {last ? (
            <Text style={styles.codeChip}>
              {codeLabel(last.type)} · {last.code}
            </Text>
          ) : null}
          <Button title="Cancel" variant="secondary" onPress={rescan} style={styles.button} />
        </View>
      ) : view === 'found' && product ? (
        <FoundProduct product={product} onRescan={rescan} />
      ) : view === 'notFound' ? (
        <View>
          <Icon name="search" color={colors.textMuted} size={40} style={styles.bigIcon} />
          <Text style={styles.title}>Product not found</Text>
          {last ? (
            <Text style={styles.message}>
              No product in this business matches barcode {codeLabel(last.type)} · {last.code}.
            </Text>
          ) : (
            <Text style={styles.message}>No product in this business matches the scanned barcode.</Text>
          )}
          <Text style={styles.message}>The barcode may not be registered yet, or it belongs to another business.</Text>
          <Button title="Scan again" full onPress={rescan} style={styles.button} />
        </View>
      ) : (
        <View>
          <Icon name="warning" color={colors.warning} size={40} style={styles.bigIcon} />
          <Text style={styles.title}>Couldn&apos;t look up the barcode</Text>
          <Banner type="error" text={errorText(lookupError)} style={styles.button} />
          <Button title="Try again" full onPress={() => last && lookup(last.code)} style={styles.button} />
          <Button title="Scan again" full variant="secondary" onPress={rescan} style={styles.button} />
        </View>
      )}
    </Screen>
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
          // Availability is a key quantity: body size, never the smaller subtitle size.
          <Text style={styles.stockQty}>
            {formatNumber(row.availableQuantity)} available · {formatNumber(row.quantity)} on hand
          </Text>
        }
        right={
          row.isLowStock || row.isOutOfStock ? (
            <View style={styles.stockBadges}>
              {row.isOutOfStock ? (
                <Badge text="Out" tone="danger" />
              ) : row.isLowStock ? (
                <Badge text="Low" tone="low" />
              ) : null}
            </View>
          ) : null
        }
      />
    </Card>
  );
}

function FoundProduct({ product, onRescan }: { product: ApiResponse; onRescan: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const archived = product.status === 'ARCHIVED';
  const { token } = useSession();

  // Per-location availability for this product. Read through the normal
  // inventory endpoint (INVENTORY_VIEW, business-scoped); reloaded on focus so
  // quantity shown here is fresh after a stock movement pushed from this card.
  const [stock, setStock] = useState<ApiResponse[]>([]);
  const [stockLoading, setStockLoading] = useState(true);

  const loadStock = useCallback(async (): Promise<void> => {
    if (!token) return;
    setStockLoading(true);
    try {
      const res = await inventoryApi.list(token, { productId: product.id, page: 1, limit: 100 });
      setStock(res?.items ?? []);
    } catch {
      // Supporting context — keep failures non-blocking, like product detail.
    } finally {
      setStockLoading(false);
    }
  }, [token, product.id]);

  useEffect(() => {
    // `loadStock` sets stockLoading synchronously before its first await on
    // purpose: stock is also reloaded on focus after a movement pushed from this
    // card, so the spinner must be able to be true while `stock` is already
    // populated; deriving it from `stock` would also turn the real "No stock yet"
    // card into a spinner.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStock();
  }, [loadStock]);
  useRefetchOnFocus(loadStock);

  function openMovement(route: string): void {
    router.push({
      pathname: route,
      params: {
        productId: product.id,
        productName: product.name,
        sku: product.sku || '',
        barcode: product.barcode || '',
        lock: '1',
      },
    });
  }

  return (
    <View>
      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.productName} numberOfLines={2}>
            {product.name}
          </Text>
          <StatusBadge status={product.status} />
        </View>
        {product.description ? <Text style={styles.description}>{product.description}</Text> : null}

        <View style={styles.divider} />
        <Field label="Barcode" value={product.barcode} mono />
        <Field label="SKU" value={product.sku} mono />
        <Field label="Category" value={product.category?.name} />
        <Field label="Unit" value={product.unit} />
        <Field label="Cost price" value={product.costPrice != null ? formatMoney(product.costPrice) : null} mono />
        <Field label="Selling price" value={product.sellingPrice != null ? formatMoney(product.sellingPrice) : null} mono />
        <Field label="Minimum stock" value={product.minimumStock != null ? formatNumber(product.minimumStock) : null} mono />
      </Card>

      <SectionHeader title="Stock at locations" style={styles.section} />
      {stockLoading ? (
        <Card>
          <View style={styles.stockEmpty}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </Card>
      ) : stock.length === 0 ? (
        <Card>
          <Text style={styles.stockEmptyText}>No stock yet — use Stock In to create a record at a location.</Text>
        </Card>
      ) : (
        <View style={styles.stockList}>
          {stock.map((row) => (
            <StockRow key={row.id} row={row} />
          ))}
        </View>
      )}

      {archived ? (
        <View style={styles.archivedNote}>
          <Text style={styles.archivedText}>
            This product is archived and cannot be used in stock movements. Restore it from the product screen first if
            you need it again.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.moveRow}>
            <Button title="Stock In" style={styles.flexBtn} onPress={() => openMovement('/stock-in')} />
            <Button title="Stock Out" variant="secondary" style={styles.flexBtn} onPress={() => openMovement('/stock-out')} />
          </View>
          <Button title="Scan another barcode" variant="secondary" full style={styles.button} onPress={onRescan} />
          <Button title="Open product" variant="ghost" full style={styles.button} onPress={() => router.push(`/products/${product.id}`)} />
        </>
      )}

      {archived ? <Button title="Scan another barcode" full style={styles.button} onPress={onRescan} /> : null}
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  // Camera scanning. The viewport behind the live camera preview stays black in
  // both themes (colors.text would flash near-white in dark mode); the reticle
  // and hint text below sit ON the camera feed, so their colors are deliberately
  // fixed literals rather than theme tokens.
  cameraShell: { flex: 1, backgroundColor: '#000', justifyContent: 'flex-end' },
  // NOTE (MOD-02): the original source spread `StyleSheet.absoluteFillObject`
  // here. React Native 0.86 no longer exports that name — it is absent from both
  // the runtime module and its typings — so the spread was already a silent
  // no-op ({...undefined} adds nothing) and this reticle is NOT absolutely
  // positioned in the shipped app. The spread is dropped rather than replaced
  // with the four properties, because writing them would move the reticle from
  // the bottom of the screen to its centre — a visible change, and this phase
  // migrates without changing behavior. Reported as an open finding.
  reticle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: { width: 250, height: 160 },
  corner: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderColor: '#FFFFFF',
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: radius.md },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: radius.md },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: radius.md },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: radius.md },
  bottomHintWrap: { padding: spacing.lg },
  bottomHint: {
    backgroundColor: colors.overlay,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  hintTitle: { color: '#FFF', ...type.label, marginBottom: 4 },
  hintText: { color: 'rgba(255,255,255,0.85)', ...type.bodySmall },

  // Permission / status / result layouts
  centerCard: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  resultContent: { paddingBottom: spacing.huge, flexGrow: 1 },
  looking: { alignItems: 'center', paddingTop: spacing.xxl },
  title: { ...type.h2, color: colors.text, textAlign: 'center', marginBottom: spacing.xs },
  message: { ...type.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs },
  bigIcon: { marginBottom: spacing.md },
  button: { marginTop: spacing.lg },
  codeChip: { ...type.caption, color: colors.textMuted, marginTop: spacing.md },

  // Found product card
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  productName: { ...type.h2, color: colors.text, flex: 1 },
  description: { ...type.body, color: colors.textSecondary, marginTop: spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs + 2 },
  fieldLabel: { ...type.body, color: colors.textMuted, flexShrink: 0 },
  fieldValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1, marginLeft: spacing.lg, textAlign: 'right' },
  fieldMono: { fontVariant: ['tabular-nums'] },
  archivedNote: {
    marginTop: spacing.lg,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  archivedText: { ...type.bodySmall, color: colors.warning, fontWeight: '600' },

  // Stock availability + movement actions
  section: { marginTop: spacing.xxl },
  stockList: { gap: spacing.md },
  // Availability is a key quantity: body size with tabular figures.
  stockQty: { ...type.body, color: colors.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'] },
  stockBadges: { flexDirection: 'row', gap: 6 },
  stockEmpty: { alignItems: 'center', paddingVertical: spacing.sm },
  stockEmptyText: { ...type.bodySmall, color: colors.textMuted },
  moveRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  flexBtn: { flex: 1 },
});
