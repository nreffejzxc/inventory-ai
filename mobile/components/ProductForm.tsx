import { useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native';

import Banner from './Banner';
import Button from './Button';
import Input from './Input';
import type { InputHandle } from './Input';
import Screen from './Screen';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { productsApi, categoriesApi } from '../lib/api';
import type { ApiResponse, ProductInput } from '../lib/api';
import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import { useActiveRef } from '../hooks/useReferences';
import { spacing } from '../lib/theme';

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
  const { token } = useSession();
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
  // ISO-4217 code for the two prices, so the assistant can format them with the right
  // currency instead of guessing. Blank means "not recorded", which is a valid state.
  const [currency, setCurrency] = useState<string>(initial?.currency ?? '');
  const [minimumStock, setMinimumStock] = useState<string>(
    initial?.minimumStock != null && initial.minimumStock !== 0 ? String(initial.minimumStock) : ''
  );
  const [imageUrl, setImageUrl] = useState<string>(initial?.imageUrl ?? '');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
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
    const code = currency.trim().toUpperCase();
    if (code && !/^[A-Z]{3}$/.test(code)) {
      problems.currency = 'Use a 3-letter ISO code, e.g. PHP';
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
    setFieldErrors({});
    const payload: ProductInput = {
      name: name.trim(),
      brand: brand.trim() || undefined,
      sku: sku.trim() || undefined,
      barcode: barcode.trim() || undefined,
      categoryId: categoryId || undefined,
      description: description.trim() || undefined,
      specifications: specifications.trim() || undefined,
      unit: unit.trim() || undefined,
      costPrice: cost.value,
      sellingPrice: sell.value,
      currency: code || undefined,
      minimumStock: min.value,
      imageUrl: imageUrl.trim() || undefined,
    };
    try {
      if (isEdit) await productsApi.update(token as string, initial.id, payload);
      else await productsApi.create(token as string, payload);
      router.back();
    } catch (err) {
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else setFormError((err as { message?: string } | null)?.message || 'Unable to save the product.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} />
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
      <Input name="currency" label="Currency" value={currency} onChangeText={setCurrency} error={fieldErrors.currency} placeholder="e.g. PHP" maxLength={3} autoCapitalize="characters" helper="3-letter ISO code for both prices. Leave blank if unknown — the assistant will not guess." />
      <Input name="unit" label="Unit" value={unit} onChangeText={setUnit} error={fieldErrors.unit} placeholder="e.g. box, kg, litre" autoCapitalize="none" />
      <Input name="minimumStock" label="Minimum stock" value={minimumStock} onChangeText={setMinimumStock} keyboardType="number-pad" error={fieldErrors.minimumStock} helper="Alert when available stock drops to this level (0 = disabled)" />
      <Input name="imageUrl" label="Image URL" value={imageUrl} onChangeText={setImageUrl} error={fieldErrors.imageUrl} placeholder="Optional https://…" autoCapitalize="none" />
      <Button title={isEdit ? 'Save changes' : 'Create product'} onPress={submit} loading={busy} full />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.huge },
});
