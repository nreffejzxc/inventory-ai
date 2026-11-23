import { useMemo, useState } from 'react';
import { Stack, router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import Input from '../../components/Input';
import Screen from '../../components/Screen';
import { fieldErrorsFrom } from '../../lib/authCopy';
import { errorRequestId } from '../../lib/errors';
import { isSessionError, useSession } from '../../lib/auth';
import { DELETE_CONFIRMATION, deleteMyAccount } from '../../lib/accountDeletion';
import { purgeProductImportDraft } from '../../lib/productImportDraft';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/**
 * Delete my account (2026-10-24).
 *
 * WHY THIS SCREEN IS DELIBERATELY UNFRIENDLY. Deletion is irreversible for the person
 * and partially irreversible for the business's history, so it asks for three separate
 * things rather than one tap: the destructive action named in words, the typed word
 * DELETE, and a re-authentication credential. None of that is the security boundary —
 * the server re-checks all of it and derives the account from the session — but a screen
 * that made this easy to do by accident would be a worse screen.
 *
 * WHAT IT TELLS THE PERSON BEFORE THEY COMMIT. Exactly what goes (name, address,
 * password, Firebase identity, sessions, reset codes, assistant conversations) and what
 * stays (the business's own stock history and audit trail, with their identity removed).
 * A deletion prompt that only says "are you sure?" asks somebody to trust a summary they
 * cannot see.
 *
 * IT DOES NOT KNOW WHETHER THE ACCOUNT IS FIREBASE-LINKED. The server publishes
 * `authMethods`, and the screen reads the `firebase` capability from it: true means the
 * identity provider will be asked to confirm, false means a password field is shown.
 * The decision is never inferred from an email domain or a provider name.
 *
 * THE REFUSALS ARE NOT SIGN-OUTS. A wrong word, wrong password, mismatched identity and
 * the last-owner 409 are all shown here, and the session stays. Only a 401 — the session
 * genuinely gone — ends it, which `isSessionError` decides.
 */
export default function DeleteAccountScreen() {
  const { token, user, signOut } = useSession();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const firebase = user?.authMethods?.firebase === true;

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const problems: Record<string, string> = {};
    if (!firebase && !password) problems.currentPassword = 'Your current password is required';
    if (!confirmation.trim()) problems.confirmation = 'Type DELETE to confirm';
    else if (confirmation.trim() !== DELETE_CONFIRMATION) {
      problems.confirmation = `Type ${DELETE_CONFIRMATION} exactly`;
    }
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      setFormError(null);
      setFormRequestId(null);
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      await deleteMyAccount({
        token: token as string,
        confirmation,
        firebase,
        password: firebase ? undefined : password,
      });

      // The server has already ended every session and deleted the credential. Clearing
      // locally is what stops the app rendering a signed-in shell for an account that no
      // longer exists; the sign-out request it makes is allowed to fail.
      // The account-scoped import draft contains product data and has no owner after
      // deletion. Best-effort: cleanup must not keep a deleted account signed in.
      // Unlike completion and Discard, account deletion must not depend on a
      // readable metadata record. The purge removes the account's CSV even when
      // SecureStore metadata deletion fails; completion and Discard keep using
      // the expected-key-protected clear.
      await purgeProductImportDraft(user?.id).catch(() => false);
      await signOut();
      router.replace('/login');
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
        return;
      }
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) {
        setFieldErrors(fields);
      } else {
        setFormError(
          (err as { message?: string } | null)?.message || 'Unable to delete the account.'
        );
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Delete account' }} />
      <Screen scroll contentStyle={styles.content}>
        <Banner
          type="warn"
          text={
            'This permanently closes your account — and your business, if you are its only ' +
            'member. It cannot be undone.'
          }
        />
        <Banner type="error" text={formError} requestId={formRequestId} />

        <Card>
          {/* The most likely reader of this screen is a sole proprietor, and for them the
              business goes too. That consequence is stated FIRST: a summary that opens with
              "what is deleted" reads as though only the person's own details are at stake. */}
          <Text style={styles.heading}>If you are the only member</Text>
          <Text style={styles.body}>
            Closing the account of a business&apos;s only member closes the business as well: its
            products, stock, movements, purchase orders, suppliers and history are deleted with it.
            There would be nobody left to own them. Everything below still applies to you.
          </Text>

          <Text style={styles.heading}>What is deleted</Text>
          <Text style={styles.body}>
            Your name and email address, your password and any Google sign-in connection, every
            signed-in session, your pending verification and reset codes, and your assistant
            conversations.
          </Text>

          <Text style={styles.heading}>What stays, if others still use your business</Text>
          <Text style={styles.body}>
            Its stock levels, stock movements, purchase orders and audit trail stay with it,
            because deleting them would make its inventory history wrong for everyone else. They
            no longer identify you. If somebody else remains but nobody else is an owner, the app
            asks you to make them an owner first — a business must always have an owner.
          </Text>
        </Card>

        <Card>
          {firebase ? (
            <Text style={styles.body}>
              We will confirm this with your sign-in. You do not need to type your password.
            </Text>
          ) : (
            <Input
              name="currentPassword"
              label="Current password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="Your current password"
              error={fieldErrors.currentPassword}
              required
              autoCapitalize="none"
            />
          )}

          <Input
            name="confirmation"
            label={`Type ${DELETE_CONFIRMATION} to confirm`}
            value={confirmation}
            onChangeText={setConfirmation}
            placeholder={DELETE_CONFIRMATION}
            error={fieldErrors.confirmation}
            autoCapitalize="characters"
            autoCorrect={false}
            required
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </Card>

        <Button
          title="Delete my account"
          variant="danger"
          onPress={submit}
          loading={busy}
          // NOT disabled on an untyped confirmation. A disabled primary action with no
          // explanation is where an accessibility user gets stuck: it cannot be focused,
          // so it cannot announce why. The press is harmless — `submit()` refuses a blank
          // or mistyped word before any request — and the refusal is SAID under the field.
          disabled={busy}
          full
        />
        <View style={styles.footer}>
          <Text style={styles.footnote}>
            Changed your mind? Go back. Nothing has happened yet.
          </Text>
        </View>
      </Screen>
    </>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { paddingBottom: spacing.huge },
    heading: {
      ...type.label,
      color: colors.text,
      marginBottom: spacing.xs,
      marginTop: spacing.sm,
    },
    body: {
      ...type.body,
      color: colors.textMuted,
      marginBottom: spacing.md,
    },
    footer: { marginTop: spacing.lg },
    footnote: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
  });
