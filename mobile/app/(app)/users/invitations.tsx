import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Badge from '../../../components/Badge';
import Banner from '../../../components/Banner';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import Input from '../../../components/Input';
import ListRow from '../../../components/ListRow';
import Screen from '../../../components/Screen';
import SelectField from '../../../components/SelectField';
import type { SelectOption } from '../../../components/SelectField';
import { Icon } from '../../../components/icons';
import { invitationsApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import { ApiError } from '../../../lib/client';
import { confirm } from '../../../lib/confirm';
import { errorRequestId as requestIdOf } from '../../../lib/errors';
import { assignableRoles, canManageUsers, roleLabel } from '../../../lib/permissions';
import { formatDate } from '../../../lib/format';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';
import { emailProblem } from '../../../lib/validation';

/**
 * Pending invitations (2026-10-25).
 *
 * WHY THIS SCREEN EXISTS. Before it, the only way to add a colleague was `New User`,
 * which makes an admin invent somebody else's password and hand it over. An invitation
 * replaces that with the person choosing their own credential: the admin names an address
 * and a role, the invitee proves the address with the six-digit code and creates their
 * own account on the invitation's terms.
 *
 * WHAT IT SHOWS: the live invitations of THIS business, resolved from the session on the
 * server — there is no business id in any request this screen makes. Expired and revoked
 * rows are filtered out server-side, so "pending" here means "still redeemable".
 *
 * WHAT IT NEVER SHOWS OR ACCEPTS: the token. It exists only in the mail and in the
 * invitee's memory; the management surface lists the address, the role and the expiry.
 *
 * THE ROLE OPTIONS COME FROM `assignableRoles`, the same helper `UserForm` uses, so an
 * ADMIN cannot offer ADMIN here any more than the direct-create route could accept it.
 * The server refuses it independently — this only avoids a request that can only fail.
 *
 * SENDING IS NOT A SILENT SUCCESS. The server writes the row, mails it, and WITHDRAWS the
 * row if delivery fails, so a 201 here means the message left the building. A 503 means
 * mail is not configured at all and names that; a 502 means the provider refused it. Both
 * are shown with their own sentence rather than a generic failure.
 */

const EMAIL_IN_USE = 'INVITATION_EMAIL_IN_USE';

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    sectionTitle: { ...type.h3, color: colors.text, marginTop: spacing.xl, marginBottom: spacing.sm },
    hint: { ...type.bodySmall, color: colors.textMuted, marginBottom: spacing.md },
    rowActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    empty: { ...type.body, color: colors.textMuted, paddingVertical: spacing.lg },
    roleBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
    formCard: { marginBottom: spacing.md },
  });

/** One pending invitation. Never its token, which this screen never receives. */
function InvitationRow({
  item,
  onRevoke,
  busy,
}: {
  item: ApiResponse;
  onRevoke: (item: ApiResponse) => void;
  busy: boolean;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Card>
      <ListRow
        leading={<Icon name="people" color={colors.primary} size={22} />}
        title={item.email}
        subtitle={`Expires ${formatDate(item.expiresAt)}`}
      />
      <View style={styles.roleBadges}>
        <Badge text={roleLabel(item.role)} tone="info" />
        <Badge text="Pending" tone="neutral" />
      </View>
      <View style={styles.rowActions}>
        <Button title="Revoke" variant="secondary" onPress={() => onRevoke(item)} loading={busy} />
      </View>
    </Card>
  );
}

export default function InvitationsScreen() {
  const { user } = useSession();

  if (!canManageUsers(user)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Invitations' }} />
        <AccessDenied message="Only the business owner and admins can invite people." />
      </>
    );
  }

  return <InvitationsManager />;
}

function InvitationsManager() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, token, signOut } = useSession();
  const authToken = token as string;

  const [items, setItems] = useState<ApiResponse[]>([]);
  const [loading, setLoading] = useState(true);
  // Pull-to-refresh is its own flag: `loading` renders the first-load label, and a
  // refresh must not replace the list with that label while the gesture is still running.
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequestId, setLoadRequestId] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const roleOptions: SelectOption[] = assignableRoles(user).map((r) => ({
    value: r,
    label: roleLabel(r),
  }));

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setLoadRequestId(null);
    try {
      const result = await invitationsApi.list(authToken);
      setItems(Array.isArray(result?.items) ? result.items : []);
    } catch (err) {
      // A 401 means the session is gone; every other failure is shown and retryable.
      if (err instanceof ApiError && err.status === 401) {
        await signOut();
        return;
      }
      setLoadError((err as { message?: string } | null)?.message || "Couldn't load invitations.");
      setLoadRequestId(requestIdOf(err));
    } finally {
      setLoading(false);
    }
  }, [authToken, signOut]);

  useEffect(() => {
    // `load` sets `loading` synchronously before its first await on purpose: the
    // initial state needs a loading label, and an empty list is a legitimate "no one is
    // waiting to join" state, so the two cannot be derived from `items` alone.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Correcting a field clears its own message and nothing else — the rule the auth
   * screens have followed since 2026-10-23, applied here so a stale field error cannot
   * outlive the value that produced it.
   */
  function clearField(field: 'email' | 'role'): void {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function send(): Promise<void> {
    const problems: Record<string, string> = {};
    const emailIssue = emailProblem(email);
    if (emailIssue) problems.email = emailIssue;
    if (!role) problems.role = 'Choose a role';
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setNotice(null);
    setFieldErrors({});
    try {
      await invitationsApi.create(authToken, { email: email.trim(), role });
      setNotice(`Invitation sent to ${email.trim()}.`);
      setEmail('');
      setRole('');
      await load();
    } catch (err) {
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else if (err instanceof ApiError && err.code === EMAIL_IN_USE) setFieldErrors({ email: err.message });
      else {
        setFormError((err as { message?: string } | null)?.message || 'Unable to send the invitation.');
        setFormRequestId(requestIdOf(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: ApiResponse): Promise<void> {
    const ok = await confirm(
      'Revoke this invitation?',
      `The link sent to ${item.email} will stop working immediately. You can invite them again later.`,
      { confirmText: 'Revoke', destructive: true }
    );
    if (!ok) return;
    setRevoking(String(item.id));
    setFormError(null);
    setFormRequestId(null);
    setNotice(null);
    try {
      await invitationsApi.revoke(authToken, String(item.id));
      setNotice(`Invitation for ${item.email} revoked.`);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await signOut();
        return;
      }
      setFormError((err as { message?: string } | null)?.message || 'Unable to revoke that invitation.');
      setFormRequestId(requestIdOf(err));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Invitations' }} />
      <Screen
        scroll
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
      >
        <Banner
          type="error"
          text={formError || loadError}
          requestId={formError ? formRequestId : loadRequestId}
        />
        <Banner type="success" text={notice} />

        <Card style={styles.formCard}>
          <Input
            name="email"
            label="Colleague's email"
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              clearField('email');
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="colleague@company.com"
            error={fieldErrors.email}
            helper="They will choose their own password after verifying this address."
            required
          />
          <SelectField
            label="Role"
            placeholder="Choose a role…"
            options={roleOptions}
            value={role}
            onChange={(value) => {
              setRole(value);
              clearField('role');
            }}
            error={fieldErrors.role}
            required
          />
          <Button title="Send invitation" icon="add" onPress={send} loading={busy} full />
        </Card>

        <Text style={styles.sectionTitle}>Pending invitations</Text>
        <Text style={styles.hint}>
          Invitations expire after seven days. Sending a new one to the same address replaces the old
          link.
        </Text>

        {loading ? <Text style={styles.empty}>Loading invitations…</Text> : null}
        {!loading && items.length === 0 ? (
          <Text style={styles.empty}>No one is waiting to join. Invite a colleague above.</Text>
        ) : null}
        {items.map((item) => (
          <InvitationRow
            key={String(item.id)}
            item={item}
            onRevoke={revoke}
            busy={revoking === String(item.id)}
          />
        ))}
      </Screen>
    </>
  );
}
