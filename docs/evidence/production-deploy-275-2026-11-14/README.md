# Production deployment — PR #275 (2026-11-14)

**PR:** [#275](https://github.com/nreffejzxc/inventory-ai/pull/275)
**Merge commit:** `cd4efcc7a9db3b39b55d3400eabf10debe32466f`
**Previous production commit:** `8245e5428ceccaba986792540a0c1b7c4b8a16a7`

## CI before merge

All four required checks passed:

| Check | Duration |
| --- | --- |
| `server` | 3m 0s |
| `mobile` | 1m 38s |
| `secret-guard` | 11s |
| `attribution-guard` | 7s |

## Deployment

Render replaced `8245e54` with `cd4efcc` in about 45 seconds. The commit transition was observed at
**14:27:11Z**; the health response's `uptimeSeconds` was 32, so the service had just restarted.

Post-deploy health at **14:27:11Z**:

- `/api/health`: HTTP **200**, `status: ok`, `db: connected`, `environment: production`,
  commit `cd4efcc`, **9** `2xx`, **0** `5xx`, `serverErrors: 0`.
- `/api/health/ready`: HTTP **200**, `status: ready`, `db: connected`.

After the boot window at **14:28:36Z**:

- `/api/health`: HTTP **200**, `status: ok`, `db: connected`, commit `cd4efcc`, uptime **116 s**,
  **31** `2xx`, **0** `5xx`, `serverErrors: 0`.
- `/api/health/ready`: HTTP **200**, `status: ready`, `db: connected`.

Raw responses are in [`health.txt`](health.txt) and [`ready.txt`](ready.txt).

## Scope and limitations

The deploy carries the staging drills/evidence and the **AI-107** total-stock-value finalizer. No
production AI prompt or evaluation was run; this evidence verifies the deployment and service
health, **not** AI-107's behavior under a production question. No production configuration, model
order, data or credentials were changed. Resource use: one Render deploy and no additional AI
spend.
