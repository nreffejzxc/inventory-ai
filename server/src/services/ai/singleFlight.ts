/**
 * One in-flight AI turn per user and conversation.
 *
 * WHY THIS EXISTS. The chat route is rate-limited per user, but the limiter counts requests in a
 * window; it does not stop two turns running at the same time. The phone disables Send while a turn
 * is in flight, yet a second device, a retried request or a hand-built client can still send the
 * same conversation twice. This guard admits one turn for a user+conversation, rejects the second
 * before the AI service or provider is reached, and releases the slot when the response finishes,
 * closes, or a bounded safety hold expires.
 *
 * SCOPE. This is deliberately in-process, like the existing AI limiter, breaker and health gates.
 * A restart clears it, and multiple server instances do not share it; it is not a distributed lock.
 * The key includes the authenticated user id, so one member cannot block another member's
 * conversation even if both send the same conversation id.
 */

import type { NextFunction, Request, Response } from 'express';

type AuthenticatedRequest = Request & { user?: { id: string } };

/** The safe sentence both transports return when a turn is already running. */
export const AI_TURN_IN_PROGRESS_MESSAGE =
  'The assistant is still answering your previous message. Wait for it to finish and try again.';

/**
 * A hard safety hold. The turn deadline is 60 s, so a normal turn releases on its response well
 * before this; the timer only prevents a dropped socket with no close event from blocking a
 * conversation forever.
 */
const DEFAULT_MAX_HOLD_MS = 120_000;

interface SingleFlightOptions {
  maxHoldMs?: number;
}

/** Build an isolated guard so tests can prove release and expiry controls. */
export function createAiSingleFlight({
  maxHoldMs = DEFAULT_MAX_HOLD_MS,
}: SingleFlightOptions = {}) {
  /** key -> the admitted turn's identity and start time. */
  const active = new Map<string, { startedAt: number; token: symbol }>();

  return function aiSingleFlight(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    const userId = req.user?.id || `ip:${req.ip || 'unknown'}`;
    const rawConversation = req.body?.conversationId;
    const conversation =
      typeof rawConversation === 'string' && rawConversation.trim()
        ? rawConversation.trim()
        : 'new';
    const key = `${userId}:${conversation}`;
    const now = Date.now();
    const current = active.get(key);

    if (current !== undefined && now - current.startedAt < maxHoldMs) {
      res.set('Cache-Control', 'no-store');
      res.status(409).json({
        error: AI_TURN_IN_PROGRESS_MESSAGE,
        code: 'AI_TURN_IN_PROGRESS',
      });
      return;
    }

    // A stale entry can survive a process pause without its timer firing. Remove it rather than
    // rejecting forever; the next turn's response will own the slot.
    const token = Symbol(key);
    active.set(key, { startedAt: now, token });

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      // The old response's finish/close/timer may arrive after a stale slot was replaced. Never
      // let that old release delete the NEW turn's slot.
      if (active.get(key)?.token === token) active.delete(key);
      clearTimeout(holdTimer);
      res.off('finish', release);
      res.off('close', release);
    };

    const holdTimer = setTimeout(release, maxHoldMs);
    holdTimer.unref?.();
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export const aiSingleFlight = createAiSingleFlight();

export default aiSingleFlight;
