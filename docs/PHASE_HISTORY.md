# Phase and Increment History

One line per phase, in order. Use it to answer "has this already been built?" — then open the
roadmap record for the measurement.

**Authoritative detail:** [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md), where each phase has a
dated `27…` record with its evidence. The compact phase list also sits in
[`../CLAUDE.md`](../CLAUDE.md) §7, because an agent needs to know what exists before proposing work.
Security-relevant decisions and open gates are in
[`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md).

This file previously carried ~12,000 words of prose for phases 08–32L. It was condensed on
**2026-10-26**: it had drifted (it stopped before the authentication campaign and the V1 close-out,
so it was both long and wrong as a history), and every paragraph in it restated a roadmap record.
Nothing was deleted that is not held, with more evidence, in that file.

---

## 1. Foundation and V1 core

| Phase | Delivered | Record |
| --- | --- | --- |
| 00 | Planning, specification, repository layout | roadmap part one |
| 01 | Project foundation: server/mobile skeletons, tooling | roadmap part one |
| 02 | Backend and MongoDB Atlas: models, connection, config | roadmap part one |
| 03 | Authentication and authorization: JWT, roles, permissions, tenant binding | roadmap part one |
| 04 | Inventory core: stock in, stock out, adjust, ledger, no negative stock | roadmap part one |
| 05 | Mobile app: the V1 screens over the API | roadmap part one |
| 06 | Read-only AI assistant with controlled tools | roadmap part one |
| 07 | Production hardening: headers, CORS, logging, error hygiene, rate limits | roadmap part one |

## 2. Post-V1 increments

| Phase | Delivered | Record |
| --- | --- | --- |
| 08A/08B | Structured request logging with correlation IDs; backend ESLint baseline | roadmap part one |
| 10A/10B | Business plan code, plan catalogue, centralized entitlement checks. **No payments, no billing** | roadmap part one |
| 11A/11B | Inventory health (IN/LOW/OUT), reorder endpoint, read-only restock tool, dashboard preview | roadmap part one |
| 14A | User management API: list/create/get, role and status update, OWNER/ADMIN only | roadmap part one |
| 16 | Audit-trail viewer: read-only `GET /api/audit`, OWNER/ADMIN | roadmap part one |
| 17 | Mobile suppliers and the full purchase-order lifecycle (create/edit/issue/cancel) | roadmap part one |
| 18A–18F | Semantic light/dark theme, shared primitives, every screen migrated; AA contrast in both themes | roadmap part one |
| 19 | Stock transfers: two legs through one route, compensation on failure, no new permission | roadmap part one |
| 21 | Archive-only product lifecycle, stated in the spec and guarded against reintroducing delete | roadmap part one |
| 22 | Read routes name their capability; permission catalogue made self-checking | roadmap part one |
| 23 | Route authorization classification (gated/authenticated/public/role) and the mobile RBAC mirror guard | roadmap part one |
| 24 | Runtime four-role authorization matrix; role-change effect proof; tenant-isolation correction | roadmap part one |
| 25 | Two design tokens recomputed to AA, measured rather than chosen by eye | roadmap part one |

## 3. Sessions, recovery and release engineering

| Phase | Delivered | Record |
| --- | --- | --- |
| 26A | Server-side sessions named by `jti`: real sign-out, per-session revocation, sign out everywhere | roadmap part one |
| 26B | Password recovery by emailed token, uniform 202, no enumeration oracle | §27B |
| 27 | Mobile recovery screens: `/forgot-password`, `/reset-password` | §27C |
| 28 | Reset mail detached from the request path (partially mitigated; residual accepted) | §27D |
| 29 | Residual security-risk decision record (B1 accepted, B2 and E3 deferred) | §27E |
| 30A | EAS foundation: profiles, identifiers, `expo-dev-client`, no updates yet | §27F |
| 30B | Native and device acceptance — defined; items closed piecemeal, iOS environment-blocked | §27AW |

## 4. Firebase authentication

| Phase | Delivered | Record |
| --- | --- | --- |
| 32A | Firebase design authority and console runbook | §27G |
| 32B | Firebase Admin boundary: Admin SDK, token verification, three `users` fields | §27H |
| 32C | Session exchange: verified ID token → ordinary Inventory JWT, UID-only lookup | §27H |
| 32D | Native SDK boundary on mobile, signing nobody in | §27H |
| 32E | Email/password flow, with the legacy password route as migration path only | §27H |
| 32F | Multi-provider decision record (email is never a join key) | §27I |
| 32G | First EAS development build run (in fact the third build) — native runtime validated | §27J |
| 32H | Account-linking boundary: `POST /api/auth/firebase/link`, four lifecycle cases | §27K |
| 32J | Registration onboarding: Google → register → exchange → session | §27L |
| 32K | Password-authority boundary and the timing-equalizer credential fix | §27M |
| 32L | Firebase unlink — **removed 2026-10-02**; re-scoped into a password change | §27Q, §27AA |
| F1/F2/F2.9 | Retire the Firebase JS SDK, browser OAuth, browser deps and the second scheme; verify on a device | §27N, §27O, §27P |

## 5. Authentication hardening (AUTH-01…06)

| Increment | Delivered | Record |
| --- | --- | --- |
| AUTH-01 | Firebase revocation checking and verification-failure classification | §27AB |
| AUTH-02 | One-hour JWT, enforced issuer/audience, 14-day session cap | §27AC |
| AUTH-03 | Session renewal: same `jti`, proactive, single-flight, rate-limited | §27AD |
| AUTH-04 | Six-digit email-verification code through the mail boundary; live acceptance on Brevo | §27Y |
| AUTH-05 | Emailed reset link returning through the server page into the app | §27DX |
| AUTH-06 | Password reset by six-digit code inside the app | §27DY |

## 6. Assistant, scale and V1 close-out

`AI-1` … `AI-84` are **delivered** and recorded from §27BD through §27HS. `AI-48`–`AI-84` were delivered in §27HR;
`AI-50`–`AI-84` are itemised in §27HS. `AI-87` and `AI-88` (ordinary/research model routing and a
controlled research failover drill) were deployed on 2026-11-08; they are recorded in
`DEVELOPMENT_LOG.md` because they were delivered without new numbered roadmap records. `AI-91`/`AI-92`
(exact product identity and per-location stock answers) merged as `6d95168` and were production-verified;
the follow-up `AI-93`–`AI-98` cleanups merged in PRs #196–#199 and are recorded in `DEVELOPMENT_LOG.md`.
`AI-99` (free-first simple inventory, deterministic totals and a resumable 10k evaluator) merged as
`8b6353a`, was deployed to Render and was published as production OTA group `0e4eca55`; a live
simple turn and a 10,256-product gate are recorded in `DEVELOPMENT_LOG.md`, and the on-device
What's New card was observed on 2026-11-10.
`AI-101` and `AI-102` are delivered: stored assistant answers carry a selectable turn reference, and
durable turn metrics plus the OWNER/ADMIN metrics endpoint are live as `eda08d0`. The matching
answer-reference What's New bundle is production OTA group `e38e07bf`; its `Ref:` line and What's
New card were observed on 2026-11-11 (task-4 evidence). Both are recorded in `DEVELOPMENT_LOG.md`.
`AI-103` (whole-set receipt and transfer totals in history answers) and `OPS-3` (the operator
monitoring runbook) were delivered on 2026-11-11; two test-isolation defects found by the local
database run were fixed in the same session. See `DEVELOPMENT_LOG.md` and §27HW. `AI-106` (finalizer
detail preservation and the reset-UX OTA) merged as `26eb0d4`; the AI-105 same-thread retry fix
merged as `3b275df` and is the current production commit. The exact same-thread count/compound
turns returned **19** and **19 / 1,633,025** with refs `bf777146` and `e4570da9`; the “Correcting
the answer…” label was observed live at `008a1583`. Production OTA `58f75323` carries the reset-UX
label. See `DEVELOPMENT_LOG.md` and
[`evidence/ai105-production-2026-11-11`](evidence/ai105-production-2026-11-11/README.md).
The deployed 10K gate rerun on 2026-11-11 passed **25/25** (0 errors, 0 degraded, $0) with no
output-limit event and a verified tenant restore (10,000 / 20,006 / 1,535 low); the long-thread
production test answered the compound question correctly but did not trigger the compact-history
trim, so that live proof remains open. GitHub still emitted no `event=schedule` run for the v2
health workflow after the stepped-cron change; manual dispatch works and is documented.
The earlier assistant increments cover the turn deadline,
retries, answer rendering, the cost line, quota, failover, streaming, and finally one provider
(OpenRouter). The
scale campaign measured the assistant and the list screens at 50 000–131 000 products (§27BX–§27DG),
and later records cover invitations (§27FB), account deletion (§27EW), the privacy policy and terms
(§27EV, §27FA), release notes (§27FE) and the V1 re-verification (§27FM).

The newest delivered records are not release-engineering ones: §27HQ records grounded answers, scoped
stock reads and the member's language; §27HR records the AI-48–AI-84 merge and deploy; §27HS is the
AI-50–AI-84 increment register. §27HT is the delivered AI-91/AI-92 record, and §27HU is the delivered
AI-99 record. AI-103/OPS-3 is §27HW, AI-106 is §27HY, and the close-out follow-ups are §27HZ.
The first assistant-roadmap implementation slice (AI-111–AI-113: Copy Answer, server-id product
links, filter-preserving screen links with bounded result rows, the highest-stock ranking and the
whole-set restock shortfall) is §27IE, merged as `af366c1`, deployed and device-verified; the
auxiliary-list correction is `91d635d`. AI-114, the deterministic complete restock/low-stock list,
is §27IF and merged as `e5c1c1d`. AI-115 (member ratings and the OWNER/ADMIN review queue) is
§27IG, and AI-116 (bounded previous-result follow-ups and per-answer freshness/Inspect) is §27IH;
both are implementation-tested in the working tree and pending deployment at this record. PLAT-1, the
INTERNAL Platform Operations plane for the Inventory AI owner/support/developers, is §27IJ; OPS-8,
the durable 5xx and feature-presence stores it reads, is §27IL; the platform-admin architecture is
aligned with the implemented interim plane and its remaining gates in §27IK. PLAT-2/PLAT-3, the
dedicated console, mandatory TOTP enrollment with optional WebAuthn, and append-only platform audit, is §27IM; PLAT-4, the
fresh review, CI browser proof, production-readiness checklist and prioritized recommendations, is
§27IN. PLAT-5, the recovery-code, durable MFA-lockout, password-change and administrator-lifecycle
hardening with fail-closed origin and cookie checks, is §27IO. PLAT-6, the deployed operations console
with support tickets, deployment history and production smoke, is §27IP at `56e8c27`. PLAT-7, the
forced recovery-code ceremony, free-plan outer access gate and break-glass drill deployed at
`e218bb0`, is §27IQ; its production gate/recovery proof and the required `webauthn-e2e` check are
§27IR. The PLAT-8 planning-only assessment of the access layer, security alerting and whole-product
priorities is §27IS; it changed documentation only and did not alter production. PLAT-9, the free-first
Cloudflare migration plan, alert-owner decision sheet, disposable restore drill and additive
follow-up assessment, is §27IT; it changed documentation only and did not touch the database or
production. PLAT-10, the primary/backup security contact record, isolated Firebase recovery drill
plan and seven-criteria IA-19–IA-33 ranking, is §27IU; the backup remains unassigned and no security
alert was activated, and it changed documentation only. PLAT-11, the named backup contact
registration (Cucumber; contact details private; test notification pending), the Firebase-plan safety
review and the IA-34–IA-37 additions, is §27IV; no drill, alert, production change or paid service
was performed. PLAT-12, the contact-wording correction, joint-rank reconciliation, pending two-contact
notification evidence and IA-38–IA-41 additions, is §27IW; no alert, notification, drill, production
change or paid service was performed. PLAT-13, the owner-run two-contact test procedure and
IA-42–IA-45 additions, is §27IX; no test message was sent, no alert was activated, and no production
change or paid service was performed. PLAT-14, the printable two-contact notification test checklist,
is §27IY; it is blank and pending, and no notification, alert or production change was made. PLAT-15,
the verified one-page checklist PDF and the TS-01–TS-06 tenant security review, is §27IZ; no
implementation, notification, alert, DNS change, deployment or paid service was made. PLAT-16, the
TS-01 notification plan, reproducible checklist renderer and RD-01–RD-06 review, is §27JA; no
implementation, notification, alert, production change or paid service was made. PLAT-17, the
checklist restoration, path-safe renderer, RD-01 drill plan and NX-01–NX-07 review, is §27JB; no
implementation, notification, alert, production fault injection or paid service was made. PLAT-18, the
RD-01 code fact-check, NX-01 sensitive-data protection design and NY-01–NY-06 review, is §27JC; no
implementation, notification, alert, production fault injection, database operation or paid service
was made. PLAT-19, the NZ-01–NZ-07 roadmap beyond NY-07, is §27JD; no implementation, notification,
alert, rollback drill, database operation, deployment or paid service was made. PLAT-20, the atomic last-SUPERADMIN guard, monitor-only 5xx accounting and
integrity-heartbeat restoration, is §27JE; no deployment, recovery-code rotation or WebAuthn
registration was performed.

PLAT-21, the console status assessment and platform/tenant account guide, is §27JF; no
deployment, account creation, production write or recovery rotation was performed.
PLAT-22, the additive security roadmap beyond PLAT-21, is §27JG; it records seven new
recommendations and verifies PR #336's five required checks, with no implementation or
merge. PLAT-23, the owner/CEO account, credential and access guide, is §27JH; it adds the
role/section matrices, complete credential inventory, storage and rotation rules,
authentication/recovery runbooks and owner checklist, with no deployment, account
creation or credential change. PLAT-24, the dedicated `docs/platform-console/` set with
an index and the tenant-disable, TOTP/WebAuthn and 5xx-scope corrections, is §27JI;
documentation only, with no code, deployment or account change. PLAT-25, the outer
gate failure budget with 429 responses and a sampled denial audit, is §27JJ; code and
tests only, with no deployment or production configuration change. PLAT-26, the audited
operator CLI creation with one `platform.admin.created` event, is §27JK; code and tests
only, with address activation left for a separate step. PLAT-27, the SEC-08 five-minute
step-up proof enforced on destructive administrator lifecycle routes, is §27JL; code,
tests and console documentation, committed to PR #336 as `282c8d6` with all five required
checks green and merged/deployed as `e7ce455`. No address activation or production
account change was made.

PLAT-29, the console user guide and documentation reconciliation, is §27JY; documentation
only, with no production setting, account creation or permission change. The tenant-facing
Operations dashboard was removed before commit. The
2026-11-15 post-deploy/triage/monitor close-out is §27IA;
the last full authenticated production proof was `74e4b87` (the console delivery plus dependency
PR #318), while public health reported `f95b5e4` on 2026-11-19. The newest OTA is
`9d759ee5-82c5-4fbe-afe0-3a0ea2c44f6c`. The AI-105 retry fix and the
live label are recorded in `DEVELOPMENT_LOG.md` and
[`evidence/ai105-production-2026-11-11`](evidence/ai105-production-2026-11-11/README.md). Release engineering remains in
§27FN (EAS retention and the plan gate on OTA signing), §27EZ (the production parity gate that
stopped a store upload) and §27FK (the runtime boundary that made a stale process impossible to
mistake for a server fault). DEP-01, the patched `glob@14.0.2` override in both manifests and the
accepted `picomatch` 4.0.7 residual review, is §27JM; merged as `ecbdb87` and
deployed, with #25 remaining open. DEP-02, the dependency-review pull-request gate pinned
to `v5.0.1`'s full SHA, is §27JN; it passed a clean run, failed a scratch
`lodash@4.17.20` pull request, and became a required `main` check with six contexts.
DEV-01, the optional loopback-only `mongo:7` compose service and its concise guide, is
§27JO; it was not executed because Docker is not installed, and the deployed path is
unchanged. PLAT-28 keeps late session responses from clearing the console's MFA challenge
and proved it with six green `webauthn-e2e` runs; it is §27JP. DEV-02 adds a
`compose-mongo` CI job that boots the committed compose file, waits for healthy and pings
MongoDB on every PR and push; it is §27JQ. DEV-03 makes it a required check and moves the
audit and current docs to seven contexts; it is §27JR. DEV-04 pins `mongo:7.0.48`, adds
weekly Docker Compose Dependabot tracking and bounds every CI job; it is §27JS. DEV-05
wires `merge_group` and the merge-group base into both required workflows, but the queue is
blocked because the repository is user-owned; it is §27JT. DEV-06 removes that inactive wiring,
keeps the seven-check PR gate and enforces SHA-pinned Actions; it is §27JU. DEV-07 verifies the
production-health workflow and keeps native Mongo service containers; DEV-08 is a ranked workflow
improvement roadmap; they are §27JV and §27JW. DEV-09 adds the workflow invariant guard, removes
persisted checkout credentials and rewrites the security policy concisely; it is §27JX.
The console guide claim audit and follow-up recommendations are §27KA; documentation only, with no
code, account, permission, deployment or production change. It corrected the TOTP display,
`READ_ONLY` deployment claim, developer command, production-guard wording, step-up scope, lost-key
order and production commit, and recorded five unimplemented follow-ups.
The five implementation plans are §27KB: a corrected FW-04, FW-07 request references, a
measurement-first FW-05 deadline, linked stock-movement reversal and supplier replenishment terms.
The FW-04 correction records that the tree has only `DRAFT`/`OPEN`/`RECEIVED`/`CANCELED`, that a
partial receipt stays `OPEN`, and that no PDF generator or mail-attachment capability exists. The
five-plan phase was documentation only: no code, schema, production data or configuration, email or
deployment change.

The audit-fix increment is §27KC: server-ranked AI price discovery with null-price exclusion and
inclusive ceilings, the full-upsert transfer retry, PO receive receipt replay after an
apply-then-throw finalize, explicit catalog PATCH clearing, archived-category refusal, idempotent
catalog creates and best-effort post-commit audit writes. The accompanying review ranks ten next
improvements and assesses the remaining transfer/receiving crash windows. Code and DB tests only;
no production data or deployment change.

FW-07 is §27KD: mobile-only copyable request references in the shared error state, sourced from a
safely validated `X-Request-ID` on every failed response. `ListScreen` and every direct
`ErrorState` caller expose it; form-level alerts remain a ranked follow-up. The increment also
records ten recommendations beyond the five plans. Mobile tests and typecheck passed; no server,
production data, configuration or deployment change.

The transfer-ledger hardening is §27KG: a unique partial operation/location index with a
preflight/quarantine migration, duplicate-key-safe recovery under a MongoDB lease shared across
serving instances, and a scheduler-facing operations runner with per-command locks and GitHub issue
alerts for the two read-only audits plus exact recovery. The complete DB suite passed 1,182 tests
with zero failures. No production migration, task registration, commit or deployment was made.

The three operational follow-ups are §27KH. `ops:integrity` now persists a failed GitHub create,
comment or close as an undelivered alert and retries it on the next `--notify` run; a recovery close
retry resumes at the close instead of duplicating its comment. `/api/health/ready` fails closed
unless the exact unique partial transfer-ledger index is present with the required key order,
uniqueness and filter, reading `listIndexes` without repairing anything. `triage:integrity` is the
read-only operator view of `REQUIRES_ATTENTION` journals and `inventory_transaction_quarantine`
rows, with reasons, snapshots and ledger evidence. Focused tests pass 38/38, unit mode 2,184 tests
with 0 failures, and the complete suite 3,231 of 3,233 after the full run exposed a stale AI-2
read-only allow-list; that test-only allow-list was corrected and its suite passes 10/10. No
production database, migration, commit or deployment was touched.

The 2026-11-20 follow-up closes the remaining alert-comment duplicate cases with a stable hidden
marker in the issue body and each alert/recovery comment: a retry whose response was lost and a
second scheduler host with separate history now read the issue before commenting, while an
unreadable issue stays pending rather than posting blind, and a pending close is not resumed
against a different issue number. Triage reads moved into a read-only module and gained a DB-backed
test that seeds a `REQUIRES_ATTENTION` transfer and quarantine row, checks the exact evidence and
proves every touched collection is unchanged. Focused tests pass 45/45, the complete server suite
3,244 of 3,244 in 529 suites with zero failures or skips, and the documentation guards 16/16. No production database, migration, commit or deployment was touched.

The required-currency and marketplace-accuracy increment is §27KJ: product create now requires an
ISO 4217 active-tender code, PATCH cannot clear it and cannot omit it on a legacy row with no valid
code, and the model repeats that rule while keeping old documents readable. The catalogue and every
seeder state `PHP` explicitly; the product API/UI labels cost and selling price separately while the
assistant keeps cost internal and carries selling price with the recorded currency;
`audit:product-currency` reports missing/invalid legacy codes without writing,
and resolution is a verified explicit PATCH. Market-price listings now carry the marketplace country,
the listing currency only when the page proves it, brand/model match evidence, the original price and
an optional ECB/Frankfurter-dated conversion; a bare `$` or unverified pair is never converted. The
mobile form now uses a searchable ISO picker (code and English name), with tests for search,
selection and legacy rows. A fresh diff review fixed malformed-code conversion attempts and removed
a duplicate seed mapping; ranked follow-ups are recorded but not implemented. The focused checks are
recorded in §27KJ; no production database, migration, commit or deployment was touched.

The post-commit reliability increment is §27KK: a test-only 503 raised after the movement service
returns proves the same-key retry replays one committed ledger row and leaves stock unchanged; a
scheduled pass and the dry-run-first `recover:movement-receipts` command recover only receipts
whose ledger row matches every movement field or whose exact inventory snapshot proves the move,
flag contradictions, prune only `COMPLETED` rows after 30 days and write recovery/prune audit
events without the idempotency key. The authenticated status route reports state and a support
reference only, and the mobile Pending Operations screen checks or retries stored requests without
displaying a raw key. Focused post-commit/idempotency **16/16**, receipt recovery **8/8** and mobile
idempotency **22/22** pass; no production data, migration, commit or deployment was touched. A
post-review batch-fairness pass selects stale unfinished receipts before attention rows, adds a
full-old-attention backlog regression, and covers the CLI and Pending Operations screen at 9/9
contract cases and 6/6 render cases respectively. The AUTH-03 capped-session fixture was made
TTL-safe and the complete server suite later passed 3,310/3,310 tests across 538 suites.

The currency-operations follow-up is §27KL: `GET /api/health` now publishes the existing
process-local exchange-rate availability snapshot under `exchangeRates`, while `/ready` and `/live`
remain unchanged and no-fallback conversion is untouched. The resolver command is injectable and
tested without a database, template mode warns when it is capped at 5,000 rows, dry-run remains the
default, and the `0/1/2` exit contract is covered. The phase record and suite citation are restored,
and 12 ranked currency/rate/price proposals are documented but not implemented. No production
data, migration, commit or deployment was touched.

The run-out follow-up is §27KM: a narrow `asksForStockCoverage()` detector plus one corrective re-ask
forces `getProductStockCoverage` before a run-out answer; Q7 now scripts the wrong `getProduct`
choice and proves the correction, while Q8 keeps null cover for no stock-out. A bounded,
opt-in six-paraphrase `eval:stock-coverage` harness records first/all tool choices on the current
configured model without changing model or CI configuration. Focused AI-118 unit **5/6 (DB suite
skipped)** and DB **8/9 (unit suite skipped)**, Phase 06 **14/14**, and the complete server suite
**3,311/3,311 across 538 suites** (0 failures, 0 skips, exit 0) passed. No live-model run, production
data, migration, commit or deployment was performed.

The release gate for §27KJ–§27KM is §27KN: one PR through the protected `main` workflow, with a
fresh review that added endpoint allowlisting for stored mobile retries. The complete server suite
passed **3,312/3,312 across 538 suites** and the complete mobile suite **1,333/1,333 across 114
suites**, both exit 0 with no failures or skips; server/mobile typecheck, focused ESLint and the
documentation checks passed. No production data, migration, live-model call or maintenance command
was touched by the verification. Render auto-deploy is scoped to `server/`, so the release PR is
the deploy trigger; merge and Render evidence are in the final release report.

The run-out follow-up is §27KO: Q7b proves a first draft with no tool call receives the single
coverage re-ask and then answers from `getProductStockCoverage`; Q7c proves a second miss stores
the exact ungrounded sentence; Q7 and Q8 remain intact. The approved six-paraphrase live run on
the configured `openai/gpt-oss-20b` selected coverage somewhere in **5/6** turns, first in **0/6**,
corrected one wrong-tool draft, left one corrected turn ungrounded, and exposed one turn where the
selected estimate was omitted from the answer. Phase 06 passed **16/16**; the run made no production
change and did not change model configuration.

The deployment follow-up is §27KP: `GET /health` and `GET /ready` are exact aliases of the existing
health handlers, and the route inventory moved to **126** routes / **33 public**. A read-only
`verify-production-deploy.mjs` and its `main`-push workflow now wait for the merged SHA before
checking readiness, liveness and `db: connected`; production `7d112cc` verified on the first attempt.
The one startup 5xx was reviewed and classified as a transient readiness/startup probe rather than a
genuine startup failure; the exact request path remains unproven because Render logs were not
available. No production write, commit or deployment was made.

The stock-coverage follow-up is §27KQ: a successful coverage read now produces a deterministic
answer with the days-of-cover estimate (or explicit no-rate outcome) and movement-proxy caveat;
`getProductStockCoverage` accepts an exact recorded name and refuses partial/duplicate names; and
`eval:stock-coverage` separates selected, succeeded and finalized/used coverage with a semantic
caveat judgement. Q7/Q8 remain intact; Q7d/Q7e cover missing estimates and caveats, and the
recorded live artifact was re-verified as 0/6 first, 5/6 anywhere, 1 correction, 0 errors and
$0.007846. AI-118 DB **9/9**, unit **5/5**, Phase 06 **18/18**, metrics **4/4**; no paid run, model
change, production data, commit or deployment was made.

The currency-hardening follow-up is §27KR: ordinary product PATCH now refuses a currency replacement
and the dedicated correction route requires a reason plus `priceReconfirmed: true` while recording
both codes; assistant price ceilings and rankings require one recorded currency, refuse
mixed/unrecorded groups and accept an explicit ISO code as scope; and failed FX lookups coalesce in
flight, negative-cache for 30 seconds with bounded exponential backoff and clear on success, keeping
the existing health counters and adding negative-cache/coalesced counts. Currency unit **17 pass / 1
skipped**, DB **8 pass / 3 skipped**, AI-45 DB **14 pass / 1 skipped**, Phase 23/docs guards
**41/41**, mobile typecheck and focused form suite **5/5**; no production data, commit or deployment
was made.

DEV-10 proves the workflow guard end to end with five temporary fixture repositories, groups
Dependabot security updates separately from routine updates for server, mobile and Actions, and
records a new ranked future roadmap; it is §27JZ. The original PR #355 passed all seven required
checks, but its branch drifted; the work was rebased onto current `main` and delivered through the
same seven-check gate. CI and configuration only, with no production change.
