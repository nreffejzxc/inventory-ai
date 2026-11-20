import { useMemo, useState } from 'react';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import Input from '../components/Input';
import { resetPassword } from '../lib/api';
import { clearPasswordResetPending, markPasswordResetPending, useSession } from '../lib/auth';
import { fieldErrorsFrom } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { confirmFirebasePasswordReset, verifyFirebasePasswordResetCode } from '../lib/firebase-auth';
import { type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { passwordRuleHint, passwordStrengthProblem } from '../lib/validation';

const RESET_COMPLETED = 'Password changed. Please sign in again.';

/**
 * The copy for a Firebase action code that cannot be redeemed — expired, already
 * spent, unknown, or issued for something other than a password reset.
 *
 * It lives here rather than in `lib/firebase-auth.ts` because it is product copy for an
 * ORDINARY state, which is the split that module documents: it returns the
 * `invalid-code` outcome with no message and this screen supplies the sentence.
 */
const LINK_INVALID = 'This reset link is invalid or has expired. Request a new one.';

/**
 * A link code arrives from the deep link and from nowhere else. A missing param is
 * `undefined`, and a link carrying the key twice yields an array — neither is a usable
 * code, and neither should ever reach the network. Nothing about the value's SHAPE is
 * checked: a Firebase `oobCode` and the custom flow's token are both opaque, so any
 * client-side rule could only ever reject a link that works.
 */
function readCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * Which recovery flow this link belongs to, decided by WHICH PARAMETER IS PRESENT.
 *
 * A Firebase action link carries `mode=resetPassword` and an `oobCode`; the custom
 * 26B/27 link carries a `token`. Both ship in N-3, so the screen supports both and
 * never guesses: the Firebase code is preferred when both are somehow present, because
 * only Firebase can redeem it and the custom flow's token is not a substitute for it.
 *
 * The two are held as a discriminated union rather than as two loose strings so that
 * `submit` below cannot accidentally send one flow's credential to the other's
 * endpoint — the branch that reads the code is the same branch that knows the kind.
 */
type ResetAttempt =
  | { kind: 'firebase'; oobCode: string }
  | { kind: 'legacy'; token: string };

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    footerText: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    link: { color: colors.link, fontWeight: '700' },
  });

/**
 * Complete a password reset (Phase 27). PUBLIC, and a sibling of login/register
 * rather than a member of the `(app)` group: the group layout redirects anyone
 * who is not signed in, which would discard the incoming token before this
 * screen could read it.
 *
 * The code is held only in route params for as long as the screen is mounted — it is
 * never rendered, logged, persisted, or copied into another navigation. It leaves the
 * app in exactly one place, and N-3 gives that place two possible forms: the body of the
 * custom flow's reset POST, or the single argument of Firebase's `confirmPasswordReset`.
 *
 * TWO FLOWS, ONE SCREEN. A Firebase link (`?oobCode=`) is redeemed by Firebase; a custom
 * link (`?token=`) still goes to `POST /api/auth/reset-password`. Which one runs is
 * decided by `attempt` below and by nothing else, and neither path can be reached with
 * the other's credential.
 */
export default function ResetPasswordScreen() {
  // Read from the focused route's params rather than latched into state, so a
  // second link delivered while this screen is already open supersedes the first.
  const params = useLocalSearchParams();
  const oobCode = readCode(params.oobCode);
  const token = readCode(params.token);

  // N-3: the presence of a FIREBASE code decides the flow; a link with only the custom
  // flow's token is the legacy path and still works. A link with neither has nothing to
  // submit, and no request is made.
  const attempt: ResetAttempt | null = oobCode
    ? { kind: 'firebase', oobCode }
    : token
      ? { kind: 'legacy', token }
      : null;

  if (!attempt) {
    return (
      <AuthLayout title="Link incomplete" subtitle="This reset link is missing its code.">
        <Banner
          type="error"
          text="The link you followed is incomplete. Request a new one to continue."
        />
        <Button title="Request a new link" onPress={() => router.replace('/forgot-password')} full />
      </AuthLayout>
    );
  }

  // The code is the form's identity, and that is what makes a second link start a clean
  // attempt: a different code is a different component, so React remounts it and every
  // field, error and flag below begins again. Resetting through identity rather than
  // through an effect on the code also means the new link never renders against the
  // previous attempt's state, not even for the commit an effect would have needed to
  // catch up. The key carries the flow as well as the code, so a Firebase link and a
  // legacy link can never be mistaken for a second attempt at the same one.
  const attemptKey = attempt.kind === 'firebase' ? attempt.oobCode : attempt.token;
  return <ResetPasswordForm key={`${attempt.kind}:${attemptKey}`} attempt={attempt} />;
}

/**
 * The reset form itself. Its state is deliberately co-located with the component
 * the `key` above remounts — state that lives any higher would survive a new
 * link, which is the one thing a fresh attempt must never do.
 */
function ResetPasswordForm({ attempt }: { attempt: ResetAttempt }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { clearSession } = useSession();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(): Promise<void> {
    // Friendly pre-checks mirroring the server rules. `confirmPassword` keeps the
    // server's own field name so a server-side error for it lands on this input.
    const problems: Record<string, string> = {};
    if (!newPassword) problems.newPassword = 'New password is required';
    else {
      // THE SHARED LENGTH RULE, which is how this screen gained the 72-character ceiling
      // it was missing. The minimum was checked here all along; the maximum was the
      // server's alone, so an over-long password travelled there and came back under the
      // input as "password must be at most 72 characters" — a developer's sentence.
      const strength = passwordStrengthProblem(newPassword);
      if (strength) problems.newPassword = strength;
    }
    // An EMPTY confirmation is reported as MISSING rather than as a mismatch. That is the
    // rule `register.tsx` already documents, and it matters for the same reason: "Passwords
    // do not match" under a field nobody has typed in describes the wrong problem and reads
    // as though a comparison had happened. A non-empty one that differs still says it.
    if (!confirmPassword) problems.confirmPassword = 'Confirm password is required';
    else if (confirmPassword !== newPassword) problems.confirmPassword = 'Passwords do not match';
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      if (attempt.kind === 'firebase') {
        // N-4 STEP 1 — WHICH ACCOUNT IS THIS LINK FOR? Firebase resolves the address the
        // code belongs to, so the person never has to retype it. This step does not touch
        // the credential, which is exactly why it may run before the marker below.
        //
        // The address is MEMORY-ONLY, and it has exactly two uses on this screen: it
        // becomes the fingerprint's input, and (one screen later, after the password has
        // changed) the address the automatic sign-in uses. It is never rendered, logged,
        // persisted, put in a route param or sent to the server, and it authorizes
        // nothing — the server resolves the account from the session and the verified uid.
        const verified = await verifyFirebasePasswordResetCode(attempt.oobCode);
        if (verified.kind === 'invalid-code') {
          setFormError(LINK_INVALID);
          return;
        }
        if (verified.kind === 'failure') {
          setFormError(verified.message);
          return;
        }

        // N-4 STEP 2 — THE RECOVERY MARKER, WRITTEN BEFORE THE PASSWORD CHANGES (M-6).
        // The ordering is the guarantee, not a convenience: an interruption at ANY point
        // after this line — a crash, a kill, a dropped connection — leaves the note
        // behind, so the next sign-in with the new password runs the credential-change
        // bridge and revokes every session minted against the old one. Writing it after
        // the change would leave precisely the window the design forbids, where the
        // credential is new and nothing owes a revocation.
        //
        // It stores a non-secret fingerprint and nothing else — no password, no code, no
        // token, no userId, no businessId, no role, no tenant data — and it cannot fail
        // the reset, because a storage fault must never stop a password change.
        await markPasswordResetPending(verified.email);

        // N-4 STEP 3 — THE CREDENTIAL CHANGES, inside Firebase and nowhere else.
        // `invalid-code` is an ordinary outcome rather than a failure: the link is simply
        // unusable, and the person needs a new one.
        const outcome = await confirmFirebasePasswordReset({
          oobCode: attempt.oobCode,
          newPassword,
        });
        if (outcome.kind === 'invalid-code') {
          // DEFINITIVE: Firebase refused the code, so no password changed and nothing is
          // owed. The marker is dropped, because keeping it would make a LATER sign-in
          // (with the unchanged password) revoke this account's sessions for a change
          // that never happened. This is the one clear that is not an acknowledgement.
          await clearPasswordResetPending();
          setFormError(LINK_INVALID);
          return;
        }
        if (outcome.kind === 'failure') {
          // UNDECIDED, SO THE MARKER STAYS. A failure here can be a transport fault that
          // happened after Firebase applied the change, so the safe assumption is that
          // the revocation is owed — and the next sign-in is the retry. Clearing here
          // would risk the very sessions the marker exists to revoke.
          setFormError(outcome.message);
          return;
        }
      } else {
        await resetPassword({ token: attempt.token, newPassword, confirmPassword });
      }
      setDone(true);
      // Clearing the local session is what stops the login screen's
      // `status === 'signedIn'` redirect from bouncing them into `(app)`, and it is
      // right for both flows. The two differ server-side and the difference is
      // recorded rather than glossed: the CUSTOM flow stamped `passwordChangedAt`, so
      // every Inventory AI session this user held is already dead; the FIREBASE flow
      // never reached the server, so those sessions are still alive at this instant —
      // the marker written above is what closes that, by having the NEXT sign-in run the
      // credential-change bridge before its session is applied (N-4). So the revocation
      // is deferred by exactly one sign-in, and it is owed by a durable note rather than
      // by anything this screen still holds. `clearSession` rather than `signOut`:
      // signOut would fire a logout request that cannot succeed for the custom flow,
      // where the token this screen holds is already dead.
      await clearSession();
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      // The link code has no input of its own, so a field error naming it would be
      // invisible; promote it to the form level instead of dropping it. (Only the custom
      // flow can produce one: Firebase's outcomes never carry `fields`.)
      const tokenProblem = fields.token;
      delete fields.token;
      if (Object.keys(fields).length) setFieldErrors(fields);
      const fallback = Object.keys(fields).length
        ? null
        : (err as { message?: string } | null)?.message || 'Unable to reset the password.';
      setFormError(tokenProblem || fallback);
      if (tokenProblem || fallback) setFormRequestId(errorRequestId(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthLayout title="Password changed" subtitle="Sign in with your new password.">
        <Banner type="success" text={RESET_COMPLETED} />
        <Button title="Go to sign in" onPress={() => router.replace('/login')} full />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose a password for your account."
      footer={
        <Text style={styles.footerText}>
          <Link href="/forgot-password" style={styles.link}>
            Request a new link
          </Link>
        </Text>
      }
    >
      <Banner type="error" text={formError} requestId={formRequestId} />
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
        name="confirmPassword"
        label="Confirm new password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry
        placeholder="Repeat your new password"
        error={fieldErrors.confirmPassword}
        required
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button title="Set new password" onPress={submit} loading={busy} full />
    </AuthLayout>
  );
}
