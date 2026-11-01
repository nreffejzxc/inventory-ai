import { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import Banner from './Banner';
import Button from './Button';
import Card from './Card';
import Input from './Input';
import Screen from './Screen';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { CenterLoader } from './ListState';
import StatCard from './StatCard';
import { inventoryApi, locationsApi, productsApi } from '../lib/api';
import type { ApiResponse, MovementInput } from '../lib/api';
import { ApiError } from '../lib/client';
import { endsOperation, newIdempotencyKey } from '../lib/idempotency';
import { useSession } from '../lib/auth';
import { alert, confirm } from '../lib/confirm';
import { formatNumber } from '../lib/format';
import { useActiveRef } from '../hooks/useReferences';
import useInventoryRow from '../hooks/useInventoryRow';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

/** Per-`kind` copy and gating rules. */
interface MovementConfig {
  quantityLabel: string;
  placeholder: string;
  submit: string;
  allowZero: boolean;
  showAvailable: boolean;
  availLabel: string | null;
  title: string;
}

const CONFIG: Record<string, MovementConfig> = {
  'stock-in': {
    quantityLabel: 'Quantity',
    placeholder: 'How many are you adding?',
    submit: 'Add stock',
    allowZero: false,
    showAvailable: false,
    availLabel: null,
    title: 'Stock In',
  },
  'stock-out': {
    quantityLabel: 'Quantity',
    placeholder: 'How many are you removing?',
    submit: 'Remove stock',
    allowZero: false,
    showAvailable: true,
    availLabel: 'Available now',
    title: 'Stock Out',
  },
  adjust: {
    quantityLabel: 'New on-hand quantity (target)',
    placeholder: 'Set the quantity to this value',
    submit: 'Set quantity',
    allowZero: true,
    showAvailable: true,
    availLabel: 'Current on hand',
    title: 'Adjust Stock',
  },
};

export interface MovementFormProps {
  /** 'stock-in' | 'stock-out' | 'adjust' — anything else falls back to stock-in. */
  kind: string;
  initialProductId?: string | null;
  initialProductName?: string | null;
  initialProductSku?: string | null;
  initialProductBarcode?: string | null;
  lockProduct?: boolean;
  initialLocationId?: string | null;
  initialLocationName?: string | null;
}

export default function MovementForm({
  kind,
  initialProductId,
  initialProductName,
  initialProductSku,
  initialProductBarcode,
  lockProduct = false,
  initialLocationId,
  initialLocationName,
}: MovementFormProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const cfg = CONFIG[kind] ?? CONFIG['stock-in'];
  const { token } = useSession();

  // When a workflow has already identified the product (e.g. a barcode scan),
  // the product is fixed and its identity is shown read-only so the user can
  // confirm they are moving the right product before submitting.
  const lockedProduct = lockProduct && Boolean(initialProductId);

  const products = useActiveRef(token, productsApi);
  const locations = useActiveRef(token, locationsApi);

  const [productId, setProductId] = useState(initialProductId ?? '');
  const [locationId, setLocationId] = useState(initialLocationId ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The operation's name on the wire (see `lib/idempotency.ts`). It survives a
  // failed delivery — a timeout is not an answer, so the retry must be the SAME
  // operation — and is dropped as soon as the form describes a different one.
  const submitKey = useRef<string | null>(null);
  // A second press that lands before React has committed `busy` would otherwise
  // start a second request. `busy` is the UI's signal; this is the guard.
  const submitting = useRef(false);
  useEffect(() => {
    // NOT while a request is in flight: an edit made during a slow delivery would
    // drop the name of an operation that may already have been applied, and the
    // retry would then be a second, unguarded movement.
    if (!submitting.current) submitKey.current = null;
  }, [productId, locationId, quantity, reason, reference]);

  const { row: current, loading: loadingCurrent, loaded: loadedCurrent } = useInventoryRow(
    token,
    cfg.showAvailable ? productId : null,
    cfg.showAvailable ? locationId : null
  );

  const productOptions = useMemo(() => {
    const list: SelectOption[] = products.items.map((p) => ({ value: p.id, label: p.name }));
    if (initialProductId && initialProductName && !list.some((o) => o.value === initialProductId)) {
      list.unshift({ value: initialProductId, label: initialProductName });
    }
    return list;
  }, [products.items, initialProductId, initialProductName]);

  const locationOptions = useMemo(() => {
    const list: SelectOption[] = locations.items.map((l) => ({ value: l.id, label: l.name }));
    if (initialLocationId && initialLocationName && !list.some((o) => o.value === initialLocationId)) {
      list.unshift({ value: initialLocationId, label: initialLocationName });
    }
    return list;
  }, [locations.items, initialLocationId, initialLocationName]);

  // A business with one location was still asked to pick it on every movement.
  // Preselect it once the list has loaded; a location the caller supplied (a
  // scanned row, a deep link) always wins, and a later edit is never overwritten.
  const autoLocationDone = useRef(false);
  useEffect(() => {
    if (autoLocationDone.current) return;
    if (locationId) {
      autoLocationDone.current = true;
      return;
    }
    if (!locations.loading && locations.items.length === 1) {
      autoLocationDone.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time default after the reference list loads; there is no render-time value to derive it from.
      setLocationId(locations.items[0].id);
    }
  }, [locationId, locations.loading, locations.items]);

  // The route's params are not guaranteed on the first render: a cold deep link
  // can resolve them afterwards, and a reused screen can be handed a different
  // location. Seeding the state once left the field reading "Choose a location…"
  // while the movement still named one, so the member could not see where the
  // stock would land. Adopt a param that arrives or changes — unless the member
  // has chosen a location on this screen, which is never overwritten.
  const locationTouched = useRef(false);
  const suppliedLocation = useRef(initialLocationId ?? '');
  useEffect(() => {
    const next = initialLocationId ?? '';
    if (next === suppliedLocation.current) return;
    suppliedLocation.current = next;
    if (!next || locationTouched.current) return;
    setLocationId(next);
  }, [initialLocationId]);

  function chooseLocation(id: string): void {
    locationTouched.current = true;
    setLocationId(id);
  }

  // The product param has the same cold-link timing as the location. A link can
  // resolve its product after the first render, and a reused screen can be handed
  // a different one. Adopt a product that arrives or changes — unless the member
  // has chosen a product on this screen, which is never overwritten.
  const productTouched = useRef(false);
  const suppliedProduct = useRef(initialProductId ?? '');
  useEffect(() => {
    const next = initialProductId ?? '';
    if (next === suppliedProduct.current) return;
    suppliedProduct.current = next;
    if (!next || productTouched.current) return;
    setProductId(next);
  }, [initialProductId]);

  function chooseProduct(id: string): void {
    productTouched.current = true;
    setProductId(id);
  }

  const selectedProduct = productOptions.find((o) => o.value === productId);
  const selectedLocation = locationOptions.find((o) => o.value === locationId);

  const onHandQty = current ? current.quantity : null;
  const availableQty = current ? current.availableQuantity : null;

  // Stock-out/adjust need an existing row (only stock-in creates one).
  let availState: 'loading' | 'missing' | 'ready' | null = null; // null = not requested
  if (cfg.showAvailable && productId && locationId) {
    availState = loadingCurrent ? 'loading' : !loadedCurrent ? 'loading' : current ? 'ready' : 'missing';
  }

  const qtyNum = quantity.trim() === '' ? null : Number(quantity);
  const qtyOk = cfg.allowZero ? qtyNum != null && qtyNum >= 0 && Number.isInteger(qtyNum) : qtyNum != null && qtyNum >= 1 && Number.isInteger(qtyNum);
  // An adjustment is the only movement with no external document behind it, so
  // the server requires the reason; the button must not let a member discover
  // that only after the target has been typed.
  const reasonRequired = kind === 'adjust';
  const reasonOk = !reasonRequired || reason.trim().length > 0;

  // `qtyNum != null` is implied by `qtyOk` (which is a ternary, so TS cannot
  // alias-narrow through it); it is stated explicitly for that reason only and
  // cannot change the outcome.
  const warnOver =
    kind === 'stock-out' && availState === 'ready' && qtyOk && availableQty != null && qtyNum != null && qtyNum > availableQty;
  const warnNoChange = kind === 'adjust' && availState === 'ready' && qtyOk && onHandQty != null && qtyNum === onHandQty;
  const canSubmit = Boolean(
    productId &&
      locationId &&
      qtyOk &&
      reasonOk &&
      !busy &&
      !warnOver &&
      !warnNoChange &&
      availState !== 'missing' &&
      // The adjustment confirmation states the CURRENT quantity, so it must not
      // be offered while that quantity is still unknown.
      (kind !== 'adjust' || availState === 'ready')
  );

  const shownValue = kind === 'adjust' ? onHandQty : availableQty;

  async function submit(): Promise<void> {
    if (submitting.current) return;
    if (reasonRequired && !reason.trim()) {
      setFieldErrors({ reason: 'A reason is required for an adjustment.' });
      return;
    }
    submitting.current = true;

    // An adjustment overwrites the recorded quantity rather than adding to it,
    // so show the member the exact before/after they are about to commit. The
    // press is not a send: cancelling here leaves the operation unstarted and
    // mints no key.
    if (kind === 'adjust') {
      const product = selectedProduct?.label ?? 'this product';
      const at = selectedLocation?.label ?? 'this location';
      const from = onHandQty != null ? formatNumber(onHandQty) : 'no stock';
      const to = qtyNum != null ? formatNumber(qtyNum) : '?';
      const delta = onHandQty != null && qtyNum != null ? qtyNum - onHandQty : null;
      const change = delta != null ? ` (${delta > 0 ? '+' : ''}${formatNumber(delta)})` : '';
      const ok = await confirm(
        'Adjust stock?',
        `Set ${product} at ${at} from ${from} to ${to}${change}.\nReason: ${reason.trim()}`,
        { confirmText: 'Adjust', destructive: true }
      );
      if (!ok) {
        submitting.current = false;
        return;
      }
    }

    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const idempotencyKey = (submitKey.current ??= newIdempotencyKey());
    const payload: MovementInput = {
      productId,
      locationId,
      // `qtyNum` is non-null for any submittable form (qtyOk gates the button).
      quantity: qtyNum as number,
      reason: reason.trim() || undefined,
      reference: reference.trim() || undefined,
    };
    const actions: Record<string, () => Promise<ApiResponse>> = {
      'stock-in': () => inventoryApi.stockIn(token as string, payload, idempotencyKey),
      'stock-out': () => inventoryApi.stockOut(token as string, payload, idempotencyKey),
      adjust: () => inventoryApi.adjust(token as string, payload, idempotencyKey),
    };
    const perform = actions[kind];
    try {
      const res = await perform();
      const { previousQuantity, newQuantity } = res;
      const at = `${selectedProduct?.label ?? 'product'} at ${selectedLocation?.label ?? 'location'}`;
      await alert(cfg.title, `Done. ${at}: ${formatNumber(previousQuantity)} → ${formatNumber(newQuantity)}`);
      router.back();
    } catch (err) {
      // Only an answer that ENDS the operation mints a new key; a transport failure
      // and a still-in-flight claim both keep it. See `lib/idempotency.ts`.
      if (endsOperation(err)) submitKey.current = null;
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else setFormError((err as { message?: string } | null)?.message || 'The movement could not be completed.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  // A locked (scanned) product doesn't need the product picker's list, so don't
  // block the form on loading products that won't be shown.
  if (!lockedProduct && products.loading && products.items.length === 0) {
    return <CenterLoader label="Loading products…" />;
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} />

      {availState === 'loading' ? <Banner type="info" text="Checking current stock…" /> : null}
      {availState === 'missing' ? (
        <Banner type="warn" text="No stock record for this product at this location yet — use Stock In to create one." />
      ) : null}
      {warnOver ? (
        <Banner type="warn" text={`Only ${formatNumber(availableQty)} available — the server will not let stock go below zero.`} />
      ) : null}
      {warnNoChange ? (
        <Banner type="warn" text="This product is already at that quantity — no adjustment is needed." />
      ) : null}

      {lockedProduct ? (
        <Card style={styles.lockedCard}>
          <Text style={styles.lockedHeading}>Product</Text>
          <Text style={styles.lockedName}>{initialProductName ?? 'Scanned product'}</Text>
          {initialProductSku ? <Text style={styles.lockedMeta}>SKU · {initialProductSku}</Text> : null}
          {initialProductBarcode ? <Text style={styles.lockedMeta}>Barcode · {initialProductBarcode}</Text> : null}
        </Card>
      ) : (
        <SelectField
          label="Product"
          placeholder="Choose a product…"
          options={productOptions}
          value={productId}
          onChange={chooseProduct}
          error={fieldErrors.productId}
          required
          searchable
        />
      )}
      <SelectField
        label="Location"
        placeholder="Choose a location…"
        options={locationOptions}
        value={locationId}
        onChange={chooseLocation}
        error={fieldErrors.locationId}
        required
        searchable
      />

      {availState === 'ready' && shownValue != null ? (
        <StatCard label={cfg.availLabel} value={formatNumber(shownValue)} style={styles.avail} />
      ) : null}

      <Input
        name="quantity"
        label={cfg.quantityLabel}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="number-pad"
        placeholder={cfg.placeholder}
        error={fieldErrors.quantity}
        helper={kind === 'adjust' ? 'You can set stock to 0.' : 'Must be a whole number of 1 or more.'}
        required
      />
      <Input
        name="reason"
        label={reasonRequired ? 'Reason' : 'Reason (optional)'}
        value={reason}
        onChangeText={setReason}
        placeholder="e.g. supplier delivery, damaged, recount"
        maxLength={500}
        error={fieldErrors.reason}
        helper={reasonRequired ? 'Recorded with the adjustment — say why the count is changing.' : undefined}
        required={reasonRequired}
      />
      <Input name="reference" label="Reference (optional)" value={reference} onChangeText={setReference} placeholder="e.g. PO-1234, invoice #" maxLength={200} autoCapitalize="none" />

      <Button
        title={cfg.submit}
        onPress={submit}
        loading={busy}
        disabled={!canSubmit}
        variant={kind === 'stock-out' ? 'secondary' : 'primary'}
        full
      />
      <Text style={styles.hint}>Changes are applied atomically on the server and recorded in inventory history.</Text>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
  content: { paddingBottom: spacing.huge },
  avail: { marginBottom: spacing.lg },
  lockedCard: { marginBottom: spacing.lg },
  lockedHeading: { ...type.label, color: colors.textMuted, marginBottom: spacing.xs },
  lockedName: { ...type.body, fontWeight: '700', color: colors.text, marginBottom: 2 },
  lockedMeta: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  // No pinned lineHeight: the type token's proportional height is what keeps
  // this line from clipping once the system font scale grows.
  hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
});
