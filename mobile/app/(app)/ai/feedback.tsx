import { useCallback, useMemo, useState } from 'react';
import { router, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Badge from '../../../components/Badge';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import Chip from '../../../components/Chip';
import { Icon } from '../../../components/icons';
import ListScreen from '../../../components/ListScreen';
import { aiApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import { feedbackReasonLabel } from '../../../lib/aiFeedback';
import { formatDateTime } from '../../../lib/format';
import { canViewAiMetrics, roleLabel } from '../../../lib/permissions';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';
import usePagedList from '../../../hooks/usePagedList';
import useRefetchOnFocus from '../../../hooks/useRefetchOnFocus';

const STATUS_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Open', value: 'OPEN' },
  { label: 'Reviewed', value: 'REVIEWED' },
];

const RATING_FILTERS = [
  { label: 'All ratings', value: '' },
  { label: 'Needs attention', value: 'DOWN' },
  { label: 'Good', value: 'UP' },
];

function SummaryCell({ label, value, tone }: { label: string; value: number | undefined; tone: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.summaryCell}>
      <Text style={[styles.summaryValue, { color: tone }]}>{value ?? 0}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function FeedbackRow({
  item,
  busy,
  onToggle,
  onOpen,
}: {
  item: ApiResponse;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const down = item.rating === 'DOWN';
  const reason = feedbackReasonLabel(item.reason);
  const tools = Array.isArray(item.answer?.toolsUsed) ? item.answer.toolsUsed.join(' · ') : null;

  return (
    <Card>
      <View style={styles.reviewHeader}>
        <View style={[styles.reviewIcon, down && styles.reviewIconDown]}>
          <Icon
            name={down ? 'thumbDown' : 'thumbUp'}
            size={18}
            color={down ? colors.warning : colors.success}
          />
        </View>
        <View style={styles.reviewHeading}>
          <Text style={styles.reviewTitle}>{down ? 'Bad response' : 'Good response'}</Text>
          <Text style={styles.reviewMeta}>
            {item.reportedBy?.name || 'Former member'} · {roleLabel(item.reportedBy?.role)} ·{' '}
            {formatDateTime(item.createdAt)}
          </Text>
        </View>
        <Badge
          text={item.status === 'REVIEWED' ? 'Reviewed' : 'Open'}
          tone={item.status === 'REVIEWED' ? 'success' : 'warning'}
          dot
        />
      </View>

      {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      {item.comment ? (
        <Text style={styles.comment} numberOfLines={4}>
          “{item.comment}”
        </Text>
      ) : null}

      {item.question?.content ? (
        <View style={styles.excerpt}>
          <Text style={styles.excerptLabel}>Question</Text>
          <Text style={styles.excerptText} numberOfLines={3}>
            {item.question.content}
          </Text>
        </View>
      ) : null}
      {item.answer?.content ? (
        <View style={styles.excerpt}>
          <Text style={styles.excerptLabel}>Answer</Text>
          <Text style={styles.excerptText} numberOfLines={6}>
            {item.answer.content}
          </Text>
        </View>
      ) : (
        <Text style={styles.missingAnswer}>The answer is no longer available.</Text>
      )}

      {tools ? <Text style={styles.provenance}>Read: {tools}</Text> : null}
      {item.turnId ? (
        <Text selectable style={styles.reference}>
          Ref: {item.turnId}
        </Text>
      ) : null}

      {/* AI-117 — the queue stays excerpt-only. This opens the explicit
          OWNER/ADMIN preview with the complete reported answer before review. */}
      <View style={styles.reviewActions}>
        <Button
          title="View conversation"
          variant="secondary"
          size="md"
          onPress={onOpen}
          style={styles.reviewButton}
        />
        <Button
          title={item.status === 'REVIEWED' ? 'Reopen report' : 'Mark reviewed'}
          variant="secondary"
          size="md"
          loading={busy}
          onPress={onToggle}
          style={styles.reviewButton}
        />
      </View>
    </Card>
  );
}

export default function AiFeedbackScreen() {
  const { user } = useSession();

  if (!canViewAiMetrics(user)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Response Feedback' }} />
        <AccessDenied message="Only the business owner and admins can review assistant feedback." />
      </>
    );
  }

  return <FeedbackList />;
}

function FeedbackList() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut } = useSession();
  const [status, setStatus] = useState('');
  const [rating, setRating] = useState('');
  const [summary, setSummary] = useState<{ total?: number; open?: number; up?: number; down?: number }>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filters = useCallback(
    () => ({ status: status || undefined, rating: rating || undefined }),
    [status, rating],
  );

  const fetcher = useCallback(
    async (page: number, limit: number) => {
      const res = await aiApi.feedbackList(token as string, { ...filters(), page, limit });
      if (res?.summary) setSummary(res.summary);
      return res;
    },
    [token, filters],
  );

  const list = usePagedList(fetcher, { params: filters(), onSessionError: signOut });
  useRefetchOnFocus(list.reload);

  async function toggleReviewed(item: ApiResponse): Promise<void> {
    setBusyId(item.id);
    setActionError(null);
    try {
      await aiApi.reviewFeedback(token as string, item.id, item.status !== 'REVIEWED');
      list.reload();
    } catch {
      setActionError('That report could not be updated. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  const header = (
    <View>
      <View style={styles.summaryRow}>
        <SummaryCell label="Total" value={summary.total} tone={colors.text} />
        <SummaryCell label="Open" value={summary.open} tone={colors.warning} />
        <SummaryCell label="Good" value={summary.up} tone={colors.success} />
        <SummaryCell label="Bad" value={summary.down} tone={colors.danger} />
      </View>
      <Text style={styles.filterLabel}>Review status</Text>
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((filter) => (
          <Chip
            key={filter.value || 'all-status'}
            label={filter.label}
            selected={status === filter.value}
            onPress={() => setStatus(filter.value)}
          />
        ))}
      </View>
      <Text style={styles.filterLabel}>Rating</Text>
      <View style={styles.filterRow}>
        {RATING_FILTERS.map((filter) => (
          <Chip
            key={filter.value || 'all-rating'}
            label={filter.label}
            selected={rating === filter.value}
            onPress={() => setRating(filter.value)}
          />
        ))}
      </View>
      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
      {list.total > 0 ? (
        <Text style={styles.count}>
          {list.total} report{list.total === 1 ? '' : 's'} · newest first
        </Text>
      ) : null}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Response Feedback' }} />
      <ListScreen
        items={list.items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <FeedbackRow
            item={item}
            busy={busyId === item.id}
            onToggle={() => void toggleReviewed(item)}
            onOpen={() => router.push({ pathname: '/ai/feedback-preview', params: { id: item.id } })}
          />
        )}
        header={header}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        errorTitle="Couldn't load assistant feedback"
        refreshing={list.refreshing}
        onRefresh={list.refresh}
        onEndReached={list.loadMore}
        loadingMore={list.loadingMore}
        loadingLabel="Loading feedback…"
        emptyTitle="No feedback yet"
        emptyMessage="When a member rates an answer, it will appear here for review."
      />
    </>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    summaryRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    summaryCell: {
      flexGrow: 1,
      flexBasis: '22%',
      minWidth: 70,
      padding: spacing.md,
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    summaryValue: { ...type.stat, fontSize: 22, lineHeight: 26 },
    summaryLabel: { ...type.caption, color: colors.textMuted, marginTop: 2 },
    filterLabel: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
    count: { ...type.caption, color: colors.textMuted, marginBottom: spacing.md },
    actionError: { ...type.caption, color: colors.danger, marginBottom: spacing.md },
    reviewHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    reviewIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.successSoft,
    },
    reviewIconDown: { backgroundColor: colors.warningSoft },
    reviewHeading: { flex: 1, gap: 2 },
    reviewTitle: { ...type.h3, color: colors.text },
    reviewMeta: { ...type.caption, color: colors.textMuted },
    reason: { ...type.label, color: colors.warning, marginTop: spacing.md },
    comment: { ...type.bodySmall, color: colors.text, marginTop: spacing.xs, fontStyle: 'italic' },
    excerpt: {
      marginTop: spacing.md,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    excerptLabel: { ...type.caption, color: colors.textMuted, fontWeight: '700', marginBottom: 2 },
    excerptText: { ...type.bodySmall, color: colors.textSecondary },
    missingAnswer: { ...type.caption, color: colors.warning, marginTop: spacing.md },
    provenance: { ...type.caption, color: colors.textMuted, marginTop: spacing.md },
    reference: { ...type.caption, color: colors.textMuted, marginTop: 2, opacity: 0.8 },
    reviewActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    reviewButton: { flexGrow: 1, flexBasis: 140 },
  });
