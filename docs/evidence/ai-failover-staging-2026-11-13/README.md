# Staging research failover on Android — a real provider 404, answered by the free fallback (2026-11-13)

This run induced a **real model-specific provider failure** on a research turn and read the answer the
fallback model produced on the phone. It used the development OpenRouter key and a local API only; it
did not change the production AI configuration or call the production provider.

## Isolation

- Device: OPPO `CPH1969` (Android 11), a temporary Android user named **Failover** (user 12). The
  owner's production user (user 0) was not used for the test.
- App: the development client, package `com.inventoryai.app` versionName 1.0.2, versionCode 9,
  JavaScript served by Metro at `http://localhost:8081`. Metro ran from local `main` at
  `6b48f32`.
- API: `npm start` on `http://localhost:4000`, database `inventoryai_dev_db`, environment
  `development`.
- Account: the disposable development account `demo-preview@example.invalid`. Only that demo
  account's Firebase password was rotated for the run; no production account was used.
- AI overrides were process-local environment values, not `.env` edits:

  ```text
  AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free
  AI_RESEARCH_MODEL_OPENROUTER=openai/gpt-oss-120b:free
  AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free
  AI_WEB_SEARCH=enable
  AI_WEB_FETCH=enable
  ```

  The research model is the retired free slug. It is still listed as a paid model, so OpenRouter
  answers the free request with a genuine `404` rather than a malformed-request `400`.

## The failure and the walk

The question was:

> Compare the Keychron K8 Pro and Royal Kludge RK61 for me.

The API classified it `route=research` and called the research model. OpenRouter returned HTTP 404:

> This model is unavailable for free. The paid version is available now - use this slug instead:
> `openai/gpt-oss-120b`

The server treated that as a model-specific availability failure and walked the real failover chain
once:

```text
AI model call provider=openrouter model=openai/gpt-oss-120b:free tier=free reasoning=disabled field=disabled source=default turn=65cd27fb
AI provider openrouter upstream HTTP 404
AI failover attempt=1 model=openai/gpt-oss-120b:free -> nvidia/nemotron-3.5-lightning:free reason=HTTP 404 remaining=59812ms
AI turn outcome=ok status=ok duration=11.47s total=11468ms providerMs=10613ms toolMs=844ms calls=4 attempts=4 empty=0 retries=0 failovers=1 reasks=0 tools=searchProducts,getInventory toolRuns=4 cost=$0.000000 model=nvidia/nemotron-3.5-lightning:free tier=free route=research turn=65cd27fb
```

`POST /api/ai/chat` completed with HTTP 200 at `2026-11-13T16:26:46.116Z`. The turn used four provider
calls in total: the refused research call plus three fallback calls (a draft, then tool rounds). The
fallback model ran the read-only `searchProducts` and `getInventory` tools and answered on the phone.
The answer reported the real catalogue and stock split: K8 Pro 6 units (2 at Demo Shop, 4 at Demo
Warehouse) and RK61 32 units (10 at Demo Shop, 22 at Demo Warehouse).

The turn's support reference is **`65cd27fb`**.

## Screenshots

- [`question-and-answer-start.png`](question-and-answer-start.png) — the question and the start of the
  answer.
- [`answer-middle.png`](answer-middle.png) — the stock comparison and key differences.
- [`answer-end.png`](answer-end.png) — the answer's conclusion, tool line and `Ref: 65cd27fb`.

## A 400 is not a failover

An earlier attempt used `invalid/failover-research-does-not-exist`, a syntactically impossible model
id. OpenRouter answered `400` with `is not a valid model ID`. The turn ended with
`failovers=0`: a bad request is not evidence that another model would help, so the failover rules
deliberately do not walk the chain for it. The retired free slug is the correct choice for this
drill because it produces a real **404** from the provider.

## Cleanup and limits

- The production APK (versionCode 10) was reinstalled on user 0, the guest user was removed, and the
  production app was cold-started and checked.
- The local API and Metro were stopped, `adb reverse` entries were removed, and the temporary
  password file was deleted.
- This is a **development-client** run: Metro served JavaScript from local `main` `6b48f32`, not the
  published production OTA bundle. It proves the real Android rendering and the server failover path;
  it does not re-verify OTA delivery.
- The provider failure was real, but it was a **retired-model 404**, not an upstream 5xx outage. It
  proves the model-specific failover path and the phone answer; it does not prove recovery from a
  provider-wide outage.
- Android only; iOS was not tested.
