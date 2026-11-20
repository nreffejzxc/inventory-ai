import { useCallback, useMemo, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import { CenterLoader, EmptyState, ErrorState } from '../../components/ListState';
import ListRow from '../../components/ListRow';
import Screen from '../../components/Screen';
import SectionHeader from '../../components/SectionHeader';
import { useSession } from '../../lib/auth';
import { confirm } from '../../lib/confirm';
import { errorRequestId, errorText } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  checkPendingOperation,
  listPendingOperations,
  retryPendingOperation,
  type PendingOperationCheck,
  type PendingOperationState,
  type PendingOperationView,
  type IdempotencyKind,
} from '../../lib/idempotency';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

const KIND_LABELS: Record<IdempotencyKind, string> = {
  'product.create': 'New product',
  'purchase-order.create': 'New purchase order',
  'reference.create': 'New reference record',
  'stock-in': 'Stock in',
  'stock-out': 'Stock out',
  adjust: 'Stock adjustment',
  transfer: 'Stock transfer',
  'purchase-order.receive': 'Purchase order receipt',
};

function kindLabel(kind: IdempotencyKind): string {
  return KIND_LABELS[kind] ?? 'Inventory operation';
}

const STATE_TONE: Record<PendingOperationState, 'info' | 'warn' | 'success'> = {
  COMPLETED: 'success',
  PROCESSING: 'info',
  RECOVERY_PENDING: 'info',
  REQUIRES_ATTENTION: 'warn',
  UNKNOWN: 'info',
};

function stateText(check: PendingOperationCheck): string {
  switch (check.state) {
    case 'COMPLETED':
      return 'Completed. This device has removed its record.';
    case 'PROCESSING':
      return 'The server is still processing this request. Check again in a moment.';
    case 'RECOVERY_PENDING':
      return 'The server is checking whether this request already changed stock. Check again before retrying.';
    case 'REQUIRES_ATTENTION':
      return check.reference
        ? `This operation needs a person to verify it. Do not repeat it. Quote reference ${check.reference}.`
        : 'This operation needs a person to verify it. Do not repeat it.';
    default:
      return 'The server could not determine the state. Check again before retrying.';
  }
}

export default function PendingOperationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, token } = useSession();
  const userId = user?.id;
  const [items, setItems] = useState<PendingOperationView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, PendingOperationCheck>>({});

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await listPendingOperations(userId));
      setLoaded(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function check(item: PendingOperationView): Promise<void> {
    if (!token) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const result = await checkPendingOperation(user?.id, item.id, token);
      setChecks((current) => ({ ...current, [item.id]: result }));
      if (result.state === 'COMPLETED') {
        setNotice('That operation was already completed. Its record has been removed from this device.');
        await load();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  async function retry(item: PendingOperationView): Promise<void> {
    if (!token) return;
    const ok = await confirm(
      'Retry this operation?',
      'Inventory AI will resend the same request. If the first attempt already landed, the server returns its original result instead of applying it twice.',
      { confirmText: 'Retry' },
    );
    if (!ok) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      await retryPendingOperation(user?.id, item.id, token);
      setNotice('The operation finished and its record has been removed from this device.');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  const body = (() => {
    if (!loaded && loading) return <CenterLoader label="Reading unfinished operations…" />;
    if (error && !loaded) {
      return (
        <ErrorState
          title="Could not read unfinished operations"
          message={errorText(error)}
          requestId={errorRequestId(error)}
          onRetry={() => void load()}
        />
      );
    }
    if (items.length === 0) {
      return (
        <EmptyState
          icon="time"
          title="Nothing is waiting"
          message="Unfinished stock changes and new records appear here after an interrupted or uncertain request."
          action={
            <Button title="Back to Profile" variant="secondary" onPress={() => router.push('/profile')} />
          }
        />
      );
    }
    return (
      <>
        {items.map((item) => {
          const checkResult = checks[item.id];
          const busy = busyId === item.id;
          return (
            <Card key={item.id} style={styles.card}>
              <ListRow
                title={item.label}
                subtitle={`${kindLabel(item.kind)} · started ${formatDateTime(item.createdAt)}`}
              />
              {checkResult ? (
                <Banner
                  type={STATE_TONE[checkResult.state]}
                  text={stateText(checkResult)}
                  style={styles.statusBanner}
                />
              ) : null}
              <View style={styles.actions}>
                <Button
                  title="Check status"
                  variant="secondary"
                  loading={busy}
                  disabled={busy}
                  onPress={() => void check(item)}
                  style={styles.action}
                />
                {item.requestAvailable ? (
                  <Button
                    title="Retry"
                    loading={busy}
                    disabled={busy}
                    onPress={() => void retry(item)}
                    style={styles.action}
                  />
                ) : null}
              </View>
              {!item.requestAvailable ? (
                <Text style={styles.note}>
                  This operation cannot be retried from here. Open its original screen and submit the same
                  details again.
                </Text>
              ) : null}
            </Card>
          );
        })}
      </>
    );
  })();

  return (
    <Screen scroll refreshing={loading && items.length > 0} onRefresh={() => void load()}>
      <SectionHeader title="Unfinished operations" />
      <Card style={styles.intro}>
        <Text style={styles.introText}>
          A request can be interrupted after the server applied it but before this phone received the answer.
          These records let you check or safely retry that exact request. The app never shows the private request
          key.
        </Text>
      </Card>
      {notice ? <Banner type="success" text={notice} /> : null}
      <Banner type="error" text={error ? errorText(error) : null} requestId={errorRequestId(error)} />
      {body}
      {items.length > 0 ? (
        <Text style={styles.footnote}>
          Records disappear after they finish or after 24 hours. A record that needs review is left in place and
          is never retried automatically.
        </Text>
      ) : null}
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    intro: { marginBottom: spacing.lg },
    introText: { ...type.body, color: colors.textSecondary, lineHeight: 22 },
    card: { marginBottom: spacing.lg },
    statusBanner: { marginTop: spacing.md, marginBottom: 0 },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    action: { flex: 1 },
    note: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 18 },
    footnote: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 18 },
  });
