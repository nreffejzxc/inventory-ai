# AI allowance-exhausted message on Android — isolated device run (2026-11-13)

This run triggered the assistant's spent-allowance path on the phone and read the rendered sentence.
It did not call the production AI provider or spend the shared production AI quota.

## Isolation

- Device: OPPO `CPH1969` (Android 11), a separate Android user named **QuotaTest** (user 10). The
  owner's production user (user 0) was not used for the test.
- App: the existing development client, package `com.inventoryai.app` 1.0.2, JavaScript served from
  Metro at `http://localhost:8081`. Production was not the API target.
- API: a local server on `http://localhost:4000`, connected to the development database
  `inventoryai_dev_db`.
- Provider: `OPENROUTER_BASE_URL=http://127.0.0.1:5999`, where a local OpenRouter-shaped stub
  answered startup **GET** probes normally and refused every completion **POST** with:
  - HTTP `429`;
  - `x-ratelimit-remaining: 0`;
  - `x-ratelimit-limit: 50`;
  - body `{"error":{"message":"stub daily allowance spent","type":"rate_limit_error"}}`.
- Account: the disposable development account `demo-preview@example.invalid`. Its stored Firebase
  password was stale, so only that demo account's password was reset through the Firebase Admin
  API for this run. No production account was used.

The development client and the production APK share a signing certificate. Installing the
versionCode 9 development client temporarily lowered the installed package code, so the saved
production APK (versionCode 10) was reinstalled on user 0 afterwards and the production app was
cold-started and checked before this record was written.

## Observed result

After signing in, opening **AI Assistant** and sending `LowStock`, the screen showed exactly:

> The assistant has used today's request allowance. It resets at midnight UTC — the rest of the app
> works as usual.

Screenshot: [`quota-message.png`](quota-message.png).

The server confirmed the same path:

- the stub received `POST /v1/messages` at `2026-11-13T05:12:10.241Z` and answered `429`;
- the API logged `AI turn outcome=AI_QUOTA_EXCEEDED status=failed ... quota=0/50 ...`;
- the chat transport was the streaming route, so `POST /api/ai/chat` itself completed with HTTP
  `200` and carried the failure in its stream error event;
- no request reached OpenRouter.

The relevant log lines are in [`quota-run.txt`](quota-run.txt).

## Other features

After the refusal, the same session opened **Products** and loaded the catalogue, category and
location filters, and the five demo products normally. The API log shows successful
`GET /api/categories`, `GET /api/locations` and `GET /api/products` responses for that screen.
Screenshot: [`products-after-quota.png`](products-after-quota.png).

The production APK was then restored on user 0: `versionCode=10`, `versionName=1.0.2`. It retained
its session, loaded the dashboard with live stock, and opened Profile. The test user was removed and
the local API, Metro and stub were stopped.
Screenshot: [`production-restored.png`](production-restored.png).

## Limits

- This is a **development-client** run: Metro served the JavaScript from local `main` (`e6629ab`),
  not the published production OTA bundle. It proves the real Android component and server error
  mapping render the sentence; it does not re-verify OTA delivery.
- The provider refusal was produced by a local stub, not by exhausting a real provider. That is
  deliberate: it exercises the server's `429`/zero-remaining classification without spending the
  shared production allowance.
- Android only; iOS was not tested.
