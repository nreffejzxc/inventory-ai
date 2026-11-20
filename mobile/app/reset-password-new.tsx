import { useMemo, useState } from 'react';
import { Link, router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import Input from '../components/Input';
import { confirmPasswordResetCode } from '../lib/api';
import { useSession } from '../lib/auth';
import { fieldErrorsFrom } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { clearVerifiedReset, readVerifiedReset } from '../lib/passwordResetSession';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { passwordRuleHint, passwordStrengthProblem } from '../lib/validation';

/**
 * AUTH-06 (two-step recovery) — STEP TWO: choose the new password.
 *
 * WHY IT IS A SEPARATE SCREEN. Step one proves control of the mailbox; this step chooses the
 * credential. Keeping them apart means the code field cannot be confused with the password fields,
 * the errors land on the thing that was actually wrong, and the password is typed only after the
 * server has confirmed the person may type one.
 *
 * IT CANNOT AUTHORIZE ITSELF. Reaching this screen proves nothing: the only input it holds is the
 * short-lived authorization `verifyPasswordResetCode` minted, read from memory. With no
 * authorization it renders the "verify again" state instead of a form, and even if the form were
 * reached by navigation, `POST /api/auth/password-reset/confirm` refuses anything that is not a
 * live, unused, unexpired authorization bound to an account.
 *
 * A SUCCESSFUL RESET SIGNS NOBODY IN. The server has already ended every session, so the truthful
 * next step is signing in with the new password — which is also what proves to the person that the
 * change took effect. This device's stored session is cleared first, because otherwise *Go to sign
 * in* would reach `/login`, which redirects into the app on a session the server has already ended.
 */
const RESET_COMPLETED = 'Password changed. Please sign in again.';
const GENERIC_FAILURE = 'Something went wrong. Please try again.';
const EXPIRED_COPY = 'That verification has expired. Verify your reset code again to continue.';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    footerText: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    link: { color: colors.link, fontWeight: '700' },
    body: {
      ...type.body,
      color: colors.textSecondary,
      alignSelf: 'stretch',
      marginBottom: spacing.lg,
    },
  });

export default function ResetPasswordNewScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /**
   * Read ONCE, at mount, and deliberately not persisted: the verification belongs to this journey.
   * `readVerifiedReset` returns `null` for an authorization past its window, so an expired journey
   * is answered here rather than by a request that can only fail.
   */
  const [verified, setVerified] = useState(() => readVerifiedReset());

  const { clearSession } = useSession();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  /** Editing a field clears its own message — the same rule as Login and Register. */
  function editField(field: string, setValue: (value: string) => void) {
    return (value: string): void => {
      setValue(value);
      if (fieldErrors[field]) {
        setFieldErrors((current) => {
          const next = { ...current };
          delete next[field];
          return next;
        });
      }
    };
  }

  if (!verified && !done) {
    return (
      <AuthLayout title="Verify your code first" subtitle="This step needs a verified reset code.">
        <Banner type="error" text={EXPIRED_COPY} />
        <Button title="Start again" onPress={() => router.replace('/forgot-password')} full />
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password changed" subtitle="Sign in with your new password.">
        <Banner type="success" text={RESET_COMPLETED} />
        <Button title="Go to sign in" onPress={() => router.replace('/login')} full />
      </AuthLayout>
    );
  }

  async function submit(): Promise<void> {
    // The confirmation is checked HERE as well as on the server, because a mistyped confirmation
    // must never reach the credential write — the server also refuses it before spending the
    // authorization, and this check is what keeps that refused request from being made at all.
    const problems: Record<string, string> = {};
    if (!newPassword) problems.newPassword = 'New password is required';
    else {
      const strength = passwordStrengthProblem(newPassword);
      if (strength) problems.newPassword = strength;
    }
    if (!confirmPassword) problems.confirmPassword = 'Confirm password is required';
    else if (confirmPassword !== newPassword)
      problems.confirmPassword = 'Passwords do not match';
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    if (!verified) return;

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      await confirmPasswordResetCode({
        resetToken: verified.resetToken,
        newPassword,
        confirmPassword,
      });
      // The authorization is spent and the password is set: forget it before anything else can
      // read it, then drop this device's session — see the header for why the second half matters.
      clearVerifiedReset();
      await clearSession();
      setDone(true);
    } catch (err) {
      const code = (err as { code?: string | null } | null)?.code;
      if (code === 'INVALID_PASSWORD_RESET_AUTHORIZATION') {
        // Definitive: this authorization is gone. Keeping the form would invite a retry that can
        // only fail, so the journey restarts at the code.
        clearVerifiedReset();
        setVerified(null);
        setFormError(EXPIRED_COPY);
        return;
      }
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || GENERIC_FAILURE);
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle={
        verified?.email
          ? `Your code was verified for ${verified.email}. Choose the password you will sign in with.`
          : 'Choose the password you will sign in with.'
      }
      footer={
        <Text style={styles.footerText}>
          Remembered it?{' '}
          <Link href="/login" style={styles.link}>
            Sign in
          </Link>
        </Text>
      }
    >
      <Banner type="error" text={formError} requestId={formRequestId} />
      <Input
        name="newPassword"
        label="New password"
        value={newPassword}
        onChangeText={editField('newPassword', setNewPassword)}
        secureTextEntry
        placeholder="At least 8 characters"
        helper={passwordRuleHint(newPassword)}
        error={fieldErrors.newPassword}
        required
        autoCapitalize="none"
        // The platform's password manager can offer a new, generated credential only if the
        // field declares that this is what it is — the same reason Login declares `current-password`.
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Input
        name="confirmPassword"
        label="Confirm new password"
        value={confirmPassword}
        onChangeText={editField('confirmPassword', setConfirmPassword)}
        secureTextEntry
        placeholder="Repeat your new password"
        error={fieldErrors.confirmPassword}
        required
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button title="Set new password" onPress={submit} loading={busy} full />
      <Text style={styles.body}>
        Your old password stops working immediately, and every device signed in to this account is
        signed out.
      </Text>
      <Text style={styles.footerText}>
        Wrong account?{' '}
        <Text
          style={styles.link}
          onPress={() => {
            clearVerifiedReset();
            router.replace('/forgot-password');
          }}
        >
          Start over
        </Text>
      </Text>
    </AuthLayout>
  );
}
