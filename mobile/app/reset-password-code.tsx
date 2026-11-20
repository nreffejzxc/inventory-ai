import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import CodeInput from '../components/CodeInput';
import { requestPasswordResetCode, verifyPasswordResetCode } from '../lib/api';
import { fieldErrorsFrom, formatRemaining } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { ApiError } from '../lib/client';
import { beginVerifiedReset } from '../lib/passwordResetSession';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

/**
 * AUTH-06 (two-step recovery) — STEP ONE: verify the emailed reset code.
 *
 * WHY THIS SCREEN EXISTS. Firebase's reset email can no longer be pointed at a destination we
 * choose — the project's email-template editor refuses every write
 * (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`) — so the "click a link, finish in a browser" journey is
 * both unconfigurable and, when it works, a browser form that revokes nothing. The code arrives by
 * email, the person types it here, and the rest happens inside the app.
 *
 * IT ASKS FOR THE CODE AND NOTHING ELSE. The new password lives on the next screen, because two
 * questions on one form made the journey read as one long step and made a wrong code and a
 * rejected password indistinguishable in the same error slot. This screen has one job, one field
 * and one button.
 *
 * WHAT IT NEVER CARRIES. The code lives in this component's state and leaves only in the request
 * body; it is never rendered back, logged, persisted or put in a route param. On success the
 * server's short-lived authorization is handed to `lib/passwordResetSession` — memory, not
 * navigation state — and the next screen reads it from there. The only route parameter is the
 * ADDRESS, which the person typed on the previous screen and which identifies no account on its
 * own: the server resolves the account from the challenge the code belongs to.
 *
 * A VERIFIED CODE IS SPENT. The server refuses to verify the same code twice, so a person who
 * leaves this journey after verifying asks for a new code; the resend control here is exactly that
 * route, and it starts a fresh challenge which supersedes the old one.
 */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;
/**
 * The server's `PASSWORD_RESET_CODE_TTL_MINUTES`, stated to the person because an expired code is
 * otherwise indistinguishably "wrong". Pinned to the server's own source by
 * `__tests__/password-reset-verify.test.tsx`, so the two cannot drift apart silently — the guard
 * `verify-email.tsx` already uses for the same number.
 */
const CODE_TTL_MINUTES = 10;

const CODE_SENT_MESSAGE = 'Password reset code sent. Check your inbox and spam folder.';
const GENERIC_FAILURE = 'Something went wrong. Please try again.';
const EMPTY_CODE_MESSAGE = 'Enter the 6-digit code from your email.';

const EXPIRED_HELPER = 'That code has expired. Send a new one to continue.';
/**
 * How long the sixth digit waits before the code is verified on its own — the same beat the
 * verification screen uses, and for the same reason: nobody should have to reach for the
 * button after typing the last digit, and nobody should lose the chance to correct it.
 */
const AUTO_VERIFY_DELAY_MS = 400;

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
    linkRow: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
      marginTop: spacing.md,
    },
  });

export default function ResetPasswordCodeScreen() {
  // The address comes from the request screen. A missing one is a broken route rather than a
  // failure: the person is sent back to ask for a code, which is the only thing that fixes it.
  const params = useLocalSearchParams<{ email?: string; sentAt?: string }>();
  const email = typeof params.email === 'string' ? params.email.trim() : '';

  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * IN MEMORY ONLY, deliberately: a cooldown describes the server's current window, and persisting it
   * would keep the control disabled after the window has moved on.
   *
   * IT STARTS FROM THE REQUEST THE PREVIOUS SCREEN MADE. The server enforces 60 seconds between sends
   * and answers a second request with the same 202 and no send, so a Resend pressed inside that window
   * used to report "code sent" about nothing. The `sentAt` the request screen passes is the start of
   * that window, and the remainder is what this screen must honour — the same thing `verify-email.tsx`
   * does with `verificationCodeIssuedAt`.
   */
  // The instant this journey's code was issued: the previous screen's `sentAt`, or a
  // resend's own success. It is the start of BOTH clocks — the 60-second resend cooldown
  // and the 10-minute lifetime — so neither is invented by this screen.
  const sentAt = Number(params.sentAt);
  const initialSentAt = Number.isFinite(sentAt) && sentAt > 0 ? sentAt : null;
  const [codeIssuedAt, setCodeIssuedAt] = useState<number | null>(initialSentAt);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(() => {
    if (initialSentAt === null) return null;
    const end = initialSentAt + RESEND_COOLDOWN_SECONDS * 1000;
    return end > Date.now() ? end : null;
  });
  const [now, setNow] = useState<number>(() => Date.now());

  /**
   * The pending auto-verify, and whether a verify is already in flight.
   *
   * A deliberate action cancels the timer, so the same code is never verified twice; the
   * in-flight guard covers a press that lands while the automatic request is running. The
   * server spends the challenge's attempts, so a duplicate request is not free.
   */
  const autoVerifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifying = useRef(false);

  useEffect(
    () => () => {
      if (autoVerifyTimer.current) clearTimeout(autoVerifyTimer.current);
    },
    []
  );

  // Ticks only while a cooldown is running.
  useEffect(() => {
    if (cooldownUntil === null) return undefined;
    const tick = (): void => {
      const at = Date.now();
      if (at >= cooldownUntil) {
        setCooldownUntil(null);
        return;
      }
      setNow(at);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const remainingSeconds =
    cooldownUntil === null ? 0 : Math.ceil(Math.max(0, cooldownUntil - now) / 1000);
  const coolingDown = cooldownUntil !== null && remainingSeconds > 0;

  /** The server's own lifetime, counted from the send — see `CODE_TTL_MINUTES`. */
  const expiresAt = codeIssuedAt === null ? null : codeIssuedAt + CODE_TTL_MINUTES * 60_000;
  const codeExpired = expiresAt !== null && now >= expiresAt;
  const codeSecondsLeft =
    expiresAt === null ? 0 : Math.ceil(Math.max(0, expiresAt - now) / 1000);

  // Ticks only while the code is alive. When it runs out the interval stops and the last
  // render stands with `codeExpired` true, so the screen says so instead of counting to
  // zero and then going quiet.
  useEffect(() => {
    if (expiresAt === null || Date.now() >= expiresAt) return undefined;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!email) {
    return (
      <AuthLayout title="Start again" subtitle="We need the email address first.">
        <Banner
          type="error"
          text="This screen is missing the email address it was opened for. Request a new code to continue."
        />
        <Button title="Request a code" onPress={() => router.replace('/forgot-password')} full />
      </AuthLayout>
    );
  }

  /** A deliberate action cancels the automatic one. */
  function cancelAutoVerify(): void {
    if (autoVerifyTimer.current) {
      clearTimeout(autoVerifyTimer.current);
      autoVerifyTimer.current = null;
    }
  }

  /**
   * Six digits are verified without a tap, after a short beat.
   *
   * Nothing is scheduled for a partial code (an unfinished entry would spend one of the
   * five attempts) nor for a code this screen knows has expired — the remedy for that is a
   * new code, and the helper already says so.
   */
  function handleCodeChange(value: string): void {
    if (fieldErrors.code) setFieldErrors({});
    setCode(value);
    cancelAutoVerify();
    if (value.length !== CODE_LENGTH || codeExpired) return;
    autoVerifyTimer.current = setTimeout(() => {
      autoVerifyTimer.current = null;
      void submit(value);
    }, AUTO_VERIFY_DELAY_MS);
  }

  async function resend(): Promise<void> {
    if (coolingDown) return;
    // The old code is about to be replaced; an automatic verify of it would be a request
    // about a value the server no longer holds.
    cancelAutoVerify();
    setSending(true);
    setFormError(null);
    setFormRequestId(null);
    setNotice(null);
    try {
      await requestPasswordResetCode(email);
      setNotice(CODE_SENT_MESSAGE);
      // A resend starts a NEW code, so both clocks restart from this instant. Read once,
      // so the lifetime and the cooldown cannot disagree by a millisecond.
      const issuedAt = Date.now();
      setCodeIssuedAt(issuedAt);
      setCooldownUntil(issuedAt + RESEND_COOLDOWN_SECONDS * 1000);
    } catch (err) {
      // The server states the wait on a 429; honour it verbatim rather than guessing.
      const wait = err instanceof ApiError ? err.retryAfter : null;
      if (typeof wait === 'number' && wait > 0) {
        setCooldownUntil(Date.now() + wait * 1000);
      }
      setFormError((err as { message?: string } | null)?.message || GENERIC_FAILURE);
      setFormRequestId(errorRequestId(err));
    } finally {
      setSending(false);
    }
  }

  async function submit(candidate: string = code): Promise<void> {
    cancelAutoVerify();
    // One verify at a time: the automatic request and a press can otherwise overlap.
    if (verifying.current) return;
    // A FRIENDLY PRE-CHECK THAT SAVES SOMETHING REAL: the challenge allows five attempts, and a
    // half-typed code would be refused by the server as an invalid code, spending a guess the
    // person never made.
    if (candidate.length !== CODE_LENGTH) {
      setFieldErrors({ code: EMPTY_CODE_MESSAGE });
      return;
    }

    verifying.current = true;
    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const verified = await verifyPasswordResetCode({ email, code: candidate });
      // THE SERVER'S OWN WINDOW, not a client constant, and held in memory rather than in the
      // navigation route — see `lib/passwordResetSession.ts`.
      beginVerifiedReset({
        email,
        resetToken: verified.resetToken,
        expiresInSeconds: verified.expiresInSeconds,
      });
      // `replace`, not `push`: the code has just been spent, so going back to this screen could
      // only offer a field that the server will refuse.
      router.replace('/reset-password-new');
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError(
          (err as { message?: string } | null)?.message ||
            'That code could not be verified. Please try again.'
        );
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  }

  const resendLabel = coolingDown
    ? `Resend code in ${formatRemaining(remainingSeconds)}`
    : 'Resend code';

  // THE SUBTITLE NAMES THE INBOX, not just the step. A code the person cannot find is
  // the commonest way this screen stalls, and the first question it raises is "which
  // address did I use?". The address is already on this screen's route (it is what the
  // previous screen collected), it identifies no account on its own, and "Wrong
  // address? Start over" is directly below — so stating it turns a guess into a decision.
  return (
    <AuthLayout
      title="Enter your reset code"
      subtitle={`Enter the ${CODE_LENGTH}-digit code we emailed to ${email}. It expires in ${CODE_TTL_MINUTES} minutes — you will choose a new password on the next screen.`}
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
      <Banner type="success" text={notice} />
      <CodeInput
        label="Reset code"
        value={code}
        onChangeText={handleCodeChange}
        error={fieldErrors.code}
        required
        // The lifetime is stated as a COUNT, from this journey's own send instant. A static
        // "expires in 10 minutes" describes the moment the code was issued, not the moment
        // the person is reading it — and an expired code is otherwise indistinguishable
        // from a wrong one until the server refuses it.
        helper={
          expiresAt === null
            ? undefined
            : codeExpired
              ? EXPIRED_HELPER
              : `Code expires in ${formatRemaining(codeSecondsLeft)}`
        }
        // The field declares itself as a one-time code to the platform (inside `CodeInput`), which
        // is what lets Android's autofill and the iOS QuickType bar offer all six digits instead of
        // making the person leave the app to copy them.
        onSubmitEditing={() => submit()}
      />
      <Button
        title="Verify code"
        onPress={() => submit()}
        loading={busy}
        disabled={sending || code.length !== CODE_LENGTH}
        full
      />
      <Button
        title={resendLabel}
        variant="secondary"
        onPress={resend}
        loading={sending}
        disabled={busy || sending || coolingDown}
        full
      />
      <Text style={styles.body}>
        We will ask for your new password once the code is verified. Checking the code does not
        change anything on your account yet.
      </Text>
      <Text style={styles.linkRow}>
        Wrong address?{' '}
        <Link href="/forgot-password" style={styles.link}>
          Start over
        </Link>
      </Text>
    </AuthLayout>
  );
}
