import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Linking, StyleSheet, Text, View } from 'react-native';

import Badge from '../../components/Badge';
import Banner from '../../components/Banner';
import Button from '../../components/Button';
import Card from '../../components/Card';
import ListRow from '../../components/ListRow';
import Screen from '../../components/Screen';
import SectionHeader from '../../components/SectionHeader';
import { useSession } from '../../lib/auth';
import { API_URL } from '../../lib/config';
import { confirm } from '../../lib/confirm';
import { formatDateTime } from '../../lib/format';
import { roleLabel, defaultHomePath } from '../../lib/permissions';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/**
 * The installed app version — which is also this build's over-the-air runtime version, because
 * `app.json` sets `runtimeVersion.policy: "appVersion"`. It is read from the bundle's own config
 * rather than written out here, so it cannot drift from `app.json` the first time the version is
 * bumped. This is the line that makes a support conversation possible at all: without it nobody
 * can say which build they are on, and "did the update arrive?" is guesswork.
 */
const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

/**
 * One label/value line. The label is the muted title and the value renders at
 * body size beneath it (never a fixed-height right column) so long emails and
 * long names reflow instead of truncating at large system font sizes.
 */
function DetailRow({ label, value, divider }: { label: string; value?: ReactNode; divider?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (value == null || value === '') return null;
  return (
    <ListRow
      style={divider ? styles.detailRow : undefined}
      title={label}
      titleStyle={styles.detailLabel}
      footer={<Text style={styles.detailValue}>{value}</Text>}
    />
  );
}

export default function ProfileScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, signOut, refresh, connectFirebase } = useSession();
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);

  /**
   * The two legal pages live on our own server, not in the app bundle, for the same reason
   * Google Play asks for a URL: they must be readable without signing in, and they must be
   * CORRECTABLE without shipping a build. So the app opens them in the browser instead of
   * rendering a copy that could go stale.
   *
   * The address is derived from `API_URL`, never written out here: a build pointed at the
   * development server opens the development pages, and a production build opens production. A
   * hand-typed domain would be the one thing that silently kept pointing somewhere else.
   *
   * `canOpenURL` is checked first because a phone with no browser (or a locked-down profile)
   * would otherwise throw after the tap and look like nothing happened; the failure is stated
   * instead. Nothing here is a security control — the pages are public and carry no data about
   * this account.
   */
  async function openLegal(path: '/privacy' | '/terms'): Promise<void> {
    setLegalError(null);
    const url = `${API_URL}${path}`;
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error('no handler');
      await Linking.openURL(url);
    } catch {
      setLegalError('Could not open the page on this device. Check your connection and try again.');
    }
  }

  /**
   * Phase 32M — Add Google sign-in, from the Sign-in methods card.
   *
   * THE SERVER DECIDES EVERYTHING. This handler starts the flow, reports what came
   * back, and does nothing else: it holds no token, no uid and no email, and it sends
   * none of them. `connectFirebase` obtains the credential from the Firebase layer at
   * the moment of use, and the server's account (from the session) and identity (from
   * the verified token) are what it links.
   *
   * `cancelled` and `in-flight` are ORDINARY, so neither shows anything: closing the
   * Google sheet is not a failure, and a duplicate tap that started nothing must not
   * report one. A success shows a notice rather than a banner-only silence, because the
   * action disappears in the same commit — the account can no longer be offered the
   * method it now has — and the sentence is what explains the change.
   *
   * A REFUSAL SHOWS THE SERVER'S OWN SENTENCE. The conflict message is deliberately
   * generic server-side — it may not say whether the identity belongs to someone else or
   * this account already carries a different one — so this screen relays it rather than
   * inventing an explanation it cannot support. A 400 for a rejected provider credential
   * renders here too and is NOT session loss: the Inventory AI session is untouched, and
   * the client only treats a 401/403 on a token-carrying request as a dead session.
   */
  async function onConnectGoogle(): Promise<void> {
    setConnectBusy(true);
    setConnectError(null);
    setConnectNotice(null);
    try {
      const outcome = await connectFirebase();
      if (outcome.kind === 'linked') {
        setConnectNotice(
          'Google sign-in connected. You can now sign in with Google or your password.'
        );
      }
    } catch (err) {
      setConnectError(
        (err as { message?: string } | null)?.message ||
          'Unable to add Google sign-in. Please try again.'
      );
    } finally {
      setConnectBusy(false);
    }
  }

  async function onSignOut(): Promise<void> {
    const ok = await confirm('Sign out', 'You will need to sign in again to manage inventory.', {
      confirmText: 'Sign Out',
      destructive: true,
    });
    if (ok) await signOut();
  }

  return (
    <Screen scroll>
      <Card style={styles.headerCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(user?.name ?? '?').slice(0, 1).toUpperCase()}</Text>
        </View>
        <Text style={styles.name}>{user?.name}</Text>
        <Badge
          text={roleLabel(user?.role)}
          tone={user?.role === 'OWNER' ? 'info' : 'neutral'}
          style={styles.headerBadge}
        />
      </Card>

      <SectionHeader title="Account" style={styles.section} />
      <Card>
        <View style={styles.detailList}>
          <DetailRow label="Name" value={user?.name} divider />
          <DetailRow label="Email" value={user?.email} divider />
          <DetailRow label="Role" value={roleLabel(user?.role)} divider />
          <DetailRow label="Status" value={user?.status === 'ACTIVE' ? 'Active' : user?.status} divider />
          <DetailRow label="Member since" value={formatDateTime(user?.createdAt)} />
        </View>
        <Button
          title="Edit name"
          variant="secondary"
          style={styles.editName}
          onPress={() => router.push('/edit-name')}
        />
      </Card>

      <SectionHeader title="Sign-in methods" style={styles.section} />
      <Card>
        <Text style={styles.securityText}>
          Manage the ways you can sign in to your Inventory AI account.
        </Text>
        {/* Both render nothing when empty, so only the live feedback shows. */}
        <Banner type="success" text={connectNotice} />
        <Banner type="error" text={connectError} />
        {/**
         * Phase 32K, widened by this pass — local password management is offered only
         * where the server will actually accept it. `authMethods.password` is false
         * for an account whose credential is held by its sign-in provider: Firebase
         * is the authentication authority for such an account, so the server refuses
         * a local password change outright (409 `PASSWORD_NOT_APPLICABLE`) and
         * showing the control would only lead to that rejection.
         *
         * THIS PASS ADDS THE SECOND HALF OF THE CONDITION, and it is the point rather
         * than a tidy-up. `{ password: true, firebase: true }` describes an account
         * that still carries a local password AND authenticates through a Firebase
         * identity — a legacy password account that later attached one. For it the
         * server keeps the `passwordHash` but `loginWithPassword` refuses the account
         * with 403 `FIREBASE_SIGN_IN_REQUIRED`, so the retained hash no longer
         * authenticates anyone and `/change-password` answers 409
         * `PASSWORD_NOT_APPLICABLE` exactly as it does for a native Firebase account.
         * Reading `password: true` alone as "this account manages its own password"
         * therefore offered an action whose only possible outcome was an error.
         *
         * THE CURRENT SERVER DOES NOT PRODUCE THAT SHAPE. `authMethodsFor` derives the
         * two capabilities as exact complements of `firebaseUid`, so today an account
         * is either `{ true, false }` or `{ false, true }`. This branch is defensive:
         * the shape is reachable if the capability block is ever derived differently
         * (the reasoning Phase 32M already pins for the same combination), and the
         * cost of covering it now is one condition instead of a dead end later.
         *
         * Both halves are tested with `===`, so the historical behaviour survives in
         * exactly the cases that must keep it: a user object without `authMethods` (an
         * older server, or a response that predates these fields) still gets the local
         * button, and so does an account that is neither provider-owned nor linked.
         *
         * Nothing here is a security control. The server is the boundary either way;
         * this only stops the UI from offering an action it knows will fail.
         */}
        {user?.authMethods?.password === false || user?.authMethods?.firebase === true ? (
          <Text style={[styles.securityText, styles.spaced]}>
            Your password is managed by your sign-in provider. Use the action below to change it.
          </Text>
        ) : (
          <>
            <Text style={styles.methodLabel}>Email & Password</Text>
            <Button
              title="Change password"
              variant="secondary"
              style={styles.spaced}
              onPress={() => router.push('/change-password')}
            />
          </>
        )}
        {/**
         * Phase A (F-1) — the password-change entry point for a Firebase account.
         *
         * THE BUTTON USED TO DETACH THE FIREBASE IDENTITY; IT NOW CHANGES THE PASSWORD.
         * Firebase owns this account's credential (Phase 32K refuses a local change with
         * 409 `PASSWORD_NOT_APPLICABLE`), so the only place a password can be changed is
         * Firebase, and the account keeps its `firebaseUid` either way.
         *
         * `authMethods.firebase` is the server's own statement that this account
         * authenticates through a Firebase identity, so it is the correct gate: it is
         * true for a Firebase-NATIVE account and for a Firebase-LINKED legacy account
         * alike, and the app cannot tell those apart — nor should it, since the
         * server publishes a capability rather than the identity behind it. Every such
         * account can therefore change its password from here, which is what makes the
         * old "password is managed by your sign-in provider" line below a signpost
         * rather than a dead end.
         *
         * The test is `=== true`, not truthiness, so a user object that predates the
         * field simply shows no action instead of opening a flow the server would
         * refuse with 409 `FIREBASE_IDENTITY_CONFLICT`.
         *
         * Nothing here is a security control: the screen re-checks the same
         * capability, and the server is the boundary in every case.
         */}
        {/**
         * Phase 32M — the Add Google sign-in entry point, offered only where reconnecting
         * is both possible and meaningful.
         *
         * THE GATE IS THE SERVER'S OWN CAPABILITY BLOCK, tested with `===` on BOTH
         * halves so an older server's user object — one without `authMethods` at all —
         * simply shows nothing rather than offering a flow whose preconditions are
         * unknown. `firebase === false` means no Firebase identity is attached, and
         * `password === true` means the account has a local password, which is the
         * credential the caller uses to prove ownership of the account being linked.
         * An account whose password the provider manages is therefore NOT offered this:
         * it already authenticates through Firebase, and the server is the boundary that
         * would refuse or allow the link in any case.
         *
         * Nothing here is a security control. It only stops the UI from offering an
         * action whose precondition it cannot see; the server decides the link itself,
         * from the session and the verified token, and no client value reaches it.
         */}
        {user?.authMethods?.firebase === false && user?.authMethods?.password === true ? (
          <>
            <Text style={styles.methodLabel}>Google sign-in</Text>
            <Text style={styles.securityText}>
              Use your Google account to sign in to Inventory AI.
            </Text>
            <Button
              title="Add Google sign-in"
              variant="secondary"
              style={styles.spaced}
              loading={connectBusy}
              disabled={connectBusy}
              onPress={onConnectGoogle}
            />
          </>
        ) : null}
        {user?.authMethods?.firebase === true ? (
          <>
            <Text style={[styles.securityText, styles.spaced]}>
              Change the password you use to sign in to your Inventory AI account.
            </Text>
            <Button
              title="Change sign-in password"
              variant="secondary"
              style={styles.spaced}
              onPress={() => router.push('/disconnect-firebase')}
            />
          </>
        ) : null}
      </Card>

      <SectionHeader title="Security" style={styles.section} />
      <Card>
        <Text style={styles.securityText}>
          Inventory AI keeps your sign-in on this device&apos;s secure storage. Permissions and business data are
          always enforced by the server — the app never stores your password.
        </Text>
        <Button
          title="Active sessions"
          variant="secondary"
          style={styles.editName}
          onPress={() => router.push('/sessions')}
        />
      </Card>

      {/*
       * The AI assistant's practical limits, kept short and member-facing. The detailed reference
       * in docs/guides/18-ai-assistant-limits.md carries the internal numbers; this card states
       * only what changes a member's experience: how often they can ask, how long an answer may
       * take, what stopping does, and what happens when the assistant is unavailable.
       *
       * Deliberately absent: token caps, tool counts, model ids, provider quotas and fallback
       * rules. Those are operator facts, and showing them here would invite a member to reason
       * about a system they cannot control.
       */}
      <SectionHeader title="AI assistant" style={styles.section} />
      <Card>
        <Text style={styles.securityText}>
          The assistant can read the inventory you are allowed to see. It never changes stock,
          products, or other records.
        </Text>
        <Text style={styles.methodLabel}>Messages</Text>
        <Text style={styles.securityText}>
          You can send up to 20 messages per minute. If you reach the limit, wait a moment and try
          again.
        </Text>
        <Text style={styles.methodLabel}>Answer time</Text>
        <Text style={styles.securityText}>
          An answer can take up to a minute. If it takes too long, the app stops waiting and you
          can ask again.
        </Text>
        <Text style={styles.methodLabel}>Stopping an answer</Text>
        <Text style={styles.securityText}>
          Stopping cancels the answer. If it had already finished, it will be in the chat when you
          reopen it.
        </Text>
        <Text style={styles.methodLabel}>When the assistant is unavailable</Text>
        <Text style={styles.securityText}>
          If the assistant is unavailable or reaches its usage limit, the chat tells you. The rest
          of Inventory AI keeps working.
        </Text>
      </Card>

      {/*
       * About: the doorway to the release notes, and the only place the app states its own
       * version. Both belong to the quiet end of the screen — a person checks them once — and
       * neither needs the network, so the card works offline.
       */}
      <SectionHeader title="About" style={styles.section} />
      <Card>
        <Text style={styles.securityText}>
          Inventory AI updates itself. A new version arrives the next time you open the app, so
          there is nothing to download from the store.
        </Text>
        <Button
          title="What's new"
          variant="secondary"
          style={styles.editName}
          onPress={() => router.push('/whats-new')}
        />
        <View style={styles.versionRow}>
          <Text style={styles.versionLabel}>App version</Text>
          <Text style={styles.versionValue}>{APP_VERSION}</Text>
        </View>
      </Card>

      {/*
       * The legal pages, kept at the quiet end of the screen: they are reference material a
       * person reads once, not an action. Both are PUBLIC pages on the server, so this card
       * works for an account that is signed in and says nothing about it — no token, no id and
       * no address travels with the tap.
       */}
      <SectionHeader title="Legal" style={styles.section} />
      <Card>
        <Text style={styles.securityText}>
          The privacy policy describes what the app collects and which outside services process it.
          The terms of use describe what the service asks of you and what you can expect from it.
        </Text>
        <Banner type="error" text={legalError} style={styles.legalError} />
        <Button
          title="Privacy policy"
          variant="secondary"
          style={styles.editName}
          onPress={() => void openLegal('/privacy')}
        />
        <Button
          title="Terms of use"
          variant="secondary"
          style={styles.spaced}
          onPress={() => void openLegal('/terms')}
        />
      </Card>

      <Button title="Refresh account" variant="secondary" style={styles.spaced} onPress={() => refresh()} />
      <Button title="Back to home" variant="secondary" style={styles.spaced} onPress={() => router.replace(defaultHomePath(user))} />
      <Button title="Sign out" variant="danger" style={styles.spaced} onPress={onSignOut} />

      {/*
       * Deletion lives at the BOTTOM of the profile, below sign-out, and behind its own
       * confirmation screen — never a one-tap action beside it. The screen it opens is
       * the only place the consequences are stated, so this row is a doorway rather than
       * the decision. `secondary` keeps it visually quieter than sign-out: closing the
       * account is rarer and more consequential, not more prominent.
       */}
      <Button
        title="Delete account"
        variant="secondary"
        style={styles.spaced}
        onPress={() => router.push('/delete-account')}
      />
    </Screen>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  headerCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  avatarText: { ...type.h1, color: colors.textOnPrimary },
  name: { ...type.h2, color: colors.text, marginBottom: spacing.xs },
  // The legal banner sits between the explanatory copy and the two buttons; the banner's own
  // bottom margin is larger than this card wants, so it is trimmed here.
  legalError: { marginTop: spacing.sm, marginBottom: 0 },
  // Badge sets alignSelf:'flex-start' for list rows; centre it under the name.
  headerBadge: { alignSelf: 'center' },
  section: { marginTop: spacing.xxl },
  detailList: { gap: spacing.sm },
  detailRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider, paddingBottom: spacing.sm },
  detailLabel: { ...type.label, color: colors.textMuted },
  detailValue: { ...type.body, color: colors.text, fontWeight: '600' },
  editName: { marginTop: spacing.lg },
  securityText: { ...type.bodySmall, color: colors.textSecondary },
  // The user-facing NAME of a sign-in method, above its description and action.
  // Sentence-cased words rather than implementation names, and no provider is
  // named where the account's provider is not knowable (see the phase comments).
  methodLabel: { ...type.label, color: colors.text, marginTop: spacing.lg },
  spaced: { marginTop: spacing.md },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  versionLabel: { ...type.label, color: colors.textMuted },
  versionValue: { ...type.body, color: colors.text, fontWeight: '600' },
});
