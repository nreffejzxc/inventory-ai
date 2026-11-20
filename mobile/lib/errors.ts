import { isSafeRequestId } from './client';

/**
 * The message carried by a thrown value. `err` is genuinely unknown at call
 * sites, so this checks the shape instead of assuming every failure is an Error.
 */
export function errorText(
  err: unknown,
  fallback = 'Unable to load. Check your connection and try again.',
): string {
  if (err == null) return fallback;
  if (typeof err === 'string') return err;
  return (err as { message?: string }).message || fallback;
}

/**
 * The server's safe request reference carried by a thrown error, or `null`.
 *
 * The transport already applies the server's rule when it reads the header. This
 * repeats the check at the presentation boundary so a hand-built error or a future
 * caller cannot turn an arbitrary value into UI.
 */
export function errorRequestId(err: unknown): string | null {
  if (err == null || typeof err !== 'object') return null;
  const requestId = (err as { requestId?: unknown }).requestId;
  return isSafeRequestId(requestId) ? requestId : null;
}

/** The one visible spelling of a support reference, or `null` for no/unsafe id. */
export function requestReferenceText(requestId?: string | null): string | null {
  return isSafeRequestId(requestId) ? `Reference: ${requestId}` : null;
}

/**
 * Append a support reference to a plain-text message (an Alert body, for example).
 * Unsafe or absent ids change nothing, so every caller can pass its error blindly.
 */
export function withRequestReference(
  message: string,
  requestId?: string | null,
): string {
  const line = requestReferenceText(requestId);
  return line ? `${message}\n\n${line}` : message;
}
