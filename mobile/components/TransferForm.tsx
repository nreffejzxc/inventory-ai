import { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import Banner from './Banner';
import Button from './Button';
import Input from './Input';
import Screen from './Screen';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { CenterLoader } from './ListState';
import StatCard from './StatCard';
import { inventoryApi, locationsApi, productsApi } from '../lib/api';
import { ApiError } from '../lib/client';
import { endsOperation, newIdempotencyKey } from '../lib/idempotency';
import { useSession } from '../lib/auth';
import { alert } from '../lib/confirm';
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

export interface TransferFormProps {
  initialProductId?: string | null;
  initialProductName?: string | null;
  initialLocationId?: string | null;
  initialLocationName?: string | null;
}

/**
 * Moves one product between two locations of the business (Phase 19).
 *
 * Two locations rather than one, so this is a sibling of MovementForm rather
 * than a `kind` on it. The source row is read first so the form can show what
 * is actually available and warn before the user commits; the server still
 * enforces the availability guard, the same-location rule and the tenant
 * boundary atomically.
 */
export default function TransferForm({
  initialProductId,
  initialProductName,
  initialLocationId,
  initialLocationName,
}: TransferFormProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token } = useSession();

  const products = useActiveRef(token, productsApi);
  const locations = useActiveRef(token, locationsApi);

  const [productId, setProductId] = useState(initialProductId ?? '');
  const [fromLocationId, setFromLocationId] = useState(initialLocationId ?? '');
  const [toLocationId, setToLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One name per operation attempt (see `lib/idempotency.ts`), kept across a retry
  // of the same attempt and dropped when the form describes a different transfer.
  const submitKey = useRef<string | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    // NOT while a request is in flight — see MovementForm: an edit during a slow
    // delivery must not rename an operation that may already have been applied.
    if (!submitting.current) submitKey.current = null;
  }, [productId, fromLocationId, toLocationId, quantity, reason, reference]);

  const { row: source, loading: loadingSource, loaded: loadedSource } = useInventoryRow(
    token,
    productId,
    fromLocationId
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

  const selectedProduct = productOptions.find((o) => o.value === productId);
  const fromLabel = locationOptions.find((o) => o.value === fromLocationId)?.label;
  const toLabel = locationOptions.find((o) => o.value === toLocationId)?.label;

  const availableQty = source ? source.availableQuantity : null;

  // The source needs an existing row — a transfer moves stock, it never creates it.
  let sourceState: 'loading' | 'missing' | 'ready' | null = null; // null = not requested
  if (productId && fromLocationId) {
    sourceState = loadingSource || !loadedSource ? 'loading' : source ? 'ready' : 'missing';
  }

  const sameLocation = Boolean(fromLocationId && toLocationId && fromLocationId === toLocationId);
  const qtyNum = quantity.trim() === '' ? null : Number(quantity);
  const qtyOk = qtyNum != null && qtyNum >= 1 && Number.isInteger(qtyNum);

  const warnOver =
    sourceState === 'ready' && qtyOk && availableQty != null && qtyNum > availableQty;

  const canSubmit = Boolean(
    productId &&
      fromLocationId &&
      toLocationId &&
      qtyOk &&
      !sameLocation &&
      !warnOver &&
      !busy &&
      sourceState !== 'missing'
  );

  async function submit(): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const idempotencyKey = (submitKey.current ??= newIdempotencyKey());
    try {
      const res = await inventoryApi.transfer(token as string, {
        productId,
        fromLocationId,
        toLocationId,
        // `qtyNum` is non-null for any submittable form (qtyOk gates the button).
        quantity: qtyNum as number,
        reason: reason.trim() || undefined,
        reference: reference.trim() || undefined,
      }, idempotencyKey);
      const from = fromLabel ?? 'source';
      const to = toLabel ?? 'destination';
      await alert(
        'Transfer Stock',
        `Done. ${selectedProduct?.label ?? 'Product'} moved from ${from} to ${to}.\n` +
          `${from}: ${formatNumber(res.previousQuantity)} → ${formatNumber(res.newQuantity)}\n` +
          `${to}: ${formatNumber(res.destinationPreviousQuantity)} → ${formatNumber(res.destinationNewQuantity)}`
      );
      router.back();
    } catch (err) {
      // Only an answer that ENDS the operation mints a new key; a transport failure
      // and a still-in-flight claim both keep it. See `lib/idempotency.ts`.
      if (endsOperation(err)) submitKey.current = null;
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else setFormError((err as { message?: string } | null)?.message || 'The transfer could not be completed.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (products.loading && products.items.length === 0) {
    return <CenterLoader label="Loading products…" />;
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} />

      {sourceState === 'loading' ? <Banner type="info" text="Checking stock at the source location…" /> : null}
      {sourceState === 'missing' ? (
        <Banner type="warn" text="No stock record for this product at the source location — use Stock In to create one." />
      ) : null}
      {warnOver ? (
        <Banner
          type="warn"
          text={`Only ${formatNumber(availableQty)} available to move — the server will not let stock go below zero.`}
        />
      ) : null}
      {sameLocation ? (
        <Banner type="warn" text="Choose two different locations — a transfer moves stock somewhere else." />
      ) : null}

      <SelectField
        label="Product"
        placeholder="Choose a product…"
        options={productOptions}
        value={productId}
        onChange={setProductId}
        error={fieldErrors.productId}
        required
        searchable
      />
      <SelectField
        label="From location"
        placeholder="Choose the source…"
        options={locationOptions}
        value={fromLocationId}
        onChange={setFromLocationId}
        error={fieldErrors.fromLocationId}
        required
        searchable
      />
      {sourceState === 'ready' && availableQty != null ? (
        <StatCard label="Available to transfer" value={formatNumber(availableQty)} style={styles.avail} />
      ) : null}
      <SelectField
        label="To location"
        placeholder="Choose the destination…"
        options={locationOptions}
        value={toLocationId}
        onChange={setToLocationId}
        error={fieldErrors.toLocationId}
        required
        searchable
      />

      <Input
        name="quantity"
        label="Quantity"
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="number-pad"
        placeholder="How many are you moving?"
        error={fieldErrors.quantity}
        helper="Must be a whole number of 1 or more."
        required
      />
      <Input name="reason" label="Reason (optional)" value={reason} onChangeText={setReason} placeholder="e.g. rebalancing, stock count" maxLength={500} />
      <Input name="reference" label="Reference (optional)" value={reference} onChangeText={setReference} placeholder="e.g. TRF-1234" maxLength={200} autoCapitalize="none" />

      <Button title="Transfer stock" onPress={submit} loading={busy} disabled={!canSubmit} full />
      <Text style={styles.hint}>
        Both locations are updated together and recorded in inventory history.
      </Text>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { paddingBottom: spacing.huge },
    avail: { marginBottom: spacing.lg },
    // No pinned lineHeight: the type token's proportional height is what keeps
    // this line from clipping once the system font scale grows.
    hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
  });
