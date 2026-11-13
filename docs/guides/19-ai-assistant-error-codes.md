# 19. AI Assistant error codes and Android messages

This is the reference for what can go wrong on the assistant's chat route and what the Android app
does about it. The server's code is the authoritative classification; the Android sentence is what
the member actually sees. Both were read from the AI runtime at commit `705d192` on
**2026-11-13**; later commits are tests and documentation only.

Source of truth: `server/src/controllers/ai.controller.ts` (`mapAiFailure`, `sseFailure`),
`server/src/services/ai/aiErrors.ts`, `server/src/services/ai/rateLimiter.ts`,
`mobile/components/AiChat.tsx` (`sendErrorMessage`, `StoppedRow`), `mobile/lib/client.ts`, and
`mobile/lib/sse.ts`.

## 1. How a failed send appears

A failed send is not one surface. The app has five distinct outcomes:

1. **Red banner above the composer.** This is the normal failure surface. It sits between the
   conversation and the text box, in the danger colour, and contains one sentence.
2. **The question is withdrawn.** If the failure happens before any answer text has been shown, the
   optimistic question bubble is removed and its text is put back in the composer. The member can
   retry without retyping.
3. **The question and partial answer stay.** If the stream had already shown text, that text was
   read by the member, so the screen keeps it and adds the banner below it. The turn is still not
   stored (a failed turn writes nothing), but the visible text is not erased.
4. **The member's own stop.** A stop is not an error. It shows no banner; it leaves a footer note
   where the answer would have been. The exact note is in §4.
5. **A session ending.** If the failure is a terminal session error, the app signs out instead of
   showing an AI banner.

Conversation history load failures are a separate surface: the chat screen shows the full-screen
`Couldn't load this chat` state and the error's own message, not `sendErrorMessage`. The table below
is about sending and streaming a turn.

The banner deliberately hides the server's code. A member sees the sentence, not `AI_TIMEOUT` or
`AI_QUOTA_EXCEEDED`; support reads the code from the server log or the Render turn record.

## 2. Server AI codes and the exact Android text

`Status` is the HTTP status on the JSON path, and the status carried in the stream's `error` event
on the streaming path. The Android text is copied from `sendErrorMessage` unless the row says
otherwise.

| Status | Code | What happened | Exact Android text | Notes |
|---:|---|---|---|---|
| 503 | `AI_NOT_CONFIGURED` | No usable AI provider, model, or key on the server. | `The AI assistant is not enabled on this server yet. Ask an administrator to turn it on.` | A member cannot fix this. Production currently has a configured provider and model. |
| 502 | `AI_UNAVAILABLE` | The provider failed upstream, returned nothing usable, or another provider-side failure reached the turn. | `The AI service is temporarily unavailable. Please try again in a moment.` | The app's own sentence replaces the server's. Retrying is reasonable. |
| 429 | `AI_RATE_LIMITED` | This member sent more than **20 chat requests in 60 s** (process-local, per authenticated user). | `You're sending messages too quickly — wait a moment and try again.` | The server sends `Retry-After`, but the app does not display or enforce it; the sentence says "wait a moment". This is checked before any network classification. |
| 429 | `AI_QUOTA_EXCEEDED` | The provider's allowance was reached (`429`/`402`, or a refusal reporting zero remaining). | `The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app works as usual.` | The app's sentence is specific; the server's own sentence stays generic. The reset is stated in UTC only, so the app does not imply the member is in a particular city or guess the device's time zone. Rendered on the Android phone on 2026-11-13 with a local 429 stub: [evidence](../evidence/ai-quota-device-2026-11-13/README.md). |
| 502 | `AI_OUTPUT_LIMIT` | The model spent its whole output budget before producing a usable answer. | `The assistant ran out of room before it could answer. Please ask a shorter or more specific question.` | If some usable answer text did exist, this is **not** this error: the turn is a 201 with a degraded marker (§3). |
| 504 | `AI_TIMEOUT` | The whole turn outlasted `AI_TURN_DEADLINE_MS` (60 s by default). | `The assistant took too long to answer. Please try again.` | The client's own 75 s budget can fire first as `NETWORK_TIMEOUT`, which deliberately uses the same sentence. |
| 499 | `AI_ABANDONED` | The caller disconnected before the answer existed; the server stopped the turn. | Not displayed by the Android app. | A member's Stop is handled locally as `REQUEST_CANCELLED` (§4), so the 499 is a server-side record, not a banner. If a hand-built API client receives it, the server sentence is `The request was cancelled before the assistant answered.` |
| 400 | `VALIDATION_ERROR` | The message is missing, blank, or over **4,000** characters; or the conversation id is malformed. | The field message, for example `message must be at most 4000 characters` or `message is required`. | The composer's `maxLength` is 4,000, so a normal Android entry cannot exceed it. A stale or non-app client can. The app shows the `message` field before the top-level error. |
| 404 | `NOT_FOUND` | The conversation does not exist, or belongs to another user or business. | `Conversation not found` | The ownership check deliberately does not reveal which case it is. |
| 500 | `INTERNAL_ERROR` | An unmapped server failure. | `Something went wrong. Please try again.` | The server never sends an internal message, stack, database name, or provider body. |
| 403 | `FORBIDDEN` | The caller lacks `ai.use`. | `Insufficient permissions for this action` | All four roles normally hold `ai.use`, so this is not a normal member outcome. It is a generic authorization refusal, not an AI limit; a refused drill has its own `AI_DRILL_FORBIDDEN` code in §7. |

## 3. A truncated answer is not an error

A provider answer that reaches `AI_MAX_OUTPUT_TOKENS` (1,200 by default) **after producing usable
text** is stored and returned as a successful 201 turn with `degraded: "OUTPUT_LIMIT"`. The Android
bubble keeps the answer and adds one warning line under it:

- `This answer hit the length limit, so it may be incomplete.` — when the app also shows the
  restock-list link.
- `This answer hit the length limit, so it may be incomplete — ask a narrower question to see the
  rest.` — when there is no restock link.

The 502 `AI_OUTPUT_LIMIT` row above is the different case: the model produced no usable answer at
all. The retry described in Guide 18 §4 may rescue it before the member sees anything.

## 4. Client-side transport outcomes

These codes are created by the Android client, not the server. They still produce the same banner
when they reach `sendErrorMessage`.

| Code | What happened | Exact Android text | Notes |
|---|---|---|---|
| `NETWORK_TIMEOUT` | The client's own **75 s** AI budget expired. | `The assistant took too long to answer. Please try again.` | Deliberately final: the server may still be finishing the same turn, so the app does not retry automatically. |
| `NETWORK_ERROR` | The request never reached the server, the stream body was missing, the stream closed before `done`, or the stream was silent for **20 s** (`STREAM_IDLE_MS`). | `Cannot reach the server. Check your connection and try again.` | Even the stream's own "stopped sending" message is replaced by this network sentence because `sendErrorMessage` checks the transport class first. |
| `REQUEST_CANCELLED` | The member pressed **Stop** and the client aborted the request. | No banner. The footer note is `You stopped waiting for this answer. If the assistant had already finished, it will be here when you reopen this chat.` | `sendErrorMessage` would say `You stopped waiting for that answer.` if it were ever routed there; the chat screen deliberately routes a stop away from the banner. |

A stopped turn is not a failure, does not clear the session, and does not delete stored messages. If
the answer had already finished server-side, it can appear when the chat is reopened; the footer
note says so rather than promising that nothing was written.

## 5. Streaming fallback rules

The app first asks for `text/event-stream`. If that request fails before any answer text has been
shown, it may retry once over ordinary JSON. The fallback is allowed only when the failure is
transport-like: `status === 0`, `404`, `405`, or `501`. It is **not** attempted for:

- `NETWORK_TIMEOUT` — the 75 s budget expiring is not evidence that the stream route is missing,
  and a second request could start a second billable turn;
- `AI_RATE_LIMITED` or `AI_QUOTA_EXCEEDED`;
- `AI_NOT_CONFIGURED`;
- `AI_TIMEOUT`;
- any ended session;
- any failure after answer text has already appeared.

If the fallback runs and also fails, the member sees the fallback's error, not the first one. If the
stream fails after text was shown, the partial text stays and the stream error is shown in the
banner.

## 6. Authentication and session outcomes

Authentication is handled before the AI error mapping. These are not AI limits, but they change
what the member sees:

- **`SESSION_EXPIRED` (401).** Recoverable. The client renews the token once and retries the same
  request. If renewal cannot complete now, the session is preserved and the banner shows
  `Could not refresh your sign-in. Check your connection and try again.` — not "sign in again".
- **Terminal session codes** — `SESSION_REVOKED`, `SESSION_INVALIDATED`, `INVALID_TOKEN`,
  `AUTH_REQUIRED`, `ACCOUNT_DISABLED`, `FIREBASE_TOKEN_INVALID`, `FIREBASE_IDENTITY_CONFLICT` —
  the app signs out. There is no AI error banner.
- **`FORBIDDEN` (403)** carries a code, so it is not classified as session loss; it shows the
  authorization sentence in §2.

## 7. Codes the Android app cannot produce

These exist on the server but no Android screen sends the headers or request shapes that reach
them.

| Status | Code | Why it is unreachable from the app |
|---:|---|---|
| 403 | `AI_DRILL_FORBIDDEN` | The failover and output-limit drills are owner-only and require `x-ai-failover-drill` or `x-ai-output-limit-drill`; the app sends neither. |
| 400 | `AI_DRILL_UNKNOWN` | The drill header names an unsupported drill. The app sends no drill header. |
| 400 | `AI_DRILL_NOT_CONFIGURED` | The drill needs `AI_PROVIDER=openrouter` or a distinct research model. The app does not arm drills. |
| 400 | `AI_DRILL_REQUIRES_RESEARCH` | The research drill was armed on a non-research question. The app does not arm drills. |

`TOOL_ERROR` is also not an HTTP error. It is the `code` inside a failed tool result that the model
reads; it never becomes an Android banner. If the turn as a whole fails, the member sees one of the
turn-level codes above instead.

## 8. The short version

1. **Banner** for every real failure, except a stop and a session ending.
2. **`AI_TIMEOUT` and `NETWORK_TIMEOUT` share one sentence**: the assistant took too long.
3. **`AI_RATE_LIMITED` and `AI_QUOTA_EXCEEDED` are different**: one says wait a moment; the other
   says the allowance is spent and names the UTC reset.
4. **`AI_OUTPUT_LIMIT` has its own sentence**: ask a shorter or more specific question. A usable but
   truncated answer is a 201 with a warning line instead.
5. **`AI_ABANDONED` is a server record**, not something a member sees; the member's Stop has its own
   footer note.
6. **A failed turn stores nothing**, so a retry is a fresh attempt.
