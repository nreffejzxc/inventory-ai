import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { StatusBadge } from './Badge';
import Banner from './Banner';
import Button from './Button';
import Card from './Card';
import Chip from './Chip';
import { Icon } from './icons';
import type { IconName } from './icons';
import Input from './Input';
import KeyboardScrollView from './KeyboardScrollView';
import ListRow from './ListRow';
import ListScreen from './ListScreen';
import SearchField from './SearchField';
import Sheet from './Sheet';
import { ApiError } from '../lib/client';
import {
  completeOperation,
  endsOperation,
  getOrCreateOperationKey,
  PendingOperationsFullError,
} from '../lib/idempotency';
import { errorRequestId } from '../lib/errors';
import type { QueryParams } from '../lib/client';
import { useSession } from '../lib/auth';
import { alertError, confirm } from '../lib/confirm';
import type { PermissionSubject } from '../lib/permissions';
import type { ApiResponse, ReferencePayload } from '../lib/api';
import useDebounced from '../hooks/useDebounced';
import usePagedList from '../hooks/usePagedList';
import { spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

function fieldMap(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.fields)) {
    for (const f of err.fields) out[f.field] = f.message;
  }
  return out;
}

/** One optional extra writable column a reference group declares. */
export interface RefField {
  name: string;
  label: string;
  maxLength?: number;
  keyboardType?: TextInputProps['keyboardType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
}

/** The shared reference CRUD surface (categories, locations, suppliers). */
export interface RefManageApi {
  list: (token: string, params?: QueryParams) => Promise<ApiResponse>;
  create: (token: string, payload: ReferencePayload, idempotencyKey?: string) => Promise<ApiResponse>;
  update: (token: string, id: string, payload: ReferencePayload) => Promise<ApiResponse>;
  archive: (token: string, id: string) => Promise<ApiResponse>;
  restore: (token: string, id: string) => Promise<ApiResponse>;
}

export interface RefManageProps {
  api: RefManageApi;
  canManageFn: (u: PermissionSubject | null | undefined) => boolean;
  singular: string;
  label: string;
  placeholder?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  fields?: RefField[];
  icon?: IconName;
}

/**
 * Shared manage screen for business-scoped reference lists (Categories,
 * Locations, Suppliers): search, status filter, server-driven pagination, and —
 * for users with the manage permission — create/edit via a sheet plus archive/
 * restore. The backend stays the authority; this UI only gates what's shown.
 *
 * `fields` adds extra optional writable columns (e.g. supplier contactName/
 * phone/email) to the form and the list row. Default `[]` keeps
 * Categories/Locations behaviour byte-for-byte unchanged.
 *
 * `icon` is an optional semantic icon name used as the row's leading glyph.
 */
export default function RefManage({
  api,
  canManageFn,
  singular,
  label,
  placeholder,
  emptyTitle,
  emptyMessage,
  fields = [],
  icon,
}: RefManageProps) {
  const { user, token, signOut } = useSession();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const manage = canManageFn(user);

  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 300);
  const [statusFilter, setStatusFilter] = useState('ALL');

  const fetcher = useCallback(
    (page: number, limit: number) =>
      api.list(token as string, {
        page,
        limit,
        q: debouncedQ || undefined,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      }),
    [api, token, debouncedQ, statusFilter]
  );

  const list = usePagedList(fetcher, {
    params: { q: debouncedQ, status: statusFilter },
    onSessionError: signOut,
  });

  // Create / edit form state.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiResponse>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function openCreate(): void {
    setEditing(null);
    setName('');
    setDescription('');
    setExtras({});
    setFieldErrors({});
    setFormError(null);
    setFormRequestId(null);
    setFormOpen(true);
  }
  function openEdit(item: ApiResponse): void {
    setEditing(item);
    setName(item.name);
    setDescription(item.description ?? '');
    const next: Record<string, string> = {};
    for (const f of fields) next[f.name] = item[f.name] ?? '';
    setExtras(next);
    setFieldErrors({});
    setFormError(null);
    setFormRequestId(null);
    setFormOpen(true);
  }
  function closeForm(): void {
    if (!saving) setFormOpen(false);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setFormError(null);
    setFormRequestId(null);
    setFieldErrors({});
    const payload: ReferencePayload = {
      name: name.trim(),
      // An edit must be able to clear the description. The service treats '' as an
      // explicit clear on PATCH; create still omits a blank.
      description: description.trim() || (editing ? '' : undefined),
    };
    for (const f of fields) {
      const v = (extras[f.name] ?? '').trim();
      // create: skip blanks so nothing empty is stored; update: forward '' so
      // the server clears a previously-set value (its PATCH applies differing fields).
      if (editing) payload[f.name] = v;
      else if (v) payload[f.name] = v;
    }
    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = editing
        ? undefined
        : await getOrCreateOperationKey({
            kind: 'reference.create',
            ownerId: user?.id,
            target: singular.toLowerCase(),
            payload,
          });
      if (editing) await api.update(token as string, editing.id, payload);
      else await api.create(token as string, payload, idempotencyKey);
      if (idempotencyKey) await completeOperation('reference.create', idempotencyKey, user?.id);
      setFormOpen(false);
      list.reload();
    } catch (err) {
      if (err instanceof PendingOperationsFullError) {
        setFormError(err.message);
        setFormRequestId(null);
        return;
      }
      if (idempotencyKey && endsOperation(err)) {
        await completeOperation('reference.create', idempotencyKey, user?.id);
      }
      const fields = fieldMap(err);
      if (Object.keys(fields).length) setFieldErrors(fields);
      else {
        setFormError((err as { message?: string } | null)?.message || `Unable to save the ${singular.toLowerCase()}.`);
        setFormRequestId(errorRequestId(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(item: ApiResponse): Promise<void> {
    if (item.status === 'ARCHIVED') {
      try {
        await api.restore(token as string, item.id);
        list.reload();
      } catch (err) {
        await alertError('Could not restore', err);
      }
      return;
    }
    const ok = await confirm(
      `Archive ${singular.toLowerCase()}?`,
      `"${item.name}" will be hidden from new records but kept for history. You can restore it later.`,
      { confirmText: 'Archive', destructive: true }
    );
    if (!ok) return;
    try {
      await api.archive(token as string, item.id);
      list.reload();
    } catch (err) {
      await alertError('Could not archive', err);
    }
  }

  const header = (
    <View>
      <SearchField value={q} onChangeText={setQ} placeholder={placeholder} style={styles.search} />
      <View style={styles.filterRow}>
        <Chip label="All" selected={statusFilter === 'ALL'} onPress={() => setStatusFilter('ALL')} />
        <Chip label="Active" selected={statusFilter === 'ACTIVE'} onPress={() => setStatusFilter('ACTIVE')} />
        <Chip label="Archived" selected={statusFilter === 'ARCHIVED'} onPress={() => setStatusFilter('ARCHIVED')} />
      </View>
      {manage ? (
        <Button title={`New ${singular}`} icon="add" onPress={openCreate} full style={styles.newBtn} />
      ) : null}
    </View>
  );

  const renderItem = ({ item }: { item: ApiResponse }) => {
    const meta = fields
      .map((f) => item[f.name])
      .filter((v) => v != null && String(v).trim() !== '')
      .join(' · ');
    return (
      <Card>
        <ListRow
          leading={icon ? <Icon name={icon} color={colors.primary} size={22} /> : null}
          title={item.name}
          subtitle={item.description || undefined}
          right={<StatusBadge status={item.status} />}
          footer={meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}
        />
        {manage ? (
          <View style={styles.rowActions}>
            <Button title="Edit" variant="secondary" onPress={() => openEdit(item)} style={styles.smallBtn} />
            <Button
              title={item.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
              variant={item.status === 'ARCHIVED' ? 'secondary' : 'danger'}
              onPress={() => toggleArchive(item)}
              style={styles.smallBtn}
            />
          </View>
        ) : null}
      </Card>
    );
  };

  return (
    <View style={styles.flex}>
      <ListScreen
        items={list.items}
        keyExtractor={(item: ApiResponse) => item.id}
        renderItem={renderItem}
        header={header}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        errorTitle="Couldn't load items"
        refreshing={list.refreshing}
        onRefresh={list.refresh}
        onEndReached={list.loadMore}
        loadingMore={list.loadingMore}
        emptyTitle={emptyTitle}
        emptyMessage={debouncedQ ? `No ${label.toLowerCase()} match “${debouncedQ}”.` : emptyMessage}
        emptyAction={
          manage && !debouncedQ ? (
            <Button title={`Add your first ${singular.toLowerCase()}`} onPress={openCreate} />
          ) : null
        }
        footer={
          list.items.length >= 20 ? <Text style={styles.count}>{list.total} total</Text> : undefined
        }
      />

      {/* Create / edit */}
      <Sheet
        visible={formOpen}
        onClose={closeForm}
        title={editing ? `Edit ${singular.toLowerCase()}` : `New ${singular.toLowerCase()}`}
      >
        <KeyboardScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
          <Banner type="error" text={formError} requestId={formRequestId} />
          <Input
            name="name"
            label="Name"
            value={name}
            onChangeText={setName}
            error={fieldErrors.name}
            required
            autoCapitalize="words"
          />
          <Input
            name="description"
            label="Description (optional)"
            value={description}
            onChangeText={setDescription}
            multiline
            error={fieldErrors.description}
          />
          {fields.map((f) => (
            <Input
              key={f.name}
              name={f.name}
              label={f.label}
              value={extras[f.name] ?? ''}
              onChangeText={(v) => setExtras((prev) => ({ ...prev, [f.name]: v }))}
              error={fieldErrors[f.name]}
              maxLength={f.maxLength}
              keyboardType={f.keyboardType}
              autoCapitalize={f.autoCapitalize ?? 'none'}
            />
          ))}
          <Button title={editing ? 'Save changes' : `Create ${singular.toLowerCase()}`} onPress={save} loading={saving} full />
          <Button title="Cancel" variant="secondary" onPress={closeForm} style={styles.cancelBtn} full />
        </KeyboardScrollView>
      </Sheet>
    </View>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    search: { marginBottom: spacing.md },
    filterRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    newBtn: { marginBottom: spacing.md },
    rowMeta: { ...type.bodySmall, color: colors.textMuted },
    rowActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    smallBtn: { flex: 1 },
    count: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md },
    sheetScroll: { flexShrink: 1 },
    sheetBody: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
    cancelBtn: { marginTop: spacing.md },
  });
