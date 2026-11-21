# Inventory AI — free-first follow-up opportunities

**Status:** planning assessment. The three assistant accuracy items below — coverage finalizer,
exact-name coverage resolution and deterministic proxy caveat — plus the evaluator's
selected/succeeded/used split were implemented in §27KQ. The remaining recommendations are
planning only; no paid service or production change is authorized. This is a follow-up to the
merged whole-product assessment, not a replacement for it.

**Reviewed:** 2026-11-17; post-deployment refresh 2026-11-20
**Funding constraint:** Inventory AI has no paying customers. The owner's current budget is already
committed to the coding agent and the OpenRouter gateway, with ordinary living costs alongside them.
Every recommendation below must be deliverable with **$0 incremental recurring spend** and existing
free tiers. Paid services are explicitly deferred, even where they would be simpler.

**Basis:** the complete conversation and decision history, the live console, the merged access,
monitoring and whole-product assessments, the AI roadmap, the vault/restore tooling, and the current
free-only operating boundary.

## 1. What this adds — and what it does not

The existing [`INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md`](INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md)
already ranks 18 items (`IA-01`–`IA-18`). This page does **not** re-rank or duplicate them.

It adds opportunities that are not already represented:

| New ID | Opportunity | Why it is not a duplicate |
| --- | --- | --- |
| IA-19 | Backup fidelity: index and collection-option manifest | IA-04 covers the restore drill; this closes the specific data-only-backup gap the drill exposes |
| IA-20 | Firebase identity outage and recovery drill | No existing item covers identity-provider unavailability or a Firebase recovery exercise |
| IA-21 | Auth-email deliverability and bounce monitoring | Existing monitoring covers server/API health, not Brevo delivery or reset-code receipt |
| IA-22 | AI conversation retention, redaction and owner-review controls | IA-18 covers data lifecycle broadly; this is the AI-content-specific privacy boundary |
| IA-23 | Mobile offline/read-only resilience | No existing item covers a phone that loses connectivity during an inventory task |
| IA-24 | Free-tier provider quota/cost watch | IA-05 covers AI model spend; this covers Render/Atlas/Brevo/Firebase free-tier limits |
| IA-25 | First-customer onboarding and trial-readiness checklist | IA-09 covers the store release; this covers the first-run/support journey after install |
| IA-26 | Accessibility and localization QA pass | The design system and language work exist, but there is no recurring free QA gate |
| IA-27 | SBOM and dependency provenance snapshot | Dependency decisions exist; artifact/SBOM traceability is not covered |
| IA-28 | Tenant health/adoption insights without tenant detail | The console is aggregate-only; this is a privacy-safe product signal, not a tenant drill-down |
| IA-29 | Data-residency/compliance decision record | No existing item records where data may live or what future customers must be told |

Deliberately excluded because they duplicate existing work: access (`IA-01`), alert ownership
(`IA-02`), audit export (`IA-03`), AI budget (`IA-05`), support grants (`IA-07`), release readiness
(`IA-09`), mobile crash telemetry (`IA-11`), AI evaluation (`IA-15`), retention/deletion (`IA-18`),
ticket SLA/incident routing (`CI-13`/`CI-14`), and the Cloudflare/restore plans delivered alongside
this page.

## 2. Free-first rules for every new item

1. **No new subscription, paid tier, domain purchase, pager, log-retention add-on or managed
   database plan.** Use existing Render, Atlas M0, Brevo, Firebase, GitHub Actions/UptimeRobot free
   tiers and the owner's current tools.
2. **No free-tier abuse.** Respect provider limits; do not create multiple accounts to evade quotas,
   and do not use a trial that will expire into an unplanned charge.
3. **No security compromise disguised as thrift.** Free does not mean accepting a public console,
   shared admin identity or unverified restore. If a free option cannot meet the control, the item is
   deferred or explicitly accepted, not silently weakened.
4. **Prefer code/process over new infrastructure.** A local script, a GitHub issue, a documented
   runbook or an existing free dashboard is preferred to a new vendor.
5. **Measure the free limit.** Record the quota, the observed usage, the failure mode and the
   threshold at which the owner must revisit funding.
6. **Paid is a later decision.** A recommendation may name a paid upgrade as a future option only
   when the free fallback is stated and the paid path is clearly deferred.

## 3. Ranked additions

Ranking uses business value, security impact, reliability impact, effort and the free-first rule.
`Cost` means incremental recurring cost, not engineering time.

| Rank | ID | Opportunity | Business | Security | Reliability | Effort | Cost | Why this rank |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **IA-19** | Index/collection-option manifest for backups | H | H | H | M | **$0** | A document-only restore can look complete while indexes/validators are missing. This is a direct recovery gap the drill will expose, and it is fixable in code without a service. |
| 2 | **IA-20** | Firebase auth outage/recovery drill | H | H | H | M | **$0** | If Firebase is unavailable, sign-in and new sessions fail; there is no tested provider-outage runbook or identity export. The app cannot be considered recoverable without it. |
| 3 | **IA-21** | Auth-email deliverability and bounce watch | H | M | H | S/M | **$0** | Password-reset and verification codes are useless if Brevo delivery silently degrades. A free daily count/bounce report catches onboarding failure before a customer reports it. |
| 4 | **IA-22** | AI conversation retention/redaction controls | M | H | M | M | **$0** | Feedback and answer previews can retain sensitive business text. The owner needs a retention/redaction rule and a bounded review path that is not a standing tenant-detail window. |
| 5 | **IA-23** | Mobile offline/read-only resilience | H | L/M | H | L | **$0** | A phone losing signal during stock work is a real operational failure. A read-only cache and honest offline state improve reliability without new infrastructure. |
| 6 | **IA-24** | Free-tier quota/cost watch | M | L | H | S/M | **$0** | Free Render/Atlas/Brevo/Firebase limits can become outages or surprise charges. A manual weekly quota check is free and catches the first ceiling. |
| 7 | **IA-25** | First-customer onboarding/trial checklist | H | M | M | M | **$0** | The store release is only the front door. A first-run checklist, support handoff and data-import expectation reduce failed onboarding before paying users exist. |
| 8 | **IA-26** | Accessibility/localization QA pass | M | L | M | M | **$0** | The app already supports local languages and a design system; a recurring manual/a11y check prevents regressions without a paid tool. |
| 9 | **IA-27** | SBOM and dependency provenance snapshot | M | M | M | S/M | **$0** | A generated SBOM and lockfile/provenance record make a future incident review faster; it uses free local tooling and repository storage. |
| 10 | **IA-28** | Privacy-safe tenant health/adoption signals | M | M | L/M | M | **$0** | Aggregate activation/usage signals can guide the product without a tenant selector, preserving the current no-detail boundary. |
| 11 | **IA-29** | Data-residency/compliance decision | L now | M | L | S | **$0** | A written decision is free and prevents accidental provider sprawl; it becomes customer-relevant only when real data arrives. |

### Priority tiers

- **Do before inviting real customers:** IA-19 (restore fidelity), IA-20 (identity outage), IA-21
  (auth email), IA-22 (AI retention), IA-25 (onboarding).
- **Do while improving reliability:** IA-23 (offline), IA-24 (free-tier quotas), IA-26 (a11y/localization).
- **Do when the team or evidence need grows:** IA-27 (SBOM), IA-28 (privacy-safe signals), IA-29
  (residency decision).

### 2026-11-20 post-deployment refresh — new candidates and revised order

This refresh extends, rather than replaces, the existing 29-item product list and the assistant
roadmap. The new candidates use `PD-01`–`PD-04` so they cannot collide with the later `IA-19`–`IA-45`
ranking. The three assistant accuracy items and the evaluator split are implemented in §27KQ; the
remaining recommendations are not. The read-only release check named under PD-03 exists from the
deployment work but is not yet a required gate.

| Rank | Improvement | New? | Value | Dependency / guard |
| ---: | --- | --- | --- | --- |
| 1 | **Deterministic coverage answer/finalizer.** **Implemented 2026-11-20 (§27KQ).** Build or verify the answer from the coverage payload, and reject a response that selected coverage but omits the estimate. | Existing AI priority | The 2026-11-20 live run found a turn that selected the coverage tool but never showed its result. A finalizer makes the evidence the answer instead of a suggestion to the model. | Existing `forecast`/availability payload; no new model call. |
| 2 | **Name-resolving one-call coverage route.** **Implemented 2026-11-20 (§27KQ).** Accept an exact product name with ambiguity refusal, or resolve it server-side before calling coverage. | Existing AI priority | The same run selected coverage first on **0/6** name questions because the tool accepted only id/SKU/barcode; the search-first workaround cost calls and seconds. | Existing product resolver and coverage service; never resolve a name on the client. |
| 3 | **Catalogue-wide run-out ranking.** One bounded aggregate over ACTIVE products with a minimum-movement rule and an explicit stock-out proxy. | Existing AI priority | Answers “what will run out first?” as an operational list without N+1 reads or invented seasonality. | A business-wide aggregation and a fixed movement window; no lead-time guess. |
| 4 | **PD-01 — Answer provenance and scope envelope.** Every assistant answer states the data as-of time, business/location scope, currency basis, tools read and any limitation, in addition to today's support `Ref:`. | **New** | Makes a plausible answer auditable: a member can see what was read and what was not, and support can distinguish a stale scope from a wrong number without replaying the turn. | A response envelope and mobile rendering; store only the same bounded metadata as the turn record. Never expose another tenant's scope. |
| 5 | **PD-02 — Pre-answer data-quality gate.** Before a price, stock-value or coverage answer, detect unresolved product currency, missing prices/costs and missing inventory rows, and label the answer incomplete rather than omitting the gap. | **New** | The assistant is read-only but confident; an unresolved currency or absent price can turn an otherwise correct total into a misleading one. This reuses the existing read-only audits and makes the limitation explicit. | Existing `audit:product-currency`, price-quality reads and tool payloads; no inferred currency and no write path. |
| 6 | **Deterministic stock-out proxy caveat.** **Implemented 2026-11-20 (§27KQ).** Append the sales/usage/damage/write-off caveat whenever a coverage estimate is present without it. | Existing AI priority | Only one of five grounded live answers stated the proxy; prompt wording alone did not hold. The caveat is part of the meaning of “days of cover”, not optional copy. | Existing answer finalizer; no schema change. |
| 7 | **PD-03 — Make deployment verification a required release gate.** Keep the new read-only SHA/readiness verifier, but make a failed `main` verification block or explicitly flag the release, and route repeated failures to the existing alert owner. | **New follow-up; verifier exists** | The script proves the build after the fact, but a failed workflow that nobody watches is still a stale-build risk. A required check or alert turns the evidence into a release control. | A repository branch-protection/required-check decision and an owner; no deploy automation or rollback. |
| 8 | **Two-product and current-versus-minimum comparison.** One scoped read/finalizer labels both sides, missing fields and the comparison basis. | Existing AI priority | Removes the last common model-composed arithmetic shape and keeps currencies separate. | Existing product, availability and `unitsBelowMinimum` reads; verified rate only for cross-currency display. |
| 9 | **Repeated bounded selection ledger.** **Metric split implemented 2026-11-20 (§27KQ); repeat runs remain.** Record selected/succeeded/finalized-used tool choice, correction outcome and latency across repeat runs without putting paid calls in CI. | Existing AI priority | One six-question run cannot establish a trend; a repeatable ledger would show whether the coverage repairs actually work. | The existing harness and turn records; explicit approval for live calls and no production model change. |
| 10 | **PD-04 — Unit-of-measure and pack metadata.** Record whether a product is stocked in pieces, boxes, cases or weight, with an explicit conversion and display unit. | **New** | “How many boxes?” currently has no authoritative answer; the assistant and stock totals can silently treat packs as pieces. This is a data-model improvement that prevents a whole class of plausible wrong answers. | Product schema, import/export, stock movements and mobile display; migration with historical rows left unknown, never relabelled. |

**Why this order.** The first three items were the assistant accuracy tranche supported by the
live run and are now implemented: selection and use of the coverage evidence came before adding
more answer shapes. PD-01
and PD-02 are the trust controls that make every later answer auditable; PD-03 is the release control
that makes the deployment fact checkable. Comparison, repeated evidence and unit metadata follow
because they need a product/data decision or a larger schema. Existing supplier/PO-aware restock,
search within a previous answer, confirmed stock-out reason and scheduled digest remain valid
candidates below this top ten.

**Explicitly not proposed here:** a write-capable assistant, automatic currency conversion without a
verified dated rate, a tenant-detail support window, a paid pager/observability service, or a model
change made to improve an evaluation score. Those cross the read-only, privacy or free-first
boundaries recorded elsewhere.

### 2026-11-21 stock-coverage refresh — ranked remaining candidates

Scope: the complete server unit and DB suites were run against the §27KQ stock-coverage tree, and
the coverage tool, its tests and the earlier live audit were reviewed. Nothing below is
implemented. Ranking uses operational value, evidence quality, effort and the free-first rule;
**New** means the candidate is not already recorded in this file or the AI roadmap.

| Rank | Candidate | New? | Value | Dependency / guard |
| ---: | --- | --- | --- | --- |
| 1 | **Coverage evidence and confidence gate.** Require a minimum number of stock-out movements (and active movement days) before a precise estimate, otherwise return `insufficient evidence` or a low-confidence range. | **New** | A single stock-out currently produces a confident-looking `daysOfCover`; an evidence gate stops one damage write-off from becoming a purchasing decision. | Existing coverage payload and window; no new collection. State the threshold and the refused case in the answer. |
| 2 | **Days-to-minimum and reorder trigger.** Report days until stock reaches the recorded `minimumStock`, plus the current units below minimum, alongside days to zero. | **New** | “When do I need to reorder?” is the operational question; days-to-zero alone arrives after the reorder point. Uses a field the product model already has. | Existing `minimumStock` and availability; no schema change. Still a movement proxy, not lead-time-aware. |
| 3 | **Catalogue-wide run-out ranking.** One bounded aggregate over ACTIVE products with a minimum-movement rule and an explicit stock-out proxy. | Existing AI priority | Answers “what will run out first?” as a ranked operational list without N+1 reads or invented seasonality. Highest day-to-day value of the remaining items. | Business-wide aggregation over a fixed window; guard the product cap and never present a zero-movement product as infinite cover. |
| 4 | **Stockout-censored demand correction.** Account for days when available stock was zero; otherwise the observed outflow understates demand and overstates cover. | **New** | A product that was empty for half the window looks slow-moving. Expose a corrected upper bound or a lower-confidence label instead of a precise estimate. | Needs stock-level history or reliable zero-stock reconstruction; keep the uncorrected number visible when the correction is speculative. |
| 5 | **Outlier-resistant estimator.** Trim or flag one-off bulk issues, damage and write-offs, and compare the two halves of the window to detect accelerating or decelerating demand. | **New** | One large issue can dominate a 30-day average. A trimmed rate and a half-window comparison make the estimate honest without a forecasting model. | Existing movement rows; state the trim rule and show the excluded events rather than hiding them. |
| 6 | **Intermittent-demand handling.** Classify slow movers with ADI/CV² or a Croston-style estimate instead of a simple daily average. | **New** | One sale in 30 days currently yields hundreds of days of cover, which reads as “no risk”. Intermittent-demand treatment prevents that false comfort. | Pure computation over the existing movement window; no new dependency required. Label the method used. |
| 7 | **Transfer-aware location coverage.** For a location-scoped product, show availability at the business's other locations and a read-only transfer opportunity. | **New** | A location can appear out of stock while the same business holds the product elsewhere; today the answer omits that context. | Existing per-location stock reads; no automatic transfer and no cross-tenant data. Respect the member's location permissions. |
| 8 | **Coverage outcome ledger and backtesting.** Record redacted inputs and estimates for coverage answers, then compare them with later actual stock-outs to calibrate confidence. | **New** | There is no evidence today that a 14-day estimate is accurate. A local, free ledger turns future runs into calibration evidence instead of another one-off sample. | Turn records plus a scheduled comparison; no paid service, no production model change, and no tenant-identifying export. |
| 9 | **Supplier/PO-aware restock.** Include supplier lead time, inbound purchase-order ETA and minimum order quantity in a restock recommendation. | Existing AI priority | Days of cover is only actionable next to when replenishment can actually arrive. | Supplier and purchase-order data must be recorded and scoped first; recommendations stay read-only. |
| 10 | **Controlled stock-out reason codes.** Distinguish sale, internal usage, damage and write-off when recording `STOCK_OUT`. | Existing AI priority | Would turn today's movement proxy into actual demand and make every estimate above more trustworthy. | Product/movement schema, mobile and web entry work; historical rows stay unknown and must never be relabelled. |

**Why this order.** Evidence quality comes first: ranks 1, 4, 5 and 6 all make the existing
one-product estimate less misleading without adding a new answer shape, and rank 2 answers the
question members actually act on. The catalogue-wide ranking (3) is the highest-value new shape but
should ship after the per-product estimate has an evidence gate. Ranks 7–10 need broader data or
schema work and remain planning only.

**Small later quick win.** Render the projected run-out date in the business's local calendar next
to `daysOfCover`; it is presentation-only and must use the recorded timezone, not the server's.

## 4. Details

### IA-19 — Backup fidelity: index and collection-option manifest

**Opportunity.** Extend the existing data-only backup with a read-only metadata file that records
collection options, validators and index definitions, and verify it during restore. This closes the
gap identified in [`PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md`](PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md):
the current manifest proves document bytes, not a complete database.

**Why it matters.** A restore can insert every document and still be unusable or untrusted because a
unique index, partial index or validator is absent. The current drill must rebuild indexes manually
and fails if the rebuild is not proven. This is a recovery-integrity issue, not a performance polish.

**Free approach.** Add metadata to the existing manifest and a verification step in the existing
`backup:db`/`restore:db` scripts; use the model index inventory already in the repo. No new service.

**Acceptance.** A backup of a fixture with a unique/partial index and a validator restores the data,
the metadata, the indexes and the validators; a missing/different index fails the drill with the
database untouched until verification completes.

### IA-20 — Firebase identity outage/recovery drill

**Opportunity.** Document and exercise what happens when Firebase Authentication is unavailable,
misconfigured or compromised: existing-session behavior, sign-in failure copy, recovery contact,
project/account recovery, and the path to restore identity service. Include a bounded export of
identity linkage data if Firebase supports it on the current plan, without exporting passwords.

**Why it matters.** Firebase is the identity provider; a provider outage can block every new login
and session exchange even when the API and MongoDB are healthy. The current health checks cannot see
this dependency. A local session may continue until expiry, but the support path is undefined.

**Free approach.** A tabletop drill against a disposable Firebase project or an isolated local stub;
a written runbook; no paid identity tier. Do not simulate an outage against production.

**Acceptance.** The owner can state the detection signal, user-facing message, support response,
recovery owner and maximum acceptable identity outage; a test proves a signed-in session degrades
honestly and a new sign-in fails with a bounded message rather than a crash.

### IA-21 — Auth-email deliverability and bounce watch

**Opportunity.** A free daily summary of verification/reset/invitation sends, provider errors and
bounces, with a threshold that opens a GitHub issue or emails the owner. Use the existing Brevo
account and server logs; do not add a paid email vendor.

**Why it matters.** The app depends on six-digit codes for verification and recovery. A silent
deliverability failure looks like “the app is broken” at the worst possible moment, and a reset email
that never arrives can strand a user.

**Free approach.** Parse existing send results/log counters, check the free Brevo dashboard weekly,
and use the existing GitHub issue/UptimeRobot channel. Never log the code or recipient address.

**Acceptance.** A failed/suppressed send is visible in a bounded count; a synthetic bad-recipient run
in a non-production environment produces the alert; no code, address or message body is logged.

### IA-22 — AI conversation retention, redaction and owner-review controls

**Opportunity.** Decide how long AI turns/feedback are retained, what is redacted before owner review,
and how a member can request deletion. Keep the current aggregate console and the bounded feedback
preview; do not add a standing tenant-detail window.

**Why it matters.** Prompts and answers can contain product names, prices, supplier details or
personal text. The assistant is read-only, but retention and owner review still create a privacy
boundary. IA-18 covers general data lifecycle; this is the AI-content-specific control.

**Free approach.** Existing MongoDB TTLs and code-level redaction; an owner-run retention job or
documented manual review; no paid DLP service.

**Acceptance.** A documented retention period, a redaction list, a deletion path, and a test proving
the owner preview cannot expose fields outside the approved boundary.

### IA-23 — Mobile offline/read-only resilience

**Opportunity.** When the phone has no network, show a last-known read-only inventory/dashboard state
with a clear “offline, not live” label, and refuse writes rather than queueing them silently. Do not
add background sync or write queues without a separate approved design.

**Why it matters.** Stock work happens in poor-signal areas. A blank screen or a silent failed write
is worse than an honest stale read; a write queue would add conflict and duplicate-ledger risk.

**Free approach.** Cache only the existing read models on the device; reuse the current API/cache
patterns; no new service.

**Acceptance.** Airplane-mode run shows the last-known data with a timestamp, writes are disabled with
a clear message, reconnect refreshes, and stale data is never presented as live.

### IA-24 — Free-tier quota/cost watch

**Opportunity.** A weekly free-tier check for Render instance hours/bandwidth, Atlas M0 storage,
Brevo send limits and Firebase quotas, with a small record and an owner action threshold. This is not
the AI token budget (IA-05); it covers the platform providers.

**Why it matters.** A free-tier ceiling can look like a code outage, and an overage can create an
unexpected bill. Inventory AI cannot afford surprise spend.

**Free approach.** Existing provider dashboards, a calendar reminder and a short log entry. Do not add
a paid observability vendor.

**Acceptance.** The owner can state current usage, the next limit, the expected failure mode and the
action at 80%/100%; a dry-run check is recorded weekly.

### IA-25 — First-customer onboarding and trial-readiness checklist

**Opportunity.** Define the first-run journey after install: sign-in/verification, business setup,
first location/product/stock-in, invite a teammate, assistant first question, support contact and
data-import expectations. Include a “what happens if email is delayed” path.

**Why it matters.** The Play release is planned, but a store install is not a successful onboarding.
The first customer will expose gaps that no amount of feature work fixes without a checklist.

**Free approach.** A written checklist, a test account, a manual support script and existing app
screens; no paid onboarding tool.

**Acceptance.** A fresh account completes the checklist on an installed build with no developer
intervention beyond the documented steps; every failure has an owner and a support sentence.

### IA-26 — Accessibility and localization QA pass

**Opportunity.** A recurring manual check of the main screens at large text, screen reader labels,
contrast and the supported languages, using free platform tools. Keep the existing design tokens and
language rules.

**Why it matters.** Inventory work is often done one-handed in a busy environment; accessibility and
language regressions are business usability, not polish. The project already invested in a design
system and Bisaya/Tagalog answers; this protects that investment.

**Free approach.** Android accessibility scanner/TalkBack, iOS simulator where available, manual
review and the existing language fixtures; no paid audit.

**Acceptance.** A dated checklist covers the main journeys, records defects with owners, and reruns
on release candidates; no new paid vendor.

### IA-27 — SBOM and dependency provenance snapshot

**Opportunity.** Generate a software bill of materials for server and mobile dependencies and keep a
dated snapshot with the lockfiles. Record the provenance of release artifacts where the free tooling
supports it.

**Why it matters.** The project already tracks residual advisories. An SBOM makes the next dependency
incident and store/release audit faster, especially when the owner is the only responder.

**Free approach.** Local package-manager/SBOM tooling and a repository record; no paid supply-chain
service. Do not upload private source to a third party without an owner decision.

**Acceptance.** A generated SBOM matches the lockfiles, is dated, contains no secrets, and a known
package can be traced to its declared version and advisory decision.

### IA-28 — Privacy-safe tenant health/adoption signals

**Opportunity.** Add aggregate activation/usage signals (for example: businesses with at least one
product, first stock-in completed, assistant used in the last 7 days) without a tenant selector,
names, emails or product data. Use them to guide onboarding, not surveillance.

**Why it matters.** The current console is deliberately aggregate-only. The owner needs to know
whether onboarding works before spending on acquisition; a privacy-safe aggregate is enough for that
decision.

**Free approach.** Existing operations aggregates and a small set of counts; no new analytics vendor.

**Acceptance.** The report has no tenant/member identifier, no small-cell disclosure that identifies a
business, and a written definition for each signal.

### IA-29 — Data-residency and compliance decision record

**Opportunity.** Write down where production data lives (Render region, Atlas region, Brevo,
Firebase/OpenRouter flows), what leaves the region, and what a future customer will be told. Revisit
when a real customer or contract requires it.

**Why it matters.** Provider sprawl is easy on free tiers; a later enterprise question becomes a
migration if it is not recorded now. A decision record is free and prevents accidental architecture.

**Free approach.** A dated document and provider-region review; no legal subscription.

**Acceptance.** The record names each provider/region, the data category, the transfer path and the
owner decision; it distinguishes current facts from future requirements.

## 5. What stays paid and deferred

These are **not approved** and should not be started while there is no revenue:

- A purchased domain solely for Cloudflare Access (use an existing domain if one exists; otherwise
  defer the Access migration).
- Cloudflare paid log retention/Logpush.
- Tailscale Standard for commercial use (the free Personal plan is non-commercial and is not an
  acceptable business licence).
- Render Scale/Enterprise for inbound IP rules ($499/month plus compute).
- A paid pager/on-call service.
- A paid Atlas backup tier or object-storage archive.
- A paid observability, DLP, email-deliverability or analytics vendor.
- A paid identity provider.
- A paid support/helpdesk platform.

Each can be reconsidered when there is recurring revenue, a contractual requirement or a measured
free-tier ceiling that blocks essential security/reliability.

## 6. Free-first sequence

### Now / before first customer

1. Finish the restore drill and close the index/collection-option gap (IA-19).
2. Write and tabletop the Firebase outage/recovery runbook (IA-20).
3. Add the free auth-email watch (IA-21).
4. Set the AI retention/redaction rule (IA-22).
5. Run the first-customer onboarding checklist (IA-25).

### Next / while still free

6. Mobile offline/read-only (IA-23).
7. Weekly free-tier quota watch (IA-24).
8. Accessibility/localization QA (IA-26).

### Later / when evidence or team grows

9. SBOM snapshot (IA-27).
10. Privacy-safe adoption signals (IA-28).
11. Data-residency decision (IA-29).

This sequence is a recommendation only. It does not authorize code, database, configuration or
production work.

## 7. Sources

- Whole-product assessment and existing 18-item ranking:
  [`INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md`](INVENTORY_AI_IMPROVEMENT_ASSESSMENT.md).
- Cloudflare free-tier and domain constraint:
  [`PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md`](PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md).
- Alert ownership and free channels:
  [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).
- Restore/index gap:
  [`PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md`](PLATFORM_DATABASE_RESTORE_DRILL_PLAN.md).
- AI roadmap: [`AI_ASSISTANT_IMPROVEMENT_ROADMAP.md`](AI_ASSISTANT_IMPROVEMENT_ROADMAP.md).
- Auth/security invariants: [`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md).
