# Platform access layer — assessment and decision brief

**Status:** **PLANNING AND RESEARCH ONLY.** This document does not authorize a production configuration
change, a code change, a deployment, a domain purchase or a new paid service. The live console
remains on the current application-level gate.

**Reviewed:** 2026-11-17
**Scope:** The live `/platform` console and `/api/platform` plane on the Render web service.
**Question:** Is there a free or low-cost access layer that materially reduces public reachability
beyond the existing `PLATFORM_ACCESS_KEY` gate, and which option should be piloted first?

## 0. Free-first decision

**Incremental budget: $0.** Inventory AI has no paying users, and the owner's current budget is fully
committed. No domain may be purchased, no Render plan may be upgraded and no paid pager, log tier or
identity service may be started for this work.

This changes the recommendation from “implement Cloudflare Access” to:

- **Keep the current free gate and platform MFA.** They are already deployed and cost nothing.
- **Cloudflare Access remains the preferred design only if a controlled domain already exists.** Its
  free plan covers up to 50 users, but the domain is a prerequisite; if no domain is already owned,
  the migration is **deferred**, not funded.
- **Do not use a free subdomain you do not fully control for administrator security.** A free
  subdomain whose DNS/NS control is incomplete cannot be treated as a Cloudflare zone or a reliable
  prod origin.
- **Tailscale Personal is not eligible** for commercial use, and the paid Standard/private-service
  design is deferred.
- **Render IP rules are not eligible** because web-service rules require Scale/Enterprise.
- **Free baseline work continues:** keep the gate, recovery codes, TOTP/WebAuthn and console
  monitoring; use the free alert channels in
  [`PLATFORM_SECURITY_ALERT_DECISION_SHEET.md`](PLATFORM_SECURITY_ALERT_DECISION_SHEET.md).

The detailed migration remains in
[`PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md`](PLATFORM_CLOUDFLARE_ACCESS_IMPLEMENTATION_PLAN.md),
marked conditional on an existing domain and a separately approved code change.

## 1. Current state

| Control | What is true today | What it does not do |
| --- | --- | --- |
| Render URL | The API and console are served at `https://ai-inventory-l1mi.onrender.com` on a Hobby/free web service. | It is reachable from the public internet. Render Hobby cannot attach inbound IP rules to a web service. |
| Outer gate | `platformAccessGate` requires HTTP Basic for the browser and `X-Platform-Access-Key` for Bearer API clients. | It is one shared secret, not a per-person identity; it is not a network boundary. |
| Platform login | Password + mandatory TOTP/WebAuthn, HttpOnly session cookie, CSRF and exact-origin checks. | It is the application authentication boundary, not an edge access layer. |
| Recovery | Forced recovery-code ceremony and a guarded break-glass CLI are live. | Recovery does not reduce anonymous reachability. |
| Monitoring | Health checks, an audit trail and a read-only console view exist. | No edge access log or platform-security alert pipeline exists yet. |

The gate is useful defense in depth and should stay during any transition. It does not satisfy the
readiness requirement for an additional access layer by itself.

## 2. Constraints and decision criteria

1. **Free or low-cost first.** No new recurring paid service without an explicit owner decision.
2. **Identity is better than a shared secret.** Prefer per-person SSO or device identity, not another
   key posted in a chat.
3. **The Render origin must remain protected.** A control that only protects a hostname while the
   default `onrender.com` URL still serves the app is not sufficient.
4. **Browser and machine clients both need a path.** The console is browser-based; API smoke and
   monitoring clients use headers.
5. **Recovery must remain possible.** A misconfigured access layer must not create a new permanent
   lockout.
6. **The tenant API must not be disrupted.** The platform plane may be protected separately; tenant
   mobile traffic must keep working.
7. **Keep the existing application authentication.** Access is an outer gate, not a replacement for
   the administrator password, TOTP/WebAuthn, session checks or capability model.
8. **Operational cost includes attention.** A solution requiring a new private-network refactor or a
   second control plane is not free just because its list price is zero.

## 3. Options at a glance

Prices and limits below were checked against the vendors' public pages on 2026-11-17. They can
change; confirm at purchase time.

| Option | List cost | Identity model | Fit with the current Render service | Origin-bypass protection | Assessment |
| --- | --- | --- | --- | --- | --- |
| Keep the existing `PLATFORM_ACCESS_KEY` gate | $0 | Shared secret | Already deployed | None beyond the application gate | Keep as defense in depth; not the missing access layer |
| **Cloudflare Access** | **$0 for up to 50 users**; $7/user/month beyond that; **domain must already exist** — no purchase under the current budget | SSO/OTP identity, per-application policies, service tokens | Good after adding a custom domain; the Render origin can remain a public service | **Needs origin JWT validation**; hostname-only Access is bypassable through the default Render URL | **Preferred design only if a controlled domain already exists; otherwise deferred** |
| Tailscale | Personal free for **non-commercial use**, up to 6 users; Standard **$8/user/month** for business | Device/tailnet identity and ACLs | Poor for the current single public web service | Strong only if the platform is moved to a private Render service | Future option, not the first choice |
| Render inbound IP rules | Scale workspace **$499/month + compute**; Enterprise custom | Network allowlist, not user identity | Directly supported only on Scale/Enterprise | Strong when the allowlist is correct | Not low-cost; only if Scale is already justified |
| Cloudflare Tunnel alone | $0 for standard tunnels | None by itself | Does not remove the Render public URL | Only protects an origin with no public route; not the current shape | Adjunct, not a complete answer |

## 4. Cloudflare Access

### 4.1 Why it is the preferred pilot

Cloudflare Access is an identity-aware proxy for a hostname. An Access application is deny-by-default;
a user must match an Allow policy, and the identity provider can be Google, another OIDC/SAML provider
or a one-time PIN. It can be limited to the exact `/platform` and `/api/platform` host/path, with a
separate service-token policy for machine clients. That is a real improvement over a shared Basic
key: the outer door can be tied to a named person or group and the decision is logged at the edge.

The current Cloudflare plan page lists **Free: $0, 50 users** and **Pay-as-you-go: $7 per user per
month**. The Access product documentation describes self-hosted public applications, identity
providers, application tokens and service tokens. Cloudflare's free plan has **up to 24 hours of
standard log retention**; longer retention or Logpush is a paid/contract capability. That matters for
the security-monitoring plan: Access alone is not a durable audit store.

### 4.2 What it would take

1. **A domain in Cloudflare.** Access requires an active Cloudflare zone (or a supported custom
   hostname setup). The current `onrender.com` hostname is not a zone the project controls. A domain
   is an owner purchase or an existing domain; it is not a code change.
2. **A Render custom hostname.** Add a platform hostname to the Render service, complete Render's
   domain verification, and point a proxied Cloudflare CNAME at the Render target. Keep tenant API
   hostnames separate or deliberately included; do not accidentally put the whole tenant API behind
   the console policy.
3. **An Access application and policy.** Deny by default, allow only the named administrator
   identity/group, set a short session duration, and require a second factor or a strong IdP policy.
   Create a service-token policy for the API smoke/monitoring caller rather than sharing a human
   identity.
4. **Origin validation — a future code change.** Cloudflare documents that an origin must validate
   the `Cf-Access-Jwt-Assertion` token when it is publicly routable; otherwise a caller who reaches
   the Render `onrender.com` URL can bypass Access. The application would need to verify the token
   against the team's published keys, audience and issuer on `/platform` and `/api/platform`, while
   leaving `/api/health` public for the uptime watchers. This is mandatory for the option to be a
   real boundary; it is not implemented by this assessment.
5. **Configuration and origin updates.** Update `PLATFORM_CONSOLE_ORIGIN`, `PLATFORM_API_ORIGIN`,
   `PLATFORM_WEBAUTHN_ORIGIN` and `PLATFORM_WEBAUTHN_RP_ID` for the chosen hostname; verify the
   `SameSite=Strict` cookie still works, the CORS allow-list is exact, and a real browser completes
   TOTP/WebAuthn after the origin change. The current WebAuthn origin was set for the Render host;
   changing the host is a security-sensitive migration, not a DNS-only change.
6. **Transition and rollback.** Keep the Basic gate and platform login during the pilot. Test the
   direct `onrender.com` path, a missing Access cookie, a wrong-audience token, an unauthorized
   identity and a valid service token. Record a rollback that removes the Access DNS record/policy
   and returns to the current gate without locking out the only administrator.

### 4.3 Security and operational benefits

- Named identity and group policy at the edge, before the application login.
- A managed Access session and a central place to revoke access.
- Access logs provide an independent edge signal for the monitoring plan.
- Service tokens let automated clients stay distinct from the human administrator.
- The tenant API can remain public; only the platform hostname/paths are protected.

### 4.4 Risks and limitations

- **Origin bypass is the main risk.** Access protects a hostname, not a public Render service. Without
  origin JWT validation or a network allowlist, the control is cosmetic against a caller who knows
  `onrender.com`. Render free cannot provide the network allowlist.
- **The free plan's 24-hour log retention is not enough for an incident review.** The monitoring plan
  must export or use a paid retention tier if Access is adopted.
- **A domain and DNS are prerequisites.** Domain cost, DNS ownership and TLS verification are owner
  actions. Cloudflare's partial/CNAME setup has extra DNS steps.
- **Cloudflare becomes a dependency.** An account compromise, policy mistake or Cloudflare/IdP outage
  can affect access. Protect the Cloudflare account with strong MFA and a recovery path.
- **The origin change affects WebAuthn and cookies.** Plan a controlled cutover and test the browser
  flow; a hostname-only test is not enough.
- **No support SLA on the free tier.** Treat it as an operational dependency, not a 24/7 vendor
  guarantee.
- **Not a replacement for application MFA.** Keep the separate platform identity, recovery codes and
  break-glass process.

### 4.5 Cost sketch

| Item | Estimated cost | Notes |
| --- | --- | --- |
| Cloudflare Access, up to 50 users | **$0** | Free plan; 24-hour log retention |
| Access beyond 50 users | $7/user/month (billing terms vary by page) | Not expected for this operator group |
| Domain | **$0 only if already owned** | Not purchased under the current budget; if no controlled domain exists, the Access migration is deferred |
| Render custom domain | $0 on the current service | Render supports custom domains; TLS is managed |
| Implementation effort | Medium | DNS/domain, Access policy, origin JWT validation, WebAuthn/origin migration, tests |

## 5. Tailscale

### 5.1 Commercial eligibility

Tailscale's Personal plan is free, allows up to 6 users and unlimited user devices, and is explicitly
described by Tailscale as **for non-commercial use**. A tailnet created with a business/custom domain
is treated as business use. The paid Standard plan is **$8 per user per month** (Premium $18).
Therefore, **the free Personal plan is not an acceptable licensing basis for Inventory AI's
commercial administration**, even if the user count fits. Budget Standard if this path is pursued.

### 5.2 Why it does not fit the current service

Tailscale Serve exposes a local service to the tailnet; Tailscale Funnel exposes it to the public
internet. Neither closes the Render web service's public listener. Installing Tailscale in the
existing container would add a private path, but the Render URL would still route to the same app.
That is not an additional access boundary.

A real Tailscale design would require:

1. Split `/platform` and `/api/platform` into a **Render private service** with no public URL, or host
   the console on a private always-on machine outside Render.
2. Run a Tailscale subnet router/sidecar as a Render private service (Render publishes an example
   Tailscale subnet-router template) and scope the ACL to the platform host and port, not the entire
   Render private network.
3. Install Tailscale on every administrator device and require tailnet identity/device posture.
4. Move the console/API origin, cookies, CORS and WebAuthn configuration to the private path, or
   front it with a controlled reverse proxy.
5. Keep a second recovery route so a lost device or a failed tailnet does not lock out the only
   administrator.

This is a material architecture change, not a gateway toggle. Render private services have no free
instances; compute starts at the paid 0.5 CPU/512 MB tier ($7/month list), and Tailscale Standard adds
$8/user/month. The total may look small, but the engineering and lockout risk are not.

### 5.3 Benefits and risks

**Benefits:** true network-level reachability control, device identity, ACLs, possible SSH/private
network consolidation.

**Risks:** commercial licence, Tailscale control-plane dependency, device enrollment and recovery,
subnet-router scope, private-service refactor, separate health checks, origin/WebAuthn migration, and
the possibility of exposing the whole private Render network if the ACL/routes are too broad.

**Verdict:** a credible future option for strict network isolation, but **not recommended for the
current public Render service** and not the first pilot.

## 6. Render inbound IP rules

Render's documentation is explicit: all workspaces can set inbound IP rules for managed Postgres and
Key Value datastores, while **web services and static sites require a Scale or Enterprise workspace**.
The public pricing page lists Scale at **$499/month plus compute** and Enterprise as custom. Rules are
IPv4 CIDR allowlists; a disallowed request gets `403`. They can block all traffic if every rule is
removed.

This would be simple and strong if the project already paid for Scale, but it is not a low-cost
change. It also does not provide per-person identity: the administrator's IP/VPN must be stable, and
a mobile or home connection can break access. Keep it as a fallback if Scale is purchased for other
reasons; do not upgrade solely for this console at the current stage.

## 7. Recommendation

**Conditional preferred design: Cloudflare Access in front of a dedicated platform hostname, with
origin JWT validation at the application, while retaining the existing Basic gate and platform MFA.**

This is the best technical fit because it provides named identity and service credentials at the edge
for $0 at the current operator count, and it does not require splitting the Render service. It is
**not a zero-change or zero-prerequisite fix**: without origin JWT validation the Render URL remains
a bypass, and without an already-owned controlled domain there is no eligible hostname.

**Current decision: keep the free gate and defer the migration until a controlled domain already
exists and the code/verification work is separately approved.** Do not buy a domain for this project
while the budget is committed. The migration plan is ready for that later decision.

**Do not choose Tailscale's free plan for commercial use.** If the owner later wants strict
network-level isolation, evaluate Tailscale Standard plus a private Render service as a separate
architecture project, not as an incremental gate.

**Do not upgrade Render to Scale only for inbound IP rules.** The $499/month workspace fee is not
justified by this single control unless Scale is already required for other reasons.

### 7.1 Proposed decision sequence (no work authorized by this document)

1. Owner confirms whether a controlled domain is available and who owns the Cloudflare account.
2. Security review approves the Access policy shape, allowed identities/groups and service-token
   use, including the free-plan 24-hour log limitation.
3. A separate implementation request covers origin JWT validation, the hostname/WebAuthn migration,
   direct-origin bypass tests, and a rollback to the current gate.
4. Pilot with a test hostname/identity, not the production administrator; record a successful browser
   MFA login, a denied identity, a valid service token and a rejected direct `onrender.com` request.
5. Only after those pass should production DNS/configuration change.

### 7.2 Acceptance criteria for a later pilot

- Access denies an anonymous browser and an identity not in the policy.
- The console still requires platform password + TOTP/WebAuthn; Access does not replace them.
- A request to the Render default hostname without a valid Access token is rejected, not served.
- A service token can read the approved API path; the human administrator's credentials do not have
  to be copied into automation.
- The exact-origin cookie/CORS/WebAuthn flow works on the new hostname.
- The Basic gate and break-glass/recovery paths still work during the transition.
- Alerting receives Access denials and origin-bypass attempts.
- Disabling/removing the Access policy has a documented, tested rollback.

## 8. Sources checked

- Cloudflare Access product and plans: <https://www.cloudflare.com/sase/products/access/> and
  <https://www.cloudflare.com/plans/zero-trust-services/>.
- Cloudflare Access self-hosted application and origin token validation:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>.
- Cloudflare Access service tokens:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>.
- Cloudflare JWT validation:
  <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>.
- Tailscale pricing and non-commercial Personal plan: <https://tailscale.com/pricing>.
- Tailscale Serve vs Funnel: <https://tailscale.com/docs/features/tailscale-serve> and
  <https://tailscale.com/docs/features/tailscale-funnel>.
- Render inbound IP rules: <https://render.com/docs/inbound-ip-rules>.
- Render private services and private network:
  <https://render.com/docs/private-services> and <https://render.com/docs/private-network>.
- Render free-instance limits: <https://render.com/docs/free>.
- Render Tailscale subnet-router example: <https://render.com/templates/tailscale>.
