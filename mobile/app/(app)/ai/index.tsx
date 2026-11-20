import { useCallback, useMemo } from 'react';
import { router } from 'expo-router';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Button from '../../../components/Button';
import { PressableCard } from '../../../components/Card';
import { Icon } from '../../../components/icons';
import ListRow from '../../../components/ListRow';
import { EmptyState, ErrorState, LoadingBlock, errorRequestId, errorText } from '../../../components/ListState';
import Screen from '../../../components/Screen';
import { aiApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { canUseAi, canViewAiMetrics } from '../../../lib/permissions';
import usePagedList from '../../../hooks/usePagedList';
import useRefetchOnFocus from '../../../hooks/useRefetchOnFocus';
import { radius, spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

function ConversationRow({ item }: { item: ApiResponse }) {
  const { colors } = useTheme();
  return (
    <PressableCard accessibilityRole="button" onPress={() => router.push(`/ai/${item.id}`)}>
      <ListRow
        leading={<Icon name="sparkles" color={colors.primary} size={22} />}
        title={item.title || 'New chat'}
        subtitle={formatDateTime(item.updatedAt)}
        right={<Icon name="chevronRight" color={colors.textMuted} size={20} />}
      />
    </PressableCard>
  );
}

/**
 * Role guard (MOD-07). The permission check lives here and nowhere else, so the
 * screen below mounts only for a role that may use the assistant. Hoisting its
 * hooks above this return instead would run them on a denied render, and both
 * `usePagedList` (first-load effect) and `useRefetchOnFocus` (focus effect)
 * fetch — which would query conversations for a role that may not read them.
 */
export default function AiHubScreen() {
  const { user } = useSession();

  if (!canUseAi(user)) {
    return <AccessDenied message="Your role does not include access to the AI assistant." />;
  }

  return <AiConversations />;
}

function AiConversations() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut, user } = useSession();

  const fetcher = useCallback(
    (page: number, limit: number) => aiApi.conversations(token as string, { page, limit }),
    [token]
  );
  const list = usePagedList(fetcher, { onSessionError: signOut });
  // Refresh ordering/timestamps after a chat screen pushes and pops.
  useRefetchOnFocus(list.reload);

  const header = (
    <View>
      <Button title="New chat" icon="add" onPress={() => router.push('/ai/new')} full style={styles.newBtn} />
      {canViewAiMetrics(user) ? (
        <Button
          title="Response feedback"
          icon="feedback"
          variant="secondary"
          onPress={() => router.push('/ai/feedback')}
          full
          style={styles.feedbackBtn}
        />
      ) : null}
      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          The assistant reads your catalog and stock to answer questions. It is read-only and never changes data.
        </Text>
      </View>
      {list.total > 0 ? (
        <Text style={styles.count}>
          {list.total} conversation{list.total === 1 ? '' : 's'} · newest first
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      {list.loading && list.items.length === 0 ? (
        <FlatList data={[]} renderItem={() => null} ListHeaderComponent={header} ListEmptyComponent={<LoadingBlock label="Loading chats…" />} contentContainerStyle={styles.content} />
      ) : list.error && list.items.length === 0 ? (
        <FlatList
          data={[]}
          renderItem={() => null}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <ErrorState
              title="Couldn't load your chats"
              message={errorText(list.error)}
              requestId={errorRequestId(list.error)}
              onRetry={list.reload}
            />
          }
          contentContainerStyle={styles.content}
        />
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ConversationRow item={item} />}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <EmptyState
              title="No conversations yet"
              message="Start a chat and ask your assistant anything about your stock."
              action={<Button title="Start a chat" onPress={() => router.push('/ai/new')} />}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={colors.primary} colors={[colors.primary]} />}
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={list.loadingMore ? <LoadingBlock label="Loading more…" /> : undefined}
          showsVerticalScrollIndicator={false}
        />
      )}
    </Screen>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.huge, flexGrow: 1 },
  newBtn: { marginBottom: spacing.md },
  feedbackBtn: { marginBottom: spacing.md },
  noteCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  noteText: { ...type.caption, color: colors.primaryDark },
  count: { ...type.caption, color: colors.textMuted, marginBottom: spacing.md },
  separator: { height: spacing.md },
});
