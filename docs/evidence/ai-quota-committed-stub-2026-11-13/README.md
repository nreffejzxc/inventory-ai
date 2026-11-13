# Fresh quota walkthrough with the committed stub (2026-11-13)

This run revalidated the documented device setup using only
[`scripts/device/quota-stub.mjs`](../../../scripts/device/quota-stub.mjs). It did not use a temporary
scratch server, contact the production AI provider, spend shared quota, or change production AI
configuration.

## Setup

- OPPO CPH1969 (`PV4DDMIZZLTCIVSK`), development client `1.0.2` (`versionCode=9`).
- Temporary guest Android user `11`; owner user `0` remained untouched.
- Local API on `http://192.168.1.13:4000` with `OPENROUTER_BASE_URL=http://127.0.0.1:5999`,
  the disposable stub key, `stub/model-1`, and a 30-second quota window.
- Stub command:
  `node scripts/device/quota-stub.mjs --port=5999 --log=.scratch/quota-committed/stub.jsonl`.
- The mobile `.env` pointed at the LAN API only for this run and was restored afterwards.

The stub's self-test was already exercised locally and by the required CI `server` job. This run then
drove the helper over HTTP from the real screen.

## Observed

| Step | UTC | Result |
| --- | --- | --- |
| Baseline turn | `2026-11-13T14:15:45Z` | Succeeded; ref `cd6c7ef4` |
| Arm next refusal | `2026-11-13T14:15:54Z` | `/control?fail=1` returned `{"failNext":true}` |
| Refused turn | `2026-11-13T14:16:42Z` | HTTP `429`; banner shown, question restored, no answer |
| Retry without retyping | `2026-11-13T14:18:00Z` | Succeeded; ref `9c2d9606`; banner cleared |

The screenshots show the same thread before and after recovery. Their `10:15 PM` and `10:18 PM`
timestamps are local UTC+8; the UTC times above come from the stub and API logs.

## Evidence

- [`refusal.png`](refusal.png) — full thread, quota banner, and the unsent question still in the
  composer.
- [`recovery.png`](recovery.png) — the same thread after pressing Send, with the recovered answer and
  empty composer.

## What this proves

- The committed helper is sufficient for a quota walkthrough; no scratch provider is needed.
- A refusal can be injected without production credentials or shared quota.
- The screen keeps the unsent question and recovers on the next Send in the same conversation.
- The helper's control state resets after one refusal, so the following completion succeeds normally.

## Limits

- This record covers one refusal and recovery. The
  [second-refusal record](../ai-quota-second-refusal-2026-11-13/README.md) covers two refusals in one
  conversation.
- The provider is local and fake; this proves the device and server seam, not a live provider.
- The run used the disposable demo account and a guest profile, not production user data.

## Cleanup

- Removed guest user `11`, restored owner user `0`, and reinstalled the production APK
  (`versionCode=10`).
- Restored `mobile/.env` to `http://localhost:4000`.
- Stopped the stub, API and Metro; ports `4000`, `8081` and `5999` are closed.
- Kept the stub/API logs only under ignored `.scratch/`; no password or log is committed.
