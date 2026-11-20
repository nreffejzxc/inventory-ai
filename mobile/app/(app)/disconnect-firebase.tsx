import { useMemo, useState } from 'react';
import { Redirect, Stack, router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import Input from '../../components/Input';
import Screen from '../../components/Screen';
import SectionHeader from '../../components/SectionHeader';
import { ApiError } from '../../lib/client';
import { errorRequestId } from '../../lib/errors';
import { isSessionError, useSession } from '../../lib/auth';
import type { FirebaseConfirmMethod } from '../../lib/firebase-auth';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';
import { passwordStrengthProblem } from '../../lib/validation';

/**
 * Phase A (F-1) — CHANGING the account's Firebase password.
 *
 * IT NO LONGER DISCONNECTS ANYTHING. Until Phase A this screen detached the account's
 * the caller's own account (which the session already proves) AND the Firebase
 * authentication must be RECENT — the verified token's `auth_time` within 300 s.
 * A person signed in hours ago satisfies the first and not the second, so the
 * confirmation is not an edge case to handle reactively; it is the normal first
 * step, and putting it FIRST is also what keeps a typed password from being held in
 * memory across a browser round-trip that can background or kill the app.
 *
 *   1. Choose how this account signs in to Firebase, and confirm it.
 *   2. Type the new password that will own the account afterwards.
 *   3. Firebase changes the credential, the server withdraws every session minted
 *      against the old one — including the one this screen is using — and the app
 *      immediately takes the one fresh session the sequence ends with.
 *
 * STEP 2 CAN HAPPEN TWICE, which is why it is a step and not a button. The server owns
 * a 300 s freshness window, so it can refuse the whole request with
 * `FIREBASE_REAUTHENTICATION_REQUIRED` — an instruction, not a verdict, and the only
 * refusal this flow retries. When it does, the flow returns to step 1, the typed
 * password is DISCARDED rather than held, and the person confirms their sign-in again
 * before typing a new one. Exactly one such retry is made.
 *
 * NOTHING SENSITIVE TRAVELS THROUGH NAVIGATION. There is no route parameter at all:
 * the screen reads what it needs from the session, the confirmation token never
 * leaves a callback inside `lib/auth.tsx`, and the typed passwords live in this
 * component's state alone. The email is DISPLAYED from the authenticated user's own
 * record and is never an input — so a person cannot steer the confirmation toward an
 * identity that is not theirs, and no email is ever compared to anything.
 *
 * THE CHOICE IS THE PERSON'S, NOT THE APP'S. The server publishes no provider data
 * (Phase 32F decision R-4), and the only Firebase API that could discover a
 * provider from an email is deprecated and discouraged, so nothing here tries to
 * guess. A wrong guess is not a security problem — the server compares the verified
 * token's uid with the account's stored `firebaseUid` and refuses a mismatch — it is
 * simply a wrong door, which is why every wrong-door answer here points at the
 * other one.
 */

/** The three steps, as one value. A plain union rather than three booleans. */
type Step = 'choose' | 'confirmPassword' | 'newPassword';

/** The two confirmation options, phrased as the person's own choice. */
const METHOD_LABELS: Record<FirebaseConfirmMethod, string> = {
  google: 'Confirm with Google',
  password: 'Confirm with password',
};

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

/**
 * The one sentence for "that was the wrong confirmation option".
 *
 * SHARED BY BOTH ROUTES INTO THIS STATE, ON PURPOSE. Locally, Firebase reports
 * `auth/user-not-found` — this address has no password identity. Remotely, the server
 * refuses the whole request with 409 `FIREBASE_IDENTITY_CONFLICT` because the verified
 * identity is not the account's. Both mean the same thing to the person and have the
 * same remedy, so they read the same sentence; two copies would drift, and a person who
 * met each one in the two orders would be told two different stories about one problem.
 *
 * THE SERVER'S OWN SENTENCE IS DELIBERATELY NOT RELAYED for the 409. It answers "This
 * sign-in cannot be connected to this account. Please contact an administrator.", which
 * is written for the LINKING caller whose mapping genuinely collided — here it would
 * send someone to an administrator over a mistyped choice. It is also "cannot be
 * connected", which is the opposite of the truth at this point: nothing is being
 * connected, and the identity being confirmed was never going to be.
 */
const OTHER_OPTION_MESSAGE =
  'That does not match this account. Try the other confirmation option.';

/**
 * The sentence for "the server needs a fresher confirmation, and the password you
 * typed is gone with it".
 *
 * It says what to DO rather than what went wrong, because nothing went wrong: the
 * account is untouched, and the person simply has to prove the sign-in again. The
 * second half is not decoration — the new password is discarded BEFORE the second
 * confirmation runs, so someone arriving back at step 1 without being told would
 * reasonably conclude their input had been lost.
 */
const REAUTHENTICATION_NOTICE =
  'For your security, please confirm your sign-in again, then choose a new password.';

/**
 * The sentence to show for a server refusal.
 *
 * Every other message is the server's own, used verbatim: those are written for a
 * person and name no provider, uid or token. The one exception is the conflict above,
 * which is answered with this screen's actionable copy instead.
 */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'FIREBASE_IDENTITY_CONFLICT') return OTHER_OPTION_MESSAGE;
    if (err.message) return err.message;
  }
  return 'We could not change your password. Please try again.';
}

/** True when the refusal means "this is the wrong confirmation option". */
function isWrongMethodRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'FIREBASE_IDENTITY_CONFLICT';
}

/**
 * True for the refusals that need the person to confirm again before they can
 * succeed.
 *
 * Recoverable by going back to step 1, which is NOT an automatic retry loop: it takes
 * a deliberate tap and a whole fresh confirmation. `FIREBASE_REAUTHENTICATION_REQUIRED`
 * is here as the LOCAL, direct route back — the orchestration normally answers a
 * freshness refusal with the `reauth-required` outcome instead, and reserving this
 * branch for it as well means a refusal that reached the screen anyway is still
 * answered by the remedy that actually helps.
 */
function needsAnotherConfirmation(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'FIREBASE_REAUTHENTICATION_REQUIRED' ||
      err.code === 'FIREBASE_TOKEN_INVALID')
  );
}

export default function ChangeFirebasePasswordScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, status, confirmFirebaseSignIn, changeFirebasePassword, signOut } = useSession();

  const [step, setStep] = useState<Step>('choose');
  /** The option that was chosen, kept after success so a retry can re-confirm. */
  const [method, setMethod] = useState<FirebaseConfirmMethod | null>(null);
  /** The Firebase password for the password option; never sent anywhere by this screen. */
  const [signInPassword, setSignInPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  /**
   * An INSTRUCTION rather than a complaint, so it is an info strip and not an error
   * banner: the wrong-option reply, and the freshness refusal that discards the password.
   */
  const [info, setInfo] = useState<string | null>(null);
  /**
   * Whether the flow's ONE automatic retry has been spent.
   *
   * It is set when a freshness refusal is received and is deliberately STICKY: going
   * back to step 1 does not re-arm it, so the second attempt is the last one this
   * screen will make on its own. A person who starts over after that does so by
   * confirming again and typing a new password, which is a deliberate act rather than a
   * loop — and the orchestration refuses a third automatic attempt regardless.
   */
  const [retried, setRetried] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The flow FINISHED, and the person is still signed in.
   *
   * Unlike the disconnect this screen used to perform, a password change does not end
   * the session — the sequence replaces it — so there is no redirect to login to carry
   * the news. The screen therefore says it plainly and offers the way back, because
   * "did that work?" is the one question this flow must never leave open.
   */
  const [done, setDone] = useState(false);

  /**
   * The gate (Phase 32L-B decision Q8). `authMethods.firebase` is what the server
   * publishes to say this account authenticates through a Firebase identity. When it
   * is not true there is nothing to disconnect, so the screen is not merely hidden —
   * it is unreachable. Nothing here is a security control; the server would refuse an
   * unlinked account with 409 `FIREBASE_IDENTITY_CONFLICT` regardless.
   *
   * The check is `!== true`, so a user object without the field (an older server, or
   * a response that predates Phase 32K) does not open a flow it cannot finish.
   */
  if (status === 'signedIn' && user && user.authMethods?.firebase !== true) {
    return <Redirect href="/profile" />;
  }

  /** Neither step can run without an account, and there is no account shape to fake. */
  const email = user?.email;

  function resetFeedback(): void {
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    setInfo(null);
  }

  /**
   * Steps 1 and 1a — confirm the sign-in.
   *
   * A CANCELLATION IS NOT REPORTED. Closing the Google sheet leaves the screen exactly
   * as it was, which is the same treatment the login screen gives it, because the
   * person changed their mind rather than hitting a problem.
   */
  async function runConfirm(choice: FirebaseConfirmMethod): Promise<void> {
    // Friendly, not authoritative, and it follows `change-password.tsx`: the screen
    // reports what is missing instead of silently disabling the control, which tells the
    // person nothing about why nothing happened. Nothing here is a gate — an empty
    // password sent anyway would be refused by Firebase and reported by the module.
    if (choice === 'password' && !signInPassword) {
      setFieldErrors({ signInPassword: 'Password is required' });
      return;
    }

    setBusy(true);
    resetFeedback();
    try {
      const outcome = await confirmFirebaseSignIn({
        method: choice,
        email,
        password: choice === 'password' ? signInPassword : undefined,
      });

      if (outcome.kind === 'idToken') {
        setMethod(choice);
        setStep('newPassword');
        return;
      }
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'wrong-method') {
        // Firebase says this address has no password identity, so the other option is
        // the one that confirms this account. The reply is an ACTION, so the flow
        // returns to where that action is — the choice — rather than leaving the person
        // on a screen whose only control cannot succeed. No banner: the info strip
        // carries the instruction.
        setInfo(OTHER_OPTION_MESSAGE);
        setMethod(null);
        setSignInPassword('');
        setStep('choose');
        return;
      }
      setFormError(outcome.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Step 2 — the new password, then the one authoritative call.
   *
   * The client-side checks are FRIENDLY, NOT AUTHORITATIVE: the server validates the
   * same password through the shared validator that `change-password` uses, and its
   * `fields` are what render when the two disagree. `confirmPassword` is compared here
   * and then dropped — it is never part of the request body, so a mistyped
   * confirmation cannot reach the server at all.
   */
  async function submit(): Promise<void> {
    const problems: Record<string, string> = {};
    if (!newPassword) problems.newPassword = 'New password is required';
    else {
      // The SHARED length rule, which is how this screen gained the 72-character ceiling
      // it was missing. The minimum was checked here; the maximum only on the server, so
      // an over-long password was sent to it and refused in a developer's words under the
      // input. That matters more on this screen than on most: the password being typed is
      // the one that becomes the account's local credential when Firebase is disconnected.
      const strength = passwordStrengthProblem(newPassword);
      if (strength) problems.newPassword = strength;
    }
    // An EMPTY confirmation is reported as MISSING rather than as a mismatch — the rule
    // `register.tsx` documents. "Passwords do not match" under a field nobody has typed in
    // names the wrong problem and reads as though a comparison had happened.
    if (!confirmPassword) problems.confirm = 'Confirm password is required';
    else if (confirmPassword !== newPassword) problems.confirm = 'Passwords do not match';
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    resetFeedback();
    try {
      const outcome = await changeFirebasePassword(
        {
          method: method ?? 'password',
          email,
          // Only the password option uses it, and it is the person's Firebase password.
          // It is re-collected here on a retry rather than remembered by the
          // orchestration, so it never spans the second confirmation.
          password: method === 'password' ? signInPassword : undefined,
          newPassword,
        },
        // The second attempt is the last one. The orchestration refuses to answer
        // `reauth-required` a second time, so this flag is the cap and not a hint.
        { retry: retried }
      );

      if (outcome.kind === 'reauth-required') {
        // THE PASSWORD IS DISCARDED HERE, BEFORE THE SECOND CONFIRMATION RUNS. That
        // ordering is the whole point: the confirmation can hand control to a browser
        // (or an account chooser) that backgrounds or kills this process, and a typed
        // password must not be sitting in memory while it does. Cleared by hand rather
        // than by remounting, so the two fields are empty on arrival at step 2 and a
        // person cannot submit the credential the server has just judged too old an
        // `auth_time` against.
        setRetried(true);
        setNewPassword('');
        setConfirmPassword('');
        setSignInPassword('');
        setMethod(null);
        setFieldErrors({});
        setFormError(null);
        setFormRequestId(null);
        setInfo(REAUTHENTICATION_NOTICE);
        setStep('choose');
        return;
      }

      // `changed`: the credential is Firebase's and the session has already been replaced
      // by the final exchange, so the person is still signed in and nothing needs
      // re-authenticating. The screen stays put and reports it rather than navigating
      // away silently, which would leave the one question that matters unanswered.
      setDone(true);
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
      } else if (!retried && (isWrongMethodRefusal(err) || needsAnotherConfirmation(err))) {
        // BOTH REMEDIES LIVE ON THE FIRST STEP, so the flow returns there instead of
        // dead-ending on a new-password form that cannot succeed: the wrong option has
        // to be replaced with the right one, and a confirmation the server no longer
        // considers fresh has to be performed again. The typed sign-in password is
        // cleared so a wrong one is neither left on screen nor resubmitted by accident.
        //
        // ONLY WHILE THE RETRY IS UNSPENT. Once `retried` is set, a freshness refusal is
        // the flow's LAST word and is surfaced instead of being answered with another
        // confirmation — otherwise "one retry" would be a comment rather than a rule.
        setSignInPassword('');
        setMethod(null);
        setInfo(isWrongMethodRefusal(err) ? OTHER_OPTION_MESSAGE : null);
        const message = needsAnotherConfirmation(err) ? messageFor(err) : null;
        setFormError(message);
        setFormRequestId(message ? errorRequestId(err) : null);
        setStep('choose');
      } else {
        const fields = fieldMap(err);
        if (Object.keys(fields).length) {
          setFieldErrors(fields);
          setFormRequestId(null);
        } else {
          setFormError(messageFor(err));
          setFormRequestId(errorRequestId(err));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Change sign-in password' }} />
      <Screen scroll contentStyle={styles.content}>
        <Banner type="error" text={formError} requestId={formRequestId} />
        {info ? <Banner type="info" text={info} /> : null}

        {done ? (
          <>
            <SectionHeader title="Password changed" />
            <Card>
              <Text style={styles.help}>
                Your password has been changed. Use it the next time you sign in. Any other device
                signed in to this account has been signed out.
              </Text>
              <Button
                title="Back to profile"
                style={styles.spaced}
                onPress={() => router.replace('/profile')}
              />
            </Card>
          </>
        ) : null}

        {!done && step === 'choose' ? (
          <>
            <SectionHeader title="Step 1 · Confirm your sign-in" />
            <Card>
              <Text style={styles.help}>
                For your security, confirm how this account signs in. Your Inventory AI session stays
                active during this step.
              </Text>
              <Text style={styles.label}>Account</Text>
              <Text style={styles.value}>{email}</Text>
              <Button
                title={METHOD_LABELS.google}
                style={styles.spaced}
                loading={busy}
                onPress={() => runConfirm('google')}
              />
              <Button
                title={METHOD_LABELS.password}
                variant="secondary"
                style={styles.spaced}
                disabled={busy}
                onPress={() => {
                  resetFeedback();
                  setStep('confirmPassword');
                }}
              />
            </Card>
          </>
        ) : null}

        {!done && step === 'confirmPassword' ? (
          <>
            <SectionHeader title="Step 1 · Confirm your sign-in" />
            <Card>
              <Text style={styles.help}>
                Enter the password this account uses to sign in. This confirms your identity — it is not
                the new password.
              </Text>
              <Input
                name="signInPassword"
                label="Sign-in password"
                value={signInPassword}
                onChangeText={setSignInPassword}
                secureTextEntry
                placeholder="Your current password"
                error={fieldErrors.signInPassword}
                required
                autoCapitalize="none"
              />
              <Button title="Confirm" style={styles.spaced} loading={busy} onPress={() => runConfirm('password')} />
              <Button
                title="Back"
                variant="secondary"
                style={styles.spaced}
                disabled={busy}
                onPress={() => {
                  resetFeedback();
                  setStep('choose');
                }}
              />
            </Card>
          </>
        ) : null}

        {!done && step === 'newPassword' ? (
          <>
            <SectionHeader title="Step 2 · Choose a new password" />
            <Card>
              <Text style={styles.help}>
                This account will sign in with this password from now on. Changing your password does
                not remove the account&apos;s sign-in — it replaces the password only.
              </Text>
              <Input
                name="newPassword"
                label="New password"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                placeholder="At least 8 characters"
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
                placeholder="Repeat the new password"
                error={fieldErrors.confirm}
                required
                autoCapitalize="none"
              />
              <Button
                title="Change sign-in password"
                loading={busy}
                style={styles.spaced}
                onPress={submit}
              />
              <Button
                title="Back"
                variant="secondary"
                style={styles.spaced}
                disabled={busy}
                onPress={() => {
                  resetFeedback();
                  setStep('choose');
                }}
              />
            </Card>
          </>
        ) : null}
      </Screen>
    </>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { paddingBottom: spacing.xxl },
    help: { ...type.bodySmall, color: colors.textSecondary },
    label: { ...type.label, color: colors.textMuted, marginTop: spacing.lg },
    // Same treatment profile.tsx gives its account values, so the read-only email
    // reflows instead of truncating at large system font sizes.
    value: { ...type.body, color: colors.text, fontWeight: '600' },
    spaced: { marginTop: spacing.md },
  });
