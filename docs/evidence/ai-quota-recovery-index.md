# AI quota recovery evidence index

These records cover the quota-recovery cases, the related spent-allowance message, and a fresh
device revalidation using the committed helper, without changing production AI configuration:

| Case | Record | Scope |
| --- | --- | --- |
| First refusal, then recovery in the same conversation | [`ai-quota-retry-2026-11-13`](ai-quota-retry-2026-11-13/README.md) | OPPO development client, local API and local stub |
| Second refusal, then recovery in that same conversation | [`ai-quota-second-refusal-2026-11-13`](ai-quota-second-refusal-2026-11-13/README.md) | OPPO development client, local API and local stub |
| First turn of a brand-new conversation refused, then recovered | [`ai-quota-brand-new-2026-11-13`](ai-quota-brand-new-2026-11-13/README.md) | Automated server test with a fake provider |
| Fresh device revalidation using only the committed helper | [`ai-quota-committed-stub-2026-11-13`](ai-quota-committed-stub-2026-11-13/README.md) | OPPO development client, local API and committed stub |
| Spent-allowance message rendered on Android | [`ai-quota-device-2026-11-13`](ai-quota-device-2026-11-13/README.md) | OPPO development client, local API and local stub |

The device runs used a temporary guest Android user and the disposable demo account. None called the
production AI provider, spent shared quota, or changed production configuration. The brand-new case
is automated evidence rather than a device run; the mobile counterpart is named in that record. The
committed-stub record revalidated the reusable setup without a scratch server.

The documentation guard fails when an `ai-quota-*` evidence directory is missing from this index or
has no README.

The reusable stub used by device walkthroughs is documented in
[`DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](../DEVELOPING_ON_A_PHYSICAL_DEVICE.md#11-local-quota-refusal-stub).

## Device walkthrough checklist

**Before**

- [ ] Start a temporary guest Android user; leave owner user 0 untouched.
- [ ] Save the installed production APK and versionCode so they can be restored.
- [ ] Run `node scripts/device/quota-stub.mjs --self-test`, then start the stub with a log under
      ignored `.scratch/`.
- [ ] Point the local API at `127.0.0.1:5999` and confirm Metro and the API are the local processes.

**Capture**

- [ ] Record a baseline success first.
- [ ] Call `/control?fail=1`, send the next question, and screenshot the full thread, refusal banner
      and unsent question.
- [ ] Record UTC times, provider refs and the next completion; confirm the refusal stayed inside the
      open stream.
- [ ] Wait past the block window, press Send without retyping, and screenshot the recovered thread.
- [ ] Repeat for a second refusal in the same thread when that is the case being recorded.

**After**

- [ ] Remove the guest user, restore owner user 0 and the saved production APK.
- [ ] Restore `mobile/.env`, stop the stub, API and Metro, and leave logs only under ignored
      `.scratch/`.
- [ ] Write the README with isolation, timestamps, refs, limits and cleanup; commit screenshots but
      no passwords or logs.
