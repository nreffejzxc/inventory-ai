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
(exact product identity and per-location stock answers) are recorded in §27HT but are not yet merged,
deployed or phone-verified, so they are not counted as delivered above. The earlier assistant increments cover the turn deadline,
retries, answer rendering, the cost line, quota, failover, streaming, and finally one provider
(OpenRouter). The
scale campaign measured the assistant and the list screens at 50 000–131 000 products (§27BX–§27DG),
and later records cover invitations (§27FB), account deletion (§27EW), the privacy policy and terms
(§27EV, §27FA), release notes (§27FE) and the V1 re-verification (§27FM).

The newest delivered records are not release-engineering ones: §27HQ records grounded answers, scoped
stock reads and the member's language; §27HR records the AI-48–AI-84 merge and deploy; §27HS is the
AI-50–AI-84 increment register. §27HT is the pending AI-91/AI-92 record. Release engineering remains in §27FN (EAS retention and the plan
gate on OTA signing), §27EZ (the production parity gate that stopped a store upload) and §27FK (the
runtime boundary that made a stale process impossible to mistake for a server fault).
