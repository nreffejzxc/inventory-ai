import { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from './Banner';
import Button from './Button';
import Card from './Card';
import Input from './Input';
import Screen from './Screen';
import SectionHeader from './SectionHeader';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { CenterLoader } from './ListState';
import { locationsApi, productsApi, purchaseOrdersApi, suppliersApi } from '../lib/api';
import type { ApiResponse, PurchaseOrderInput, PurchaseOrderLineInput } from '../lib/api';
import { ApiError } from '../lib/client';
import { endsOperation, newIdempotencyKey } from '../lib/idempotency';
import { useSession } from '../lib/auth';
import { alert } from '../lib/confirm';
import { useActiveRef } from '../hooks/useReferences';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

const PO_ITEMS_MAX = 200;
const PO_NOTES_MAX = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Friendly messages for the EXACT backend error codes (server
 * src/services/purchase-orders.service.js + inventory.service.js asserts).
 * The codes are the contract — never invented, renamed, or added here.
 */
const CODE_MESSAGES: Record<string, string> = {
  PO_NOT_FOUND: 'This purchase order no longer exists.',
  PO_NUMBER_CONFLICT: 'Could not allocate a unique order number. Please try again.',
  PO_NOT_DRAFT: 'Only a draft purchase order can be edited.',
  PO_STATE_CONFLICT: 'This order changed on the server. Refresh and try again.',
  PO_CANCELED: 'A canceled purchase order cannot be issued.',
  PO_ALREADY_RECEIVED: 'This purchase order has already been received.',
  PO_ALREADY_OPEN: 'This purchase order is already open.',
  PO_ALREADY_CANCELED: 'This purchase order is already canceled.',
  SUPPLIER_NOT_FOUND: 'The selected supplier no longer exists.',
  SUPPLIER_ARCHIVED: 'This supplier is archived and cannot be used on a purchase order.',
  PRODUCT_NOT_FOUND: 'A product on this order no longer exists.',
  PRODUCT_ARCHIVED: 'An archived product cannot be used on a purchase order.',
  LOCATION_NOT_FOUND: 'The receiving location no longer exists.',
  LOCATION_ARCHIVED: 'An archived location cannot receive a purchase order.',
  VALIDATION_ERROR: 'Check the order and try again.',
  NETWORK_TIMEOUT: 'The request timed out. Check your connection and try again.',
  NETWORK_ERROR: 'Cannot reach the server. Check your connection and try again.',
};

/** Resolve any backend error onto a user-friendly message (used by PO screens). */
export function poErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null | undefined)?.code;
  const message = (err as { message?: string } | null | undefined)?.message;
  return (code ? CODE_MESSAGES[code] : undefined) ?? message ?? 'The order could not be updated.';
}

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

/** Server-side optionalDate accepts any parseable date; YYYY-MM-DD is verified. */
function isGoodDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  return !Number.isNaN(new Date(s).getTime());
}

/** Server ISO date (stored from a YYYY-MM-DD input) back to YYYY-MM-DD, UTC parts so no day shift. */
function toDateInput(value: unknown): string {
  if (!value) return '';
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** '' -> null; a whole number -> that number; anything else -> NaN. */
function intValue(s: unknown): number | null {
  const t = (typeof s === 'string' ? s : '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : NaN;
}

/** '' -> null; a finite number -> that number; anything else -> NaN. */
function numValue(s: unknown): number | null {
  const t = (typeof s === 'string' ? s : '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** One editable line of the order. */
interface PoLine {
  key: string;
  productId: string;
  productName: string;
  sku: string;
  quantityOrdered: string;
  unitCost: string;
}

/** One client-side validation problem, keyed by the server's own field path. */
interface PoProblem {
  field: string;
  message: string;
}

let lineKeySeq = 0;
const nextKey = (): string => {
  lineKeySeq += 1;
  return `po-line-${lineKeySeq}`;
};

export interface PoFormProps {
  initial?: ApiResponse;
}

/**
 * Shared create/edit form for purchase orders (Phase 17). Create posts a new
 * DRAFT; edit (initial = the fresh detail DTO) PATCHes that DRAFT — only
 * DRAFTs are editable, so the caller guards status before rendering this.
 * Server-side validation is authoritative; this mirrors the same rules for a
 * good UX (required supplier/location, >=1 line, whole quantities >= 1, no
 * duplicate products, unit cost >= 0, YYYY-MM-DD date).
 */
export default function PoForm({ initial }: PoFormProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token } = useSession();
  const isEdit = Boolean(initial);

  // Active reference lists for the pickers (products/locations/suppliers).
  const suppliers = useActiveRef(token, suppliersApi);
  const locations = useActiveRef(token, locationsApi);
  const products = useActiveRef(token, productsApi);

  const [supplierId, setSupplierId] = useState<string>(initial?.supplier?.id ?? '');
  const [locationId, setLocationId] = useState<string>(initial?.location?.id ?? '');
  const [expectedAt, setExpectedAt] = useState<string>(initial?.expectedAt ? toDateInput(initial.expectedAt) : '');
  const [notes, setNotes] = useState<string>(initial?.notes ?? '');
  const [lines, setLines] = useState<PoLine[]>(() => {
    const items: ApiResponse[] = initial?.items ?? [];
    return items.map((i) => ({
      key: nextKey(),
      productId: i.productId,
      productName: i.productName ?? '',
      sku: i.sku ?? '',
      quantityOrdered: i.quantityOrdered != null ? String(i.quantityOrdered) : '',
      unitCost: i.unitCost != null ? String(i.unitCost) : '',
    }));
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // CREATE mints one key per attempt (see `lib/idempotency.ts`): a creation whose
  // answer was lost must not leave two DRAFTs behind when it is retried. EDIT is a
  // PATCH, which is already idempotent by construction, so no key is sent there.
  const submitKey = useRef<string | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    // NOT while a request is in flight — see MovementForm: an edit during a slow
    // delivery must not rename an operation that may already have been applied.
    if (!submitting.current) submitKey.current = null;
  }, [supplierId, locationId, expectedAt, notes, lines]);

  const supplierOptions = useMemo(() => {
    const list: SelectOption[] = suppliers.items.map((s) => ({ value: s.id, label: s.name }));
    // Editing a DRAFT whose supplier was archived since: keep the snapshot in
    // the picker (the server will reject a submit if it is truly unusable).
    if (isEdit && initial?.supplier?.id && initial?.supplier?.name && !list.some((o) => o.value === initial.supplier.id)) {
      list.unshift({ value: initial.supplier.id, label: initial.supplier.name });
    }
    return list;
  }, [suppliers.items, isEdit, initial]);

  const locationOptions = useMemo(() => {
    const list: SelectOption[] = locations.items.map((l) => ({ value: l.id, label: l.name }));
    if (isEdit && initial?.location?.id && initial?.location?.name && !list.some((o) => o.value === initial.location.id)) {
      list.unshift({ value: initial.location.id, label: initial.location.name });
    }
    return list;
  }, [locations.items, isEdit, initial]);

  // The callback's return type is named so the pair is checked against
  // SelectOption rather than asserted into it (mirrors locationOptions above).
  const productOptions = useMemo(
    () => products.items.map((p: ApiResponse): SelectOption => ({ value: p.id, label: p.name })),
    [products.items]
  );

  // Per-line options: an existing item whose product is no longer active keeps
  // its snapshot label in the picker so the order stays visible/editable.
  function lineOptions(line: PoLine): SelectOption[] {
    if (line.productName && !productOptions.some((o) => o.value === line.productId)) {
      return [{ value: line.productId, label: line.productName }, ...productOptions];
    }
    return productOptions;
  }

  function updateLine(key: string, patch: Partial<PoLine>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function setLineProduct(key: string, productId: string): void {
    updateLine(key, { productId, productName: '', sku: '' });
  }
  function removeLine(key: string): void {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }
  function addLine(): void {
    setLines((prev) => [...prev, { key: nextKey(), productId: '', productName: '', sku: '', quantityOrdered: '', unitCost: '' }]);
  }

  if ((suppliers.loading && suppliers.items.length === 0) || (locations.loading && locations.items.length === 0) || (products.loading && products.items.length === 0)) {
    return <CenterLoader label="Loading options…" />;
  }

  /** Client-side mirror of validatePurchaseOrder (structural pass only). */
  function validate(): PoProblem[] {
    const problems: PoProblem[] = [];
    if (!supplierId) problems.push({ field: 'supplierId', message: 'Supplier is required.' });
    if (!locationId) problems.push({ field: 'locationId', message: 'Location is required.' });
    const et = expectedAt.trim();
    if (et && !isGoodDate(et)) problems.push({ field: 'expectedAt', message: 'Use YYYY-MM-DD for the expected date.' });
    if (notes.trim().length > PO_NOTES_MAX) problems.push({ field: 'notes', message: `Notes must be at most ${PO_NOTES_MAX} characters.` });
    if (lines.length === 0) problems.push({ field: 'items', message: 'Add at least one product line.' });
    if (lines.length > PO_ITEMS_MAX) problems.push({ field: 'items', message: `Items must have at most ${PO_ITEMS_MAX} entries.` });

    const seen = new Set<string>();
    lines.forEach((line, idx) => {
      const prefix = `items[${idx}]`;
      if (!line.productId) {
        problems.push({ field: `${prefix}.productId`, message: 'Choose a product.' });
      } else {
        const low = line.productId.toLowerCase();
        if (seen.has(low)) problems.push({ field: `${prefix}.productId`, message: 'Each product may appear only once.' });
        seen.add(low);
      }
      const q = intValue(line.quantityOrdered);
      if (q === null) problems.push({ field: `${prefix}.quantityOrdered`, message: 'Quantity is required.' });
      else if (Number.isNaN(q) || q < 1) problems.push({ field: `${prefix}.quantityOrdered`, message: 'Quantity must be a whole number of 1 or more.' });
      const c = numValue(line.unitCost);
      if (c !== null && (Number.isNaN(c) || c < 0)) problems.push({ field: `${prefix}.unitCost`, message: 'Unit cost must be 0 or more.' });
    });

    return problems;
  }

  function lineProblem(idx: number, field: string): string | undefined {
    return fieldErrors[`items[${idx}].${field}`];
  }

  async function submit(): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const idempotencyKey = isEdit ? undefined : (submitKey.current ??= newIdempotencyKey());

    const problems = validate();
    if (problems.length) {
      const m: Record<string, string> = {};
      for (const p of problems) m[p.field] = p.message;
      setFieldErrors(m);
      submitting.current = false;
      setBusy(false);
      return;
    }

    const items: PurchaseOrderLineInput[] = lines.map((line) => {
      const out: PurchaseOrderLineInput = { productId: line.productId, quantityOrdered: intValue(line.quantityOrdered) ?? undefined };
      const c = numValue(line.unitCost);
      if (c !== null) out.unitCost = c;
      return out;
    });
    const payload: PurchaseOrderInput = { supplierId, locationId, items };
    const et = expectedAt.trim();
    if (et) payload.expectedAt = et;
    if (notes.trim()) payload.notes = notes.trim();

    try {
      const res = isEdit
        ? await purchaseOrdersApi.update(token as string, initial.id, payload)
        : await purchaseOrdersApi.create(token as string, payload, idempotencyKey);
      await alert(
        isEdit ? 'Order updated' : 'Order created',
        isEdit
          ? `${res?.number ?? 'Order'} was updated.`
          : `Draft ${res?.number ?? 'order'} created — issue it when you're ready to receive.`
      );
      // Creating now lands on the draft itself (§27CZ). `router.back()` used to dismiss the form to whatever
      // was underneath it — on the list that is the list, but on a deep link there is no draft anywhere on
      // the screen, and even from the list the order you just made is one more tap away. Landing on it puts
      // the alert's own advice ("issue it when you're ready") one tap from the member, and `replace` keeps the
      // back stack honest: back goes to the list, never to a second copy of the create form.
      if (!isEdit && res?.id) {
        router.replace(`/purchase-orders/${res.id}`);
      } else {
        router.back();
      }
    } catch (err) {
      // Only an answer that ENDS the operation mints a new key; a transport failure
      // and a still-in-flight claim both keep it. See `lib/idempotency.ts`.
      if (endsOperation(err)) submitKey.current = null;
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else setFormError(poErrorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} />
      <SelectField
        label="Supplier"
        placeholder="Choose a supplier…"
        options={supplierOptions}
        value={supplierId}
        onChange={setSupplierId}
        error={fieldErrors.supplierId}
        required
        searchable
      />
      <SelectField
        label="Receiving location"
        placeholder="Where stock will land…"
        options={locationOptions}
        value={locationId}
        onChange={setLocationId}
        error={fieldErrors.locationId}
        required
        searchable
      />
      <Input
        name="expectedAt"
        label="Expected date (optional)"
        value={expectedAt}
        onChangeText={setExpectedAt}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        autoCapitalize="none"
        error={fieldErrors.expectedAt}
        helper="e.g. 2026-10-01"
      />
      <Input
        name="notes"
        label="Notes (optional)"
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={PO_NOTES_MAX}
        error={fieldErrors.notes}
      />

      <SectionHeader title="Items" style={styles.sectionTitle} />
      {fieldErrors.items ? <Banner type="error" text={fieldErrors.items} /> : null}
      <View style={styles.lineList}>
        {lines.map((line, idx) => (
          <Card key={line.key}>
            <SelectField
              label={`Product ${idx + 1}`}
              placeholder="Choose a product…"
              options={lineOptions(line)}
              value={line.productId}
              onChange={(v) => setLineProduct(line.key, v)}
              error={lineProblem(idx, 'productId')}
              required
              searchable
            />
            <Input
              name={`items[${idx}].quantityOrdered`}
              label="Quantity ordered"
              value={line.quantityOrdered}
              onChangeText={(v) => updateLine(line.key, { quantityOrdered: v })}
              keyboardType="number-pad"
              placeholder="e.g. 24"
              error={lineProblem(idx, 'quantityOrdered')}
              required
            />
            <Input
              name={`items[${idx}].unitCost`}
              label="Unit cost (optional)"
              value={line.unitCost}
              onChangeText={(v) => updateLine(line.key, { unitCost: v })}
              keyboardType="decimal-pad"
              placeholder="e.g. 5.50"
              error={lineProblem(idx, 'unitCost')}
            />
            {lines.length > 1 ? (
              <Button title="Remove line" icon="remove" variant="danger" onPress={() => removeLine(line.key)} style={styles.removeBtn} />
            ) : null}
          </Card>
        ))}
      </View>
      <Button title="Add line" icon="add" variant="secondary" onPress={addLine} disabled={lines.length >= PO_ITEMS_MAX} full />

      <Button title={isEdit ? 'Save changes' : 'Create draft order'} onPress={submit} loading={busy} full />
      <Text style={styles.hint}>Drafts can be edited and issued later. Issued orders are frozen — only receiving changes them.</Text>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
  content: { paddingBottom: spacing.huge },
  sectionTitle: { marginTop: spacing.xl },
  lineList: { gap: spacing.md },
  removeBtn: { marginBottom: spacing.lg },
  // No pinned lineHeight: the type token's proportional height is what keeps
  // this line from clipping once the system font scale grows.
  hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
});
