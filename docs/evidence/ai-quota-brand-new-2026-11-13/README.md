# Brand-new conversation quota refusal and recovery — automated server evidence (2026-11-13)

This is automated server evidence, not a device walkthrough. It covers the case where the **first**
question of a new chat is refused, nothing has been persisted, and the retry creates the conversation
with exactly one question and one answer.

## Coverage

The case is `recovers a brand-new conversation after a quota refusal without prior history` in
[`server/test/AI40-ai-streaming.test.mjs`](../../../server/test/AI40-ai-streaming.test.mjs).

It sends the first turn without a `conversationId` and uses the fake provider to throw a quota
refusal. It then verifies:

- the streamed refusal is the shared SSE contract fixture and creates **zero** conversations;
- after the shortened quota window, the retry reaches the provider again;
- the retry's provider context contains only the new user question — no assistant history;
- the recovery creates **one** conversation with exactly **two** messages;
- the stored messages are the question followed by the answer.

The same screen behaviour has a mobile counterpart in
[`mobile/__tests__/ai40-assistant-streaming.test.tsx`](../../../mobile/__tests__/ai40-assistant-streaming.test.tsx):
`recovers a brand-new conversation whose first question was refused`. It verifies that both the
refused first Send and the retry send `{ conversationId: null, message }`, that no thread is loaded,
and that the successful retry clears the banner and composer.

## Verification

```text
cd server
TEST_MODE=full node --test test/AI40-ai-streaming.test.mjs
```

Result on 2026-11-13: **26/26 passed, 0 failed**. The focused mobile suite passed **24/24**; server
lint and typecheck and mobile typecheck were clean.

## Limits

- The provider is local and fake; this proves the server and screen contracts, not a live provider
  or a device rendering.
- The server case sets `AI_QUOTA_BLOCK_MS=2000` and waits 2.2 seconds to keep the test fast. That is
  a test-only window; it does not change production configuration.
- Android device evidence for the first and second refusals is linked from the
  [quota recovery index](../ai-quota-recovery-index.md).
