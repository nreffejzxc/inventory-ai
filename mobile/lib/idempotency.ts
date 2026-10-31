/**
 * The client half of inventory write de-duplication.
 *
 * WHY A KEY EXISTS AT ALL. The form's submit is not one event on the wire, it is
 * one event the member sees and up to two the server can receive: the request can
 * outlive the client's own budget (a Render cold start is the measured case), the
 * form is told it failed and re-enables its button, and the member submits again.
 * Both deliveries reach the server, so without a shared name for the operation the
 * movement is applied twice — two ledger rows, two Recent Activity entries, and a
 * stock level wrong by the whole movement.
 *
 * The key is that shared name. One is minted per operation ATTEMPT and kept only
 * while the same attempt might still be retried; the server answers the second
 * delivery with the first delivery's response instead of applying it again.
 *
 * WHAT IT IS NOT. Not a secret, not a hash of the payload and not a marker of "the
 * same form". Two deliberate, identical stock-ins minutes apart are two
 * operations and mint two keys — the storage key is the attempt, so legitimate
 * repeats are never swallowed as duplicates.
 */

import { ApiError } from './client';

/**
 * Whether an answer ENDS the operation, so the next press is a new one.
 *
 * Two failures are NOT an answer and therefore do not end the operation:
 *
 *   • status 0 (timed out, unreachable) — the movement may already have landed.
 *     This is the measured case: the member is told it failed and taps again.
 *   • `IDEMPOTENT_REQUEST_IN_PROGRESS` (409) — the server is saying the SAME key
 *     is still being processed. That is this operation, not a new one; renaming
 *     it would let a delivery that is still running be applied a second time.
 *
 * Everything else (4xx and 5xx alike) is a definite answer: the services roll
 * back whatever they wrote before rethrowing, and the server releases the claim,
 * so the member's next press is a new operation.
 */
export function endsOperation(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0) return false;
  return err.code !== 'IDEMPOTENT_REQUEST_IN_PROGRESS';
}

/**
 * A fresh operation key: `op-` + base-36 time + 16 random characters.
 *
 * `Math.random()` rather than a CSPRNG because this value authorizes nothing. It
 * only has to be distinct from the keys this member's own operations use, and the
 * server scopes every key by `businessId` besides. It stays within the server's
 * accepted shape (`[A-Za-z0-9._:-]{8,200}`).
 */
export function newIdempotencyKey(): string {
  const random = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `op-${Date.now().toString(36)}-${random}`;
}
