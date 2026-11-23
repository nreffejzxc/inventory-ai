import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { StyleSheet, Text, View } from 'react-native';

import AccessDenied from '../../../components/AccessDenied';
import Banner from '../../../components/Banner';
import Button from '../../../components/Button';
import Card from '../../../components/Card';
import Screen from '../../../components/Screen';
import { productsApi } from '../../../lib/api';
import type { ProductImportStatus } from '../../../lib/api';
import { useSession } from '../../../lib/auth';
import { ApiError } from '../../../lib/client';
import { alert, confirm } from '../../../lib/confirm';
import { errorRequestId } from '../../../lib/errors';
import { endsOperation, newIdempotencyKey } from '../../../lib/idempotency';
import { canImportProducts } from '../../../lib/permissions';
import {
  cleanupProductImportDrafts,
  clearProductImportDraft,
  MAX_IMPORT_CSV_BYTES,
  readProductImportDraft,
  saveProductImportDraft,
  utf8ByteLength,
} from '../../../lib/productImportDraft';
import { spacing, type } from '../../../lib/theme';
import type { Palette } from '../../../lib/theme';
import { useTheme } from '../../../lib/theme-context';

const STATUS_POLL_MS = 3_000;
const STATUS_POLL_MAX_MS = 10 * 60_000;

interface PreviewSummary {
  totalRows: number;
  validRows: number;
  productCount: number;
  openingStockRows: number;
  openingStockUnits: number;
}

interface Preview {
  valid: boolean;
  fileName: string;
  summary: PreviewSummary;
  errors: { line: number; field?: string | null; message: string }[];
}

async function clearSavedImport(
  ownerId: string | null | undefined,
  key: string,
): Promise<boolean> {
  if (await clearProductImportDraft(ownerId, key).catch(() => false)) return true;
  return clearProductImportDraft(ownerId, key).catch(() => false);
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'IMPORT_PARTIAL') {
      return 'Part of this file was applied. Press Resume import to finish the same file; the operation key prevents a second catalogue.';
    }
    if (err.code === 'IMPORT_VALIDATION_FAILED') {
      return 'The file has errors. Nothing was written — fix the listed rows and choose the file again.';
    }
    if (err.code === 'NETWORK_TIMEOUT') {
      return 'The request timed out before the server answered. The import may still be running; progress will appear below, or press Resume import to finish the same file.';
    }
    if (err.code === 'NETWORK_ERROR') {
      return 'The connection was lost before the server answered. The import may still be running; progress will appear below, or press Resume import to finish the same file.';
    }
    if (err.code === 'IDEMPOTENT_REQUEST_IN_PROGRESS') {
      return 'The server is still importing this file. Progress will update below; wait before pressing Resume import again.';
    }
    return err.message;
  }
  return 'The file could not be read.';
}

/**
 * FW-01 mobile entry point. The server is the validator: this screen reads a
 * bounded CSV, asks for a dry run, then shows the summary/row errors before an
 * OWNER or ADMIN can apply it. The same Idempotency-Key is reused for a retry
 * of the same selected file, so a timeout cannot create a second catalogue.
 */
export default function ProductImportScreen() {
  const { user } = useSession();
  if (!canImportProducts(user)) {
    return <AccessDenied message="Only owners and admins can import products." />;
  }
  // A different signed-in account gets a fresh screen, not the previous
  // account's file, key, progress or in-flight status poll.
  return <ProductImportWorkbench key={user?.id ?? 'anonymous'} />;
}

function ProductImportWorkbench() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, user } = useSession();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProductImportStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [resumeReady, setResumeReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [restoreBlocked, setRestoreBlocked] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const pollStartedAt = useRef<number | null>(null);
  const restoredFor = useRef<string | null>(null);

  const reset = () => {
    setPreview(null);
    setErrors([]);
    setMessage(null);
    setRequestId(null);
    setKey(null);
    setProgress(null);
    setPolling(false);
    setResumeReady(false);
    pollStartedAt.current = null;
  };

  const finish = useCallback(
    async (createdCount: number, openingStockCount: number, completedKey: string | null) => {
      setPolling(false);
      // Completed work is not resumable. The expected key prevents a late
      // completion from deleting a newer draft saved afterwards. Retry once;
      // a confirmed completion must not leave a local attempt that reopens as
      // unfinished, and a clear failure must be visible rather than hidden.
      const cleared = completedKey ? await clearSavedImport(user?.id, completedKey) : true;
      if (!cleared) {
        setResumeReady(true);
        setMessage(
          'The import completed, but this device could not clear the saved import. Press Resume import to retry; the same key cannot create a second catalogue.'
        );
        return;
      }
      setKey(null);
      setResumeReady(false);
      setProgress(null);
      pollStartedAt.current = null;
      await alert(
        'Import complete',
        `${createdCount} product(s) created; ${openingStockCount} opening-stock movement(s) recorded.`,
      );
      router.replace('/products');
    },
    [user?.id]
  );

  /**
   * A timed-out apply is not a failure: the server may still be importing. The
   * receipt key is kept and polled until it reaches a terminal state, so the
   * member sees real progress instead of a blind retry. A 404 means the request
   * never reached the receipt (for example during a cold start); the same-key
   * resume then starts it without risking a second catalogue.
   */
  useEffect(() => {
    if (!polling || !key || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = pollStartedAt.current ?? Date.now();
    pollStartedAt.current = startedAt;

    const check = async () => {
      if (cancelled) return;
      try {
        const next = await productsApi.importStatus(token as string, key);
        if (cancelled) return;
        setProgress(next);
        if (next.status === 'COMPLETED') {
          await finish(
            Number(next.result?.createdCount ?? next.createdCount),
            Number(next.result?.openingStockCount ?? next.openingStockCount),
            key,
          );
          return;
        }
        if (next.status === 'PARTIAL' || next.status === 'FAILED') {
          setPolling(false);
          setResumeReady(next.status === 'PARTIAL');
          setMessage(
            next.status === 'PARTIAL'
              ? 'Part of this file was applied. Press Resume import to finish it.'
              : 'The import could not be completed. Discard this saved import before choosing a corrected file.',
          );
          setErrors(
            next.failures.map((failure) => ({
              field: `Line ${failure.line}${failure.field ? ` · ${failure.field}` : ''}`,
              message: failure.message,
            })),
          );
          return;
        }
        if (Date.now() - startedAt > STATUS_POLL_MAX_MS) {
          setPolling(false);
          setResumeReady(true);
          setMessage('The import is still running on the server. Press Resume import again shortly.');
          return;
        }
        timer = setTimeout(() => void check(), STATUS_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setPolling(false);
          setProgress(null);
          setResumeReady(true);
          setMessage('The server has not recorded this import yet. Press Resume import to send the same operation again.');
          return;
        }
        if (Date.now() - startedAt > STATUS_POLL_MAX_MS) {
          setPolling(false);
          setResumeReady(true);
          setMessage('Progress could not be checked. Press Resume import to try the same operation again.');
          return;
        }
        timer = setTimeout(() => void check(), STATUS_POLL_MS);
      }
    };
    void check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, key, token, finish]);

  /**
   * A cold start restores the exact CSV and operation key saved by `apply`. The
   * server receipt — not a fresh dry run — decides what happens next: completed
   * clears the draft, in-progress polls, partial/not-found shows the same-key
   * Resume, and failed asks for a Discard before another file. Validate is not
   * called here on purpose: rows already applied can look like duplicate SKUs to
   * a new dry run, and that must not hide a repair path the key can still finish.
   */
  useEffect(() => {
    const owner = user?.id;
    const attempt = `${owner ?? ''}#${restoreAttempt}`;
    if (!owner || !token || restoredFor.current === attempt) return;
    restoredFor.current = attempt;
    let active = true;
    setChecking(true);
    setRestoreBlocked(false);
    setMessage(null);
    void (async () => {
      try {
        await cleanupProductImportDrafts(owner).catch(() => 0);
        const result = await readProductImportDraft(owner);
        if (!active) return;
        if (result.status === 'error') {
          // A temporary SecureStore/file failure is not proof that no draft
          // exists. Keep the picker locked so a new key cannot abandon a saved
          // operation that this launch simply could not read.
          setRestoreBlocked(true);
          setMessage(
            'The saved import could not be checked. Check again before starting a new import.',
          );
          return;
        }
        if (result.status === 'missing') return;
        const draft = result.draft;
        setFile({ name: draft.fileName, csv: draft.csv });
        setKey(draft.key);
        setPreview(null);
        setErrors([]);
        setRequestId(null);
        setProgress(null);
        setResumeReady(false);
        try {
          const next = await productsApi.importStatus(token as string, draft.key);
          if (!active) return;
          setProgress(next);
          if (next.status === 'COMPLETED') {
            await finish(
              Number(next.result?.createdCount ?? next.createdCount),
              Number(next.result?.openingStockCount ?? next.openingStockCount),
              draft.key,
            );
            return;
          }
          if (next.status === 'IN_PROGRESS') {
            pollStartedAt.current = Date.now();
            setPolling(true);
            return;
          }
          setErrors(
            next.failures.map((failure) => ({
              field: `Line ${failure.line}${failure.field ? ` · ${failure.field}` : ''}`,
              message: failure.message,
            })),
          );
          if (next.status === 'PARTIAL') {
            setResumeReady(true);
            setMessage('Part of this file was applied. Press Resume import to finish it.');
          } else {
            setMessage(
              'The import could not be completed. Discard this saved import before choosing a corrected file.',
            );
          }
        } catch (err) {
          if (!active) return;
          // A status check is not allowed to strand the picker: without a known
          // terminal receipt, the same key is still the safe retry. If the server
          // actually completed, that same-key apply simply replays the receipt.
          setResumeReady(true);
          setMessage(
            err instanceof ApiError && err.status === 404
              ? 'The server has not recorded this import yet. Press Resume import to send the same operation.'
              : 'Progress could not be checked. Press Resume import to retry the same operation.',
          );
        }
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.id, token, finish, restoreAttempt]);

  async function validate(nextFile: { name: string; csv: string }) {
    setBusy(true);
    reset();
    try {
      const res = (await productsApi.importProducts(token as string, {
        fileName: nextFile.name,
        csv: nextFile.csv,
        dryRun: true,
      })) as unknown as Preview;
      setPreview(res);
      if (!res.valid) {
        setErrors(res.errors.map((e) => ({ field: `Line ${e.line}${e.field ? ` · ${e.field}` : ''}`, message: e.message })));
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setRequestId(errorRequestId(err));
      }
      setMessage(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    if (restoreBlocked) {
      setMessage('Check the saved import before choosing a file.');
      return;
    }
    if (key) {
      setMessage('Finish this import first. The same file and operation key are still selected.');
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/csv'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (typeof asset.size === 'number' && asset.size > MAX_IMPORT_CSV_BYTES) {
        setFile(null);
        setPreview(null);
        setMessage('The file is larger than 512 KiB. Split it into smaller imports.');
        return;
      }
      setBusy(true);
      const csv = await readAsStringAsync(asset.uri);
      setBusy(false);
      if (utf8ByteLength(csv) > MAX_IMPORT_CSV_BYTES) {
        setFile(null);
        setPreview(null);
        setMessage('The file is larger than 512 KiB. Split it into smaller imports.');
        return;
      }
      const next = { name: asset.name || 'products.csv', csv };
      setFile(next);
      await validate(next);
    } catch (err) {
      setBusy(false);
      setMessage(messageFor(err));
    }
  }

  async function apply() {
    if (!file || busy) return;
    // Resume is authorized by the saved key/server receipt, never by a fresh dry
    // run: rows already applied can now look like duplicate SKUs.
    if (!preview?.valid && !resumeReady) return;
    const existingKey = key;
    const operationKey = existingKey ?? newIdempotencyKey();
    setBusy(true);
    setPolling(false);
    setProgress(null);
    setMessage(null);
    setRequestId(null);
    try {
      // Save a NEW key BEFORE the request: if the process dies while the server
      // is importing, the next launch still has the same CSV and key. A restored
      // key is already durable, so a transient storage write must not block it.
      if (!existingKey) {
        const persisted = await saveProductImportDraft(user?.id, {
          fileName: file.name,
          csv: file.csv,
          key: operationKey,
        });
        if (!persisted) {
          setKey(null);
          setResumeReady(false);
          setMessage(
            'The import was not sent because its resume key could not be saved on this device. Try again.'
          );
          return;
        }
      }
      setKey(operationKey);
      const res = await productsApi.importProducts(
        token as string,
        { fileName: file.name, csv: file.csv, dryRun: false },
        operationKey,
      );
      await finish(Number(res.createdCount ?? 0), Number(res.openingStockCount ?? 0), operationKey);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setRequestId(errorRequestId(err));
      }
      setMessage(messageFor(err));
      // A definite refusal is a new attempt next time; an ambiguous answer keeps
      // the key so the same file resumes instead of creating a second catalogue.
      // `IMPORT_PARTIAL` is a durable outcome and stays resumable too.
      if (err instanceof ApiError && err.code === 'IMPORT_PARTIAL') {
        setResumeReady(true);
        pollStartedAt.current = Date.now();
        setPolling(true);
      } else if (err instanceof ApiError && endsOperation(err)) {
        setKey(null);
        setResumeReady(false);
        await clearProductImportDraft(user?.id, operationKey);
      } else {
        // The apply request itself may already have spent the client budget;
        // start the status window when polling begins, not when it was sent.
        pollStartedAt.current = Date.now();
        setPolling(true);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Escape hatch for a permanently unreadable saved copy. A temporary read
   * failure keeps the picker locked, but an explicit discard must remain
   * possible or a corrupt file would block every future import on the device.
   */
  async function discardUnreadableSaved() {
    if (busy || polling) return;
    const confirmed = await confirm(
      'Discard the unreadable saved import?',
      'The saved CSV and operation key will be removed from this device. Only do this if the saved import cannot be checked; a server receipt is not changed.',
      { confirmText: 'Discard', destructive: true },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const cleared = await clearProductImportDraft(user?.id);
      if (!cleared) {
        setMessage('The saved import could not be removed from this device. Try again.');
        return;
      }
      setRestoreBlocked(false);
      setFile(null);
      reset();
    } finally {
      setBusy(false);
    }
  }

  /** Forget this device's saved copy. The server receipt is not changed. */
  async function discardSaved() {
    if (!key || busy || polling || checking) return;
    const confirmed = await confirm(
      'Discard this saved import?',
      'The saved CSV and operation key will be removed from this device. If the server is still working, that import may continue and its receipt is not changed.',
      { confirmText: 'Discard', destructive: true },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const cleared = await clearProductImportDraft(user?.id, key);
      if (!cleared) {
        setMessage(
          'The saved import could not be removed from this device. Reopen this screen and try again.'
        );
        return;
      }
      setFile(null);
      reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll>
      <Card>
        <Text style={styles.title}>Bulk catalogue import</Text>
        <Text style={styles.body}>
          Choose a CSV with at least <Text style={styles.code}>name</Text> and{' '}
          <Text style={styles.code}>currency</Text>. Optional columns: sku, barcode, brand, description,
          specifications, category, unit, costPrice, sellingPrice, minimumStock, openingLocation,
          openingQuantity, imageUrl.
        </Text>
        <Text style={styles.body}>
          The server validates the whole file first. Nothing is written until the preview is valid.
        </Text>
      </Card>

      <Banner type="error" text={message} requestId={requestId} />

      {restoreBlocked ? (
        <>
          <Button
            title="Check saved import again"
            icon="refresh"
            onPress={() => {
              setMessage(null);
              setRestoreAttempt((value) => value + 1);
            }}
            loading={checking}
            disabled={busy || polling}
            full
          />
          <Button
            title="Discard unreadable saved import"
            variant="secondary"
            onPress={discardUnreadableSaved}
            disabled={busy || polling}
            full
            style={styles.discardButton}
          />
        </>
      ) : null}

      <Button
        title={
          key
            ? 'Finish this import first'
            : restoreBlocked
              ? 'Check saved import first'
              : file
                ? 'Choose a different CSV'
                : 'Choose CSV file'
        }
        icon="document"
        variant="secondary"
        onPress={pick}
        loading={busy && !preview}
        disabled={busy || polling || checking || restoreBlocked || Boolean(key)}
        full
      />
      {checking && !file ? (
        <Text style={styles.hint}>Checking for a saved import…</Text>
      ) : null}

      {file ? (
        <Card style={styles.fileCard}>
          <Text style={styles.fileName} numberOfLines={2}>
            {file.name}
          </Text>
          <Text style={styles.meta}>
            {preview
              ? `${preview.summary.totalRows} data row(s)`
              : checking
                ? 'Checking the saved import…'
                : key
                  ? 'Saved import · same operation key'
                  : 'Checking file…'}
          </Text>
        </Card>
      ) : null}

      {progress ? (
        <Card style={styles.summaryCard}>
          <Text style={styles.title}>
            {progress.status === 'COMPLETED'
              ? 'Import complete'
              : progress.status === 'PARTIAL'
                ? 'Import partly applied'
                : progress.status === 'FAILED'
                  ? 'Import not completed'
                  : 'Import in progress'}
          </Text>
          <Text style={styles.body}>
            {progress.createdCount} of {progress.totalRows} product row(s) created;{' '}
            {progress.openingStockCount} opening-stock movement(s) recorded.
          </Text>
          {progress.status === 'IN_PROGRESS' ? (
            <Text style={styles.hint}>
              The server is still working. Large files can take several minutes; progress updates automatically.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {preview?.valid || resumeReady ? (
        <Card style={styles.summaryCard}>
          <Text style={styles.title}>Ready to import</Text>
          <Text style={styles.body}>
            {preview?.valid
              ? `${preview.summary.productCount} product(s) will be created; ${preview.summary.openingStockRows} opening-stock movement(s) covering ${preview.summary.openingStockUnits} unit(s).`
              : 'The saved operation key will finish the rows the server already recorded. Rows already applied are skipped, so this cannot create a second catalogue.'}
          </Text>
          <Button
            title={polling ? 'Importing…' : key ? 'Resume import' : 'Import products'}
            onPress={apply}
            loading={busy || polling}
            disabled={busy || polling}
            full
          />
          <Text style={styles.hint}>
            {key
              ? 'This retry uses the same operation key, so it cannot create a second catalogue.'
              : 'This creates products and opening stock only. It does not issue, send or change any purchase order.'}
          </Text>
        </Card>
      ) : null}

      {key ? (
        <Button
          title="Discard saved import"
          variant="secondary"
          onPress={discardSaved}
          disabled={busy || polling || checking}
          full
          style={styles.discardButton}
        />
      ) : null}

      {errors.length > 0 ? (
        <View style={styles.errorList}>
          <Text style={styles.title}>Rows to fix</Text>
          {errors.slice(0, 40).map((e, idx) => (
            <View key={`${e.field}-${idx}`} style={styles.errorRow}>
              <Text style={styles.errorField}>{e.field}</Text>
              <Text style={styles.errorMessage}>{e.message}</Text>
            </View>
          ))}
          {errors.length > 40 ? <Text style={styles.hint}>Showing the first 40 problems.</Text> : null}
        </View>
      ) : null}
    </Screen>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    title: { ...type.h3, color: colors.text, marginBottom: spacing.sm },
    body: { ...type.body, color: colors.textSecondary, marginBottom: spacing.sm },
    code: { fontFamily: 'monospace', color: colors.text },
    fileCard: { marginTop: spacing.lg },
    fileName: { ...type.body, color: colors.text, fontWeight: '700' },
    meta: { ...type.caption, color: colors.textMuted, marginTop: 4 },
    summaryCard: { marginTop: spacing.lg },
    discardButton: { marginTop: spacing.lg },
    hint: { ...type.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md },
    errorList: { marginTop: spacing.xl },
    errorRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, paddingVertical: spacing.sm },
    errorField: { ...type.caption, color: colors.danger, fontWeight: '700' },
    errorMessage: { ...type.body, color: colors.text },
  });
