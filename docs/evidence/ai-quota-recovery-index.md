# AI quota recovery evidence index

These records cover the three quota-recovery cases without changing production AI configuration:

| Case | Record | Scope |
| --- | --- | --- |
| First refusal, then recovery in the same conversation | [`ai-quota-retry-2026-11-13`](ai-quota-retry-2026-11-13/README.md) | OPPO development client, local API and local stub |
| Second refusal, then recovery in that same conversation | [`ai-quota-second-refusal-2026-11-13`](ai-quota-second-refusal-2026-11-13/README.md) | OPPO development client, local API and local stub |
| First turn of a brand-new conversation refused, then recovered | [`ai-quota-brand-new-2026-11-13`](ai-quota-brand-new-2026-11-13/README.md) | Automated server test with a fake provider |

The two device runs used a temporary guest Android user and the disposable demo account. Neither
called the production AI provider, spent shared quota, or changed production configuration. The
brand-new case is automated evidence rather than a device run; the mobile counterpart is named in
that record.

The reusable stub used by device walkthroughs is documented in
[`DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](../DEVELOPING_ON_A_PHYSICAL_DEVICE.md#11-local-quota-refusal-stub).
