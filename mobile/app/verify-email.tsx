import { useEffect, useMemo, useRef, useState } from 'react';
import { Redirect } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import CodeInput from '../components/CodeInput';
import { fieldErrorsFrom, formatRemaining } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import { defaultHomePath } from '../lib/permissions';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

/**
 * AUTH-04-F — the email-verification screen, now the CUSTOM 6-DIGIT CODE flow.
 *
 * WHY IT EXISTS. An identity Firebase has authenticated but whose address is not verified
 * owns no Inventory AI User and therefore no session, so it never reaches the `(app)`
 * group (whose layout redirects anyone who is not signed in). It is held here instead.
 *
 * WHAT IT DOES NOT DO. It never carries a token, uid or email: the identity is read from
 * the Firebase layer inside `lib/auth.tsx`, the business details come from the in-memory
 * onboarding state, and the code leaves this screen only in the body of the confirm
 * request. It never signs anyone in by itself — only a server-issued session does, and the
 * signedIn guard below is what leaves this screen. No route parameter is read.
 *
 * THREE STATES, decided entirely by the in-memory onboarding value:
 *
 *   'none'               nothing is waiting -> Login (a redirect, not a dead end).
 *   'verify-unreachable' a persisted identity exists but its state could not be read ->
 *                        the safe unreachable state: Try Again + Wrong account? Sign out.
 *   'verify-email'       the code form.
 *
 * THE CODE FLOW. "Send verification code" (or "Resend code" once one has been sent) asks
 * the AUTH-04 request endpoint for a fresh six-digit code; the code is mailed by the
 * server and never returned to this app. "Verify" submits it to the confirm endpoint, and
 * on success the context reloads Firebase, mints a forced-refresh token, registers a
 * pending tenant, and exchanges — after which the signedIn guard redirects away.
 *
 * THE RESEND COOLDOWN IS THE SERVER'S NUMBER. A 429 carries `Retry-After`, which is read
 * verbatim; a successful send starts the server's documented 60-second window locally, so
 * the button cannot be used to earn a guaranteed immediate 429. Nothing here invents a
 * cooldown length.
 *
 * A CODE MAY ALREADY HAVE BEEN SENT WHEN THIS SCREEN OPENS. Registration requests one
 * before it navigates, so `verificationCodeIssuedAt` (in-memory context state) says so and
 * the screen opens with the truthful subtitle, the "Resend" wording and the remainder of
 * the server's window already counting down. A sign-in for an unverified identity passes
 * `null`, and then the screen correctly says a code will be sent rather than pretending
 * one already was.
 */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;
/**
 * The server's `EMAIL_VERIFICATION_TTL_MINUTES`, stated to the person because an
 * expired code is otherwise indistinguishably "wrong". The number is pinned to the
 * server's own source by `__tests__/auth-ux-hardening.test.tsx`, so the two cannot
 * drift apart silently — the same guard `lib/validation.ts` uses for the email and
 * password rules.
 */
const CODE_TTL_MINUTES = 10;

const CODE_SENT_MESSAGE = 'Verification code sent. Check your inbox and spam folder.';
const EXPIRED_HELPER = 'That code has expired. Send a new one to continue.';
/**
 * How long the sixth digit waits before the code is submitted on its own.
 *
 * NOT ZERO, and not a button either. A beat long enough for the last digit to be replaced
 * (a paste that lands one char short, a typo seen immediately) and short enough that nobody
 * reaches for the button — so the common case costs no tap, while an explicit press or a
 * resend still cancels the wait and states what the person intended.
 */
const AUTO_VERIFY_DELAY_MS = 400;
const STILL_UNVERIFIED_MESSAGE =
  'That code was accepted, but your email is not verified yet. Try again in a moment.';
const GENERIC_FAILURE_MESSAGE = 'Something went wrong. Please try again.';
const EMPTY_CODE_MESSAGE = 'Enter the 6-digit code from your email.';

const SUBTITLE_SENT = `Enter the ${CODE_LENGTH}-digit code we emailed you. It expires in ${CODE_TTL_MINUTES} minutes.`;
const SUBTITLE_NOT_SENT =
  `We'll email you a ${CODE_LENGTH}-digit code to confirm this address. It expires in ` +
  `${CODE_TTL_MINUTES} minutes.`;

const UNREACHABLE_TITLE = 'Check your connection';
const UNREACHABLE_SUBTITLE = 'We could not confirm your sign-in just now.';
const UNREACHABLE_BODY =
  'We could not reach the verification service. Check your connection, then try again.';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    footerText: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    // The inbox this code went to. Muted, because it is a fact to check rather than an
    // instruction — the instruction is the label under it.
    address: {
      ...type.bodySmall,
      color: colors.textSecondary,
      alignSelf: 'stretch',
      marginBottom: spacing.sm,
    },
    link: { color: colors.link, fontWeight: '700' },
  });

export default function VerifyEmailScreen() {
  const {
    status,
    user,
    firebaseOnboarding,
    requestVerificationCode,
    confirmVerificationCode,
    retryVerificationResume,
    cancelFirebaseOnboarding,
    verificationEntryError,
    clearVerificationEntryError,
    verificationCodeIssuedAt,
    firebaseRegistrationRequired,
    firebaseAccountEmail,
  } = useSession();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // REGISTRATION SENDS BEFORE IT NAVIGATES, so the screen can open knowing a code is
  // already in flight. Without that, it opened on an enabled "Send verification code"
  // whose only possible answer was the server's resend refusal — a dead control offered
  // at the exact moment the person should be reading their inbox.
  // `typeof === 'number'` rather than `!== null`, so a context value that predates the
  // field (undefined) reads as "nothing sent" instead of claiming a code is in flight.
  const [codeSent, setCodeSent] = useState(typeof verificationCodeIssuedAt === 'number');
  /**
   * When this journey's code was issued, in ms — the start of its 10-minute lifetime.
   * Present when registration sent one before navigating, and set again by every
   * successful resend, so the countdown always describes the CURRENT code.
   */
  const [codeIssuedAt, setCodeIssuedAt] = useState<number | null>(() =>
    typeof verificationCodeIssuedAt === 'number' ? verificationCodeIssuedAt : null
  );
  // IN-MEMORY ONLY, deliberately: a cooldown is a fact about the server's current window,
  // and persisting it would keep the button disabled after the window has moved on. The
  // initial value continues the server's 60-second window from the send registration
  // already made, so the countdown is the wait that actually remains rather than a fresh
  // minute invented by this mount.
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(() => {
    if (typeof verificationCodeIssuedAt !== 'number') return null;
    const end = verificationCodeIssuedAt + RESEND_COOLDOWN_SECONDS * 1000;
    return end > Date.now() ? end : null;
  });
  const [now, setNow] = useState<number>(() => Date.now());

  /**
   * The pending auto-submit, and whether a confirm is already in flight.
   *
   * The timer is cancelled by anything the person does deliberately — pressing Verify, or
   * asking for a new code — so one code is never submitted twice. The in-flight guard
   * covers the other order: a press that lands while the automatic request is running is
   * ignored, because the server counts attempts and a duplicate would spend one.
   */
  const autoVerifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirming = useRef(false);

  useEffect(
    () => () => {
      if (autoVerifyTimer.current) clearTimeout(autoVerifyTimer.current);
    },
    []
  );

  // Ticks only while a cooldown is running, and clears the stale notice with it.
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

  // Ticks only while a code is alive; the last render after it runs out says so.
  useEffect(() => {
    if (expiresAt === null || Date.now() >= expiresAt) return undefined;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // AUTH-04-F (Option B) — a registration whose INITIAL code request failed arrives here
  // with a one-shot reason (a safe sentence only). It is shown until the person acts, at
  // which point their own action's outcome takes over. It is never re-sent automatically.
  const shownError = error ?? verificationEntryError;

  if (status === 'signedIn') return <Redirect href={defaultHomePath(user)} />;
  /**
   * VERIFIED, BUT WITH NO TENANT TO CREATE — FOUND ON A DEVICE.
   *
   * A confirmation that succeeds while `pendingRegistration` is absent (the ordinary
   * result of a cold start: registration details are in-memory, and the restart/resume
   * probe restores only the identity) ends at the exchange, which refuses with
   * `REGISTRATION_REQUIRED`. That refusal armed the registration route — and this screen
   * then sat on its own form showing the refusal's sentence, with no control that goes
   * anywhere. Retrying Verify only re-ran the same exchange, and the only way out was
   * "Wrong account? Sign out" followed by a fresh sign-in.
   *
   * So when the registration route is armed, this screen hands off to it, exactly as the
   * login screen does for the same refusal. The screen does not render a second copy of
   * that journey's form: it holds no identity, and `register-firebase` is where the
   * business name is collected from the authenticated Firebase identity.
   */
  if (firebaseRegistrationRequired) return <Redirect href="/register-firebase" />;
  // Nothing is waiting to be verified: the probe found no identity, or a verified one.
  // A redirect rather than a dead-end screen — the probe already decided this.
  if (firebaseOnboarding === 'none') return <Redirect href="/login" />;

  function errorMessage(err: unknown): string {
    return (err as { message?: string } | null)?.message || GENERIC_FAILURE_MESSAGE;
  }

  /** A deliberate action cancels the automatic one; the person's intent wins. */
  function cancelAutoVerify(): void {
    if (autoVerifyTimer.current) {
      clearTimeout(autoVerifyTimer.current);
      autoVerifyTimer.current = null;
    }
  }

  /**
   * A complete code is submitted without a tap — after a short beat.
   *
   * Nothing is scheduled for a partial code (the server's attempt budget is five, and an
   * unfinished entry would spend one), nor for a code this screen already knows is past its
   * window: the answer to an expired code is a new code, and the helper says so. A phone
   * whose clock disagrees with the server can still submit by pressing Verify.
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

  async function wrongAccount(): Promise<void> {
    setBusy(true);
    setError(null);
    clearVerificationEntryError();
    try {
      await cancelFirebaseOnboarding();
    } catch (err) {
      setError(GENERIC_FAILURE_MESSAGE);
      setFormRequestId(errorRequestId(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(): Promise<void> {
    if (coolingDown) return;
    // A resend replaces the code, so an automatic submission of the old one would be a
    // request about a value that is no longer current.
    cancelAutoVerify();
    setSending(true);
    setError(null);
    setNotice(null);
    clearVerificationEntryError();
    try {
      await requestVerificationCode();
      setCodeSent(true);
      setNotice(CODE_SENT_MESSAGE);
      // A resend replaces the code, so both clocks restart from this instant.
      setCodeIssuedAt(Date.now());
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    } catch (err) {
      // The server states the wait on a 429; honour it verbatim rather than guessing.
      const wait = err instanceof ApiError ? err.retryAfter : null;
      if (typeof wait === 'number' && wait > 0) {
        setCooldownUntil(Date.now() + wait * 1000);
      }
      setError(errorMessage(err));
      setFormRequestId(errorRequestId(err));
    } finally {
      setSending(false);
    }
  }

  async function submit(candidate: string = code): Promise<void> {
    cancelAutoVerify();
    // One confirm at a time: the automatic request and a press can otherwise overlap.
    if (confirming.current) return;
    const trimmed = candidate.trim();
    // THE ATTEMPT BUDGET IS FIVE PER CHALLENGE, so an obviously incomplete value must not
    // spend one. The field already strips non-digits and caps at six, which means anything
    // shorter here is an unfinished entry: the server would answer its one
    // indistinguishable "invalid or has expired", describing a malformed submission as a
    // wrong code and burning a guess the person never made.
    if (trimmed.length !== CODE_LENGTH) {
      setFieldErrors({ code: EMPTY_CODE_MESSAGE });
      return;
    }
    confirming.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    clearVerificationEntryError();
    try {
      const signedIn = await confirmVerificationCode(trimmed);
      // `null` means Firebase still reports the address unverified after a successful
      // confirm — an ordinary state, not a failure.
      if (!signedIn) setNotice(STILL_UNVERIFIED_MESSAGE);
      // On success the signedIn guard above redirects this screen away.
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) {
        setFieldErrors(fields);
        setFormRequestId(null);
      } else {
        setError(errorMessage(err));
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }

  async function tryAgain(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await retryVerificationResume();
    } catch (err) {
      setError(GENERIC_FAILURE_MESSAGE);
      setFormRequestId(errorRequestId(err));
    } finally {
      setBusy(false);
    }
  }

  if (firebaseOnboarding === 'verify-unreachable') {
    return (
      <AuthLayout
        title={UNREACHABLE_TITLE}
        subtitle={UNREACHABLE_SUBTITLE}
        footer={
          <Text style={styles.footerText}>
            Wrong account?{' '}
            <Text style={styles.link} onPress={wrongAccount}>
              Sign out
            </Text>
          </Text>
        }
      >
        <Banner type="info" text={UNREACHABLE_BODY} />
        <Banner type="error" text={error} requestId={formRequestId} />
        <Button title="Try again" onPress={tryAgain} loading={busy} full />
      </AuthLayout>
    );
  }

  const resendLabel = coolingDown
    ? `Resend code in ${formatRemaining(remainingSeconds)}`
    : codeSent
      ? 'Resend verification code'
      : 'Send verification code';

  return (
    <AuthLayout
      title="Verify your email"
      subtitle={codeSent ? SUBTITLE_SENT : SUBTITLE_NOT_SENT}
      footer={
        <Text style={styles.footerText}>
          Wrong account?{' '}
          <Text style={styles.link} onPress={wrongAccount}>
            Sign out
          </Text>
        </Text>
      }
    >
      {notice ? <Banner type="info" text={notice} /> : null}
      <Banner type="error" text={shownError} requestId={error ? formRequestId : null} />
      {/**
       * WHICH INBOX. A code that has not arrived is the commonest way this screen
       * stalls, and the first question is "which address did I use?". The address is
       * known when this run typed it (registration, or a sign-in that reached this
       * screen); on a cold-start resume it is not, and the line is omitted rather than
       * invented.
       */}
      {firebaseAccountEmail ? (
        <Text style={styles.address}>
          {codeSent
            ? `We sent the code to ${firebaseAccountEmail}.`
            : `We will email the code to ${firebaseAccountEmail}.`}
        </Text>
      ) : null}
      {/**
       * THE SAME CONTROL THE RESET JOURNEY USES, and deliberately not a second one: both screens
       * ask for the same thing — six digits read out of an email — so they get the same boxes, the
       * same autofill declaration, the same paste and backspace behaviour and the same error slot.
       * Only the wiring around it differs.
       */}
      <CodeInput
        label="Verification code"
        value={code}
        onChangeText={handleCodeChange}
        error={fieldErrors.code}
        required
        // The lifetime as a COUNT, from this journey's own send instant. The static
        // subtitle describes when the code was issued, not how long it has left — and an
        // expired code is otherwise indistinguishable from a wrong one until the server
        // refuses it.
        helper={
          expiresAt === null
            ? undefined
            : codeExpired
              ? EXPIRED_HELPER
              : `Code expires in ${formatRemaining(codeSecondsLeft)}`
        }
        onSubmitEditing={() => submit()}
      />
      {/**
       * THE RESEND COOLDOWN MUST NOT BLOCK VERIFYING. It used to: `coolingDown` was part
       * of this button's `disabled`, so after a resend — or after the cooldown the screen
       * starts on a successful send — the code in the person's inbox could not be
       * submitted for a whole minute. The cooldown belongs to the SEND below, which
       * already carries it.
       */}
      <Button
        title="Verify"
        onPress={() => submit()}
        loading={busy}
        disabled={sending || code.length !== CODE_LENGTH}
        full
      />
      <Button
        title={resendLabel}
        variant="secondary"
        onPress={sendCode}
        loading={sending}
        disabled={busy || sending || coolingDown}
        full
      />
    </AuthLayout>
  );
}
