import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from '../../../../components/Banner';
import { PoStatusBadge } from '../../../../components/Badge';
import Button from '../../../../components/Button';
import Card from '../../../../components/Card';
import { Icon } from '../../../../components/icons';
import Input from '../../../../components/Input';
import ListRow from '../../../../components/ListRow';
import { CenterLoader, EmptyState, ErrorState, errorText } from '../../../../components/ListState';
import Screen from '../../../../components/Screen';
import SectionHeader from '../../../../components/SectionHeader';
import AccessDenied from '../../../../components/AccessDenied';
import { purchaseOrdersApi } from '../../../../lib/api';
import type { ApiResponse } from '../../../../lib/api';
import { ApiError } from '../../../../lib/client';
import { endsOperation, newIdempotencyKey } from '../../../../lib/idempotency';
import { isSessionError, useSession } from '../../../../lib/auth';
import { alert } from '../../../../lib/confirm';
import { formatNumber } from '../../../../lib/format';
import { canReceivePurchaseOrders } from '../../../../lib/permissions';
import { radius, spacing, type } from '../../../../lib/theme';
import type { Palette } from '../../../../lib/theme';
import { useTheme } from '../../../../lib/theme-context';

function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Amount of a line that can actually be received right now. The server's item
 * DTO reports remaining = ordered − received (the ledger truth) but reserves are
 * ALSO taken out of what a receive may claim. Pending claims (an interrupted
 * receive) therefore reduce the offered maximum; at rest they are empty.
 */
function offeredQuantity(line: ApiResponse, pendingByProduct: Map<string, number>): number {
  return Math.max(0, (line.remainingQuantity || 0) - (pendingByProduct.get(line.productId) || 0));
}

/** Receivable lines — items with some remaining after any pending claims. */
function receivableLines(po: ApiResponse): ApiResponse[] {
  const pending = new Map<string, number>();
  for (const c of po.pendingClaims ?? []) pending.set(c.productId, (pending.get(c.productId) || 0) + (c.quantity || 0));
  return (po.items ?? [])
    .map((item: ApiResponse) => ({ ...item, offered: offeredQuantity(item, pending) }))
    .filter((item: ApiResponse) => item.offered > 0);
}

/** Per-line default: receive everything still remaining (edit down for partial). */
function defaultQuantities(po: ApiResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of receivableLines(po)) out[line.productId] = String(line.offered);
  return out;
}

/** One line editor's parsed state: empty (skip), invalid (with a reason), or a whole number. */
type QtyEntry = { kind: 'empty' } | { kind: 'invalid'; msg: string } | { kind: 'ok'; n: number };

function entry(raw: string | undefined, offered: number): QtyEntry {
  const s = (raw ?? '').trim();
  if (s === '') return { kind: 'empty' };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return { kind: 'invalid', msg: 'Enter a whole number of units.' };
  if (n === 0) return { kind: 'empty' };
  if (n > offered) return { kind: 'invalid', msg: `Only ${formatNumber(offered)} remaining on this line.` };
  return { kind: 'ok', n };
}

const CODE_MESSAGES: Record<string, string> = {
  PO_NOT_FOUND: 'This purchase order no longer exists.',
  PO_NOT_ISSUED: 'Issue the purchase order before receiving it.',
  PO_ALREADY_RECEIVED: 'This purchase order has already been received.',
  PO_CANCELED: 'This purchase order was canceled and cannot be received.',
  PO_LINE_NOT_FOUND: 'A product on this receive is not on the purchase order. Refresh and retry.',
  PO_REMAINING_EXCEEDED: 'A quantity exceeds what is still remaining. Refresh and retry.',
  PO_STATE_CONFLICT: 'The purchase order changed underneath this receive. Refresh and retry.',
  VALIDATION_ERROR: 'Check the receive quantities and try again.',
  NETWORK_TIMEOUT: 'The request timed out. Check your connection and try again.',
  NETWORK_ERROR: 'Cannot reach the server. Check your connection and try again.',
};

/**
 * Role guard (MOD-07). The permission check lives here and nowhere else, so the
 * form below mounts only for a role that may receive stock. Hoisting its hooks
 * above this return instead would run them on a denied render, and the load
 * effect below fetches the purchase order — a query a role without
 * `purchase_orders.receive` may not make.
 */
export default function ReceiveStockScreen() {
  const { user } = useSession();

  if (!canReceivePurchaseOrders(user)) {
    return <AccessDenied message="Your role does not allow receiving purchase orders." />;
  }

  return <ReceiveStockForm />;
}

function ReceiveStockForm() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams();
  const { token, signOut } = useSession();
  const poId = str(id);

  const [po, setPo] = useState<ApiResponse>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ message: string } | null>(null); // { message } when a 409 landed some lines
  const [busy, setBusy] = useState(false);

  // One name per receive attempt (see `lib/idempotency.ts`): a receipt whose answer
  // was lost must not be applied twice on retry. It is dropped when the quantities
  // or reference change, because that is a different batch of stock.
  const submitKey = useRef<string | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    // NOT while a request is in flight — see MovementForm: an edit during a slow
    // delivery must not rename an operation that may already have been applied.
    if (!submitting.current) submitKey.current = null;
  }, [quantities, reference]);

  const load = useCallback(async (): Promise<void> => {
    if (!token || !poId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await purchaseOrdersApi.get(token, poId);
      setPo(data);
      // Rebuild editors from the fresh order state (initial load, and after a
      // partial receive the applied lines are dropped and remaining re-offered).
      setQuantities(defaultQuantities(data));
    } catch (err) {
      setError(err);
      if (isSessionError(err)) await signOut();
    } finally {
      setLoading(false);
    }
  }, [token, poId, signOut]);

  useEffect(() => {
    // `load` sets loading/error synchronously before its first await on purpose:
    // a reload after a partial receive keeps the order and the rebuilt editors on
    // screen, so `loading` can't be derived from `po` — it must be able to be true
    // while `po` is already populated (the "Refreshing the order…" banner).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (loading && !po) return <CenterLoader label="Loading order…" />;
  if (error && !po) return <ErrorState title="Couldn't load the purchase order" message={errorText(error)} onRetry={load} />;
  if (!po) return null;

  // Only OPEN orders are receivable. DRAFT must be issued server-side first;
  // RECEIVED/CANCELED are terminal.
  if (po.status !== 'OPEN') {
    const note =
      po.status === 'DRAFT'
        ? 'Issue this order before receiving it.'
        : po.status === 'RECEIVED'
          ? 'This order is already fully received.'
          : po.status === 'CANCELED'
            ? 'This order was canceled and can no longer be received.'
            : 'This order cannot be received in its current state.';
    return (
      <Screen scroll>
        <Card>
          <View style={styles.titleRow}>
            <Text style={styles.number} numberOfLines={1}>
              {po.number}
            </Text>
            <PoStatusBadge status={po.status} />
          </View>
          <View style={styles.divider} />
          <EmptyState title={note} />
        </Card>
      </Screen>
    );
  }

  const lines = receivableLines(po);

  if (lines.length === 0) {
    return (
      <Screen scroll>
        <Card>
          <View style={styles.titleRow}>
            <Text style={styles.number} numberOfLines={1}>
              {po.number}
            </Text>
            <PoStatusBadge status={po.status} />
          </View>
          <View style={styles.divider} />
          <EmptyState
            title="Nothing left to receive"
            message="Every line on this order has already been received (or is held by an interrupted receive)."
          />
        </Card>
      </Screen>
    );
  }

  const entries = lines.map((line: ApiResponse) => ({ line, ...entry(quantities[line.productId], line.offered) }));
  const ok = entries.filter((e) => e.kind === 'ok');
  const units = ok.reduce((sum, e) => sum + e.n, 0);
  const hasInvalid = entries.some((e) => e.kind === 'invalid');
  const canSubmit = !busy && ok.length > 0 && !hasInvalid;
  const buttonTitle = units > 0 ? `Receive ${formatNumber(units)} unit${units === 1 ? '' : 's'}` : 'Receive stock';

  function onChangeQty(productId: string, value: string): void {
    setQuantities((prev) => ({ ...prev, [productId]: value }));
  }

  async function submit(): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFormError(null);
    setPartial(null);
    const idempotencyKey = (submitKey.current ??= newIdempotencyKey());
    try {
      const linesPayload = ok.map((e) => ({ productId: e.line.productId, quantity: e.n }));
      const res = await purchaseOrdersApi.receive(token as string, poId, {
        lines: linesPayload,
        reference: reference.trim() || undefined,
      }, idempotencyKey);
      const summary = `Received ${formatNumber(units)} unit(s) across ${ok.length} line${ok.length === 1 ? '' : 's'}.`;
      const done = res?.allReceived ? `${summary}\n\nThis order is now fully received.` : summary;
      await alert('Receive Stock', done);
      router.back();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RECEIVE_CONFLICT') {
        // Some lines landed before the batch was rejected. Tell the operator,
        // then refetch the order so the applied lines drop out of the editors
        // and the user can immediately receive the rest.
        // The batch is answered: the remaining lines are a NEW operation, so the
        // next press must not replay this 409.
        submitKey.current = null;
        const applied = err.applied ?? [];
        const landed = applied.reduce((sum, a) => sum + (a.quantity || 0), 0);
        setPartial({
          message:
            applied.length > 0
              ? `Only part could be received — ${formatNumber(landed)} unit(s) across ${applied.length} line(s) landed. The rest is shown below; receive again to finish it.`
              : err?.message || 'This receive could not be applied. Refresh and retry the remaining lines.',
        });
        await load();
      } else {
        // Only an answer that ENDS the operation mints a new key; a transport failure
        // and a still-in-flight claim both keep it. See `lib/idempotency.ts`.
        if (endsOperation(err)) submitKey.current = null;
        const e = err as { code?: string | null; message?: string } | null;
        const code = e?.code;
        setFormError((CODE_MESSAGES[code ?? ''] ?? e?.message) || 'The receive could not be completed.');
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen scroll keyboard>
      <Card>
        <View style={styles.titleRow}>
          <Text style={styles.number} numberOfLines={1}>
            {po.number}
          </Text>
          <PoStatusBadge status={po.status} />
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {po.location?.name ? `Receives into ${po.location.name}` : 'Receives into the order location'}
          </Text>
          {po.supplier?.name ? <Text style={styles.meta}>{po.supplier.name}</Text> : null}
        </View>
      </Card>

      <Banner type="error" text={formError} />
      <Banner type="warn" text={partial?.message} />

      {loading ? <Banner type="info" text="Refreshing the order…" /> : null}

      <SectionHeader title="Receive quantities" style={styles.section} />
      <View style={styles.lineList}>
        {entries.map((e) => (
          <View key={e.line.productId} style={styles.lineCard}>
            <ListRow
              style={styles.lineRow}
              leading={<Icon name="cube" color={colors.primary} size={22} />}
              title={e.line.productName ?? 'Unknown product'}
              subtitle={e.line.sku ? `SKU · ${e.line.sku}` : undefined}
              footer={
                // Ordered/received context stays at body size (never the smaller subtitle size).
                <Text style={styles.lineQty}>
                  Ordered {formatNumber(e.line.quantityOrdered)} · Received {formatNumber(e.line.quantityReceived)}
                </Text>
              }
            />
            <Input
              name={e.line.productId}
              label="Receive quantity"
              value={quantities[e.line.productId]}
              onChangeText={(v) => onChangeQty(e.line.productId, v)}
              keyboardType="number-pad"
              placeholder={`0–${e.line.offered}`}
              error={e.kind === 'invalid' ? e.msg : undefined}
              helper={`Remaining on this line: ${formatNumber(e.line.offered)}. Set 0 to skip.`}
            />
          </View>
        ))}
      </View>

      <Input
        name="reference"
        label="Reference (optional)"
        value={reference}
        onChangeText={setReference}
        placeholder="e.g. delivery note or invoice #"
        maxLength={200}
        autoCapitalize="none"
      />

      <Button title={buttonTitle} onPress={submit} loading={busy} disabled={!canSubmit} full />
      <Text style={styles.hint}>
        Stock lands at the order&apos;s location and is recorded in inventory history. The server enforces remaining quantities
        and concurrency — the order flips to Received when complete.
      </Text>
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    number: { ...type.h2, color: colors.text, flex: 1, fontVariant: ['tabular-nums'] },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
    meta: { ...type.caption, color: colors.textMuted },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.lg },
    // SectionHeader brings its own bottom margin; sections keep the top gap.
    section: { marginTop: spacing.xxl },
    lineList: { gap: spacing.md },
    lineCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      marginBottom: spacing.md,
    },
    // Preserves the gap between the line header and its quantity input.
    lineRow: { marginBottom: spacing.md },
    // Ordered/received context is a key quantity: body size with tabular figures.
    lineQty: { ...type.body, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg, lineHeight: 18 },
  });
