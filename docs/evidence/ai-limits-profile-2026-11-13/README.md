# AI assistant limits in Profile — production OTA (2026-11-13)

This report records the production release of the Profile **AI assistant** card and the phone
inspection of the rendered card. It covers the UI only; no AI model, tool, provider setting or
server code was changed in this release.

## Deployment

- PR [#250](https://github.com/nreffejzxc/inventory-ai/pull/250) passed all four required checks
  (`server`, `mobile`, `secret-guard`, `attribution-guard`) and was squash-merged as
  `8b99f4696b1127f82205b1c4cd617dcd17951b36` at 2026-11-13T04:28:03Z.
- Production OTA group `39f78213-cc77-45f6-8b1b-0b9232b44a62` (Android update
  `01a1d32a-e2e6-7ad8-9ad0-dcccee0fc5ea`) was published from `8b99f46` with the message
  **“Add AI assistant limits to Profile”**.
- The update host served `39f78213` for runtime `1.0.2` on the production channel.
- The previous production group was `58f75323-eeab-4aee-b48d-5f3c38e2396a`.
- Separately, the deprecated `AI_REASONING` Render variable was removed. The service environment
  went from 25 to 24 variables, `AI_REASONING_PAID_MODELS=enable` and
  `AI_REASONING_FREE_MODELS=disable` were retained, and `705d192` was redeployed as
  `dep-dbr90j8u01pc73ai2pgg`. `/api/health` reported `status: ok`, `db: connected`, and
  `/api/health/ready` returned 200.

## Phone inspection

Device: OPPO `CPH1969` (Android 11), production package `com.inventoryai.app` 1.0.2
(versionCode 10), production channel, runtime 1.0.2.

After the publish, the app was force-stopped and cold-started twice. The dashboard loaded with live
stock figures, which also confirms the bundle carried the production API URL. Profile → **AI
assistant** showed the complete card:

- read-only statement: the assistant can read permitted inventory but never changes records;
- **Messages:** up to 20 messages per minute, with a wait-and-retry instruction;
- **Answer time:** an answer can take up to a minute, and the app stops waiting if it takes too long;
- **Stopping an answer:** stopping cancels the answer; a finished answer is in the chat on reopen;
- **When the assistant is unavailable:** the chat reports it and the rest of Inventory AI keeps
  working.

The card wrapped cleanly at 1080 px width with no clipped text or horizontal overflow, and About
followed below it. Screenshot: [`profile-ai-card.png`](profile-ai-card.png).

## Not verified on the device

- The spent-allowance error sentence was not triggered, so the live quota copy was not rendered in
  this run. Its exact text is pinned by the two mobile copy tests: **“The assistant has used today's
  request allowance. It resets at midnight UTC — the rest of the app works as usual.”**
- The card's read-only behaviour was verified from the copy and the existing assistant tests, not by
  attempting a write through the assistant.

Android only; iOS was not tested.
