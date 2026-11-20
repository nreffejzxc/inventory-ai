import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Badge from './Badge';
import Banner from './Banner';
import Button from './Button';
import Card from './Card';
import Chip from './Chip';
import Input from './Input';
import Screen from './Screen';
import SelectField from './SelectField';
import type { SelectOption } from './SelectField';
import { usersApi } from '../lib/api';
import type { ApiResponse, UserInput } from '../lib/api';
import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import type { AuthUser } from '../lib/auth';
import { errorRequestId } from '../lib/errors';
import { confirm } from '../lib/confirm';
import { assignableRoles, canModifyUser, roleLabel } from '../lib/permissions';
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

const STATUS_ACTIVE = 'ACTIVE';
const STATUS_DISABLED = 'DISABLED';

/** Why `actor` cannot edit `target` (server codes CANNOT_MODIFY_SELF / OWNER_IMMUTABLE / ADMIN_RESTRICTED). */
function blockReason(actor: AuthUser | null, target: ApiResponse): string {
  if (String(actor?.id) === String(target.id)) return 'You cannot change your own role or status.';
  if (target.role === 'OWNER') return 'The business owner cannot be modified.';
  return 'Admins cannot modify or assign other admins.';
}

export interface UserFormProps {
  initial?: ApiResponse;
}

/**
 * Create/edit form for business users (Phase 14B). Backend is authoritative —
 * this validates input for a good UX and surfaces the server's problems on
 * submit. Create takes name/email/password/role; edit changes only role/status
 * (the PATCH endpoint accepts no other fields). Role options are gated by the
 * actor's own role (OWNER assigns ADMIN/MANAGER/STAFF; ADMIN only MANAGER/STAFF).
 */
export default function UserForm({ initial }: UserFormProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user: actor, token } = useSession();
  const isEdit = Boolean(initial);

  const [name, setName] = useState<string>(initial?.name ?? '');
  const [email, setEmail] = useState<string>(initial?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<string>(initial?.role ?? '');
  const [status, setStatus] = useState<string>(initial?.status ?? STATUS_ACTIVE);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A target the actor is not allowed to modify (self / OWNER / ADMIN-for-ADMIN)
  // renders read-only — the list hides Edit, this guards deep links.
  if (isEdit && !canModifyUser(actor, initial)) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Banner type="error" text={blockReason(actor, initial)} />
        <Card>
          <TextRow label="Name" value={initial.name} />
          <TextRow label="Email" value={initial.email} />
          <View style={styles.roleRow}>
            <TextRow label="Role" value={roleLabel(initial.role)} />
            <Badge
              text={initial.status === STATUS_ACTIVE ? 'Active' : 'Disabled'}
              tone={initial.status === STATUS_ACTIVE ? 'success' : 'neutral'}
            />
          </View>
        </Card>
        <Button title="Back to users" variant="secondary" style={styles.spaced} full onPress={() => router.back()} />
      </Screen>
    );
  }

  const roleOptions: SelectOption[] = assignableRoles(actor).map((r) => ({ value: r, label: roleLabel(r) }));
  const nothingChanged = isEdit && role === initial.role && status === initial.status;

  async function submit(): Promise<void> {
    // Client-side pre-checks (friendly, mirrors the server rules).
    const problems: Record<string, string | undefined> = {};
    if (isEdit) {
      // Edit mode only touches role/status; selection is always valid.
    } else {
      if (!name.trim()) problems.name = 'Name is required';
      if (!email.trim()) problems.email = 'Email is required';
      if (!password) problems.password = 'Password is required';
      else if (password.length < 8) problems.password = 'Password must be at least 8 characters';
      if (confirmPassword !== password) problems.confirm = 'Passwords do not match';
      if (!role) problems.role = 'Choose a role';
    }
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    // Disabling is a destructive-feeling action (access revoked immediately).
    if (isEdit && status === STATUS_DISABLED && initial.status !== STATUS_DISABLED) {
      const ok = await confirm('Disable this user?', 'They will lose access immediately. You can re-enable them later.', {
        confirmText: 'Disable',
        destructive: true,
      });
      if (!ok) return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      if (isEdit) {
        const body: UserInput = {};
        if (role !== initial.role) body.role = role;
        if (status !== initial.status) body.status = status;
        await usersApi.update(token as string, initial.id, body);
      } else {
        await usersApi.create(token as string, {
          name: name.trim(),
          email: email.trim(),
          password,
          role,
        });
      }
      router.back();
    } catch (err) {
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || 'Unable to save the user.');
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Banner type="error" text={formError} requestId={formRequestId} />
      <Input name="name" label="Name" value={name} onChangeText={setName} error={fieldErrors.name} required autoCapitalize="words" editable={!isEdit} />
      <Input name="email" label="Email" value={email} onChangeText={setEmail} error={fieldErrors.email} keyboardType="email-address" autoCapitalize="none" required editable={!isEdit} />

      {isEdit ? (
        <>
          <SelectField
            label="Role"
            placeholder="Choose a role…"
            options={roleOptions}
            value={role}
            onChange={setRole}
            error={fieldErrors.role}
            required
          />
          <View style={styles.statusWrap}>
            <Text style={styles.statusLabel}>Account status</Text>
            <View style={styles.statusRow}>
              <Chip label="Active" selected={status === STATUS_ACTIVE} onPress={() => setStatus(STATUS_ACTIVE)} />
              <Chip label="Disabled" selected={status === STATUS_DISABLED} onPress={() => setStatus(STATUS_DISABLED)} tone="danger" />
            </View>
          </View>
          <Button title="Save changes" onPress={submit} loading={busy} full disabled={nothingChanged} />
        </>
      ) : (
        <>
          <Input name="password" label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 8 characters" helper="Min 8 characters" error={fieldErrors.password} required />
          <Input name="confirm" label="Confirm password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry placeholder="Repeat your password" error={fieldErrors.confirm} required returnKeyType="go" onSubmitEditing={submit} />
          <SelectField label="Role" placeholder="Choose a role…" options={roleOptions} value={role} onChange={setRole} error={fieldErrors.role} required />
          <Button title="Create user" onPress={submit} loading={busy} full />
        </>
      )}
    </Screen>
  );
}

function TextRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { paddingBottom: spacing.huge },
    spaced: { marginTop: spacing.lg },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      gap: spacing.sm,
      paddingVertical: spacing.sm + 2,
    },
    roleRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    rowLabel: { ...type.body, color: colors.textMuted },
    rowValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1 },
    statusWrap: { marginBottom: spacing.lg },
    statusLabel: { ...type.label, color: colors.text, marginBottom: spacing.xs + 2 },
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  });
