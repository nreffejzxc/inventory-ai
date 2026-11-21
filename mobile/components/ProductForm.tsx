import { useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from './Banner';
import Button from './Button';
import Chip from './Chip';
import Input from './Input';
import type { InputHandle } from './Input';
import Screen from './Screen';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { productsApi, categoriesApi } from '../lib/api';
import type { ApiResponse, ProductInput } from '../lib/api';
import { ApiError } from '../lib/client';
import {
  completeOperation,
  endsOperation,
  getOrCreateOperationKey,
  PendingOperationsFullError,
} from '../lib/idempotency';
import { errorRequestId } from '../lib/errors';
import { normaliseCurrencyCode, PRODUCT_CURRENCIES } from '../lib/currencies';
import { useSession } from '../lib/auth';
import { useActiveRef } from '../hooks/useReferences';
import { spacing } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

const CURRENCY_OPTIONS: SelectOption[] = PRODUCT_CURRENCIES.map(({ code, name }) => ({
  value: code,
  label: `${code} — ${name}`,
}));

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

interface ParsedNumber {
  value: number | undefined;
  ok: boolean;
  message?: string;
}

function toNumber(text: string | null | undefined): ParsedNumber {
  const t = (text ?? '').trim();
  if (t === '') return { value: undefined, ok: true };
  const n = Number(t);
  if (!Number.isFinite(n)) return { value: undefined, ok: false, message: 'Enter a valid number' };
  return { value: n, ok: true };
}

function toWhole(text: string | null | undefined): ParsedNumber {
  const r = toNumber(text);
  if (!r.ok || r.value === undefined) return r;
  if (!Number.isInteger(r.value)) return { value: undefined, ok: false, message: 'Enter a whole number' };
  return r;
}

/**
 * Product create/edit form (backend is authoritative; this validates input for
 * a good UX and surfaces the server's { field, message } problems on submit).
 */
export default function ProductForm({ initial }: { initial?: ApiResponse }) {
  const { token, user } = useSession();
  const { colors } = useTheme();
  const isEdit = Boolean(initial);
  const categories = useActiveRef(token, categoriesApi);

  const [name, setName] = useState<string>(initial?.name ?? '');
  const [brand, setBrand] = useState<string>(initial?.brand ?? '');
  const [sku, setSku] = useState<string>(initial?.sku ?? '');
  const [barcode, setBarcode] = useState<string>(initial?.barcode ?? '');
  const [categoryId, setCategoryId] = useState<string>(initial?.category?.id ?? '');
  const [description, setDescription] = useState<string>(initial?.description ?? '');
  const [specifications, setSpecifications] = useState<string>(initial?.specifications ?? '');
  const [unit, setUnit] = useState<string>(initial?.unit ?? '');
  const [costPrice, setCostPrice] = useState<string>(
    initial?.costPrice != null && initial.costPrice !== 0 ? String(initial.costPrice) : ''
  );
  const [sellingPrice, setSellingPrice] = useState<string>(
    initial?.sellingPrice != null && initial.sellingPrice !== 0 ? String(initial.sellingPrice) : ''
  );
  // ISO 4217 code for the two prices. Required, so the assistant can format them with
  // the right currency instead of guessing. An edit of a legacy row with no code must
  // supply one here; the field is never silently cleared.
  const [currency, setCurrency] = useState<string>(initial?.currency ?? '');
  // The server accepts only the EXACT stored code on an ordinary edit. Comparing
  // a normalised selection with a normalised legacy `php` (or padded) value would
  // hide the correction the server requires, so compare against the raw value.
  const initialCurrency = typeof initial?.currency === 'string' ? initial.currency : '';
  const selectedCurrency = normaliseCurrencyCode(currency);
  const currencyNeedsCorrection = isEdit && selectedCurrency !== initialCurrency;
  const [currencyCorrectionReason, setCurrencyCorrectionReason] = useState('');
  const [priceReconfirmed, setPriceReconfirmed] = useState(false);
  const [minimumStock, setMinimumStock] = useState<string>(
    initial?.minimumStock != null && initial.minimumStock !== 0 ? String(initial.minimumStock) : ''
  );
  const [imageUrl, setImageUrl] = useState<string>(initial?.imageUrl ?? '');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<InputHandle>(null);

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'No category' },
    ...categories.items.map((c) => ({ value: c.id, label: c.name })),
  ];

  async function submit(): Promise<void> {
    // Client-side pre-checks (friendly, mirrors the server rules).
    const problems: Record<string, string | undefined> = {};
    if (!name.trim()) problems.name = 'Name is required';
    const cost = toNumber(costPrice);
    if (!cost.ok) problems.costPrice = cost.message;
    else if (cost.value != null && cost.value < 0) problems.costPrice = 'Cost must be at least 0';
    const sell = toNumber(sellingPrice);
    if (!sell.ok) problems.sellingPrice = sell.message;
    else if (sell.value != null && sell.value < 0) problems.sellingPrice = 'Selling price must be at least 0';
    const min = toWhole(minimumStock);
    if (!min.ok) problems.minimumStock = min.message;
    else if (min.value != null && min.value < 0) problems.minimumStock = 'Minimum stock must be at least 0';
    const code = normaliseCurrencyCode(currency);
    if (!code) {
      problems.currency = 'Currency is required. Use a valid ISO 4217 code, e.g. PHP';
    }
    if (isEdit && currencyNeedsCorrection) {
      if (currencyCorrectionReason.trim().length < 3) {
        problems.reason = 'Explain why the recorded currency is changing (at least 3 characters).';
      }
      if (!priceReconfirmed) {
        problems.priceReconfirmed = 'Confirm that both price values were rechecked in the selected currency.';
      }
    }
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      // The Create button sits at the bottom of a long form. Without this, a missing
      // name rendered its message above the viewport and the submit looked inert.
      // Focusing the field also lets KeyboardScrollView bring it into view.
      if (problems.name) requestAnimationFrame(() => nameRef.current?.focus());
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    // An edit must be able to REMOVE a recorded value. `undefined` means "leave this
    // field alone" to the PATCH validator; `null` means "clear it". A create still
    // omits blanks (a null there would be stored as an empty value).
    const blank = (value: string) => value.trim() || (isEdit ? null : undefined);
    const numberOrClear = (value: number | undefined) => value ?? (isEdit ? null : undefined);
    const payload: ProductInput = {
      name: name.trim(),
      brand: blank(brand),
      sku: blank(sku),
      barcode: blank(barcode),
      categoryId: categoryId || (isEdit ? null : undefined),
      description: blank(description),
      specifications: blank(specifications),
      unit: blank(unit),
      costPrice: numberOrClear(cost.value),
      sellingPrice: numberOrClear(sell.value),
      currency: code ?? undefined,
      minimumStock: numberOrClear(min.value),
      imageUrl: blank(imageUrl),
    };
    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = isEdit
        ? undefined
        : await getOrCreateOperationKey({
            kind: 'product.create',
            ownerId: user?.id,
            payload,
            label: `Product: ${payload.name || 'new product'}`,
            request: { method: 'POST', path: '/api/products', body: payload },
          });
      if (isEdit) {
        if (currencyNeedsCorrection) {
          await productsApi.correctCurrency(token as string, initial.id, {
            ...payload,
            reason: currencyCorrectionReason.trim(),
            priceReconfirmed: true,
          });
        } else {
          await productsApi.update(token as string, initial.id, payload);
        }
      }
      else await productsApi.create(token as string, payload, idempotencyKey);
      if (idempotencyKey) await completeOperation('product.create', idempotencyKey, user?.id);
      router.back();
    } catch (err) {
      if (err instanceof PendingOperationsFullError) {
        setFormError(err.message);
        setFormRequestId(null);
        return;
      }
      if (idempotencyKey && endsOperation(err)) {
        await completeOperation('product.create', idempotencyKey, user?.id);
      }
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || 'Unable to save the product.');
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} requestId={formRequestId} />
      <Input ref={nameRef} name="name" label="Product name" value={name} onChangeText={setName} error={fieldErrors.name} required autoCapitalize="words" />
      <Input name="brand" label="Brand" value={brand} onChangeText={setBrand} error={fieldErrors.brand} placeholder="Optional — e.g. Nestlé, Samsung" autoCapitalize="words" />
      <Input name="sku" label="SKU" value={sku} onChangeText={setSku} error={fieldErrors.sku} placeholder="Optional — unique per business" autoCapitalize="characters" />
      <Input name="barcode" label="Barcode" value={barcode} onChangeText={setBarcode} error={fieldErrors.barcode} placeholder="Optional — unique per business" autoCapitalize="characters" />
      <SelectField
        label="Category"
        placeholder="Choose a category…"
        options={categoryOptions}
        value={categoryId}
        onChange={setCategoryId}
        error={fieldErrors.categoryId}
        searchable
        disabled={categories.items.length === 0}
      />
      <Input name="description" label="Description" value={description} onChangeText={setDescription} multiline error={fieldErrors.description} />
      <Input
        name="specifications"
        label="Specifications"
        value={specifications}
        onChangeText={setSpecifications}
        multiline
        maxLength={1000}
        error={fieldErrors.specifications}
        helper="Recorded facts such as dimensions, battery, capacity, or connectivity. The assistant compares these, not guesses."
      />
      <Input name="costPrice" label="Cost price" value={costPrice} onChangeText={setCostPrice} keyboardType="decimal-pad" error={fieldErrors.costPrice} placeholder="0.00" />
      <Input name="sellingPrice" label="Selling price" value={sellingPrice} onChangeText={setSellingPrice} keyboardType="decimal-pad" error={fieldErrors.sellingPrice} placeholder="0.00" />
      <SelectField
        label="Currency"
        placeholder="Select a currency…"
        options={CURRENCY_OPTIONS}
        value={currency}
        onChange={setCurrency}
        error={fieldErrors.currency}
        required
        searchable
        testID="currency-picker"
      />
      {currencyNeedsCorrection ? (
        <View style={styles.correction}>
          <Input
            name="reason"
            label="Currency correction reason"
            value={currencyCorrectionReason}
            onChangeText={setCurrencyCorrectionReason}
            error={fieldErrors.reason}
            required
            helper="Required and audited: explain the verified source for the replacement code."
          />
          <Text style={[styles.correctionLabel, { color: colors.text }]}>Price reconfirmation</Text>
          <Chip
            label="I reconfirmed cost and selling prices"
            selected={priceReconfirmed}
            onPress={() => {
              setPriceReconfirmed((value) => !value);
              setFieldErrors((current) => ({ ...current, priceReconfirmed: undefined }));
            }}
          />
          {fieldErrors.priceReconfirmed ? (
            <Text style={[styles.fieldError, { color: colors.danger }]}>{fieldErrors.priceReconfirmed}</Text>
          ) : null}
        </View>
      ) : null}
      <Input name="unit" label="Unit" value={unit} onChangeText={setUnit} error={fieldErrors.unit} placeholder="e.g. box, kg, litre" autoCapitalize="none" />
      <Input name="minimumStock" label="Minimum stock" value={minimumStock} onChangeText={setMinimumStock} keyboardType="number-pad" error={fieldErrors.minimumStock} helper="Alert when available stock drops to this level (0 = disabled)" />
      <Input name="imageUrl" label="Image URL" value={imageUrl} onChangeText={setImageUrl} error={fieldErrors.imageUrl} placeholder="Optional https://…" autoCapitalize="none" />
      <Button title={isEdit ? 'Save changes' : 'Create product'} onPress={submit} loading={busy} full />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.huge },
  correction: { marginBottom: spacing.lg },
  correctionLabel: { marginBottom: spacing.xs + 2 },
  fieldError: { marginTop: 6 },
});
