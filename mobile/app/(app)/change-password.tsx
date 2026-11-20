import { useState } from 'react';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';

import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import Input from '../../components/Input';
import Screen from '../../components/Screen';
import { changePassword } from '../../lib/api';
import { errorRequestId } from '../../lib/errors';
import { fieldErrorsFrom } from '../../lib/authCopy';
import { isSessionError, useSession } from '../../lib/auth';
import { spacing } from '../../lib/theme';
import { passwordRuleHint, passwordStrengthProblem } from '../../lib/validation';

/**
 * Change the signed-in user's password (Phase 15). The server verifies the
 * current password, then stamps passwordChangedAt — which invalidates every
 * JWT issued before it, including the one this request used. On success the
 * session is therefore cleared and the app returns to the login screen, where
 * the user signs in again with the new password.
 */
export default function ChangePasswordScreen() {
  const { token, signOut } = useSession();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    // Client-side pre-checks (friendly, mirrors the server rules).
    const problems: Record<string, string> = {};
    if (!currentPassword) problems.currentPassword = 'Current password is required';
    if (!newPassword) problems.newPassword = 'New password is required';
    else {
      // The SHARED length rule, which is how this screen gained the 72-character ceiling
      // it was missing: the minimum was checked here, the maximum only on the server, so an
      // over-long password was refused in a developer's words under the input.
      const strength = passwordStrengthProblem(newPassword);
      if (strength) problems.newPassword = strength;
    }
    // An EMPTY confirmation is reported as MISSING, not as a mismatch — the rule
    // `register.tsx` documents. "Passwords do not match" under an untouched field names the
    // wrong problem.
    if (!confirmPassword) problems.confirm = 'Confirm password is required';
    else if (confirmPassword !== newPassword) problems.confirm = 'Passwords do not match';
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      await changePassword(token as string, { currentPassword, newPassword });
      // Every prior token is now dead server-side — clear the session and the
      // auth gate returns the user to the login screen.
      await signOut();
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
      } else {
        const fields = fieldErrorsFrom(err);
        if (Object.keys(fields).length) setFieldErrors(fields);
        else {
          setFormError((err as { message?: string } | null)?.message || 'Unable to change the password.');
          setFormRequestId(errorRequestId(err));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Change Password' }} />
      <Screen scroll contentStyle={styles.content}>
        <Banner type="error" text={formError} requestId={formRequestId} />
        <Card>
          <Input
            name="currentPassword"
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            placeholder="Your current password"
            error={fieldErrors.currentPassword}
            required
            autoCapitalize="none"
          />
          <Input
            name="newPassword"
            label="New password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            placeholder="At least 8 characters"
            helper={passwordRuleHint(newPassword)}
            error={fieldErrors.newPassword}
            required
            autoCapitalize="none"
          />
          <Input
            name="confirm"
            label="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            placeholder="Repeat your new password"
            error={fieldErrors.confirm}
            required
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </Card>
        <Button title="Change password" onPress={submit} loading={busy} full />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.huge },
});
