import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import Badge, { PoStatusBadge, TypeBadge } from '../../components/Badge';
import AccessDenied from '../../components/AccessDenied';
import Button from '../../components/Button';
import type { ButtonVariant } from '../../components/Button';
import Card, { PressableCard } from '../../components/Card';
import IconButton from '../../components/IconButton';
import { Icon } from '../../components/icons';
import type { IconName } from '../../components/icons';
import { CenterLoader, EmptyState, ErrorState, errorText } from '../../components/ListState';
import ListRow from '../../components/ListRow';
import Screen from '../../components/Screen';
import SectionHeader from '../../components/SectionHeader';
import StatCard from '../../components/StatCard';
import type { StatTone } from '../../components/StatCard';
import WhatsNewCard from '../../components/WhatsNewCard';
import { activityRouteParams } from '../../lib/activity';
import { dashboardApi, productsApi, purchaseOrdersApi } from '../../lib/api';
import type { ApiResponse } from '../../lib/api';
import { isSessionError, useSession } from '../../lib/auth';
import { confirm } from '../../lib/confirm';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';
import {
  canAdjustStock,
  canManagePurchaseOrders,
  canManageUsers,
  canStockIn,
  canStockOut,
  canTransferStock,
  canUseAi,
  canViewAudit,
  canViewDashboard,
  canViewPurchaseOrders,
  roleLabel,
} from '../../lib/permissions';
import useRefetchOnFocus from '../../hooks/useRefetchOnFocus';
import { useReleaseNotes } from '../../hooks/useReleaseNotes';
import { radius, spacing, type } from '../../lib/theme';
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/** Time-aware greeting (A): morning / afternoon / evening by local hour. */
function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function deltaText(t: ApiResponse): string {
  if (t.type === 'STOCK_IN') return `+${t.quantity}`;
  if (t.type === 'STOCK_OUT') return `−${t.quantity}`;
  // A transfer is neither a gain nor a loss — the same quantity leaves one
  // location and arrives at another — so its quantity is shown unsigned, and
  // the Transfer badge names the movement (Phase 19).
  if (t.type === 'TRANSFER') return `${t.quantity}`;
  const d = t.newQuantity - t.previousQuantity;
  return d >= 0 ? `+${d}` : `−${Math.abs(d)}`;
}
function deltaTone(colors: Palette, t: ApiResponse): string {
  if (t.type === 'STOCK_IN') return colors.success;
  if (t.type === 'STOCK_OUT') return colors.danger;
  return colors.textSecondary;
}

/**
 * One transfer is ONE activity, so its row shows where the stock moved between
 * rather than the two ledger legs underneath (Phase 19). Every other movement
 * keeps its single location.
 */
function activitySubtitle(item: ApiResponse): string {
  const when = formatDateTime(item.createdAt);
  if (item.type === 'TRANSFER') {
    return `${item.from?.name ?? 'Unknown location'} → ${item.to?.name ?? 'Unknown location'} · ${when}`;
  }
  return `${item.location?.name ?? 'No location'} · ${when}`;
}

const ACTIVITY_ICONS: Record<string, IconName> = { STOCK_IN: 'stockIn', STOCK_OUT: 'stockOut', ADJUSTMENT: 'adjust', TRANSFER: 'transfer' };

/** Latest movement row — opens that movement's details (G). */
function ActivityRow({ item }: { item: ApiResponse }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <PressableCard onPress={() => router.push({ pathname: '/history/[id]', params: activityRouteParams(item) })} style={styles.rowCard}>
      <ListRow
        leading={<Icon name={ACTIVITY_ICONS[item.type] ?? 'time'} color={deltaTone(colors, item)} size={22} />}
        title={item.product?.name ?? 'Unknown product'}
        subtitle={activitySubtitle(item)}
        right={
          <View style={styles.activityRight}>
            <TypeBadge type={item.type} />
            <Text style={[styles.delta, { color: deltaTone(colors, item) }]}>{deltaText(item)}</Text>
          </View>
        }
      />
    </PressableCard>
  );
}

/** One "needs attention" row — taps into the product detail (C). */
function RestockRow({ item }: { item: ApiResponse }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isOut = item.stockStatus === 'OUT_OF_STOCK';
  return (
    <PressableCard onPress={() => router.push(`/products/${item.id}`)} style={styles.rowCard}>
      <ListRow
        leading={<Icon name={isOut ? 'alert' : 'warning'} color={isOut ? colors.danger : colors.warning} size={22} />}
        title={item.name}
        subtitle={`${formatNumber(item.availableQuantity)} available · minimum ${formatNumber(item.minimumStock)}`}
        right={<Badge text={isOut ? 'Out' : 'Low'} tone={isOut ? 'danger' : 'low'} dot />}
      />
    </PressableCard>
  );
}

/** Open purchase-order awareness row — taps into the PO detail (D). */
function OpenPoRow({ item }: { item: ApiResponse }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const meta = [item.supplier?.name, item.location?.name].filter(Boolean).join(' · ') || 'No supplier / location';
  return (
    <PressableCard onPress={() => router.push(`/purchase-orders/${item.id}`)} style={styles.rowCard}>
      <ListRow
        leading={<Icon name="receipt" color={colors.primary} size={22} />}
        title={item.number}
        subtitle={`${meta}${item.expectedAt ? ` · expected ${formatDate(item.expectedAt)}` : ''}`}
        right={<PoStatusBadge status={item.status} />}
      />
    </PressableCard>
  );
}

/** Destination row for the workspace navigation hierarchy (F/H). */
function NavRow({ icon, title, subtitle, route }: { icon: IconName; title: string; subtitle: string; route: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <PressableCard onPress={() => router.push(route)} style={styles.rowCard}>
      <ListRow
        leading={<Icon name={icon} color={colors.primary} size={22} />}
        title={title}
        subtitle={subtitle}
        right={<Icon name="chevronRight" color={colors.textMuted} size={18} />}
      />
    </PressableCard>
  );
}

/** Compact text link used as a SectionHeader action (keeps a 44px target). */
function HeaderLink({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} style={styles.headerLink}>
      <Text style={styles.headerLinkText}>{label}</Text>
    </Pressable>
  );
}

/** One "Overview" tile. */
interface HealthTile {
  key: string;
  label: string;
  value: string;
  tone: StatTone;
  route: string;
}

/** One role-gated quick action (E). */
interface QuickAction {
  key: string;
  title: string;
  icon: IconName;
  route: string;
  variant: ButtonVariant;
}

/** One workspace destination (F/H). */
interface NavEntry {
  key: string;
  icon: IconName;
  title: string;
  subtitle: string;
  route: string;
  show: boolean;
}

/**
 * Dashboard header (A): brand identity, role context, theme toggle, and the
 * same confirm-then-sign-out flow every screen uses. The sign-out is rendered
 * with the shared semantic signOut glyph via IconButton (44px); SignOutIcon
 * stays for native-stack headers (inventory) where it already lives.
 */
function TopBar({ name, role, onSignOut }: { name?: string | null; role?: string; onSignOut: () => void }) {
  const { colors, isDark, setScheme } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.topBar}>
      <View style={styles.brandBlock}>
        <Text style={styles.brand}>Inventory AI</Text>
        <View style={styles.roleRow}>
          <Text style={styles.userName} numberOfLines={1}>
            {name ?? 'there'}
          </Text>
          <Badge text={roleLabel(role)} tone="neutral" />
        </View>
      </View>
      <View style={styles.topBarActions}>
        <IconButton
          icon={isDark ? 'sunny' : 'moon'}
          variant="subtle"
          size={20}
          accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          onPress={() => setScheme(isDark ? 'light' : 'dark')}
        />
        <IconButton icon="signOut" variant="subtle" size={20} accessibilityLabel="Sign out" onPress={onSignOut} />
      </View>
    </View>
  );
}

/**
 * Role guard (MOD-07). The permission check lives here and nowhere else, so the
 * dashboard below mounts only for a role that may view it. Hoisting its hooks
 * above this return instead would run them on a denied render, and the load
 * effect below fetches the summary, the restock preview and open purchase
 * orders — queries a role without `dashboard.view` may not make.
 */
export default function DashboardScreen() {
  const { user } = useSession();

  if (!canViewDashboard(user)) {
    return <AccessDenied message="Only managers and above can view the dashboard." />;
  }

  return <DashboardView />;
}

function DashboardView() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, token, signOut } = useSession();
  // One card per published note, on the surface the person opens first (2026-10-25).
  const releaseNotes = useReleaseNotes();
  const [summary, setSummary] = useState<ApiResponse>(null);
  const [restock, setRestock] = useState<ApiResponse[] | null>(null);
  const [openPos, setOpenPos] = useState<ApiResponse[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const canSeePos = canViewPurchaseOrders(user);
  const firstName = user?.name?.split(' ')[0] ?? 'there';
  const greeting = `${greetingForHour(new Date().getHours())}, ${firstName}`;

  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    setError(null);
    setLoading(true);
    try {
      const data = await dashboardApi.summary(token);
      setSummary(data);
      // Restock preview is secondary and never blocks the summary — if it
      // fails, the Overview tiles still tell the story. Only fetched when the
      // summary itself reports something at or below minimum.
      if ((data.lowStockProducts ?? 0) + (data.outOfStockProducts ?? 0) > 0) {
        try {
          const list = await productsApi.reorder(token, { limit: 5 });
          setRestock(list.items ?? []);
        } catch {
          setRestock(null);
        }
      } else {
        setRestock([]);
      }
      // Open-PO awareness is fire-and-forget (D): it never blocks the summary,
      // and the section simply omits itself on failure or when unauthorized.
      if (canSeePos) {
        purchaseOrdersApi
          .list(token, { status: 'OPEN', limit: 3 })
          .then((res) => setOpenPos(res.items ?? []))
          .catch(() => setOpenPos(null));
      } else {
        setOpenPos(null);
      }
    } catch (err) {
      setError(err);
      setRestock(null);
      setOpenPos(null);
      if (isSessionError(err)) await signOut();
    } finally {
      setLoading(false);
    }
  }, [token, signOut, canSeePos]);

  // First load only. `load` sets `error`/`loading` synchronously before its first
  // await on purpose: loading must be true at request start, and it cannot be
  // derived from `summary` — a refresh deliberately keeps the previous summary
  // visible, so an empty summary is not a loading state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Refetch whenever the screen regains focus, so stock actions taken on other
  // screens are reflected here. The hook skips the mount focus, so the initial
  // load above is not duplicated.
  useRefetchOnFocus(load);

  async function onSignOut(): Promise<void> {
    const ok = await confirm('Sign out', 'You will need to sign in again to manage inventory.', {
      confirmText: 'Sign Out',
      destructive: true,
    });
    if (ok) await signOut();
  }

  // Health tiles reuse the existing dashboardApi.summary (B) — only real fields,
  // and the same deep links the previous dashboard offered.
  const healthTiles: HealthTile[] = [
    { key: 'in', label: 'In stock', value: formatNumber(summary?.inStockProducts), tone: 'success', route: '/products' },
    { key: 'low', label: 'Low stock', value: formatNumber(summary?.lowStockProducts), tone: 'warning', route: '/inventory?status=low' },
    { key: 'out', label: 'Out of stock', value: formatNumber(summary?.outOfStockProducts), tone: 'danger', route: '/inventory?status=out' },
    { key: 'active', label: 'Active products', value: formatNumber(summary?.totalProducts), tone: 'primary', route: '/products' },
    { key: 'onhand', label: 'Total on-hand qty', value: formatNumber(summary?.totalInventoryQuantity), tone: 'default', route: '/inventory' },
  ];

  // Role-gated quick actions (E): Stock In, Stock Out, Scan, New PO.
  // `satisfies` on each gated literal: the array annotation above cannot reach
  // through the spread-of-a-ternary, so the icon/variant literals would
  // otherwise widen to `string` and lose their checked contract.
  const quickActions: QuickAction[] = [
    ...(canStockIn(user) ? [{ key: 'stock-in', title: 'Stock In', icon: 'stockIn', route: '/stock-in', variant: 'primary' } satisfies QuickAction] : []),
    ...(canStockOut(user) ? [{ key: 'stock-out', title: 'Stock Out', icon: 'stockOut', route: '/stock-out', variant: 'secondary' } satisfies QuickAction] : []),
    ...(canStockIn(user) || canStockOut(user) ? [{ key: 'scan', title: 'Scan', icon: 'scan', route: '/scan', variant: 'secondary' } satisfies QuickAction] : []),
    ...(canManagePurchaseOrders(user) ? [{ key: 'new-po', title: 'New PO', icon: 'receipt', route: '/purchase-orders/new', variant: 'secondary' } satisfies QuickAction] : []),
  ];

  // Remaining destinations, grouped as the navigation hierarchy (F/H). Every
  // route already exists in the native stack — nothing renamed, nothing added.
  const workspace = (
    [
      { key: 'inventory', icon: 'cube', title: 'Inventory', subtitle: 'Rows & stock status', route: '/inventory', show: true },
      { key: 'products', icon: 'pricetags', title: 'Products', subtitle: 'Product catalog', route: '/products', show: true },
      { key: 'categories', icon: 'layers', title: 'Categories', subtitle: 'Group products', route: '/categories', show: true },
      { key: 'locations', icon: 'location', title: 'Locations', subtitle: 'Where stock lives', route: '/locations', show: true },
      { key: 'adjust', icon: 'adjust', title: 'Adjust stock', subtitle: 'Set an exact quantity', route: '/adjust', show: canAdjustStock(user) },
      { key: 'transfer', icon: 'transfer', title: 'Transfer stock', subtitle: 'Move stock between locations', route: '/transfer', show: canTransferStock(user) },
      { key: 'ai', icon: 'sparkles', title: 'AI Assistant', subtitle: 'Ask about inventory', route: '/ai', show: canUseAi(user) },
      { key: 'users', icon: 'people', title: 'Users', subtitle: 'Manage accounts', route: '/users', show: canManageUsers(user) },
      { key: 'audit', icon: 'document', title: 'Audit log', subtitle: 'Who did what', route: '/audit', show: canViewAudit(user) },
      { key: 'profile', icon: 'person', title: 'Profile', subtitle: 'Account & password', route: '/profile', show: true },
    ] satisfies NavEntry[]
  ).filter((item) => item.show);

  return (
    <Screen scroll refreshing={loading} onRefresh={load}>
      <TopBar name={user?.name} role={user?.role} onSignOut={onSignOut} />

      {!summary && loading ? (
        <CenterLoader label="Loading dashboard…" />
      ) : !summary && error ? (
        <ErrorState title="Couldn't load the dashboard" message={errorText(error)} onRetry={load} />
      ) : summary ? (
        <>
          <Text style={styles.greeting}>{greeting}</Text>
          {error ? (
            <Pressable style={styles.stale} onPress={load} accessibilityRole="button" accessibilityLabel="Retry loading">
              <Text style={styles.staleText}>Showing earlier data — pull to retry.</Text>
            </Pressable>
          ) : null}

          {/**
           * Release notes sit below the stale-data warning, not above it: if the figures on this
           * screen are out of date, that outranks product news. The card acknowledges on either
           * action — dismissing it and opening the list are both "I have seen this" — so it can
           * never come back for the same note.
           */}
          {releaseNotes.latest && releaseNotes.unseen ? (
            <WhatsNewCard
              note={releaseNotes.latest}
              onOpen={() => {
                releaseNotes.acknowledge();
                router.push('/whats-new');
              }}
              onDismiss={releaseNotes.acknowledge}
            />
          ) : null}

          <SectionHeader
            title="Overview"
            subtitle="Here's how your stock is doing across all locations"
            style={styles.section}
          />
          <View style={styles.healthGrid}>
            {healthTiles.map((tile) => (
              <Pressable
                key={tile.key}
                onPress={() => router.push(tile.route)}
                accessibilityRole="button"
                accessibilityLabel={`${tile.label}: ${tile.value}`}
                style={styles.healthCell}
              >
                <StatCard label={tile.label} value={tile.value} tone={tile.tone} />
              </Pressable>
            ))}
          </View>

          {restock !== null ? (
            <>
              <SectionHeader
                title="Needs attention"
                subtitle={restock.length ? 'At or below minimum stock' : 'Nothing below minimum stock right now'}
                style={styles.section}
                /* §27CR — this used to read "View inventory" and open `/inventory`
                   unfiltered, so the five rows above were the whole list anyone could
                   reach. The products themselves have their own screen now. */
                action={<HeaderLink label="View all" onPress={() => router.push('/restock')} />}
              />
              {restock.length ? (
                <View style={styles.rowList}>
                  {restock.map((item) => (
                    <RestockRow key={item.id} item={item} />
                  ))}
                </View>
              ) : (
                <Card>
                  <EmptyState
                    icon="checkCircle"
                    title="All caught up"
                    message="No products need restocking right now."
                  />
                </Card>
              )}
            </>
          ) : null}

          {quickActions.length ? (
            <>
              <SectionHeader title="Quick actions" subtitle="Common stock and order tasks" style={styles.section} />
              <View style={styles.quickGrid}>
                {quickActions.map((action) => (
                  <Button
                    key={action.key}
                    title={action.title}
                    icon={action.icon}
                    variant={action.variant}
                    size="lg"
                    style={styles.quickButton}
                    onPress={() => router.push(action.route)}
                  />
                ))}
              </View>
            </>
          ) : null}

          {canSeePos ? (
            <>
              <SectionHeader title="Procurement" subtitle="Open orders & suppliers" style={styles.section} />
              {openPos === null ? null : openPos.length ? (
                <View style={styles.rowList}>
                  {openPos.map((item) => (
                    <OpenPoRow key={item.id} item={item} />
                  ))}
                </View>
              ) : (
                <View style={styles.emptyInline}>
                  <Text style={styles.emptyInlineText}>No open purchase orders — nothing is awaiting receipt.</Text>
                </View>
              )}
              <View style={styles.rowList}>
                <NavRow icon="receipt" title="Purchase orders" subtitle="Browse, receive, and manage orders" route="/purchase-orders" />
                <NavRow icon="storefront" title="Suppliers" subtitle="Vendor directory" route="/suppliers" />
              </View>
            </>
          ) : null}

          <SectionHeader
            title="Recent activity"
            subtitle="Latest stock movements"
            style={styles.section}
            action={<HeaderLink label="History" onPress={() => router.push('/history')} />}
          />
          {summary.recentActivity?.length ? (
            <View style={styles.rowList}>
              {summary.recentActivity.map((item: ApiResponse) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <Card>
              <EmptyState icon="time" title="No activity yet" message="Stock in, stock out, transfers, and adjustments will appear here." />
            </Card>
          )}

          <SectionHeader title="Workspace" subtitle="Everything else" style={styles.section} />
          <View style={styles.rowList}>
            {workspace.map((item) => (
              <NavRow key={item.key} icon={item.icon} title={item.title} subtitle={item.subtitle} route={item.route} />
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    topBar: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: spacing.xl },
    brandBlock: { flex: 1, marginRight: spacing.md },
    brand: { ...type.caption, color: colors.primary, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
    roleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
    userName: { ...type.h3, color: colors.text, flexShrink: 1 },
    topBarActions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    greeting: { ...type.h1, color: colors.text },
    stale: {
      marginTop: spacing.md,
      backgroundColor: colors.warningSoft,
      borderRadius: radius.md,
      padding: spacing.sm + 2,
      paddingHorizontal: spacing.md,
    },
    staleText: { ...type.caption, color: colors.warning, fontWeight: '600' },
    section: { marginTop: spacing.xxl },
    healthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    healthCell: { flexGrow: 1, flexBasis: '46%', minWidth: '46%' },
    quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    quickButton: { flexGrow: 1, flexBasis: '46%' },
    rowList: { gap: spacing.sm },
    rowCard: { paddingVertical: spacing.md },
    activityRight: { alignItems: 'flex-end', gap: spacing.xs },
    delta: { ...type.button, fontSize: 16 },
    headerLink: { minHeight: 44, justifyContent: 'center' },
    headerLinkText: { ...type.label, color: colors.primary, fontWeight: '600' },
    emptyInline: { paddingVertical: spacing.sm },
    emptyInlineText: { ...type.body, color: colors.textMuted },
  });
