# AI quota refusal and retry on Android — isolated device run (2026-11-13)

This run verified that a streamed quota refusal leaves the unsent question in the composer and that
the next Send, after the quota window, continues the same conversation with its earlier turns. It
did **not** call the production AI provider or spend the shared production quota.

## Isolation

- Device: OPPO `CPH1969` (Android 11). The run used a temporary **guest** Android user; the owner's
  user 0 was not used for the test. The guest was removed and the owner profile restored afterwards.
- App: the existing development client, package `com.inventoryai.app` 1.0.2. Metro served the
  JavaScript from the development tree over the host's local network.
- API: a local server on port `4000`, connected to the development database. It was not the
  production API.
- Provider: a local OpenRouter-shaped stub on `127.0.0.1:5999`. The stub streamed a normal completion
  for the baseline, refused one controlled completion with:
  - HTTP `429`;
  - `x-ratelimit-remaining: 0`;
  - `x-ratelimit-limit: 50`;
  - body `{"error":{"message":"stub daily allowance spent","type":"rate_limit_error"}}`;
  then streamed the next completion normally. No request reached OpenRouter.
- Account: the disposable development account `demo-preview@example.invalid`. No production account
  was used.

## Observed result

At `08:11:13Z`, `Say hello in one sentence.` streamed:

> Hello from the local stub. I can help with your inventory.

The answer carried `Ref: 8b2f1d70`. The conversation was left open.

At `08:11:40Z`, the next turn was refused by the stub. The app showed exactly:

> The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app
> works as usual.

The app kept the unsent question in the composer. Screenshot:
[`quota-refusal.png`](quota-refusal.png).

After the block window, the same Send button was pressed without retyping. At `08:12:40Z` the retry
streamed a complete answer:

> Hello from the local stub. I can help with your inventory.

The retry carried `Ref: b37876ec`. Both earlier turns and both answers remained in the thread.
Screenshot: [`retry-success.png`](retry-success.png).

The stub's request log confirmed that the retry request carried the baseline question and its
assistant answer as conversation history. The local API logged the streaming chat route as HTTP
`200` for the successful baseline, the refusal, and the successful retry; the refusal itself was
carried inside the already-open stream.

## Limits

- This is a **development-client** run, not a production OTA run. It proves the Android rendering
  and retry behaviour, not OTA delivery.
- The refusal was produced by a local stub deliberately, so the shared production allowance was not
  spent. The stub does not implement inventory tool calls. An earlier inventory question was
  therefore correctly replaced by the existing AI-60 “could not read that” fallback; the recorded
  walkthrough uses a greeting so that it isolates quota recovery rather than the unrelated guard.
- The draft contains a stray `c` (`chelp`) from the `adb` text-injection command. It is shown
  exactly as typed; this is not an app edit. The meaningful observation is that the draft stayed in
  the composer and was sent again without retyping.
- Android only; iOS was not tested.

## Cleanup

The temporary guest profile and its demo session were removed, the owner profile was restored, and
the local stub, API, and Metro processes were stopped. No production configuration or quota was
changed.
