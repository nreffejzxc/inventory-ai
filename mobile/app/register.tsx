import { useMemo, useState } from 'react';
import { Link, Redirect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import AuthLayout from '../components/AuthLayout';
import Banner from '../components/Banner';
import Button from '../components/Button';
import Card from '../components/Card';
import Input from '../components/Input';
import { fieldErrorsFrom } from '../lib/authCopy';
import { errorRequestId } from '../lib/errors';
import { useSession } from '../lib/auth';
import { getPendingInvite } from '../lib/pendingInvite';
import { defaultHomePath, roleLabel } from '../lib/permissions';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { emailProblem, passwordProblem, passwordRuleHint, passwordStrengthProblem } from '../lib/validation';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    // alignSelf:'stretch' + centred text so the "Already have an account? <link>"
    // line wraps cleanly instead of shrink-wrapping off-centre at large scales.
    footerText: {
      ...type.bodySmall,
      color: colors.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    link: { color: colors.link, fontWeight: '700' },
    inviteRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    inviteLabel: { ...type.body, color: colors.textMuted },
    inviteValue: { ...type.body, color: colors.text, fontWeight: '600', flexShrink: 1 },
  });

/**
 * Create Account, in two shapes.
 *
 * ORDINARY: a person starts a business, so the form asks for its name and the server
 * creates a Business with them as its OWNER.
 *
 * INVITED (2026-10-25): `app/invite.tsx` has already stored the invitation in memory and
 * sent the person here. The business and the role come from that invitation row, so the
 * form asks for neither — it names what they are joining instead. The email is PREFILLED
 * AND LOCKED, because the server checks the invited address against the verified
 * Firebase identity: letting it be edited would only produce a refusal after a six-digit
 * code had been typed. Everything else — the password, the confirmation, the name — is
 * the person's own, which is the point of an invitation: nobody else chooses their
 * credential.
 */
export default function RegisterScreen() {
  const { status, user, signUp, firebaseOnboarding } = useSession();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Read once, at mount: the value is in-memory module state that only this journey sets,
  // and re-reading it on every render would make the form re-key itself for no reason.
  const [invite] = useState(() => getPendingInvite());
  const [businessName, setBusinessName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(invite?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  /** Correcting a field clears its own message — see the same rule on Login. */
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

  async function submit(): Promise<void> {
    // Required-field validation runs first, so an empty form never reaches the
    // Firebase sign-up path — a path that CREATES AN IDENTITY, which is why getting
    // this wrong here is worse than anywhere else. The password/confirm-match rule is
    // preserved: an empty confirmation reports its own required error, and a non-empty
    // one that differs still reports 'Passwords do not match'.
    //
    // The EMAIL rule now comes from the shared module and covers the address's SHAPE
    // as well as its presence. Presence alone was the old guard, so `owner@company`
    // travelled as far as Firebase and came back described in a developer's words —
    // and on an unconfigured build it travelled to the server's validator, the only
    // place that shape rule then existed.
    const next: Record<string, string> = {};
    // Invited registrations have no business to name — the invitation already holds one.
    if (!invite && !businessName.trim()) next.businessName = 'Business name is required';
    if (!name.trim()) next.name = 'Name is required';
    const emailIssue = emailProblem(email);
    if (emailIssue) next.email = emailIssue;
    // Presence first, then LENGTH — in that order, so a short password and an empty one
    // are never confused. The length rule was the server's alone until now, which meant
    // a 5-character password travelled there and came back as "password must be at least
    // 8 characters" under the input. `reset-password.tsx` and `change-password.tsx`
    // already refused it client-side; this is the third screen that chooses a password.
    const passwordIssue = passwordProblem(password);
    if (passwordIssue) next.password = passwordIssue;
    else {
      const strength = passwordStrengthProblem(password);
      if (strength) next.password = strength;
    }
    if (!confirm) next.confirm = 'Confirm password is required';
    else if (confirm !== password) next.confirm = 'Passwords do not match';
    if (Object.keys(next).length) {
      setFieldErrors(next);
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    try {
      // Register issues no token — signUp logs the new owner in afterwards.
      //
      // THE ADDRESS IS TRIMMED ON THE WAY OUT, exactly as `login.tsx` already trims it.
      // A trailing space is invisible on a phone keyboard, and in a Firebase-configured
      // build it reached `createUserWithEmailAndPassword` verbatim — either creating an
      // identity under a padded address or coming back as `auth/invalid-email` for an
      // address the person can see is correct. The two name fields are trimmed for the
      // same reason (`Business name is required` above already judged the trimmed value,
      // so sending the raw one made the validation and the request disagree). The
      // password is deliberately NOT trimmed: spaces are legitimate password characters.
      await signUp({
        businessName: invite ? undefined : businessName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
      });
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || 'Unable to create your account. Please try again.');
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={invite ? `Join ${invite.businessName ?? 'the business'}` : 'Create your workspace'}
      subtitle={
        invite
          ? `Create your account to join as ${roleLabel(invite.role).toLowerCase()}.`
          : "You'll get a new business and an Owner account."
      }
      footer={
        <Text style={styles.footerText}>
          {invite ? 'Not you? ' : 'Already have an account? '}
          <Link href="/login" style={styles.link}>
            Sign in
          </Link>
        </Text>
      }
    >
      <Banner type="error" text={formError} requestId={formRequestId} />
      {invite ? (
        <Card>
          <View style={styles.inviteRow}>
            <Text style={styles.inviteLabel}>Business</Text>
            <Text style={styles.inviteValue}>{invite.businessName ?? 'Not available'}</Text>
          </View>
          <View style={styles.inviteRow}>
            <Text style={styles.inviteLabel}>Role</Text>
            <Text style={styles.inviteValue}>{roleLabel(invite.role)}</Text>
          </View>
        </Card>
      ) : (
        <Input
          name="businessName"
          label="Business name"
          value={businessName}
          onChangeText={editField('businessName', setBusinessName)}
          placeholder="Acme Retail"
          // A business name is a name: the keyboard should capitalise it. `Input`
          // defaults to `none` for the code/barcode fields this app is full of.
          autoCapitalize="words"
          returnKeyType="next"
          error={fieldErrors.businessName}
          required
        />
      )}
      <Input
        name="name"
        label="Your name"
        value={name}
        onChangeText={editField('name', setName)}
        placeholder="Jane Doe"
        error={fieldErrors.name}
        required
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        returnKeyType="next"
      />
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
        // The invited address is the identity the server compares against, so it is shown
        // and not editable — the invitation was sent to it.
        editable={!invite}
        helper={invite ? 'This invitation was sent to this address.' : undefined}
        // What the field HOLDS, so the phone's password manager can fill it instead of
        // asking the person to retype an address they already saved.
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
        placeholder="At least 8 characters"
        helper={passwordRuleHint(password)}
        error={fieldErrors.password}
        required
        // THE declaration that makes a password manager offer a generated password —
        // `current-password` here would ask it for an existing one, which cannot work on
        // an account that does not exist yet.
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="next"
      />
      <Input
        name="confirm"
        label="Confirm password"
        value={confirm}
        onChangeText={editField('confirm', setConfirm)}
        secureTextEntry
        placeholder="Repeat your password"
        error={fieldErrors.confirm}
        required
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button title="Create Account" onPress={submit} loading={busy} full />
    </AuthLayout>
  );
}
