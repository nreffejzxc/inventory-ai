import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Badge from '../../../components/Badge';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import Screen from '../../../components/Screen';
import { aiApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { isSessionError, useSession } from '../../../lib/auth';
import { feedbackReasonLabel } from '../../../lib/aiFeedback';
import { formatDateTime } from '../../../lib/format';
import { canViewAiMetrics, roleLabel } from '../../../lib/permissions';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

/**
 * AI-117 — the explicit expansion behind one report.
 *
 * The queue returns bounded excerpts on purpose. An OWNER/ADMIN opens this screen
 * before marking a report reviewed, sees the complete reported answer and up to
 * six messages on either side, and may review or reopen from here. The server
 * re-checks the role and business on the request itself; this guard only stops
 * the screen asking for data the caller cannot read.
 */
export default function AiFeedbackPreviewScreen() {
  const { user } = useSession();

  if (!canViewAiMetrics(user)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Conversation' }} />
        <AccessDenied message="Only the business owner and admins can review assistant feedback." />
      </>
    );
  }

  return <FeedbackPreview />;
}

function FeedbackPreview() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut } = useSession();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] ?? '' : '';
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const next = await aiApi.feedbackConversation(token, id);
      setData(next);
      setError(null);
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
      } else {
        setError('This conversation could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  }, [token, id, signOut]);

  useEffect(() => {
    if (!token || !id) return;
    let active = true;
    aiApi
      .feedbackConversation(token, id)
      .then((next) => {
        if (!active) return;
        setData(next);
        setError(null);
      })
      .catch(async (err) => {
        if (!active) return;
        if (isSessionError(err)) {
          await signOut();
        } else {
          setError('This conversation could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, id, signOut]);

  function retry(): void {
    setError(null);
    setLoading(true);
    void load();
  }

  async function toggleReviewed(): Promise<void> {
    if (!token || !data?.feedback) return;
    setBusy(true);
    setActionError(null);
    try {
      await aiApi.reviewFeedback(token, id, data.feedback.status !== 'REVIEWED');
      await load();
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
      } else {
        setActionError('That report could not be updated. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!token || !id) {
    return (
      <>
        <Stack.Screen options={{ title: 'Conversation' }} />
        <Screen>
          <View style={styles.center}>
            <Text style={styles.errorTitle}>Could not load conversation</Text>
            <Text style={styles.errorText}>This report is unavailable.</Text>
            <Button title="Back" variant="ghost" onPress={() => router.back()} />
          </View>
        </Screen>
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <Stack.Screen options={{ title: 'Conversation' }} />
        <Screen>
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.loadingText}>Loading conversation…</Text>
          </View>
        </Screen>
      </>
    );
  }

  if (error || !data?.feedback) {
    return (
      <>
        <Stack.Screen options={{ title: 'Conversation' }} />
        <Screen>
          <View style={styles.center}>
            <Text style={styles.errorTitle}>Could not load conversation</Text>
            <Text style={styles.errorText}>{error ?? 'This report is unavailable.'}</Text>
            <Button title="Try again" variant="secondary" onPress={retry} />
            <Button title="Back" variant="ghost" onPress={() => router.back()} />
          </View>
        </Screen>
      </>
    );
  }

  const report = data.feedback;
  const messages: ApiResponse[] = Array.isArray(data.messages) ? data.messages : [];
  const reviewed = report.status === 'REVIEWED';
  const reason = feedbackReasonLabel(report.reason);

  return (
    <>
      <Stack.Screen options={{ title: 'Conversation' }} />
      <Screen scroll>
        <Card style={styles.reportCard}>
          <View style={styles.badgeRow}>
            <Badge
              text={report.rating === 'DOWN' ? 'Bad response' : 'Good response'}
              tone={report.rating === 'DOWN' ? 'warning' : 'success'}
            />
            <Badge text={reviewed ? 'Reviewed' : 'Open'} tone={reviewed ? 'success' : 'warning'} dot />
          </View>
          {reason ? <Text style={styles.reason}>{reason}</Text> : null}
          {report.comment ? <Text style={styles.comment}>“{report.comment}”</Text> : null}
          <Text style={styles.meta}>
            {report.reportedBy?.name || 'Former member'} · {roleLabel(report.reportedBy?.role)} ·{' '}
            {formatDateTime(report.createdAt)}
          </Text>
          {report.turnId ? (
            <Text selectable style={styles.reference}>
              Ref: {report.turnId}
            </Text>
          ) : null}
        </Card>

        <Text style={styles.sectionTitle}>Conversation</Text>
        <Text style={styles.windowNote}>
          The reported answer is shown in full. Up to six messages before and after it are included.
        </Text>
        {data.omittedBefore ? <Text style={styles.omitted}>Earlier messages are not shown.</Text> : null}

        {messages.map((message) => {
          const reported = message.reported === true;
          const assistant = message.role === 'ASSISTANT';
          return (
            <Card key={message.id} style={reported ? styles.reportedCard : styles.messageCard}>
              <View style={styles.messageHeader}>
                <Text style={styles.messageRole}>{assistant ? 'Assistant' : 'Member'}</Text>
                {reported ? <Badge text="Reported answer" tone="warning" /> : null}
              </View>
              <Text style={styles.messageTime}>{formatDateTime(message.createdAt)}</Text>
              <Text selectable style={styles.messageText}>
                {message.content}
              </Text>
            </Card>
          );
        })}

        {data.omittedAfter ? <Text style={styles.omitted}>Later messages are not shown.</Text> : null}
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
        <Button
          title={reviewed ? 'Reopen report' : 'Mark reviewed'}
          variant="secondary"
          size="lg"
          loading={busy}
          onPress={() => void toggleReviewed()}
          full
          style={styles.reviewButton}
        />
      </Screen>
    </>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
    },
    loadingText: { ...type.bodySmall, color: colors.textMuted },
    errorTitle: { ...type.h3, color: colors.text, textAlign: 'center' },
    errorText: { ...type.bodySmall, color: colors.textMuted, textAlign: 'center' },
    reportCard: { marginBottom: spacing.lg },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    reason: { ...type.label, color: colors.warning, marginTop: spacing.md },
    comment: { ...type.bodySmall, color: colors.text, marginTop: spacing.xs, fontStyle: 'italic' },
    meta: { ...type.caption, color: colors.textMuted, marginTop: spacing.md },
    reference: { ...type.caption, color: colors.textMuted, marginTop: 2, opacity: 0.8 },
    sectionTitle: { ...type.h3, color: colors.text, marginBottom: spacing.xs },
    windowNote: { ...type.caption, color: colors.textMuted, marginBottom: spacing.md },
    omitted: { ...type.caption, color: colors.textMuted, fontStyle: 'italic', marginBottom: spacing.md },
    messageCard: { marginBottom: spacing.md },
    reportedCard: {
      marginBottom: spacing.md,
      borderColor: colors.warning,
      borderWidth: 2,
    },
    messageHeader: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    messageRole: { ...type.label, color: colors.text },
    messageTime: { ...type.caption, color: colors.textMuted, marginTop: 2 },
    messageText: { ...type.bodySmall, color: colors.textSecondary, marginTop: spacing.sm },
    actionError: { ...type.caption, color: colors.danger, marginTop: spacing.sm },
    reviewButton: { marginTop: spacing.md, marginBottom: spacing.xl },
  });
