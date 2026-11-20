import { useMemo, useState } from 'react';
import { Link, router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import Input from '../components/Input';
import { requestPasswordResetCode } from '../lib/api';
import { fieldErrorsFrom } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { emailProblem } from '../lib/validation';

/**
 * Request a six-digit password-reset code (AUTH-06). PUBLIC — a sibling of login/register,
 * deliberately outside the `(app)` group, so it renders whether or not a session exists.
 *
 * WHAT CHANGED, AND WHY. This screen used to ask Firebase to email a reset LINK, and a build with
 * no Firebase configuration fell back to the custom 26B endpoint. Both are gone from this path:
 *
 *   * the link's destination could no longer be configured — the project's email-template editor
 *     refuses every write (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`) — so the "return to the app" half
 *     of that design was unbuildable; and
 *   * even when Firebase's email does arrive, it leads to a BROWSER form and revokes nothing.
 *
 * The server now mints and mails the code itself (through Brevo, the provider already used for the
 * account-verification code), and the next screen takes the code and the new password. So this
 * screen sends ONE request, has ONE path, and cannot end in a browser.
 *
 * THE SUCCESS STATE IS A NAVIGATION, NOT A MESSAGE, because the code screen is where the journey
 * actually continues — and it opens for an unknown address exactly as it opens for a known one,
 * which is what keeps the request path enumeration-proof end to end.
 *
 * THE RESPONSE BODY IS NEVER READ. The server answers one 202 and one sentence whether or not the
 * address exists, and whether or not the mail was delivered (the send is detached). Rendering that
 * body would be the one place this client could undo the guarantee, so it does not read it.
 */
const DEV_DIAGNOSTIC_PREFIX = 'Diagnostic (dev only) — ';

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
    diagnostic: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      marginBottom: spacing.sm,
    },
  });

export default function ForgotPasswordScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set on every failure, rendered only under `__DEV__`. The sentence a person sees is reduced to
  // safe copy, which is right for them and useless for an operator; the application code is shown
  // here because it is the first thing worth knowing and it carries no address, code or token.
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const value = email.trim();
    // PRESENCE AND SHAPE, from the one shared client rule (`lib/validation.ts`), which mirrors the
    // server's own and is pinned to it by `__tests__/auth-validation-rules.test.ts`. Refusing a
    // malformed address here is what distinguishes a typo from an empty field before a request.
    const emailIssue = emailProblem(value);
    if (emailIssue) {
      setFieldErrors({ email: emailIssue });
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    setDiagnostic(null);
    try {
      await requestPasswordResetCode(value);
      /**
       * The code screen is the journey's next step, and it needs two things: the address the person
       * typed — never an account identifier — and WHEN the request was accepted.
       *
       * The timestamp exists because the server enforces a 60-second resend cooldown and answers it
       * with the same 202 and no send. Without the timestamp the next screen opened with Resend
       * enabled, and a tap inside that minute said "code sent" about a send that never happened. The
       * server cannot say "wait", because that would classify the address; this screen can, because
       * it already knows when it sent.
       */
      router.push({
        pathname: '/reset-password-code',
        params: { email: value, sentAt: String(Date.now()) },
      });
    } catch (err) {
      setDiagnostic(`server: ${(err as { code?: string | null } | null)?.code ?? '(no code)'}`);
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError(
          (err as { message?: string } | null)?.message ||
            'Unable to send a reset code. Please try again.'
        );
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Forgot password?"
      subtitle="We'll email you a 6-digit code. Verify it here, then choose a new password."
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
      {__DEV__ && diagnostic ? (
        <Text style={styles.diagnostic} selectable>
          {DEV_DIAGNOSTIC_PREFIX}
          {diagnostic}
        </Text>
      ) : null}
      <Input
        name="email"
        label="Email"
        value={email}
        onChangeText={(value: string) => {
          // Editing is acting on the refusal: the message described a value that no
          // longer exists, so it must not sit under the corrected one.
          if (fieldErrors.email) setFieldErrors({});
          setEmail(value);
        }}
        keyboardType="email-address"
        autoCapitalize="none"
        placeholder="you@company.com"
        error={fieldErrors.email}
        required
        // So the phone's password manager can supply the saved address rather than
        // making the person retype the one thing this screen needs.
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button title="Send reset code" onPress={submit} loading={busy} full />
      <Text style={styles.body}>
        The code expires in 10 minutes. You will choose the new password inside the app, on the
        next screen.
      </Text>
    </AuthLayout>
  );
}
