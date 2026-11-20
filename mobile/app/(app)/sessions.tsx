import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import Badge from '../../components/Badge';
import Button from '../../components/Button';
import Card from '../../components/Card';
import { Icon } from '../../components/icons';
import ListRow from '../../components/ListRow';
import ListScreen from '../../components/ListScreen';
import { revokeSession, sessions as fetchSessions } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { isSessionError, useSession } from '../../lib/auth';
import { alertError, confirm } from '../../lib/confirm';
import { formatDateTime } from '../../lib/format';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/**
 * Active sessions (Phase 26A).
 *
 * Every sign-in now creates a server-side session, and this screen is the user's
 * view of them: which devices are signed in, which one is this device, and how
 * to end one — or all of them — without waiting for a password change.
 *
 * What the server sends is a strict allowlist (`id`, `current`, `deviceLabel`,
 * `createdAt`, `lastUsedAt`, `expiresAt`). No token and no `jti` ever reaches the
 * client, so there is nothing here to display that could be replayed, and this
 * screen never asks for one: `current` tells it which row is its own.
 *
 * The current session deliberately has no "sign out" button — ending it here
 * would sign the user out mid-tap. "Sign out everywhere" is the honest control
 * for that, and normal sign-out lives on the Profile screen.
 */

/** "Started Sep 8, 2026 · 14:05" plus a last-used line, or a placeholder. */
function sessionWhen(item: ApiResponse): { started: string; used: string } {
  const started = formatDateTime(item.createdAt);
  const used = item.lastUsedAt ? formatDateTime(item.lastUsedAt) : null;
  return {
    started: started ? `Signed in ${started}` : 'Sign-in time unavailable',
    used: used ? `Last active ${used}` : 'No activity recorded yet',
  };
}

function SessionRow({ item, onRevoke, revoking }: { item: ApiResponse; onRevoke: () => void; revoking: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const when = sessionWhen(item);
  return (
    <Card>
      <ListRow
        leading={
          <Icon
            name={item.current ? 'checkCircle' : 'lock'}
            size={22}
            color={item.current ? colors.success : colors.textMuted}
          />
        }
        title={item.deviceLabel}
        subtitle={when.started}
        right={
          item.current ? (
            <Badge text="This device" tone="info" dot />
          ) : (
            <Button title="Sign out" variant="secondary" onPress={onRevoke} loading={revoking} />
          )
        }
        footer={<Text style={styles.when}>{when.used}</Text>}
      />
    </Card>
  );
}

export default function SessionsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOutEverywhere } = useSession();

  const [items, setItems] = useState<ApiResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  // Not paginated: a user has a handful of devices, and the server caps the list.
  // A revoked or expired session answering 401 is handled centrally by the API
  // client (lib/client.ts → lib/auth.tsx), so this screen does not repeat that
  // decision — it just reports whatever the request said.
  const load = useCallback(
    async ({ refresh = false }: { refresh?: boolean } = {}): Promise<void> => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetchSessions(token as string);
        setItems(res?.sessions ?? []);
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token]
  );

  useEffect(() => {
    // `load` sets `loading` synchronously before its first await on purpose: the
    // initial load needs a spinner and pull-to-refresh drives a separate
    // `refreshing` flag, so neither can be derived from `items` — an empty list is
    // a legitimate "No active sessions" state, not a loading one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function onRevoke(item: ApiResponse): Promise<void> {
    const ok = await confirm(
      'Sign out this device',
      `${item.deviceLabel} will need to sign in again. Other devices stay signed in.`,
      { confirmText: 'Sign Out', destructive: true }
    );
    if (!ok) return;
    setBusyId(item.id);
    try {
      await revokeSession(token as string, item.id);
      setItems((prev) => prev.filter((s) => s.id !== item.id));
    } catch (err) {
      // A failure here would otherwise be invisible: the list is not empty, so
      // the screen-level error state never renders. A session that has itself
      // gone (401) is already handled centrally, so it needs no second message.
      if (!isSessionError(err)) {
        await alertError('Could not sign out', err, 'Could not sign out. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  }

  async function onSignOutEverywhere(): Promise<void> {
    const others = items.filter((s) => !s.current).length;
    const ok = await confirm(
      'Sign out everywhere',
      others > 0
        ? `This device and ${others} other ${others === 1 ? 'device' : 'devices'} will be signed out.`
        : 'This device will be signed out.',
      { confirmText: 'Sign Out Everywhere', destructive: true }
    );
    if (!ok) return;
    setSigningOutAll(true);
    // Ends every session server-side and clears this device's session; the
    // authenticated layout then sends the app back to login on its own.
    await signOutEverywhere();
    setSigningOutAll(false);
  }

  const header = (
    <View>
      <Card style={styles.intro}>
        <Text style={styles.introText}>
          These are the devices currently signed in to your account. Signing one out ends it
          immediately on the server, and the app on that device returns to the login screen.
        </Text>
      </Card>
      <Button
        title="Sign out everywhere"
        variant="danger"
        icon="signOut"
        style={styles.everywhere}
        loading={signingOutAll}
        onPress={onSignOutEverywhere}
      />
    </View>
  );

  return (
    <ListScreen
      items={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <SessionRow item={item} onRevoke={() => onRevoke(item)} revoking={busyId === item.id} />
      )}
      header={header}
      loading={loading}
      error={error}
      onRetry={load}
      errorTitle="Couldn't load your sessions"
      refreshing={refreshing}
      onRefresh={() => load({ refresh: true })}
      loadingLabel="Loading sessions…"
      emptyTitle="No active sessions"
      emptyMessage="Sign in again to start a new session."
    />
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    intro: { marginBottom: spacing.lg },
    introText: { ...type.bodySmall, color: colors.textSecondary },
    everywhere: { marginBottom: spacing.lg },
    when: { ...type.caption, color: colors.textMuted },
  });
