/**
 * AI controller — conversation persistence and the chat endpoint.
 *
 * Routes under /api/ai (see ai.routes.js). Every handler is scoped by the
 * authenticated user: businessId/userId always come from req.user (Phase 03
 * requireAuth), never from the request body. Conversations are persisted with
 * the Phase 02 AIConversation/AIMessage models — no duplicate collections, no
 * secrets ever stored.
 */

import type { Request, Response } from 'express';
import type mongoose from 'mongoose';

import { AIConversation, AIMessage } from '../models/index.ts';
import { parsePagination, pageResult } from '../utils/pagination.ts';
import { optionalObjectId, requiredString, isObjectId } from '../utils/validate.ts';
import { invalidId, notFound, throwValidation } from '../utils/errors.ts';
import ApiError from '../utils/ApiError.ts';
import { aiConfig } from '../services/ai/aiConfig.ts';
import {
  AiAbandoned,
  AiNotConfigured,
  AiOutputLimit,
  AiProviderError,
  AiQuotaExceeded,
  AiTimeout,
} from '../services/ai/aiErrors.ts';
import { runAiChat, type ChatTurn } from '../services/ai/ai.service.ts';

/**
 * The request context this controller reads, following `audit.controller.ts`,
 * `auth.controller.ts` and `users.controller.ts`: declaring these fields on
 * Express's global `Request` would let any module read an authoritative-looking
 * `req.user` on a public route.
 *
 * `user` is optional for the same reason it is optional in
 * `middlewares/authenticate.ts`: a handler is registered against Express's
 * `RequestHandler`, whose parameter is a plain `Request`; a required `user`
 * would make that `Request` unassignable and every route registration a type
 * error. The reads below assert it with `!` instead, which is justified by the
 * route table — every route in `routes/ai.routes.ts` is registered
 * `requireAuth, requirePermission(PERMISSIONS.AI_USE), controller`, so the
 * middleware has always run by the time these handlers execute. Optional
 * chaining was NOT used: it would silently pass `undefined` where the code
 * would previously have thrown, which is a behaviour change.
 *
 * `role` is read as well as `id`/`businessId` because `sendMessage` forwards it
 * to the AI service, which passes it to the tool layer's permission check.
 */
type AuthenticatedRequest = Request & { user?: { id: string; businessId: string; role: string } };

/** The stored conversation / message documents, derived from their models. */
type ConversationDoc = mongoose.HydratedDocFromModel<typeof AIConversation>;
type MessageDoc = mongoose.HydratedDocFromModel<typeof AIMessage>;

const TITLE_MAX = 120;

function conversationPublic(conv: ConversationDoc) {
  return {
    id: String(conv._id),
    title: conv.title || null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

function messagePublic(msg: MessageDoc) {
  const usage = msg.usage
    ? { inputTokens: msg.usage.inputTokens ?? undefined, outputTokens: msg.usage.outputTokens ?? undefined }
    : undefined;
  return {
    id: String(msg._id),
    conversationId: String(msg.conversationId),
    role: msg.role,
    content: msg.content,
    model: msg.model || undefined,
    toolsUsed: Array.isArray(msg.toolsUsed) && msg.toolsUsed.length ? msg.toolsUsed : undefined,
    usage,
    // AI-8 — the mark travels with the message, so a conversation read back from the
    // database says the same thing about a truncated answer as the screen that received
    // it did. Absent, not null, on every turn that was not degraded.
    degraded: msg.degraded || undefined,
    createdAt: msg.createdAt,
  };
}

function titleFrom(message: string) {
  const trimmed = message.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

/** Map AI-layer failures to safe, secret-free client responses. */
function mapAiFailure(err: unknown) {
  if (err instanceof AiNotConfigured) {
    return new ApiError(
      503,
      'The AI assistant is not configured on this server yet. Ask an administrator to enable it.',
      'AI_NOT_CONFIGURED'
    );
  }
  // AI-1 — the turn outlasted its own deadline. Deliberately its own status and
  // code: before this, a turn cut short and a provider outage were reported to
  // the user as the same thing. 504 rather than 502 because nothing upstream
  // failed — we stopped waiting, and the client should retry rather than
  // investigate a service it cannot see.
  if (err instanceof AiTimeout) {
    return new ApiError(504, 'The assistant took too long to answer. Please try again.', 'AI_TIMEOUT');
  }
  // AI-1 — the caller left. 499 is the conventional "client closed request", and
  // it is deliberately NOT a 502: nothing failed, and the socket this would be
  // written to is already gone. Its reason for existing is the log line, since a
  // request the client aborted used to leave no server-side trace whatsoever.
  if (err instanceof AiAbandoned) {
    return new ApiError(499, 'The request was cancelled before the assistant answered.', 'AI_ABANDONED');
  }
  // AI-6 — the gateway refused because a LIMIT was reached, not because anything
  // failed. 429 (not 502) and its own code and sentence, because the correct
  // action is the opposite of the one a 502 asks for: a 502 says "try again in a
  // moment", and a spent allowance cannot be waited out that way. This is the
  // case the device run measured as the DOMINANT failure at this tier (§27BF),
  // and it used to arrive as a provider outage.
  //
  // It is deliberately distinct from the route's own `429 AI_RATE_LIMITED`: that
  // one says *this member* is sending too fast and clears in seconds, while this
  // one says the assistant's allowance is spent and does not.
  if (err instanceof AiQuotaExceeded) {
    return new ApiError(
      429,
      'The AI assistant has reached its usage limit. Please try again later.',
      'AI_QUOTA_EXCEEDED'
    );
  }
  // AI-10 — the model spent its whole output budget before producing anything usable.
  // Checked BEFORE the provider branch because it is a different fact with a different
  // remedy: nothing is unavailable, and "try again in a moment" cannot help, since the
  // same question spends the same budget again. The status stays in the 502 family (the
  // upstream response was unusable) while the CODE and the sentence carry the meaning —
  // which is the distinction the mobile client switches on.
  if (err instanceof AiOutputLimit) {
    return new ApiError(
      502,
      'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.',
      'AI_OUTPUT_LIMIT'
    );
  }
  if (err instanceof AiProviderError) {
    return new ApiError(502, 'The AI service is temporarily unavailable. Please try again in a moment.', 'AI_UNAVAILABLE');
  }
  return err;
}

/**
 * Load the text turns already stored for a conversation (USER/ASSISTANT only) as
 * prior provider context. Called BEFORE the current turn is persisted, so the
 * result can never include the in-flight user message — the provider service
 * appends that message itself, and persisting/loading it first would send it
 * twice (Phase 07E / M6).
 */
async function priorTurnHistory(conversationId: ConversationDoc['_id'], limit: number): Promise<ChatTurn[]> {
  const historyFilter = { conversationId, role: { $in: ['USER', 'ASSISTANT'] } };
  const historyCount = await AIMessage.countDocuments(historyFilter);
  const skip = Math.max(0, historyCount - limit);
  const recent = await AIMessage.find(historyFilter)
    .sort({ createdAt: 1, _id: 1 })
    .skip(skip)
    .limit(limit);
  return recent.map((m) => ({ role: m.role === 'ASSISTANT' ? 'assistant' : 'user', content: m.content }));
}

/**
 * AI-40 — does this request want the answer as it is written?
 *
 * Negotiated on `Accept`, not on a second path or a body flag, so the route table, the
 * permission gate and the rate limiter stay exactly what they were. A client that sends the
 * ordinary `Accept: application/json` (every existing caller, and the mobile fallback) gets the
 * exact JSON response it always got — streaming is opt-in and cannot change a request that
 * did not ask for it.
 */
function wantsEventStream(req: Request): boolean {
  return /\btext\/event-stream\b/i.test(String(req.headers?.accept ?? ''));
}

/** The turn's inputs, resolved and validated, before any model call is made. */
interface PreparedTurn {
  cfg: ReturnType<typeof aiConfig>;
  message: string;
  conversation: ConversationDoc | null;
  history: ChatTurn[];
  /** The member's clock time for the question, taken before the model is called (AI-24). */
  askedAt: Date;
  /**
   * The member's IANA time zone, straight from the request body (AI-41).
   * Untrusted and display-only; the service validates it and falls back to UTC.
   */
  timeZone?: string;
  clientGone: AbortController;
  onResponseClose: () => void;
}

/**
 * Validate the request and resolve the conversation it continues.
 *
 * Shared by the JSON and the streamed path since AI-40, because every rule here is about what
 * may be asked and whose conversation it is — not about how the answer travels back. A
 * validation failure therefore behaves identically on both: it is thrown before any response
 * header is written, so the client sees the same JSON error envelope either way.
 */
async function prepareTurn(req: AuthenticatedRequest, res: Response): Promise<PreparedTurn> {
  const cfg = aiConfig();
  const problems = [];
  const convId = optionalObjectId(req.body?.conversationId, 'conversationId');
  problems.push(...convId.problems);
  const msg = requiredString(req.body?.message, 'message', cfg.maxMessageChars);
  problems.push(...msg.problems);
  if (problems.length) throwValidation(problems);
  // `requiredString` reports a problem instead of a value when the input is
  // unusable, and the throw above has already fired on that path, so the value
  // is a string here. The assertion is erased at runtime.
  const message = msg.value as string;

  const { businessId, id: userId } = req.user!;

  // Resolve an existing conversation (never created client-side, always under
  // the authenticated session). A new conversation is created lazily below.
  let conversation: ConversationDoc | null = null;
  let history: ChatTurn[] = [];
  if (convId.value) {
    conversation = await AIConversation.findOne({
      _id: convId.value,
      businessId,
      userId,
    });
    if (!conversation) notFound('Conversation not found');
    history = await priorTurnHistory(conversation._id, cfg.contextMessages);
  }

  // AI-1 — the caller's continued interest, as a signal the model call can be
  // cancelled with.
  //
  // `close` on the RESPONSE fires both when a response has finished normally
  // and when the connection was dropped before it could, so `writableEnded` is
  // what tells the two apart — and only the second means the client is gone.
  // (`req.on('close')` cannot be used for this: since Node 16 it also fires on
  // ordinary completion, which would abort every successful turn.)
  const clientGone = new AbortController();
  const onResponseClose = () => {
    if (!res.writableEnded) clientGone.abort();
  };
  res.on('close', onResponseClose);
  // The caller may ALREADY be gone: a connection can be dropped while auth and
  // validation are still running, before this listener exists, and 'close' is
  // not replayed for a response that has already closed. Measured, not
  // assumed — `res close (writableEnded=false, destroyed=true)` is what an
  // abort looks like when the listener is attached in time, and the listener
  // simply never fires when it is not. Without this check that turn would run
  // to its deadline and pay for a model call nobody will ever read.
  if (res.destroyed) clientGone.abort();

  // AI-24 — when the member ASKED, recorded before the model is called.
  //
  // The turn is persisted only after the provider succeeds (Phase 07E / M7), so the
  // default `createdAt` Mongoose would stamp on the USER message is the moment the turn
  // COMPLETED — the answer's clock on the question. Two timestamps made of that are
  // seconds apart however long the member waited, which is exactly the interval the
  // question/answer pair exists to show. Taking the time here makes the stored question
  // carry its own send time, on the server's clock like the answer beside it, so the
  // difference is the real turn duration anywhere it is read: on screen live, in a
  // reloaded thread, and straight out of the database.
  //
  // A supplied `createdAt` is honoured by Mongoose (measured 2026-10-19 against the
  // schema: a value 45 s in the past was stored unchanged), so no schema change is
  // needed and none was made.
  const askedAt = new Date();

  // AI-41 — the member's clock. Deliberately NOT validated into a 400: an old
  // client omits it and a broken one sends nonsense, and neither may turn a
  // question the assistant can answer into a validation failure. The service
  // resolves it (unknown -> UTC) and it only ever changes displayed dates.
  const timeZone = typeof req.body?.timeZone === 'string' ? req.body.timeZone : undefined;

  return { cfg, message, conversation, history, askedAt, timeZone, clientGone, onResponseClose };
}

/** The three documents one successful turn writes. */
interface SavedTurn {
  conversation: ConversationDoc;
  userMessage: MessageDoc;
  assistantMessage: MessageDoc;
}

/**
 * Persist a completed turn.
 *
 * Phase 07E / M7's rule is unchanged and is why this runs only on the success path: a failed
 * turn writes nothing, so a retry is a fresh, predictable attempt and the thread never shows a
 * question that was never answered. Both transports call it, so the JSON response and the
 * stream's `done` event carry byte-identical message objects.
 */
async function persistTurn({
  businessId,
  userId,
  message,
  askedAt,
  conversation,
  result,
}: {
  businessId: string;
  userId: string;
  message: string;
  askedAt: Date;
  conversation: ConversationDoc | null;
  result: Awaited<ReturnType<typeof runAiChat>>;
}): Promise<SavedTurn> {
  let conv = conversation;
  if (!conv) {
    conv = await AIConversation.create({
      businessId,
      userId,
      title: titleFrom(message),
    });
  }
  const userMessage = await AIMessage.create({
    conversationId: conv._id,
    role: 'USER',
    content: message,
    // AI-24 — the member's clock time, not the persistence time.
    createdAt: askedAt,
  });
  const assistantMessage = await AIMessage.create({
    conversationId: conv._id,
    role: 'ASSISTANT',
    content: result.content,
    model: result.model || undefined,
    toolsUsed: result.toolsUsed?.length ? result.toolsUsed : undefined,
    usage: result.usage || undefined,
    // AI-8 — a degraded turn is still a completed turn (AI-2), so it is still stored;
    // what is new is that the STORE now knows it was degraded. Only the reason is kept,
    // never a sentence: the partial answer in `content` is what the member read.
    degraded: result.degraded || undefined,
  });

  // AI-7 — the conversation is now the most recently ACTIVE one.
  //
  // Phase 20F declared the list's sort key as `updatedAt` and the mobile list already
  // displays that field, so both ends were built for an activity time that nothing
  // ever wrote: the only writes to this collection were `create(...)`, which left
  // `updatedAt` equal to `createdAt` forever. The list therefore read "newest first"
  // as "newest CREATED first" and a continued chat showed the time it was opened
  // rather than the time it was last used (seen on the device 2026-10-14 — a
  // conversation continued at 17:14 still listed as 17:02, §27BT).
  //
  // Bumping it here, immediately after the turn is durable and before the response,
  // is the whole fix, and it is deliberately placed on the SUCCESS path only: a
  // failed turn still persists nothing (Phase 07E / M7), so the activity time can
  // only ever move when a member actually received an answer.
  conv.updatedAt = new Date();
  await conv.save();

  return { conversation: conv, userMessage, assistantMessage };
}

/** What both transports send once a turn is durable. */
function turnPayload(saved: SavedTurn, result: Awaited<ReturnType<typeof runAiChat>>) {
  return {
    conversation: conversationPublic(saved.conversation),
    userMessage: messagePublic(saved.userMessage),
    assistantMessage: messagePublic(saved.assistantMessage),
    // AI-2 — a degraded turn is a COMPLETED turn: the member did read an answer,
    // so it stays a 201 and is marked rather than turned into an error. The mark
    // is what makes the failure countable at the boundary for the first time.
    // Deliberately NOT persisted on this object: it already rides the ASSISTANT
    // message, and `JSON.stringify` drops `undefined`, so a healthy turn carries
    // no `degraded` key at all rather than a null.
    degraded: result.degraded,
  };
}

/**
 * AI-40 — one turn, streamed.
 *
 * The wire contract is three event names and nothing else:
 *
 *   delta  { text }                     one piece of answer text, in order
 *   done   { conversation, userMessage, assistantMessage, degraded }
 *                                        the stored turn — identical to the JSON response
 *   error  { status, code, message }    the same mapping the JSON path uses, after headers
 *
 * The `done` payload is the authority, not the deltas: the server rewrites status constants and
 * trims a cut-off unit before storing, so the client replaces what it rendered with the final
 * message. Deltas are what make the wait visible; `done` is what makes it correct.
 *
 * Persistence is identical to the JSON path and happens at the same moment — after the provider
 * has answered, never as text arrives. A turn that fails still writes nothing, so a retry is the
 * same fresh attempt it was before streaming existed.
 */
async function sendStreamedTurn(req: AuthenticatedRequest, res: Response): Promise<void> {
  const turn = await prepareTurn(req, res);
  const { businessId, id: userId, role } = req.user!;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // `no-transform` matters as much as `no-cache`: a proxy that re-encodes or buffers the body
  // defeats the whole feature, and it is the header such a proxy is supposed to honour.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  const write = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // A compression middleware would otherwise hold the chunk until its own buffer fills.
      (res as Response & { flush?: () => void }).flush?.();
    } catch {
      // The socket is gone. The close listener has already aborted the turn; nothing to do.
      closed = true;
    }
  };

  // A comment line every 15 s keeps an idle connection alive through a proxy or a mobile
  // network. Every SSE parser ignores it, so it costs the client nothing.
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15000);
  heartbeat.unref?.();

  try {
    const result = await runAiChat({
      businessId,
      userId,
      role,
      history: turn.history,
      message: turn.message,
      signal: turn.clientGone.signal,
      timeZone: turn.timeZone,
      onTextDelta: (text) => write('delta', { text }),
    });
    const saved = await persistTurn({
      businessId,
      userId,
      message: turn.message,
      askedAt: turn.askedAt,
      conversation: turn.conversation,
      result,
    });
    write('done', turnPayload(saved, result));
  } catch (err) {
    write('error', sseFailure(err));
  } finally {
    clearInterval(heartbeat);
    res.off('close', turn.onResponseClose);
    if (!res.writableEnded) res.end();
  }
}

/** The safe, secret-free event payload for a failure that happened mid-stream. */
function sseFailure(err: unknown): { status: number; code: string | null; message: string } {
  const mapped = mapAiFailure(err);
  if (mapped instanceof ApiError) {
    return { status: mapped.status, code: mapped.code ?? null, message: mapped.message };
  }
  // Never the thrown value: an internal error's message can name a database or a stack.
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
}

const aiController = {
  /** POST /api/ai/conversations -> start an (empty) conversation. */
  async createConversation(req: AuthenticatedRequest, res: Response) {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, TITLE_MAX) : '';
    const conversation = await AIConversation.create({
      businessId: req.user!.businessId,
      userId: req.user!.id,
      title: title || undefined,
    });
    res.status(201).json({ conversation: conversationPublic(conversation) });
  },

  /** GET /api/ai/conversations -> the user's conversations, newest first. */
  async listConversations(req: AuthenticatedRequest, res: Response) {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { businessId: req.user!.businessId, userId: req.user!.id };
    const [total, docs] = await Promise.all([
      AIConversation.countDocuments(filter),
      AIConversation.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit),
    ]);
    res.json(pageResult(docs.map(conversationPublic), total, page, limit));
  },

  /** GET /api/ai/conversations/:id/messages -> one conversation's messages. */
  async listMessages(req: AuthenticatedRequest, res: Response) {
    const id = req.params.id;
    if (!isObjectId(id)) invalidId();
    const conversation = await AIConversation.findOne({
      _id: id,
      businessId: req.user!.businessId,
      userId: req.user!.id,
    });
    if (!conversation) notFound('Conversation not found');
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { conversationId: conversation._id };
    const [total, docs] = await Promise.all([
      AIMessage.countDocuments(filter),
      AIMessage.find(filter).sort({ createdAt: 1, _id: 1 }).skip(skip).limit(limit),
    ]);
    res.json(pageResult(docs.map(messagePublic), total, page, limit));
  },

  /**
   * POST /api/ai/chat -> run one user message through the AI service.
   *
   * Persistence semantics (Phase 07E / M7):
   *   * An existing conversationId is resolved up front and ownership-checked
   *     (business + user); an unknown/foreign id is a 404 and nothing is written.
   *   * A brand-new conversation is NOT created until the provider has produced a
   *     final answer, and the USER + ASSISTANT messages are persisted together
   *     only after that success. A provider failure therefore writes nothing:
   *     no empty conversation, no orphaned USER message, no misleading ASSISTANT
   *     reply — and retrying the same request is a fresh, predictable attempt.
   *   * On success the current user message appears exactly once in the provider
   *     request: prior history is loaded BEFORE this turn exists, and the AI
   *     service appends the current message once (Phase 07E / M6).
   */
  async sendMessage(req: AuthenticatedRequest, res: Response) {
    // AI-40 — negotiated on the header, before anything else is read. A request that did not
    // ask for a stream takes the path below unchanged, down to the status code it returns.
    if (wantsEventStream(req)) return sendStreamedTurn(req, res);

    // Validation, conversation ownership, the AI-1 abort listener and the AI-24 asked-at stamp
    // live in `prepareTurn`, which the streamed path uses too. The rules of "what may be asked
    // and whose conversation it is" therefore exist once: a fix here cannot leave the other
    // transport answering by different rules.
    const turn = await prepareTurn(req, res);
    const { businessId, id: userId, role } = req.user!;

    let result;
    try {
      result = await runAiChat({
        businessId,
        userId,
        role,
        history: turn.history,
        message: turn.message,
        signal: turn.clientGone.signal,
        timeZone: turn.timeZone,
      });
    } catch (err) {
      // Nothing was persisted yet, so a failed request leaves no trace and a
      // retry is deterministic — the same conversation is reused when an id was
      // given, or a fresh attempt starts cleanly when there was none.
      throw mapAiFailure(err);
    } finally {
      res.off('close', turn.onResponseClose);
    }

    // Provider succeeded — persist the turn durably now. AI-40 — shared with the streamed
    // path, so a stored turn is identical whichever way it travelled and the one place the
    // Phase 07E / M7 persistence rules live cannot drift.
    const saved = await persistTurn({
      businessId,
      userId,
      message: turn.message,
      askedAt: turn.askedAt,
      conversation: turn.conversation,
      result,
    });
    res.status(201).json(turnPayload(saved, result));
  },
};

export default aiController;
