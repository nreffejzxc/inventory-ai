import { useCallback, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { ListRenderItem } from 'react-native';

import Badge from '../../components/Badge';
import Button from '../../components/Button';
import { Icon } from '../../components/icons';
import ListRow from '../../components/ListRow';
import ListScreen from '../../components/ListScreen';
import SearchField from '../../components/SearchField';
import SelectField from '../../components/SelectField';
import { PressableCard } from '../../components/Card';
import { categoriesApi, productsApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { useSession } from '../../lib/auth';
import type { QueryParams } from '../../lib/client';
import { formatNumber } from '../../lib/format';
import { canManagePurchaseOrders } from '../../lib/permissions';
import { spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';
import useDebounced from '../../hooks/useDebounced';
import { referenceAvailability, useActiveRef } from '../../hooks/useReferences';
import usePagedList from '../../hooks/usePagedList';
import useRefetchOnFocus from '../../hooks/useRefetchOnFocus';

/** Route params are `string | string[]` (a key repeated in the link yields an array). */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * The restock list — every product at or below its minimum stock, worst first.
 *
 * WHY THIS SCREEN EXISTS (§27CQ → §27CR). The 50 000-product phone pass measured the
 * gap: the member's own catalogue had **1 492** products at or below minimum stock, the
 * dashboard previewed **five**, and its "View inventory" link opened `/inventory` with
 * no restock filter, so the list it promised did not exist anywhere in the app. Asked
 * for the same list, the assistant was cut off by the answer cap after eight rows. The
 * remaining 1 479 were unreachable from the screen that had just displayed them.
 *
 * The data was never the problem: `GET /api/products/reorder` has been paginated,
 * worst-first, total-bearing and `products.view`-scoped since Phase 11. This screen is
 * the client half that was missing — **no server change, no new permission**, and the
 * same endpoint the dashboard preview and the AI restock tool already use, so the three
 * surfaces cannot disagree about what "needs restocking" means.
 *
 * Two deliberate choices:
 *   - **worst first** is the endpoint's own order (availability ascending), so page 1 is
 *     the most urgent work and the order is not re-sorted here — a client sort would
 *     reorder only the rows it happens to hold.
 *   - **search is the endpoint's `q`**, not a filter over loaded rows, because at this
 *     scale the rows that matter are usually not on the pages already fetched.
 */
export default function RestockScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, user, signOut } = useSession();
  const canDraftPurchaseOrder = canManagePurchaseOrders(user);
  const params = useLocalSearchParams();
  const categories = useActiveRef(token, categoriesApi, { allPages: true });

  const [q, setQ] = useState(() => str(params.q));
  const [categoryId, setCategoryId] = useState(() => str(params.categoryId));
  const [categoryTouched, setCategoryTouched] = useState(false);
  const paramCategoryName = str(params.category);
  const debouncedQ = useDebounced(q, 300);

  // A named-category route parameter is resolved from the loaded reference list
  // without writing state in an effect. Once the member touches the picker, the
  // route parameter no longer overrides their choice — including "All categories".
  const resolvedParamCategoryId = useMemo(() => {
    if (!paramCategoryName) return '';
    return (
      categories.items.find(
        (category) => category.name.toLowerCase() === paramCategoryName.toLowerCase(),
      )?.id ?? ''
    );
  }, [categories.items, paramCategoryName]);
  const selectedCategoryId = categoryTouched
    ? categoryId
    : categoryId || resolvedParamCategoryId;
  const categoryAvailability = referenceAvailability(selectedCategoryId, categories);
  const categoryMissing = categoryAvailability === 'missing';
  const categoryNameUnresolved = Boolean(
    paramCategoryName && !categoryTouched && !categoryId && categories.complete && !resolvedParamCategoryId,
  );
  const activeCategoryId = categoryMissing ? '' : selectedCategoryId;

  const queryParams = useCallback(
    (): QueryParams => ({
      page: undefined,
      q: debouncedQ || undefined,
      categoryId: activeCategoryId || undefined,
    }),
    [debouncedQ, activeCategoryId],
  );

  const fetcher = useCallback(
    (page: number, limit: number) => productsApi.reorder(token as string, { ...queryParams(), page, limit }),
    [token, queryParams]
  );

  const list = usePagedList(fetcher, { params: queryParams(), onSessionError: signOut });
  // A product's minimum or stock can change on another screen; returning here should
  // re-read rather than show the rows from before the change.
  useRefetchOnFocus(list.reload);

  const header = (
    <View>
      {/* The total is the whole point: at 1 492 products the member needs to know the
          size of the job, and it is the one fact the five-row preview never showed. */}
      {list.total > 0 ? (
        <Text testID="restock-count" style={styles.count}>
          {formatNumber(list.total)} {list.total === 1 ? 'product' : 'products'} at or below minimum stock, most urgent first
        </Text>
      ) : null}
      {canDraftPurchaseOrder ? (
        <Button
          title="Create draft PO"
          icon="receipt"
          variant="secondary"
          full
          onPress={() => router.push('/purchase-orders/from-restock')}
          style={styles.draftButton}
        />
      ) : null}
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search restock by name, SKU or barcode…"
        style={styles.search}
      />
      <SelectField
        label="Category"
        placeholder="All categories"
        options={[
          { value: '', label: 'All categories' },
          ...categories.items.map((category) => ({ value: category.id, label: category.name })),
        ]}
        value={activeCategoryId}
        onChange={(value) => {
          setCategoryTouched(true);
          setCategoryId(value);
        }}
      />
      {categoryMissing || categoryNameUnresolved ? (
        <Text
          testID="restock-category-unavailable"
          style={[styles.notice, { color: colors.warning }]}
        >
          {categoryMissing
            ? 'That category is archived or unavailable. Showing every category.'
            : 'That category name is no longer active. Showing every category.'}
        </Text>
      ) : null}
    </View>
  );

  // The list scrolls more rows in silently, so the one thing a member cannot infer is
  // whether they have reached the end. The header states the size of the job; this states
  // how much of it is on screen, and it is only meaningful once the first page has landed.
  const footer =
    list.total > 0 ? (
      <Text testID="restock-footer" style={styles.footer}>
        {list.items.length >= list.total
          ? `All ${formatNumber(list.total)} ${list.total === 1 ? 'product' : 'products'} shown`
          : `Showing ${formatNumber(list.items.length)} of ${formatNumber(list.total)} — scroll for more`}
      </Text>
    ) : undefined;

  const renderItem: ListRenderItem<ApiResponse> = ({ item }) => {
    const isOut = item.stockStatus === 'OUT_OF_STOCK';
    const available = formatNumber(item.availableQuantity);
    const minimum = formatNumber(item.minimumStock);
    const belowMinimum =
      typeof item.unitsBelowMinimum === 'number' && item.unitsBelowMinimum > 0
        ? `${formatNumber(item.unitsBelowMinimum)} below minimum`
        : null;
    return (
      <PressableCard onPress={() => router.push(`/products/${item.id}`)} accessibilityRole="button">
        <ListRow
          leading={<Icon name={isOut ? 'alert' : 'warning'} color={isOut ? colors.danger : colors.warning} size={22} />}
          title={item.name}
          subtitle={[
            item.sku ? `SKU ${item.sku}` : null,
            `${available} available`,
            `minimum ${minimum}`,
            belowMinimum,
          ]
            .filter(Boolean)
            .join(' · ')}
          right={<Badge text={isOut ? 'Out' : 'Low'} tone={isOut ? 'danger' : 'low'} dot />}
        />
      </PressableCard>
    );
  };

  return (
    <ListScreen
      items={list.items}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      header={header}
      footer={footer}
      loading={list.loading}
      error={list.error}
      onRetry={list.reload}
      refreshing={list.refreshing}
      onRefresh={list.refresh}
      onEndReached={list.loadMore}
      loadingMore={list.loadingMore}
      loadingLabel="Loading restock list…"
      emptyTitle={q ? 'Nothing matches' : 'All stocked up'}
      emptyMessage={
        q ? `No product at or below minimum stock matches “${q}”.` : 'Nothing needs restocking right now.'
      }
    />
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    count: { ...type.caption, color: colors.textSecondary, marginBottom: spacing.md },
    search: { marginBottom: spacing.lg },
    footer: { ...type.caption, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.lg },
    draftButton: { marginBottom: spacing.lg },
    notice: { ...type.caption, fontWeight: '600', marginTop: spacing.sm },
  });
