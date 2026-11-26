import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Banner from '../../../components/Banner';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import Screen from '../../../components/Screen';
import SectionHeader from '../../../components/SectionHeader';
import SelectField from '../../../components/SelectField';
import { locationsApi, productsApi, purchaseOrdersApi, suppliersApi } from '../../../lib/api';
import type { ApiResponse, PurchaseOrderFromRestockInput } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import { ApiError } from '../../../lib/client';
import { confirm } from '../../../lib/confirm';
import { errorRequestId } from '../../../lib/errors';
import { formatNumber } from '../../../lib/format';
import { endsOperation, newIdempotencyKey } from '../../../lib/idempotency';
import { canManagePurchaseOrders } from '../../../lib/permissions';
import {
  clearRestockPurchaseOrderDraft,
  loadRestockPurchaseOrderDraft,
  saveRestockPurchaseOrderDraft,
} from '../../../lib/restockPurchaseOrderDraft';
import type { RestockPurchaseOrderDraft } from '../../../lib/restockPurchaseOrderDraft';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';
import { referenceAvailability, useActiveRef } from '../../../hooks/useReferences';

const MAX_ROWS = 100;

function errorFields(err: unknown): string[] {
  return err instanceof ApiError ? err.fields.map((f) => f.message) : [];
}

/** Retry the local clear once; a confirmed server success must not depend on it. */
async function clearSavedAttempt(
  ownerId: string | null | undefined,
  key: string,
): Promise<boolean> {
  if (await clearRestockPurchaseOrderDraft(ownerId, key).catch(() => false)) return true;
  return clearRestockPurchaseOrderDraft(ownerId, key).catch(() => false);
}

/**
 * FW-01 follow-on: choose a supplier + receiving location, select rows from the
 * location-scoped restock list, and create ONE DRAFT purchase order. The server
 * re-reads the rows before allocating the order; a stale selection is refused
 * and this screen refreshes instead of submitting old quantities. There is no
 * issue/send action here by design.
 */
export default function DraftFromRestockScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, user } = useSession();
  const suppliers = useActiveRef(token, suppliersApi, { allPages: true });
  const locations = useActiveRef(token, locationsApi, { allPages: true });

  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [rows, setRows] = useState<ApiResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [fieldMessages, setFieldMessages] = useState<string[]>([]);
  const [saved, setSaved] = useState<RestockPurchaseOrderDraft | null>(null);
  const [restoreDoneFor, setRestoreDoneFor] = useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const restoredFor = useRef<string | null>(null);
  // A location change can overlap the previous restock read. Without this
  // sequence, a slower earlier answer can replace the rows for the location now
  // selected, and a selected row would be submitted under a location whose list
  // the operator is not looking at. Only the latest request may commit.
  const loadSeq = useRef(0);
  const restoring = Boolean(user?.id) && restoreDoneFor !== user?.id;
  const locked = Boolean(saved) || restoreFailed;

  const load = useCallback(
    async (loc: string, keepSelected?: Set<string>) => {
      const requestId = ++loadSeq.current;
      if (!loc) {
        setRows([]);
        setTotal(0);
        setSelected(new Set());
        setLoading(false);
        return;
      }
      if (keepSelected === undefined) {
        // A different location's rows must never be submitted under this
        // location if the new query fails.
        setRows([]);
        setTotal(0);
        setSelected(new Set());
      }
      setLoading(true);
      setMessage(null);
      setRequestId(null);
      setFieldMessages([]);
      try {
        const res = await productsApi.reorder(token as string, { locationId: loc, limit: MAX_ROWS });
        if (requestId !== loadSeq.current) return;
        const items = (res.items ?? []) as ApiResponse[];
        setRows(items);
        setTotal(Number(res.total ?? items.length));
        setSelected((prev) =>
          new Set([...(keepSelected ?? prev)].filter((id) => items.some((row) => row.id === id))),
        );
      } catch (err) {
        if (requestId !== loadSeq.current) return;
        setMessage(err instanceof ApiError ? err.message : 'The restock list could not be loaded.');
        setRequestId(errorRequestId(err));
      } finally {
        if (requestId === loadSeq.current) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    const owner = user?.id;
    const attemptKey = owner ? `${owner}#${restoreAttempt}` : '';
    if (!owner || restoredFor.current === attemptKey) return;
    restoredFor.current = attemptKey;
    let active = true;
    setSaved(null);
    setSupplierId('');
    setLocationId('');
    setRows([]);
    setTotal(0);
    setSelected(new Set());
    setMessage(null);
    setRequestId(null);
    setFieldMessages([]);
    setRestoreFailed(false);
    void loadRestockPurchaseOrderDraft(owner)
      .then(async (result) => {
        if (!active) return;
        if (result.status === 'error') {
          setRestoreFailed(true);
          setMessage(
            'The saved draft attempt could not be checked on this device. Check again before creating another draft.',
          );
          return;
        }
        if (result.status === 'missing') return;
        const { draft } = result;
        const ids = new Set(draft.payload.items.map((item) => item.productId));
        setSaved(draft);
        setSupplierId(draft.payload.supplierId);
        setLocationId(draft.payload.locationId);
        setSelected(ids);
        await load(draft.payload.locationId, ids);
        if (!active) return;
        setMessage(
          'An unfinished draft attempt was restored. Submit it unchanged to reuse the same key, or start over after checking Purchase orders.',
        );
      })
      .catch(() => {
        if (active) {
          setRestoreFailed(true);
          setMessage(
            'The saved draft attempt could not be checked on this device. Check again before creating another draft.',
          );
        }
      })
      .finally(() => {
        if (active) setRestoreDoneFor(owner);
      });
    return () => {
      active = false;
    };
  }, [load, user?.id, restoreAttempt]);

  if (!canManagePurchaseOrders(user)) {
    return <AccessDenied message="Only managers and above can create purchase orders." />;
  }

  const supplierOptions = suppliers.items.map((s) => ({ value: s.id, label: s.name }));
  const locationOptions = locations.items.map((l) => ({ value: l.id, label: l.name }));
  const supplierAvailability = referenceAvailability(supplierId, suppliers);
  const locationAvailability = referenceAvailability(locationId, locations);
  const supplierMissing = supplierAvailability === 'missing';
  const locationMissing = locationAvailability === 'missing';
  const referenceBlocked = supplierMissing || locationMissing;
  const selectedRows = rows.filter((row) => selected.has(row.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (busy || restoring || restoreFailed) return;
    if (referenceBlocked) {
      setMessage('A saved supplier or receiving location is archived. Start over and choose active references.');
      return;
    }
    let operationKey: string;
    let payload: PurchaseOrderFromRestockInput;

    if (saved) {
      // Same-key resume: the stored body is the only body this key may send.
      // Editing a selection after an ambiguous answer could create a second
      // DRAFT once the first request lands.
      operationKey = saved.key;
      payload = saved.payload;
    } else {
      if (!supplierId || !locationId) {
        setMessage('Choose a supplier and a receiving location first.');
        return;
      }
      if (selectedRows.length === 0) {
        setMessage('Select at least one restock row.');
        return;
      }
      operationKey = newIdempotencyKey();
      payload = {
        supplierId,
        locationId,
        items: selectedRows.map((row) => ({
          productId: row.id,
          availableQuantity: Number(row.availableQuantity ?? 0),
          minimumStock: Number(row.minimumStock ?? 0),
        })),
      };
    }

    setBusy(true);
    setMessage(null);
    setRequestId(null);
    setFieldMessages([]);

    try {
      if (!saved) {
        const draft: RestockPurchaseOrderDraft = {
          payload,
          key: operationKey,
          savedAt: Date.now(),
        };
        // The server has not been called yet. A key that cannot survive a
        // restart is not enough for an operation whose response may be lost;
        // do not create an unresumable DRAFT attempt.
        if (!(await saveRestockPurchaseOrderDraft(user?.id, draft))) {
          setSaved(null);
          setMessage(
            'The draft was not sent because its resume key could not be saved on this device. Try again.',
          );
          return;
        }
        setSaved(draft);
      }
      const po = await purchaseOrdersApi.createFromRestock(token as string, payload, operationKey);
      // A confirmed server success must not leave a local attempt that looks
      // unfinished on the next launch. Retry once, then report the stale local
      // state truthfully instead of pretending it was cleared.
      const cleared = await clearSavedAttempt(user?.id, operationKey);
      if (!cleared) {
        setMessage(
          'The draft order was created, but this device could not clear the saved resume attempt. Press Resume draft creation to retry; the same key cannot create a second order.',
        );
        return;
      }
      setSaved(null);
      router.replace(`/purchase-orders/${po.id}`);
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.code === 'RESTOCK_ROWS_STALE'
          ? 'The restock list changed while you were selecting. The list has been refreshed — review it and submit again.'
          : err instanceof ApiError && endsOperation(err)
            ? err.message
            : 'The draft could not be confirmed. Press Resume draft creation to retry the same operation.',
      );
      setRequestId(errorRequestId(err));
      setFieldMessages(errorFields(err));
      if (endsOperation(err)) {
        await clearSavedAttempt(user?.id, operationKey);
        setSaved(null);
      }
      if (err instanceof ApiError && err.code === 'RESTOCK_ROWS_STALE') {
        setSelected(new Set());
        await load(locationId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function startOver(): Promise<void> {
    if (!saved || busy) return;
    const ok = await confirm(
      'Start over?',
      'Check Purchase orders first. If the earlier attempt created a draft, starting over can create a second one.',
      { confirmText: 'Start over', destructive: true },
    );
    if (!ok) return;
    const cleared = await clearRestockPurchaseOrderDraft(user?.id, saved.key);
    if (!cleared) {
      setMessage('The saved attempt could not be removed from this device. Try again.');
      return;
    }
    setSaved(null);
    setSupplierId('');
    setLocationId('');
    setRows([]);
    setTotal(0);
    setSelected(new Set());
    setMessage(null);
    setRequestId(null);
    setFieldMessages([]);
  }

  function retryRestore(): void {
    setRestoreDoneFor(null);
    setRestoreFailed(false);
    setMessage(null);
    setRestoreAttempt((value) => value + 1);
  }

  return (
    <Screen scroll>
      <Card>
        <Text style={styles.title}>Draft purchase order from restock</Text>
        <Text style={styles.body}>
          Select the products to replenish. Quantities are calculated by the server from the selected
          location&apos;s current availability and each product&apos;s minimum stock.
        </Text>
      </Card>

      <SectionHeader title="Order details" style={styles.section} />
      <SelectField
        label="Supplier"
        placeholder="Choose a supplier…"
        options={supplierOptions}
        value={supplierMissing ? '' : supplierId}
        onChange={setSupplierId}
        disabled={locked}
        searchable
        required
      />
      <SelectField
        label="Receiving location"
        placeholder="Choose a location…"
        options={locationOptions}
        value={locationMissing ? '' : locationId}
        onChange={(id) => {
          if (locked) return;
          setLocationId(id);
          void load(id);
        }}
        disabled={locked}
        searchable
        required
      />

      {referenceBlocked ? (
        <Banner
          type="warn"
          text={
            saved
              ? 'The saved attempt names a supplier or location that is now archived. It cannot be resumed safely; check Purchase orders, then Start over to choose active references.'
              : 'A selected supplier or location is archived. Choose active references before creating the draft.'
          }
        />
      ) : null}
      <Banner type="error" text={message} requestId={requestId} />
      {fieldMessages.length > 0 ? (
        <Card style={styles.fieldCard}>
          {fieldMessages.map((text, idx) => (
            <Text key={`${text}-${idx}`} style={styles.fieldText}>
              • {text}
            </Text>
          ))}
        </Card>
      ) : null}

      <SectionHeader title="Restock rows" style={styles.section} />
      {!locationId ? (
        <Text style={styles.empty}>Choose a receiving location to load its restock list.</Text>
      ) : loading ? (
        <Banner type="info" text="Loading restock rows…" />
      ) : rows.length === 0 ? (
        <Text style={styles.empty}>Nothing at or below minimum stock at this location.</Text>
      ) : (
        <>
          <Text style={styles.meta}>
            {saved ? saved.payload.items.length : selected.size} selected · {formatNumber(total)} row(s) at or below minimum
            {total > rows.length ? ` · showing the first ${MAX_ROWS}` : ''}
          </Text>
          <View style={styles.rowList}>
            {rows.map((row) => {
              const isSelected = selected.has(row.id);
              const isOut = row.stockStatus === 'OUT_OF_STOCK';
              return (
                <Pressable
                  key={row.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected, disabled: locked }}
                  disabled={locked}
                  onPress={() => toggle(row.id)}
                  style={({ pressed }) => [
                    styles.row,
                    isSelected && styles.rowSelected,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                    {isSelected ? <Text style={styles.check}>✓</Text> : null}
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle} numberOfLines={2}>
                      {row.name}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={2}>
                      {[
                        row.sku ? `SKU ${row.sku}` : null,
                        `${formatNumber(row.availableQuantity)} available`,
                        `minimum ${formatNumber(row.minimumStock)}`,
                        isOut ? 'out of stock' : 'low stock',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {restoreFailed ? (
        <Button
          title="Check saved attempt again"
          onPress={retryRestore}
          loading={restoring}
          disabled={busy || restoring}
          full
          style={styles.submit}
        />
      ) : (
        <Button
          title={
            saved
              ? saved.payload.items.length === 1
                ? 'Resume draft creation (1 item)'
                : `Resume draft creation (${saved.payload.items.length} items)`
              : selected.size === 1
                ? 'Create draft order (1 item)'
                : `Create draft order (${selected.size} items)`
          }
          onPress={submit}
          loading={busy || restoring}
          disabled={
            busy ||
            restoring ||
            loading ||
            (!saved && (!supplierId || !locationId || selected.size === 0))
            || referenceBlocked
          }
          full
          style={styles.submit}
        />
      )}
      {saved ? (
        <Button
          title="Start over"
          variant="ghost"
          onPress={startOver}
          disabled={busy || restoring}
          full
        />
      ) : null}
      <Text style={styles.hint}>
        Creates one DRAFT purchase order. It is not issued, sent or ordered automatically.
      </Text>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    title: { ...type.h3, color: colors.text, marginBottom: spacing.sm },
    body: { ...type.body, color: colors.textSecondary },
    section: { marginTop: spacing.xl },
    meta: { ...type.caption, color: colors.textSecondary, marginBottom: spacing.md },
    empty: { ...type.body, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xl },
    rowList: { gap: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: spacing.md,
    },
    rowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
    rowPressed: { opacity: 0.85 },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    check: { color: colors.textOnPrimary, fontWeight: '800' },
    rowBody: { flex: 1 },
    rowTitle: { ...type.body, color: colors.text, fontWeight: '700' },
    rowMeta: { ...type.caption, color: colors.textMuted, marginTop: 2 },
    fieldCard: { marginBottom: spacing.lg },
    fieldText: { ...type.body, color: colors.danger, marginBottom: 4 },
    submit: { marginTop: spacing.xl },
    hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md },
  });
