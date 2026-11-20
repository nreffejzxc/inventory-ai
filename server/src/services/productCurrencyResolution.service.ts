import mongoose from 'mongoose';

import Product from '../models/product.model.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit.ts';
import { normaliseCurrencyCode, PRODUCT_CURRENCY_CODES } from '../constants/currencies.ts';
import { recordAudit } from './audit.service.ts';
import { monitorAuditFailure } from './auditFailure.service.ts';

/** One reviewed evidence file and one review template are both capped here. */
export const MAX_CURRENCY_RESOLUTION_ENTRIES = 5_000;
const MAX_EVIDENCE_CHARS = 1_000;
const MAX_NAME_CHARS = 200;
const MAX_REVIEWER_CHARS = 200;
const MAX_SOURCE_CHARS = 500;

export type CurrencyResolutionEntry = {
  productId: string;
  currency: string;
  evidence: string;
  /** Optional exact recorded name, used as a second guard against a bad paste. */
  expectedName?: string;
};

export type CurrencyResolutionEvidence = {
  version: 1;
  businessId: string;
  reviewedBy: string;
  reviewedAt: string;
  source: string;
  entries: CurrencyResolutionEntry[];
};

export type CurrencyResolutionStatus =
  | 'WOULD_RESOLVE'
  | 'RESOLVED'
  | 'ALREADY_RESOLVED'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'NAME_MISMATCH'
  | 'FAILED';

export type CurrencyResolutionRow = {
  productId: string;
  name: string | null;
  currency: string;
  previousCurrency: string | null;
  status: CurrencyResolutionStatus;
  message?: string;
  auditRecorded?: boolean;
};

export type CurrencyResolutionReport = {
  businessId: string;
  reviewedBy: string;
  reviewedAt: string;
  source: string;
  dryRun: boolean;
  resolved: number;
  wouldResolve: number;
  alreadyResolved: number;
  conflicts: number;
  notFound: number;
  nameMismatches: number;
  failed: number;
  rows: CurrencyResolutionRow[];
};

type ValidationResult =
  | { ok: true; evidence: CurrencyResolutionEvidence }
  | { ok: false; errors: string[] };

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function sameName(left: string, right: string) {
  return left.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() ===
    right.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Only an exact stored code is already resolved. A lower-case or padded value
 * is legacy data too: the audit reports it, and this resolver must not treat it
 * as a different valid currency and refuse the repair.
 */
function exactStoredCurrency(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value === normaliseCurrencyCode(value) ? value : null;
}

/**
 * Validate a human-approved evidence file without consulting the database.
 *
 * A currency is never inferred here. Every row must name the product, the
 * exact ISO 4217 code, and the evidence the reviewer checked; the approval
 * metadata is mandatory so an unattributed bulk write cannot be constructed by
 * accident. Duplicate product ids are refused rather than silently merged.
 */
export function validateCurrencyResolutionEvidence(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['the evidence file must be a JSON object'] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) errors.push('version must be 1');

  const businessId = text(raw.businessId);
  if (!/^[a-f0-9]{24}$/i.test(businessId)) errors.push('businessId must be a 24-character hex id');

  const reviewedBy = text(raw.reviewedBy);
  if (!reviewedBy || reviewedBy.length > MAX_REVIEWER_CHARS) {
    errors.push(`reviewedBy is required (maximum ${MAX_REVIEWER_CHARS} characters)`);
  }

  const reviewedAt = text(raw.reviewedAt);
  if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    errors.push('reviewedAt must be an ISO date-time');
  }

  const source = text(raw.source);
  if (!source || source.length > MAX_SOURCE_CHARS) {
    errors.push(`source is required (maximum ${MAX_SOURCE_CHARS} characters)`);
  }

  const entriesRaw = raw.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    errors.push('entries must be a non-empty array');
    return { ok: false, errors };
  }
  if (entriesRaw.length > MAX_CURRENCY_RESOLUTION_ENTRIES) {
    errors.push(`entries may contain at most ${MAX_CURRENCY_RESOLUTION_ENTRIES} products`);
  }

  const seen = new Set<string>();
  const entries: CurrencyResolutionEntry[] = [];
  for (const [index, value] of entriesRaw.entries()) {
    const prefix = `entries[${index}]`;
    if (!value || typeof value !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const row = value as Record<string, unknown>;
    const productId = text(row.productId);
    if (!/^[a-f0-9]{24}$/i.test(productId)) {
      errors.push(`${prefix}.productId must be a 24-character hex id`);
    } else if (seen.has(productId.toLowerCase())) {
      errors.push(`${prefix}.productId is duplicated`);
    } else {
      seen.add(productId.toLowerCase());
    }

    const currency = normaliseCurrencyCode(row.currency);
    if (!currency) {
      errors.push(`${prefix}.currency must be an accepted ISO 4217 code`);
    }

    const evidence = text(row.evidence);
    if (evidence.length < 3 || evidence.length > MAX_EVIDENCE_CHARS) {
      errors.push(`${prefix}.evidence is required (3–${MAX_EVIDENCE_CHARS} characters)`);
    }

    const expectedName = text(row.expectedName);
    if (expectedName.length > MAX_NAME_CHARS) {
      errors.push(`${prefix}.expectedName is too long (maximum ${MAX_NAME_CHARS} characters)`);
    }

    if (currency) {
      entries.push({
        productId,
        currency,
        evidence,
        ...(expectedName ? { expectedName } : {}),
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    evidence: { version: 1, businessId, reviewedBy, reviewedAt, source, entries },
  };
}

/** The exact eligibility filter shared by the read path and the atomic write. */
function legacyFilter() {
  return {
    $or: [
      { currency: { $exists: false } },
      { currency: null },
      { currency: '' },
      { currency: { $nin: [...PRODUCT_CURRENCY_CODES] } },
    ],
  };
}

async function safeAudit(payload: Parameters<typeof recordAudit>[0]) {
  try {
    await recordAudit(payload);
    return true;
  } catch (err) {
    console.error(`[product-currency] audit write failed after resolution: ${String((err as { message?: unknown }).message)}`);
    try {
      await monitorAuditFailure({
        businessId: payload.businessId,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        error: err,
      });
    } catch {
      // The resolution is already committed; a monitoring failure must not
      // turn a successful currency repair into a failed batch.
    }
    return false;
  }
}

/**
 * Apply a reviewed evidence file as a batch of idempotent PATCH-like updates.
 *
 * Rules:
 * - the tenant comes from the evidence file and every query is scoped by it;
 * - only a missing or invalid currency is eligible — a valid, different code is
 *   a conflict and is never overwritten;
 * - an already-resolved row is a no-op, so rerunning the same file records no
 *   second update and no second audit row;
 * - a dry run writes nothing;
 * - the update is conditional on the row still being legacy, so a concurrent
 *   human edit wins rather than being overwritten.
 */
export async function resolveProductCurrencies({
  evidence,
  apply = false,
}: {
  evidence: CurrencyResolutionEvidence;
  apply?: boolean;
}): Promise<CurrencyResolutionReport> {
  if (!mongoose.Types.ObjectId.isValid(evidence.businessId)) {
    throw new Error('invalid businessId');
  }
  const businessId = new mongoose.Types.ObjectId(evidence.businessId);
  const report: CurrencyResolutionReport = {
    businessId: evidence.businessId,
    reviewedBy: evidence.reviewedBy,
    reviewedAt: evidence.reviewedAt,
    source: evidence.source,
    dryRun: !apply,
    resolved: 0,
    wouldResolve: 0,
    alreadyResolved: 0,
    conflicts: 0,
    notFound: 0,
    nameMismatches: 0,
    failed: 0,
    rows: [],
  };

  for (const entry of evidence.entries) {
    const target = entry.currency;
    let doc;
    try {
      doc = await Product.findOne({ _id: entry.productId, businessId })
        .select('name currency')
        .lean();
    } catch (err) {
      report.failed += 1;
      report.rows.push({
        productId: entry.productId,
        name: null,
        currency: target,
        previousCurrency: null,
        status: 'FAILED',
        message: String((err as { message?: unknown })?.message ?? err),
      });
      continue;
    }
    if (!doc) {
      report.notFound += 1;
      report.rows.push({
        productId: entry.productId,
        name: null,
        currency: target,
        previousCurrency: null,
        status: 'NOT_FOUND',
        message: 'no product with this id in the evidence business',
      });
      continue;
    }

    const current = typeof doc.currency === 'string' && doc.currency.trim() ? doc.currency : null;
    const validCurrent = exactStoredCurrency(current);
    if (validCurrent) {
      if (validCurrent === target) {
        report.alreadyResolved += 1;
        report.rows.push({
          productId: entry.productId,
          name: doc.name ?? null,
          currency: target,
          previousCurrency: validCurrent,
          status: 'ALREADY_RESOLVED',
          message: 'already has the same verified code; no write',
        });
      } else {
        report.conflicts += 1;
        report.rows.push({
          productId: entry.productId,
          name: doc.name ?? null,
          currency: target,
          previousCurrency: validCurrent,
          status: 'CONFLICT',
          message: 'a different valid currency is already recorded; this command never overwrites it',
        });
      }
      continue;
    }

    if (entry.expectedName && !sameName(entry.expectedName, doc.name ?? '')) {
      report.nameMismatches += 1;
      report.rows.push({
        productId: entry.productId,
        name: doc.name ?? null,
        currency: target,
        previousCurrency: current,
        status: 'NAME_MISMATCH',
        message: 'the recorded name does not match expectedName; no write',
      });
      continue;
    }

    if (!apply) {
      report.wouldResolve += 1;
      report.rows.push({
        productId: entry.productId,
        name: doc.name ?? null,
        currency: target,
        previousCurrency: current,
        status: 'WOULD_RESOLVE',
        message: 'dry run: no write',
      });
      continue;
    }

    try {
      const updated = await Product.findOneAndUpdate(
        {
          _id: entry.productId,
          businessId,
          ...legacyFilter(),
        },
        { $set: { currency: target } },
        { returnDocument: 'after', runValidators: true }
      );
      if (!updated) {
        const fresh = await Product.findOne({ _id: entry.productId, businessId })
          .select('name currency')
          .lean();
        const freshValid = exactStoredCurrency(fresh?.currency);
        if (fresh && freshValid === target) {
          report.alreadyResolved += 1;
          report.rows.push({
            productId: entry.productId,
            name: fresh.name ?? null,
            currency: target,
            previousCurrency: freshValid,
            status: 'ALREADY_RESOLVED',
            message: 'another writer resolved it to the same code; no second audit row',
          });
        } else if (fresh && freshValid) {
          report.conflicts += 1;
          report.rows.push({
            productId: entry.productId,
            name: fresh.name ?? null,
            currency: target,
            previousCurrency: freshValid,
            status: 'CONFLICT',
            message: 'another writer recorded a different valid code; nothing overwritten',
          });
        } else {
          report.failed += 1;
          report.rows.push({
            productId: entry.productId,
            name: fresh?.name ?? doc.name ?? null,
            currency: target,
            previousCurrency: fresh?.currency ?? current,
            status: 'FAILED',
            message: 'the row changed while the batch was running and is still not resoluble',
          });
        }
        continue;
      }

      const auditRecorded = await safeAudit({
        businessId,
        userId: null,
        action: AUDIT_ACTIONS.PRODUCT_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.PRODUCT,
        entityId: updated._id,
        metadata: {
          updated: ['currency'],
          previousCurrency: current,
          currency: target,
          reason: 'legacy-currency-resolution',
          evidence: entry.evidence,
          reviewedBy: evidence.reviewedBy,
          reviewedAt: evidence.reviewedAt,
          source: evidence.source,
        },
      });
      report.resolved += 1;
      report.rows.push({
        productId: entry.productId,
        name: updated.name ?? null,
        currency: target,
        previousCurrency: current,
        status: 'RESOLVED',
        auditRecorded,
      });
    } catch (err) {
      report.failed += 1;
      report.rows.push({
        productId: entry.productId,
        name: doc.name ?? null,
        currency: target,
        previousCurrency: current,
        status: 'FAILED',
        message: String((err as { message?: unknown })?.message ?? err),
      });
    }
  }

  return report;
}

/** Bounded read used to prepare a human review template; writes nothing. */
export async function unresolvedCurrencyCandidates({
  businessId,
  limit = MAX_CURRENCY_RESOLUTION_ENTRIES,
}: {
  businessId: string;
  limit?: number;
}) {
  if (!mongoose.Types.ObjectId.isValid(businessId)) throw new Error('invalid businessId');
  const bounded = Math.min(MAX_CURRENCY_RESOLUTION_ENTRIES, Math.max(1, Math.trunc(limit)));
  // Read one extra row so the CLI can tell a complete template from one that
  // stopped at the cap; the extra row is never included in the template.
  const rows = await Product.find({
    businessId: new mongoose.Types.ObjectId(businessId),
    ...legacyFilter(),
  })
    .sort({ name: 1, _id: 1 })
    .limit(bounded + 1)
    // The template needs only the id and expectedName. Do not load fields the
    // operator cannot review here, especially on a 5,000-row read.
    .select('name')
    .lean();
  return {
    items: rows.slice(0, bounded),
    truncated: rows.length > bounded,
    limit: bounded,
  };
}

export default {
  validateCurrencyResolutionEvidence,
  resolveProductCurrencies,
  unresolvedCurrencyCandidates,
};
