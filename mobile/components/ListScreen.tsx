import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import type { FlatListProps, ListRenderItem, StyleProp, ViewStyle } from 'react-native';
import { spacing } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { EmptyState, ErrorState, LoadingBlock, errorRequestId, errorText } from './ListState';
import Screen from './Screen';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { padding: spacing.lg, paddingBottom: spacing.huge, flexGrow: 1 },
    separator: { height: spacing.md },
  });

export interface ListScreenProps<T> {
  items: T[];
  renderItem: ListRenderItem<T>;
  keyExtractor?: (item: T, index: number) => string;
  header?: FlatListProps<T>['ListHeaderComponent'];
  refreshing?: boolean;
  onRefresh?: () => void;
  onEndReached?: () => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  errorTitle?: ReactNode;
  emptyTitle?: ReactNode;
  emptyMessage?: ReactNode;
  emptyAction?: ReactNode;
  loadingLabel?: ReactNode;
  loadingMore?: boolean;
  footer?: FlatListProps<T>['ListFooterComponent'];
  separator?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Standard paged-list screen shell: safe-area background, pull-to-refresh,
 * loading / error / empty states, and infinite scroll. Encapsulates the list
 * plumbing every list screen repeats so a screen only supplies data + rows.
 *
 * Adopted by the core list screens (Phase 18C: products, inventory,
 * purchase orders).
 *
 * The inner `FlatList` supplies its own content padding, so the `Screen` shell
 * is rendered with `padded={false}` — otherwise the two paddings stack.
 */
function ListScreen<T>({
  items,
  renderItem,
  keyExtractor,
  header,
  refreshing,
  onRefresh,
  onEndReached,
  loading,
  error,
  onRetry,
  errorTitle,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  emptyAction,
  loadingLabel = 'Loading…',
  loadingMore,
  footer,
  separator = true,
  contentStyle,
}: ListScreenProps<T>) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const listProps = {
    data: items,
    renderItem,
    keyExtractor,
    ListHeaderComponent: header,
    ItemSeparatorComponent: separator ? () => <View style={styles.separator} /> : undefined,
    contentContainerStyle: [styles.content, contentStyle],
    refreshControl: onRefresh ? (
      <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
    ) : undefined,
    onEndReached,
    onEndReachedThreshold: 0.4,
    ListFooterComponent: loadingMore ? <LoadingBlock label="Loading more…" /> : footer ?? undefined,
    keyboardShouldPersistTaps: 'handled',
    showsVerticalScrollIndicator: false,
  } satisfies FlatListProps<T>;

  if (loading && items.length === 0) {
    return (
      <Screen padded={false}>
        <FlatList {...listProps} ListEmptyComponent={<LoadingBlock label={loadingLabel} />} />
      </Screen>
    );
  }

  if (error && items.length === 0) {
    return (
      <Screen padded={false}>
        <FlatList
          {...listProps}
          ListEmptyComponent={
            <ErrorState
              title={errorTitle}
              message={errorText(error)}
              requestId={errorRequestId(error)}
              onRetry={onRetry}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <FlatList
        {...listProps}
        ListEmptyComponent={<EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />}
      />
    </Screen>
  );
}

export default ListScreen;
