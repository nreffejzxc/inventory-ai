import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { StyleSheet } from 'react-native';

import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import Input from '../../components/Input';
import Screen from '../../components/Screen';
import { updateMe } from '../../lib/api';
import { ApiError } from '../../lib/client';
import { errorRequestId } from '../../lib/errors';
import { useSession } from '../../lib/auth';
import { spacing } from '../../lib/theme';

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

/**
 * Edit the signed-in user's display name (Phase 15). PATCH /api/auth/me accepts
 * ONLY `name` — identity comes from the authenticated session, and the server
 * rejects every other field. After a successful save the session user is
 * refreshed from /api/auth/me.
 */
export default function EditNameScreen() {
  const { user, token, refresh } = useSession();

  const [name, setName] = useState(user?.name ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldErrors({ name: 'Name is required' });
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      await updateMe(token as string, { name: trimmed });
      await refresh(); // re-fetch /api/auth/me so the session user reflects the new name
      router.back();
    } catch (err) {
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || 'Unable to update your name.');
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Edit Name' }} />
      <Screen scroll contentStyle={styles.content}>
        <Banner type="error" text={formError} requestId={formRequestId} />
        <Card>
          <Input
            name="name"
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="Your display name"
            error={fieldErrors.name}
            required
            autoCapitalize="words"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </Card>
        <Button title="Save changes" onPress={submit} loading={busy} full />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.huge },
});
