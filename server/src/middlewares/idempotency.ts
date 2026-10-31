import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import IdempotencyRecord from '../models/idempotencyRecord.model.ts';
import ApiError from '../utils/ApiError.ts';

/**
 * Idempotency for the writes that change stock or create an order.
 *
 * THE PROBLEM THIS SOLVES. A movement is applied once by the domain services, but
 * the HTTP REQUEST that carries it can arrive twice. Two real paths do that: a
 * double tap that lands inside one JS task, and — the one measured — a request
 * whose client budget expires while the server is still working. On the second
 * path the member is told it failed and submits again, so one tap becomes two
 * ledger rows and a stock level wrong by the whole movement. Recent Activity then
 * shows the operation twice, which is how the defect was reported.
 *
 * So the de-duplication is a transport concern, not a domain one: nothing in
 * `inventory.service.ts` or `purchase-orders.service.ts` changes, and their
 * compensation paths are untouched.
 *
 * THE CONTRACT, in order:
 *
 *   • no `Idempotency-Key`                → the request is untouched (old builds).
 *   • malformed key                       → 400 `IDEMPOTENCY_KEY_INVALID`.
 *   • key not seen                        → claim it, run the handler, remember the answer.
 *   • key COMPLETED, same body             → replay the stored status and body.
 *   • key COMPLETED, different body        → 422 `IDEMPOTENCY_KEY_REUSED`, nothing applied.
 *   • key IN_PROGRESS                      → 409 `IDEMPOTENT_REQUEST_IN_PROGRESS` + Retry-After.
 *
 * FAILED REQUESTS RELEASE THE KEY — UNLESS THE FAILURE APPLIED WORK. A 4xx/5xx answer
 * that changed nothing deletes the claim, so a member who fixes a validation error,
 * or a retry after a real server fault, starts a new operation rather than replaying
 * a refusal forever. A 409 `RECEIVE_CONFLICT` that reports `applied` lines is the
 * exception: it names work that landed, so it is recorded and replayed like a
 * success. See `appliedWork()`.
 *
 * AN ABANDONED CLAIM IS TAKEN OVER AFTER 60 s. If the process died mid-request no
 * answer is ever stored, and without this the key would block its own retry until
 * the TTL expired. The takeover is a conditional update on the same document, so
 * only one of several concurrent retries becomes the new owner; the request budget
 * is 15 s, so a minute-old claim cannot still be running healthy work.
 */

/** The key's own shape. Opaque to the server; only length and charset are policed. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/** A claim older than this owes an answer it will never produce. */
const STALE_CLAIM_MS = 60_000;

/** Only the authenticated context this middleware reads. `requireAuth` sets it first. */
type AuthenticatedRequest = Request & { user?: { id: string; businessId: string } };

/** MongoDB's duplicate-key error — the signal that somebody else owns the claim. */
function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/**
 * What makes two deliveries the SAME operation: the method, the addressed route and
 * the body. The route matters because a body alone does not identify the resource —
 * a receive key replayed against a different order carries the same lines and would
 * otherwise answer with the first order's result.
 */
function fingerprintOf(req: { method: string; originalUrl: string; body: unknown }): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ method: req.method, path: req.originalUrl, body: req.body ?? null }))
    .digest('hex');
}

/** Answer used both for a live claim and for the loser of a takeover race. */
function stillProcessing(res: Response, next: NextFunction): void {
  res.setHeader('Retry-After', '1');
  next(new ApiError(409, 'This operation is still being processed', 'IDEMPOTENT_REQUEST_IN_PROGRESS'));
}

/**
 * True when a refusal still REPORTS that part of the operation was applied. A
 * purchase-order receive is the one such answer: a batch that loses its last
 * line returns 409 `RECEIVE_CONFLICT` carrying an `applied` list of the lines that
 * landed. That is an outcome, not a refusal that changed nothing, so it must be
 * replayable rather than released.
 */
function appliedWork(body: unknown): boolean {
  const applied = (body as { applied?: unknown } | null | undefined)?.applied;
  return Array.isArray(applied) && applied.length > 0;
}

/** Logged, never thrown: the answer has already been decided. */
function recordFailure(err: unknown, claimId: unknown): void {
  console.error(
    `[idempotency] could not record the outcome of claim ${String(claimId)}: ${String((err as { message?: unknown }).message)}`
  );
}

/**
 * Records the outcome on the claim. Called from the patched `res.json` rather than
 * from the response's `finish` event: the handler's answer exists at that moment
 * even when the socket has already been abandoned by a timed-out client, which is
 * precisely the case this has to survive.
 *
 * A REPLAYABLE ANSWER IS RECORDED BEFORE IT IS SENT. Recording after sending leaves
 * a gap in which a duplicate delivery reads the claim as still running and is told
 * to wait rather than shown the outcome. A refusal that changed nothing is released
 * in the background instead, because an unhealthy database must not delay an error
 * response.
 *
 * A REFUSAL THAT REPORTED APPLIED WORK IS RECORDED TOO. Deleting its claim would
 * make the key claimable again, so a second delivery of the same request — the
 * one whose 409 was lost, which is why the client still holds the key — would
 * re-run the receive and apply the lines the 409 said had already landed. Only a
 * refusal that reports nothing applied releases the key, because there the next
 * attempt genuinely starts from zero.
 */
function settle(claimId: unknown, status: number, body: unknown): Promise<void> | null {
  if (status < 400 || appliedWork(body)) {
    // AN OUTCOME THAT MUST BE REPLAYABLE IS WRITTEN BEFORE THE ANSWER LEAVES. If the
    // response went first, a duplicate delivery landing in the gap would read the
    // claim as still running and be told to wait, instead of being answered with the
    // outcome — and a client that treats that 409 as a refusal would then start a NEW
    // operation. The handler that produced this answer already wrote to MongoDB, so
    // this single indexed update is not the request's first database round trip.
    // A failed write must never replace the answer; the claim is left IN_PROGRESS and
    // the stale takeover above bounds it.
    return IdempotencyRecord.updateOne(
      { _id: claimId },
      { $set: { state: 'COMPLETED', responseStatus: status, responseBody: body } }
    )
      .then(() => undefined)
      .catch((err: unknown) => recordFailure(err, claimId));
  }

  // A refusal that changed nothing only needs its claim released, and that is
  // housekeeping: it must never delay the refusal. If Mongo is unhealthy this is
  // exactly when an error response is needed most. A delete that never lands is
  // bounded by the same stale takeover.
  void IdempotencyRecord.deleteOne({ _id: claimId }).catch((err: unknown) => recordFailure(err, claimId));
  return null;
}

export function idempotent() {
  return async function idempotency(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const header = req.get('idempotency-key');
    // No key: the request behaves exactly as it did before this middleware existed.
    if (header === undefined) {
      next();
      return;
    }

    const key = header.trim();
    if (!KEY_PATTERN.test(key)) {
      next(new ApiError(400, 'The idempotency key is not usable', 'IDEMPOTENCY_KEY_INVALID'));
      return;
    }

    // `requireAuth` always runs first on the routes that mount this. Without a tenant
    // there is nothing to scope a claim to, so the request proceeds un-deduplicated
    // rather than being refused for a reason the caller cannot act on.
    const businessId = req.user?.businessId;
    if (!businessId) {
      next();
      return;
    }

    const bizOid = new mongoose.Types.ObjectId(businessId);
    const fingerprint = fingerprintOf(req);
    const filter = { businessId: bizOid, key };

    let claim = await IdempotencyRecord.findOne(filter);
    let owned = false;

    if (!claim) {
      try {
        claim = await IdempotencyRecord.create({ businessId: bizOid, key, fingerprint });
        owned = true;
      } catch (err) {
        if (!isDuplicateKey(err)) {
          next(err);
          return;
        }
        // Two deliveries raced for the same key; the winner's row is the claim.
        claim = await IdempotencyRecord.findOne(filter);
      }
    }

    if (!claim) {
      // Vanished between the failed insert and this read (expired, or released by a
      // concurrent failure). Running the handler is the safe choice: the ledger is
      // still the source of truth and the next retry will claim the key again.
      next();
      return;
    }

    if (!owned) {
      if (claim.state === 'COMPLETED') {
        if (claim.fingerprint !== fingerprint) {
          next(
            new ApiError(
              422,
              'This idempotency key was already used for a different request',
              'IDEMPOTENCY_KEY_REUSED'
            )
          );
          return;
        }
        res.status(claim.responseStatus ?? 200).json(claim.responseBody);
        return;
      }

      if (Date.now() - claim.createdAt.getTime() < STALE_CLAIM_MS) {
        stillProcessing(res, next);
        return;
      }

      const takenOver = await IdempotencyRecord.findOneAndUpdate(
        {
          _id: claim._id,
          state: 'IN_PROGRESS',
          createdAt: { $lte: new Date(Date.now() - STALE_CLAIM_MS) },
        },
        { $set: { fingerprint, createdAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!takenOver) {
        stillProcessing(res, next);
        return;
      }
      claim = takenOver;
    }

    const claimId = claim._id;
    const json = res.json.bind(res) as (body?: unknown) => Response;
    res.json = ((body?: unknown) => {
      const send = () => json(body);
      const settled = settle(claimId, res.statusCode ?? 200, body);
      // An outcome is recorded first and the answer follows it; a response that no
      // longer needs its claim is sent immediately. `send` is the rejection handler
      // too, so a recording failure still answers.
      if (settled) void settled.then(send, send);
      else send();
      return res;
    }) as Response['json'];

    next();
  };
}

export default idempotent;
