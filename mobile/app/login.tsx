import { useEffect, useMemo, useState } from 'react';
import { Link, Redirect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import Input from '../components/Input';
import { fieldErrorsFrom, formatRemaining } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import { defaultHomePath } from '../lib/permissions';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { credentialsProblems } from '../lib/validation';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    footer: { alignSelf: 'stretch' },
    // alignSelf:'stretch' + centred text so the "New to Inventory AI? <link>"
    // line wraps cleanly instead of shrink-wrapping off-centre at large scales.
    footerText: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    // Margin rather than a `gap` on the wrapper: the two lines are separate
    // Text nodes precisely so each centres on its own when it wraps.
    footerSpaced: { marginTop: spacing.md },
    // The registration action, directly under the info banner that asks for it.
    // Same alignment as the footer lines, and no negative margin to claw back the
    // banner's own spacing — the two read as one block.
    actionRow: { ...type.bodySmall, alignSelf: 'stretch', textAlign: 'center' },
    link: { color: colors.link, fontWeight: '700' },
    // The one line that explains why a password form offers a shortcut above it.
    hint: {
      ...type.bodySmall,
      color: colors.textSecondary,
      alignSelf: 'stretch',
      marginBottom: spacing.sm,
    },
  });

/**
 * Phase 32E — the one server outcome this screen must do more than print.
 *
 * `POST /api/auth/firebase/exchange` answers `REGISTRATION_REQUIRED` when the
 * identity authenticated with Firebase but has no Inventory AI account yet. The
 * server's message tells the user to create a business account, and this is the
 * screen that has to make that actionable — the message names a journey, so the
 * journey needs a control. It is rendered in the INFO tone rather than the error
 * tone: the credentials were accepted, and nothing the user did was wrong.
 *
 * Phase 32J: the control leads to `/register-firebase`, NOT `/register`. The
 * identity that produced this refusal is already authenticated with Firebase and
 * is still signed in, so sending the user to the email/password form would ask
 * them for an email they already proved and a password that would create a SECOND
 * Firebase identity — and then refuse to register either of them. The Firebase
 * onboarding screen asks only for the business name, and the identity it registers
 * is read from the Firebase layer rather than carried here, so no token, uid or
 * email travels through this link.
 *
 * Every other refusal (ACCOUNT_DISABLED, BUSINESS_NOT_ACTIVE,
 * FIREBASE_SIGN_IN_REQUIRED, INVALID_CREDENTIALS) is a statement with nothing to
 * press and is shown as an ordinary error banner.
 */
const REGISTRATION_REQUIRED = 'REGISTRATION_REQUIRED';

/**
 * The Inventory server's own login throttle, and the ONLY refusal this screen
 * turns into a cooldown.
 *
 * It is deliberately distinct from Firebase's `auth/too-many-requests`. That one
 * arrives as a `FirebaseAuthError` — nothing in it produced an HTTP response —
 * and carries no `Retry-After`, so it cannot and must not drive a countdown;
 * it is printed as an ordinary refusal. Keeping the two apart is what stops a
 * provider-side throttle from being described in the Inventory server's words,
 * or the reverse.
 */
const LOGIN_RATE_LIMITED = 'LOGIN_RATE_LIMITED';

/**
 * The sentence a rate-limited sign-in shows. The wait itself is NOT written here:
 * it is read from the server's `Retry-After` for that exact response, so this
 * screen never invents a cooldown length and there is no fixed three-minute
 * constant to drift out of step with the server's window.
 */
const RATE_LIMIT_MESSAGE =
  'Too many sign-in attempts. For your security, sign-in is paused for a moment.';

export default function LoginScreen() {
  const {
    status,
    user,
    signIn,
    signInWithGoogle,
    firebaseOnboarding,
    hasResumableFirebaseIdentity,
    continueWithPersistedIdentity,
  } = useSession();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  /**
   * The one-tap resume (see `continueWithPersistedIdentity`). Kept separate from
   * `busy` so the ordinary form stays inert while it runs, exactly as the Google
   * button is handled.
   */
  const [continuing, setContinuing] = useState(false);
  // IN-MEMORY ONLY, deliberately: a cooldown is a fact about the server's current
  // window, and persisting it would keep the form disabled after the window has
  // already moved on (or after a restart the server no longer knows about).
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Ticks only while a cooldown is running. When it elapses the stale rate-limit
  // banner is cleared with it, so the screen returns to its ordinary state rather
  // than leaving a refused message sitting over a form that is usable again.
  useEffect(() => {
    if (cooldownUntil === null) return undefined;
    const tick = (): void => {
      const at = Date.now();
      if (at >= cooldownUntil) {
        setCooldownUntil(null);
        setFormError(null);
        setFormRequestId(null);
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
  const bannerText = coolingDown
    ? `${RATE_LIMIT_MESSAGE} Try again in ${formatRemaining(remainingSeconds)}.`
    : formError;

  if (status === 'signedIn') return <Redirect href={defaultHomePath(user)} />;

  // Phase 16 - an identity created but not yet verified has NO session, so it never
  // reaches the signedIn guard above; this is the route that carries it to the verify
  // screen. It reads the in-memory onboarding state, never a route parameter.
  // AUTH-04-F - the READ-ONLY restart/resume probe can also decide that a persisted
  // identity needs verification but its state could not be read; that transient state
  // belongs on the same screen, which owns its Try Again and Sign out actions.
  if (firebaseOnboarding === 'verify-email' || firebaseOnboarding === 'verify-unreachable') {
    return <Redirect href="/verify-email" />;
  }

  /**
   * One place turns a sign-in rejection into what the screen shows. Shared by the
   * password form and the Google button, so a `REGISTRATION_REQUIRED` from the
   * exchange renders identically whichever provider proved the identity — the
   * refusal is about the Inventory AI account, not about how it was entered.
   */
  function applyAuthError(err: unknown): void {
    const fields = fieldErrorsFrom(err);
    if (Object.keys(fields).length) {
      setFieldErrors(fields);
      setFormRequestId(null);
      return;
    }
    if (err instanceof ApiError && err.code === LOGIN_RATE_LIMITED) {
      setNeedsAccount(false);
      const wait = err.retryAfter;
      // A cooldown is started only when the server actually stated a wait. With
      // no `Retry-After` the refusal is still shown, but no countdown is
      // invented — an unstated wait is not a licence to guess one.
      if (typeof wait === 'number' && wait > 0) {
        setCooldownUntil(Date.now() + wait * 1000);
      }
      setFormError(RATE_LIMIT_MESSAGE);
      setFormRequestId(errorRequestId(err));
      return;
    }
    setNeedsAccount(err instanceof ApiError && err.code === REGISTRATION_REQUIRED);
    setFormError((err as { message?: string } | null)?.message || 'Unable to sign in. Please try again.');
    setFormRequestId(errorRequestId(err));
  }

  function resetFeedback(): void {
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    setNeedsAccount(false);
  }

  /**
   * Correcting a field is acting on the refusal, so the refusal goes with it.
   *
   * Every other auth screen already did this where it mattered (the code field), and
   * a red message that survives a corrected value describes a value the person can no
   * longer see — it says the form is still wrong when it may already be right.
   */
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

  /**
   * Resumes the verified account Firebase already holds on this device.
   *
   * Offered only when the boot probe found one (`hasResumableFirebaseIdentity`), which
   * is the cold-start case: someone was refused with `REGISTRATION_REQUIRED`, closed
   * the app, and reopened it. Tapping is the whole point — the exchange is what opens a
   * session, and this screen never performs one on its own.
   */
  async function handleContinue(): Promise<void> {
    setContinuing(true);
    resetFeedback();
    try {
      await continueWithPersistedIdentity();
      // The signedIn guard redirects this screen away on success.
    } catch (err) {
      applyAuthError(err);
    } finally {
      setContinuing(false);
    }
  }

  async function submit(): Promise<void> {
    // No request is sent while the server's cooldown is running: the user is not
    // shown a second identical refusal, and the limiter is not asked again before
    // its window has moved. The button is disabled too, so this is the keyboard
    // "→" path (the field's onSubmitEditing) as well as a belt-and-braces guard.
    if (coolingDown) return;

    // REQUIRED-FIELD AND FORMAT VALIDATION RUN FIRST, AND NOTHING IS SENT IF EITHER
    // FAILS. This screen previously had no such guard at all, so pressing Sign In on
    // an empty form asked Firebase — or, on a build with no Firebase configuration, the
    // legacy endpoint — to authenticate nothing. The answer arrived as the generic
    // "Unable to sign in. Please try again.", which names neither field, suggests a
    // fault rather than a missing input, and sends the person to hunt for a problem
    // that is not there. Every other auth screen in this app already validated before
    // it called anything; this brings Login into line with them, and the rules
    // themselves live in `lib/validation.ts` so the six screens cannot drift apart.
    const problems = credentialsProblems(email, password);
    if (Object.keys(problems).length) {
      resetFeedback();
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    resetFeedback();
    try {
      // The address is TRIMMED on the way out. A trailing space is invisible on a
      // phone keyboard and would come back as `auth/invalid-email`; the server
      // normalises the same way, so the trimmed value is what both paths already
      // wanted. The password is deliberately NOT trimmed — leading and trailing
      // spaces are legitimate password characters.
      await signIn({ email: email.trim(), password });
      // Navigation: on success the signedIn guard redirects this screen away.
    } catch (err) {
      applyAuthError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Google Sign-In (Phase 32I). `signInWithGoogle` resolves `null` when the user
   * cancels, which is not an error: the Google sheet simply closes and the form is
   * left as it was, with no banner. A real refusal throws and goes through the
   * same `applyAuthError` the password form uses, so `REGISTRATION_REQUIRED`
   * shows its info banner and the "Create a business account" action.
   */
  async function handleGoogle(): Promise<void> {
    setGoogleBusy(true);
    resetFeedback();
    try {
      await signInWithGoogle();
    } catch (err) {
      applyAuthError(err);
    } finally {
      setGoogleBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to manage your inventory."
      footer={
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            <Link href="/forgot-password" style={styles.link}>
              Forgot password?
            </Link>
          </Text>
          <Text style={[styles.footerText, styles.footerSpaced]}>
            New to Inventory AI?{' '}
            <Link href="/register" style={styles.link}>
              Create an account
            </Link>
          </Text>
        </View>
      }
    >
      {needsAccount ? (
        <Banner type="info" text={bannerText} />
      ) : (
        <Banner type="error" text={bannerText} requestId={formRequestId} />
      )}
      {needsAccount ? (
        <Text style={styles.actionRow}>
          <Link href="/register-firebase" style={styles.link}>
            Create a business account
          </Link>
        </Text>
      ) : null}
      {hasResumableFirebaseIdentity ? (
        <>
          <Text style={styles.hint}>You are already signed in on this device.</Text>
          <Button
            title="Continue with saved account"
            variant="secondary"
            onPress={handleContinue}
            loading={continuing}
            disabled={busy || googleBusy}
            full
          />
        </>
      ) : null}
      <Input
        name="email"
        label="Email"
        value={email}
        onChangeText={editField('email', setEmail)}
        keyboardType="email-address"
        autoCapitalize="none"
        placeholder="you@company.com"
        error={fieldErrors.email}
        required
        // What the field HOLDS, so the platform's own autofill can fill it: Android offers the
        // saved credential, and iOS shows the password-manager suggestion above the keyboard.
        // Without the declaration both fall back to guessing from the field's shape.
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="next"
      />
      <Input
        name="password"
        label="Password"
        value={password}
        onChangeText={editField('password', setPassword)}
        secureTextEntry
        placeholder="••••••••"
        error={fieldErrors.password}
        required
        // `current-password` rather than `new-password`: this is the sign-in field, and the
        // distinction is what tells a password manager to offer a saved credential instead of
        // proposing to generate one.
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button
        title="Sign In"
        onPress={submit}
        loading={busy}
        disabled={googleBusy || continuing || coolingDown}
        full
      />
      <Button
        title="Continue with Google"
        variant="secondary"
        onPress={handleGoogle}
        loading={googleBusy}
        disabled={busy || continuing}
        full
      />
    </AuthLayout>
  );
}
