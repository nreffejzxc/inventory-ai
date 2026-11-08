import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import AssistantMarkdown from './AssistantMarkdown';
import Button from './Button';
import { Icon } from './icons';
import { CenterLoader, ErrorState, errorText } from './ListState';
import { aiApi } from '../lib/api';
import type { ApiResponse } from '../lib/api';
import { isSessionError, useSession } from '../lib/auth';
import { REQUEST_CANCELLED } from '../lib/client';
import { formatClock12 } from '../lib/format';
import { toolTrace } from '../lib/toolLabels';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

/** Server default for AI_MAX_MESSAGE_CHARS — keep the composer bounded to match. */
const MAX_MESSAGE_CHARS = 4000;

const SUGGESTIONS = [
  'Which products are low on stock?',
  'Is anything out of stock?',
  'How much stock do we hold?',
  'What has moved recently?',
  'What do our keyboards cost online?',
];

/** The error fields this module reads. Narrowed at the untrusted boundary. */
interface SendErrorLike {
  code?: string;
  isNetwork?: boolean;
  message?: string;
  fields?: { field?: string; message?: string }[] | null;
}

/**
 * The two codes that mean "we waited as long as we agreed to, then stopped".
 *
 * `NETWORK_TIMEOUT` is this client giving up on its own budget;
 * `AI_TIMEOUT` is the server reporting that a whole turn outlasted
 * `AI_TURN_DEADLINE_MS` (AI-1's 504). From the user's side these are the same
 * fact — the assistant was slow — and neither is a connectivity problem.
 */
const TIMEOUT_CODES = ['NETWORK_TIMEOUT', 'AI_TIMEOUT'];

/**
 * AI-40 — when may a failed STREAM be retried through the ordinary route?
 *
 * Only when the failure says something about the TRANSPORT, never when it says something about
 * the turn. A quota refusal, a rate limit, an unconfigured server or an ended session are all
 * real answers, and asking again would either spend a second request to be refused identically
 * or hide the one thing the member needs to know. `status === 0` and the three "this server has
 * no such route / does not stream" statuses are the safe set: the same turn over JSON is a
 * different code path that may well work — with one deliberate exception.
 *
 * A `NETWORK_TIMEOUT` is OUR budget expiring, not evidence that the stream is unavailable. The
 * server may still be running the same turn, so retrying it immediately would start a second
 * billable turn for the same question. The timeout is final on the streaming path.
 */
export function streamFallbackAllowed(err: unknown): boolean {
  const error = (err as { status?: number; code?: string | null } | null | undefined) ?? null;
  if (error?.code === 'NETWORK_TIMEOUT') return false;
  if (error?.status === 0) return true;
  return error?.status === 404 || error?.status === 405 || error?.status === 501;
}

/**
 * Maps a failed send onto a friendly, secret-free client message. The server
 * may answer 503 (AI not configured), 504 (turn deadline), 502 (provider down),
 * 429 `AI_RATE_LIMITED` (this member is sending too fast) or 429
 * `AI_QUOTA_EXCEEDED` (the assistant's allowance is spent) — all normal for an
 * assistant that reads data through the backend.
 *
 * Exported because the ordering below is the fix, not an implementation detail:
 * a timeout is ALSO a `status === 0` error, so the previous code — which tested
 * `e.isNetwork` before it looked at `e.code` — reported every slow answer as
 * "Cannot reach the server" and sent the user to check a connection that was
 * working (ISS-21 / RC-3). `__tests__/ai1-timeout-copy.test.ts` pins both
 * directions of that distinction.
 *
 * AI-6 adds the other half of the same rule, one layer up: the two 429s must
 * read differently, because their remedies are opposites. `AI_RATE_LIMITED`
 * clears in seconds and says so; `AI_QUOTA_EXCEEDED` is a spent allowance that
 * waiting a moment cannot refill, so it must NOT borrow the "temporarily
 * unavailable / try again in a moment" sentence it used to arrive as.
 *
 * AI-10 is that rule a third time, on the failure that had no code of its own: a
 * provider answer cut off at `AI_MAX_OUTPUT_TOKENS` before it produced anything
 * usable arrived as `AI_UNAVAILABLE` — "temporarily unavailable, try again in a
 * moment" for a 2xx that named the wrong component AND prescribed the one action
 * that cannot help, since the same question spends the same budget again. The
 * remedy is a narrower question, so the sentence asks for one.
 */
export function sendErrorMessage(err: unknown): string {
  const e = (err ?? {}) as SendErrorLike;
  if (e.code === 'AI_NOT_CONFIGURED') {
    return 'The AI assistant is not enabled on this server yet. Ask an administrator to turn it on.';
  }
  if (e.code === 'AI_UNAVAILABLE') {
    return 'The AI service is temporarily unavailable. Please try again in a moment.';
  }
  if (e.code === 'AI_RATE_LIMITED') {
    return "You're sending messages too quickly — wait a moment and try again.";
  }
  // AI-6 — a spent allowance, not a fault and not something a moment's wait
  // fixes. Reported before the network check like every other code.
  // The screen said "try again later" until 2026-10-19, when the provider's own counter was
  // read at its ceiling (50 of 50 free requests used, nothing in reserve) and a real turn was
  // refused: the next usable moment is the daily reset, not an unspecified "later". Naming
  // the reset is the difference between advice a member can act on and advice that sounds
  // like the assistant is broken. The server's own sentence deliberately stays generic —
  // it cannot know the provider's day boundary — so the specifics belong here, where the
  // client already owns a code-mapped sentence for every other failure.
  if (e.code === 'AI_QUOTA_EXCEEDED') {
    return "The assistant has used today's request allowance. It resets at midnight UTC (8AM in Manila) — the rest of the app works as usual.";
  }
  // AI-10 — the model spent its whole output budget before it could answer. Like the
  // quota above, this is checked before the network test and it OWNS its sentence
  // rather than inheriting the server's: the remedy is a narrower question, and a
  // member who is told to "try again in a moment" spends the same turn's budget again.
  if (e.code === 'AI_OUTPUT_LIMIT') {
    return 'The assistant ran out of room before it could answer. Please ask a shorter or more specific question.';
  }
  // AI-9 — a request the member STOPPED is the same trap one step over: it is a
  // `status === 0` error too, so without this branch a cancellation routed through here
  // would be answered with "Cannot reach the server" — a sentence about a connection that
  // was working, for an act the member performed deliberately. The screen keeps a stop
  // away from this function entirely; this makes the wrong sentence unreachable rather
  // than merely unvisited.
  if (e.code === REQUEST_CANCELLED) {
    return 'You stopped waiting for that answer.';
  }
  // Checked BEFORE `isNetwork` on purpose — see this function's doc comment.
  if (e.code && TIMEOUT_CODES.includes(e.code)) {
    return 'The assistant took too long to answer. Please try again.';
  }
  if (e.isNetwork) {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  const field = Array.isArray(e.fields) ? e.fields.find((f) => f?.field === 'message') : null;
  return field?.message || e.message || 'Your message could not be sent.';
}

/**
 * AI-9 — did the MEMBER stop this turn, rather than it failing?
 *
 * Exported and separate from `sendErrorMessage` for the same reason that function
 * is exported: the distinction is the behaviour, not an implementation detail. A stop
 * is not an error at all — there is nothing to report, no retry to offer and no
 * session to clear — so it must never reach the error banner, and a screen that
 * routed it through the banner would be telling the member their own decision had
 * gone wrong.
 */
export function isStoppedSend(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === REQUEST_CANCELLED;
}

/** One rendered bubble. */
export interface ChatRow {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  /**
   * AI-24 — the server id of the message this row came from, when it came from the server.
   *
   * Present only so the turn's stored USER message can be merged in place of the optimistic
   * bubble that was shown while it was in flight: the reply carries `userMessage`, which is
   * the copy the reloaded thread reads, so merging it means a reopened conversation shows
   * exactly what the live one showed. The optimistic row has no id and is replaced by key.
   */
  messageId?: string;
  toolsUsed?: string[];
  /**
   * AI-8 — the server's mark on a turn that did not finish cleanly. Only
   * `'OUTPUT_LIMIT'` (an answer cut off by the output cap) is drawn as a note; the two
   * canned reasons already say the turn failed, so a second warning under them would be
   * noise. Absent on a healthy answer.
   */
  degraded?: string;
}

/**
 * ONE server message -> one row, in one place.
 *
 * AI-8 — this is a function rather than two inline object literals because the live
 * reply and a reloaded thread are two different arrival paths for the same message, and
 * a field carried by one but not the other is exactly the drift that would make a thread
 * read more confidently than the screen that produced it. The mark is the first field
 * where that would be a correctness problem rather than a cosmetic one, so both paths go
 * through here.
 */
export function toRow(m: ApiResponse): ChatRow {
  return {
    key: m.id,
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
    createdAt: m.createdAt,
    messageId: m.id,
    toolsUsed: m.toolsUsed,
    degraded: m.degraded,
  };
}

function toRows(serverMessages: ApiResponse[]): ChatRow[] {
  return serverMessages.map(toRow);
}

/**
 * Does this answer contain a table? A table-bearing bubble takes the full bubble
 * width, because a shrink-wrapped bubble collapses a table's columns.
 *
 * FOUND ON THE DEVICE 2026-10-14 (ISS-27). A **2-column** table answer rendered as a
 * narrow strip: the accessibility tree measured its cells at **48 px wide and up to
 * 1 452 px tall**, and the whole answer sat in a ~200 px column with nothing else on
 * the screen. The cause is width, not content — a `flexDirection: 'row'` grid inside a
 * bubble whose width is its own content's intrinsic width has nothing to stretch
 * against, so the `flex: 1` cells shrink to their minimum and every value wraps to a
 * character or two per line, exploding the height and pushing the question above the
 * viewport. The **card** path (4+ columns) escaped it only because its row titles are
 * long enough to give the bubble a wide intrinsic width — luck, not design, so both
 * paths take the wide bubble when a table is present.
 *
 * The test is `includes('|')` rather than a parse: it is O(n) with no allocation, which
 * matters because this runs on every re-render the composer's keystrokes cause, and it
 * is a **superset** of the parser's own table detection (a pipe-free line cannot be a
 * table), so the only cost of a false positive is a slightly wider bubble.
 */
export function isTableAnswer(content: string): boolean {
  return content.includes('|');
}

/**
 * The tools whose answers are a STOCK LIST, and therefore have a screen that can show
 * the whole thing (§27CR).
 *
 * The answer cap is a property of the model's reply, not of the request: a truncated
 * *list* answer has a real destination in the app, while a truncated piece of prose
 * does not — pointing one at `/restock` would be a fabricated connection between two
 * unrelated things. These three names are the server's own tool ids, which the message
 * already carries for the provenance line ("Read: …"), so this adds no field and no
 * request.
 */
const RESTOCK_TOOLS = new Set(['getReorderNeededProducts', 'getLowStockProducts', 'getOutOfStockProducts']);

/** Where a truncated stock-list answer can be read in full, or null if nowhere. */
export function restockPathForTools(toolsUsed?: string[]): string | null {
  return toolsUsed?.some((tool) => RESTOCK_TOOLS.has(tool)) ? '/restock' : null;
}

export function MessageBubble({ item }: { item: ChatRow }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const user = item.role === 'user';
  const wide = !user && isTableAnswer(item.content);
  const restockPath = user ? null : restockPathForTools(item.toolsUsed);
  return (
    <View style={[styles.bubbleRow, user ? styles.rowUser : styles.rowAssistant]}>
      <View
        testID={user ? 'chat-bubble-user' : 'chat-bubble-assistant'}
        style={[styles.bubble, user ? styles.bubbleUser : styles.bubbleAssistant, wide ? styles.bubbleWide : null]}
      >
        {/* The member's own words are shown exactly as typed. The model's answer
            is RENDERED (AI-4): headings, lists and tables become real layout
            instead of a wall of markers — see components/AssistantMarkdown. One
            path for both loaded history and the live reply. */}
        {user ? (
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{item.content}</Text>
        ) : (
          <AssistantMarkdown content={item.content} />
        )}
        {/* AI-8 — the answer is kept and ANNOTATED, rather than replaced. `OUTPUT_LIMIT`
            is the one reason where there is a usable answer and the member still needs to
            know it stops early: the model reached the output cap mid-list. The other two
            reasons put their copy in the content itself, so they are deliberately not
            repeated here. */}
        {!user && item.degraded === 'OUTPUT_LIMIT' ? (
          <View>
            {/* §27CR — when the truncation was a stock list, "ask a narrower question"
                was advice with nowhere to go, and telling a member to narrow a question
                while offering them the full list is the wrong instruction. The sentence
                keeps that clause only when there is nowhere else to send them. */}
            <Text testID="chat-incomplete-note" style={styles.incomplete}>
              {restockPath
                ? 'This answer hit the length limit, so it may be incomplete.'
                : 'This answer hit the length limit, so it may be incomplete — ask a narrower question to see the rest.'}
            </Text>
          </View>
        ) : null}
        {/* AI-26 — the restock link is drawn on EVERY stock-list answer, not only a
            truncated one. Rule 3 tells the model to send the member to "the matching
            screen in the app" for the full list, and a paginated 36-product answer is
            just as unreachable as a truncated one: before this, a complete answer that
            showed five of 8,976 ended with that sentence and no way to act on it — the
            link existed only when the model happened to run out of output tokens. The
            destination is the same screen for all three stock tools (the reorder
            endpoint is the list they all describe), so the link says the same thing. */}
        {restockPath ? (
          <Pressable
            testID="chat-restock-link"
            accessibilityRole="button"
            onPress={() => router.push(restockPath)}
          >
            <Text style={styles.incompleteLink}>Open the full restock list</Text>
          </Pressable>
        ) : null}
        {/* AI-21 — the chip names what was READ, not which function read it: the owner's
            judgement was that `Read: getProductsByLocation` is jargon. The stored message
            and `restockPathForTools` above keep the real names, so the trace and the
            routing are unchanged. */}
        {!user && toolTrace(item.toolsUsed) ? (
          <Text style={styles.tools} numberOfLines={2} testID="chat-tools">
            Read: {toolTrace(item.toolsUsed)}
          </Text>
        ) : null}
        {/* AI-17 — the footer used to be a bare `14:05`, which the owner read as a
            response time and asked about. It is the message's own clock time: 12-hour with
            a suffix, so it reads as a time on sight. The owner chose the bare time over a
            "Sent"/"Answered" prefix — the words were tried on the device and cluttered the
            bubble, while "2:58 AM" needs no label to be understood. */}
        {item.createdAt ? (
          <Text
            testID={user ? 'chat-time-user' : 'chat-time-assistant'}
            style={[styles.time, user && styles.timeUser]}
          >
            {formatClock12(item.createdAt)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ThinkingRow() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.bubbleRow, styles.rowAssistant]}>
      <View style={[styles.bubble, styles.bubbleAssistant, styles.thinking]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.thinkingText}>
          Analyzing your inventory…
          {'\n'}
          <Text style={styles.thinkingHint}>A full answer can take up to a minute.</Text>
        </Text>
      </View>
    </View>
  );
}

/**
 * AI-9 — the note left where a turn was stopped.
 *
 * It says what the member did and what the server does about it, and it is careful
 * about ONE thing: an abort that arrives after the model already finished still
 * stores the turn, so the note must not promise that nothing was written. What it can
 * promise is bounded and true — a stopped turn is not lost from the thread, because a
 * conversation's messages are stored together only once an answer exists, and a
 * finished answer is stored the moment it is produced.
 */
function StoppedRow() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.bubbleRow, styles.rowAssistant]}>
      <View style={[styles.bubble, styles.bubbleAssistant, styles.thinking]}>
        <Icon name="close" color={colors.textMuted} size={16} />
        <Text testID="chat-stopped-note" style={styles.thinkingText}>
          You stopped waiting for this answer. If the assistant had already finished, it will be here when you
          reopen this chat.
        </Text>
      </View>
    </View>
  );
}

function Welcome({ onAsk }: { onAsk: (text: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeIcon}>
        <Icon name="sparkles" color={colors.primary} size={34} />
      </View>
      <Text style={styles.welcomeTitle}>Ask about your inventory</Text>
      <Text style={styles.welcomeBody}>
        I can read your catalog and stock to answer questions about low stock, out-of-stock items and recent
        movements. I can also search the public web for reviews, specifications and current online prices,
        quoting only the sources I actually read. I&apos;m read-only — I can&apos;t change products or stock.
      </Text>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s) => (
          <Pressable key={s} style={styles.suggestion} onPress={() => onAsk(s)} accessibilityRole="button">
            <Text style={styles.suggestionText}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export interface AiChatProps {
  /** Set for an existing thread; null starts a new one on the first message. */
  conversationId?: string | null;
}

/**
 * Chat thread for the AI assistant. Two entry modes:
 *  - `conversationId` set  -> the existing thread is loaded from the server.
 *  - `conversationId` null -> a brand-new chat; the conversation is created by
 *    the backend on the first message and remembered locally from then on.
 *
 * Messages come back as DB rows, so bubbles always reflect what the server
 * stored. Sends surface 503/502/429 through a banner above the composer rather
 * than pretending a reply exists.
 */
export default function AiChat({ conversationId = null }: AiChatProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, signOut } = useSession();
  const [convId, setConvId] = useState<string | null>(conversationId);
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * AI-40 — the answer as it is being written.
   *
   * Held apart from `rows` on purpose: it is not a stored message, it has no id and no
   * timestamp, and on completion it is REPLACED by the stored message (whose content may differ,
   * because the server rewrites status constants and trims a cut-off unit). Mixing it into the
   * list would make "this is durable" and "this is arriving" the same kind of row.
   */
  const [streamingText, setStreamingText] = useState('');
  /**
   * AI-9 — a turn the member stopped. Kept apart from `sendError` on purpose: a stop
   * is not a failure, has no sentence to show, and must survive long enough to be read
   * (the turn it belongs to is gone the moment it is aborted, so the note IS the
   * outcome). Cleared when the next send starts, not by a timer.
   */
  const [stopped, setStopped] = useState(false);
  /**
   * The in-flight turn's abort handle, non-null only while one is in flight. A ref
   * rather than state because it is read by a press handler, never rendered, and a
   * re-render must not be what makes a stop possible.
   */
  const stopRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<ChatRow>>(null);

  const loadThread = useCallback(async (): Promise<void> => {
    if (!conversationId || !token) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Fetch the whole transcript page by page (messages are stored oldest
      // first). Chats are short in practice, so this stays a plain loop.
      const all: ApiResponse[] = [];
      let page = 1;
      for (;;) {
        const res = await aiApi.messages(token, conversationId, { page, limit: 100 });
        all.push(...(res?.items ?? []));
        if (!res || all.length >= (res.total ?? 0)) break;
        page += 1;
      }
      setRows(toRows(all));
    } catch (err) {
      if (isSessionError(err)) {
        await signOut();
        return;
      }
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [conversationId, token, signOut]);

  // Loads an existing thread when its screen opens. `conversationId` is a route
  // param and the current app navigation mounts a fresh AiChat for each thread,
  // so this Effect runs once for the mounted thread. `loading` starts as
  // `Boolean(conversationId)` and `loadError` starts as null, so the synchronous
  // writes are no-ops on the initial Effect path; they exist for the imperative
  // retry handler, where re-entering the loading state is intentional.
  //
  // `loading` is a lifecycle signal, not derived data: an empty conversation and
  // a conversation that has not loaded yet are indistinguishable from `rows`.
  // The UI depends on `loading && rows.length === 0` to show the initial loader,
  // while `loadError && rows.length === 0` controls the retry error state.
  //
  // This is a narrow lint-only exception, not a correctness fix. The current
  // component has no reachable overlapping thread-load flow, so request identity
  // or cancellation is intentionally outside this lint phase.
  useEffect(() => {
    // Deliberate, narrow exception at this one call site — not a suppression of
    // any dependency rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (conversationId) loadThread();
  }, [conversationId, loadThread]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  useEffect(() => {
    if (rows.length) scrollToEnd();
  }, [rows.length, sending, scrollToEnd]);

  async function send(text?: string): Promise<void> {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setSendError(null);
    setStopped(false);
    setStreamingText('');
    // AI-24 — the member's own message gets a time, so the question and the answer can be
    // read as two clock times a member can subtract by eye.
    //
    // It is taken HERE, at the instant the request leaves, and not from `userMessage.createdAt`
    // on the reply. The server persists the USER message only after the model has answered
    // (Phase 07E / M7: nothing is written until a provider succeeds), so its stored time is
    // when the turn COMPLETED — labelling the question with the answer's clock would hide the
    // very interval this is for. The send time is the one honest timestamp for this event.
    const sentAt = new Date().toISOString();
    // ONE key, held in a local: the bubble that is about to be drawn is the ONLY row this
    // turn may replace or remove. Matching on "a user row with no server id" instead was a
    // real bug on the device (2026-10-19): three failed sends had each left their bubble
    // behind, and the next success replaced all three with the same stored message — four
    // identical rows, and React warned "Encountered two children with the same key".
    const pendingKey = `pending-${Date.now()}`;
    setRows((prev) => [...prev, { key: pendingKey, role: 'user', content: message, createdAt: sentAt }]);
    // AI-9 — one controller per turn, registered BEFORE the request so the Stop
    // button has something to pull from the first render the member can see.
    const controller = new AbortController();
    stopRef.current = controller;
    setSending(true);
    // AI-40 — what this turn has already shown. It gates two decisions below: a stream that
    // fails after text was delivered must NOT be retried (the member would read the answer
    // twice), and a failure with nothing shown may be retried over the ordinary route.
    let streamed = '';
    const onDelta = (text: string): void => {
      streamed += text;
      setStreamingText(streamed);
    };
    try {
      let res;
      try {
        res = await aiApi.chatStream(
          token as string,
          { conversationId: convId, message },
          {
            signal: controller.signal,
            onDelta,
            // AI-74 — the server threw away what it streamed (a draft it re-asks for, or an
            // answer a guard rewrote). Clear the bubble instead of leaving the replaced version
            // above the replacement; `streamed` is cleared too, because nothing the member is
            // still reading was discarded — so a later transport failure may fall back and the
            // optimistic question may be withdrawn, exactly as if no text had arrived.
            onReset: () => {
              streamed = '';
              setStreamingText('');
            },
          },
        );
      } catch (streamErr) {
        // A stop or an ended session is final on both paths; so is any failure that arrived
        // after text — see `streamFallbackAllowed` for the ones that are not.
        if (isStoppedSend(streamErr) || isSessionError(streamErr) || streamed) throw streamErr;
        if (!streamFallbackAllowed(streamErr)) throw streamErr;
        res = await aiApi.chat(
          token as string,
          { conversationId: convId, message },
          { signal: controller.signal },
        );
      }
      if (!convId) setConvId(res?.conversation?.id ?? null);
      // The stored message is the authority: it may have been rewritten (status constants) or
      // trimmed (a cut-off unit), so the live text is discarded rather than kept beside it.
      setStreamingText('');
      const reply = res?.assistantMessage;
      if (!reply?.content) throw new Error('The assistant returned no answer.');
      // AI-8 — mapped through `toRow`, the same function a reloaded thread uses, so the
      // live reply cannot carry a field the stored one does not (or the reverse). The
      // mark on a truncated answer arrives on this response and would be lost here.
      //
      // AI-24 — the turn's stored USER message is merged in the same step, replacing the
      // optimistic bubble that was appended when Send was pressed. The screen needs no
      // timestamp of its own for a reload: the optimistic time covers the live turn, and this
      // is the copy a reopened thread reads, so both paths now show the same row.
      setRows((prev) => {
        const storedUser = res?.userMessage;
        // Replace exactly THIS turn's bubble with the stored copy, so the row the live screen
        // holds is the row a reload would build.
        const replaced = storedUser
          ? prev.map((row) => (row.key === pendingKey ? toRow(storedUser) : row))
          : prev;
        const merged = [...replaced, toRow(reply)];
        // The FIRST turn creates the conversation, which starts a reload of the thread, so the
        // same stored messages can arrive on both paths. Keyed dedupe makes a duplicate row
        // structurally impossible rather than a race that is usually won.
        const seen = new Set<string>();
        return merged.filter((row) => {
          if (!row.messageId) return true;
          if (seen.has(row.messageId)) return false;
          seen.add(row.messageId);
          return true;
        });
      });
    } catch (err) {
      // Checked FIRST: a stop is the member's own act, and `isSessionError` must never
      // get the chance to end their session over it (it cannot today — a cancelled
      // request has no status — but the ordering makes that a property rather than a
      // coincidence).
      if (isStoppedSend(err)) {
        setStopped(true);
        return;
      }
      if (isSessionError(err)) {
        await signOut();
        return;
      }
      // M7 guarantees a failed turn persists NOTHING, so the bubble must not stay on screen
      // claiming otherwise: it is removed, and the text returns to the composer so a retry
      // does not have to be retyped. Before this, every failed send left its bubble behind
      // and a retry stacked another — seen on the device as four identical questions after a
      // run of database 503s (2026-10-19).
      //
      // AI-40 — the exception is a stream that broke AFTER showing text: that text was read by
      // the member, so the question stays on screen beside it. The turn is still not stored, and
      // the sentence below says what went wrong.
      if (!streamed) {
        setRows((prev) => prev.filter((row) => row.key !== pendingKey));
        setInput(message);
      }
      setSendError(sendErrorMessage(err));
    } finally {
      stopRef.current = null;
      setSending(false);
    }
  }

  /**
   * AI-9 — the member's stop.
   *
   * It aborts the request and nothing else: the server notices the closed connection
   * and ends the turn (AI-1's `499 AI_ABANDONED`) instead of running it to its 60 s
   * deadline, so a stopped turn stops costing a model call. There is no destructive
   * step here — no session cleared, no stored message removed, no conversation
   * deleted — which is why it needs no confirmation. A press with no turn in flight is
   * a no-op rather than an error.
   */
  function stop(): void {
    stopRef.current?.abort();
  }

  /**
   * AI-40 — the rows as the screen draws them: the stored thread, plus the answer arriving.
   *
   * A separate list rather than a row in state, so the streaming text can be replaced wholesale
   * on completion and can never be mistaken for something the server stored. It is always the
   * LAST row, which is also where the member is looking.
   */
  const displayRows = useMemo<ChatRow[]>(() => {
    if (!streamingText) return rows;
    return [...rows, { key: 'streaming-answer', role: 'assistant', content: streamingText }];
  }, [rows, streamingText]);

  if (loading && rows.length === 0) {
    return <CenterLoader label="Loading conversation…" />;
  }
  if (loadError && rows.length === 0) {
    return <ErrorState title="Couldn't load this chat" message={errorText(loadError)} onRetry={loadThread} />;
  }

  return (
    <View style={styles.flex}>
      <FlatList
        ref={listRef}
        style={styles.flex}
        data={displayRows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <MessageBubble item={item} />}
        ListEmptyComponent={<Welcome onAsk={send} />}
        ListFooterComponent={
          // AI-40 — the thinking row is for the wait BEFORE any text; once words are arriving
          // there is nothing left to indicate.
          sending && !streamingText ? <ThinkingRow /> : stopped ? <StoppedRow /> : undefined
        }
        contentContainerStyle={styles.listContent}
        onContentSizeChange={scrollToEnd}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      />

      <View style={styles.composerArea}>
        {sendError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{sendError}</Text>
          </View>
        ) : null}
        <View style={styles.composer}>
          <TextInput
            style={[styles.composerInput, sending && styles.composerDisabled]}
            value={input}
            onChangeText={setInput}
            placeholder="Ask about your stock…"
            placeholderTextColor={colors.placeholder}
            editable={!sending}
            multiline
            maxLength={MAX_MESSAGE_CHARS}
            autoCorrect
          />
          {/* AI-9 — one slot, two actions. While a turn is in flight the composer is
              disabled and the only useful thing left to do is stop, so the primary slot
              becomes the stop rather than a dead Send button (which is what the
              `loading={sending}` + emptied input produced before: a spinner the member
              could only wait behind for up to 75 s). */}
          {sending ? (
            <Button title="Stop" variant="secondary" onPress={stop} style={styles.sendButton} />
          ) : (
            <Button title="Send" onPress={() => send()} disabled={!input.trim()} style={styles.sendButton} />
          )}
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    listContent: { flexGrow: 1, justifyContent: 'flex-end', padding: spacing.lg },
    bubbleRow: { marginBottom: spacing.md, flexDirection: 'row' },
    rowUser: { justifyContent: 'flex-end' },
    rowAssistant: { justifyContent: 'flex-start' },
    bubble: {
      maxWidth: '84%',
      borderRadius: radius.lg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    bubbleUser: {
      backgroundColor: colors.primary,
      borderBottomRightRadius: radius.sm,
    },
    bubbleAssistant: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderBottomLeftRadius: radius.sm,
    },
    // ISS-27 — a table needs a width it can fill. `flex: 1` grows the bubble to the
    // row (`maxWidth: '84%'` above still caps it), which gives the grid's `flex: 1`
    // columns a real width to share instead of their minimum content width. Applied
    // to table answers only, so a short prose reply keeps its natural bubble.
    bubbleWide: { flex: 1 },
    bubbleText: { ...type.body, color: colors.text },
    bubbleTextUser: { color: colors.textOnPrimary },
    tools: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm },
    // AI-8 — a caveat inside the assistant bubble, in the warning colour so it reads as
    // one. `marginTop` keeps it clear of the answer's last line, which it qualifies.
    incomplete: { ...type.caption, color: colors.warning, marginTop: spacing.sm },
    incompleteLink: { ...type.caption, color: colors.primary, fontWeight: '700', marginTop: spacing.xs },

    time: { ...type.caption, color: colors.textMuted, marginTop: 4, textAlign: 'right' },
    // On the primary-filled user bubble: readable in both themes without a
    // hardcoded white, which would vanish against the dark theme's light blue.
    timeUser: { color: colors.textOnPrimary, opacity: 0.75 },
    thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    thinkingText: { ...type.caption, color: colors.textMuted, flexShrink: 1 },
    // AI-9 — the wait is stated rather than implied: turns measured on the device run
    // 6–40 s and the server's own ceiling is a minute, so "up to a minute" is the
    // honest expectation to set while the spinner is on screen.
    thinkingHint: { ...type.caption, color: colors.textMuted, opacity: 0.8 },

    welcome: { paddingVertical: spacing.xxl, alignItems: 'center' },
    welcomeIcon: { marginBottom: spacing.sm },
    // alignSelf:'stretch' keeps the title's layout box full-width: with only
    // textAlign:'center' the parent's alignItems:'center' shrink-wraps the box
    // to the *unwrapped* text width, which clips the title to one short line.
    welcomeTitle: { ...type.h3, color: colors.text, textAlign: 'center', alignSelf: 'stretch' },
    welcomeBody: { ...type.bodySmall, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm, maxWidth: 320 },
    suggestions: { marginTop: spacing.lg, alignSelf: 'stretch', gap: spacing.sm },
    suggestion: {
      backgroundColor: colors.surface,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      paddingHorizontal: spacing.md,
      minHeight: 44,
      justifyContent: 'center',
    },
    suggestionText: { ...type.bodySmall, color: colors.primary, fontWeight: '600', textAlign: 'center' },

    composerArea: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, backgroundColor: colors.surface },
    errorBanner: {
      backgroundColor: colors.dangerSoft,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    errorText: { ...type.caption, color: colors.danger, fontWeight: '600' },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    composerInput: {
      flex: 1,
      ...type.body,
      color: colors.text,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
      maxHeight: 120,
    },
    composerDisabled: { opacity: 0.6 },
    sendButton: { minWidth: 84 },
  });
