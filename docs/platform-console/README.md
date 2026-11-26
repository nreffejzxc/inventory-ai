# Internal Operations & Monitoring Console — documentation

This folder is the single home for the **Inventory AI Internal Operations & Monitoring
Console** (the `/platform` console and `/api/platform` plane). It keeps console material
separate from tenant, mobile, AI-assistant and general application documentation.

**Status:** living reference. The last full review was **2026-11-19**.
**Production entry point:** `https://ai-inventory-l1mi.onrender.com/platform`.
**Audience:** the owner/CEO, platform administrators, support personnel, developers and the engineer maintaining the console.

## Start here

| If you need to… | Read |
| --- | --- |
| **Start using the console: access, MFA, accounts, daily work and security** | **[00 — User guide](00-user-guide.md)** |
| Understand what the console is, what it shows and what it deliberately cannot show | [01 — Status and accounts](01-status-and-accounts.md) |
| See the roles, console-section access, account lifecycle and credential rules | [02 — Accounts and credentials](02-accounts-and-credentials.md) |
| Check the production-exposure gates | [04 — Production readiness](04-production-readiness.md) |
| Plan the next console improvement, or check what is still unbuilt | [`../BACKLOG.md`](../BACKLOG.md) §6 |

## What belongs in this folder

- The platform console’s current status, measured production snapshots and feature limits.
- Platform roles, capabilities, console-section access and platform/tenant account lifecycle.
- Platform login, MFA, recovery codes, WebAuthn, sessions and break-glass recovery.
- Platform credential and server-secret custody, rotation and revocation.
- Console monitoring, health signals and error-counter semantics.
- Console production-readiness and the production-exposure gates.

## What does **not** belong here

| Topic | Where it lives |
| --- | --- |
| Tenant roles, inventory, products, purchase orders and tenant audit | [`../SYSTEM_SPECIFICATION.md`](../SYSTEM_SPECIFICATION.md) |
| Mobile app behaviour and design | [`../DESIGN_SYSTEM.md`](../DESIGN_SYSTEM.md), [`../DEVELOPING_ON_A_PHYSICAL_DEVICE.md`](../DEVELOPING_ON_A_PHYSICAL_DEVICE.md) |
| Whole-API health, AI-turn metrics and the external health watch | [`../MONITORING.md`](../MONITORING.md) |
| Open console and tenant-facing security work | [`../BACKLOG.md`](../BACKLOG.md) §6 |
| Cross-cutting dependency, reliability and sensitive-data plans | [`../README.md`](../README.md) |
| Historical phase records and evidence | [`../DEVELOPMENT_ROADMAP.md`](../DEVELOPMENT_ROADMAP.md), [`../DEVELOPMENT_LOG.md`](../DEVELOPMENT_LOG.md) |

## How to maintain this folder

1. **One owner per topic.** 00 is the short entry-point guide; 01 and 02 own the detailed
   status and account/credential material. Do not add another guide that repeats those
   details; update the numbered document that owns them.
2. **Keep current and planning separate.** Documents 00, 01, 02 and 04 describe the system as it
   is. Unbuilt console work is a row in [`../BACKLOG.md`](../BACKLOG.md) §6, not a new page here.
3. **Record the date and basis.** Every edit updates the `Assessed`/`Reviewed` line and the
   implementation commit or production snapshot it was checked against.
4. **Never add secrets.** Use environment-variable names and placeholders only. No password,
   TOTP seed, recovery code, session cookie, CSRF token or access key belongs here.
5. **Update the index and the root map.** New pages need a row here and a link from
   [`../README.md`](../README.md); `node scripts/check-docs.mjs` enforces both.
6. **Keep tenant data out.** The console is aggregate-only; examples must not contain a
   tenant name, email, product row or other member-identifying data.

## Reading rules

- The **implementation** is the source of truth. A planning document does not create a
  feature, a role, a credential or a procedure by describing it.
- The **measured production snapshot** in document 01 is dated. Re-measure before treating
  a number as current.
- **No PIN, biometric app lock, SMS OTP, tenant MFA, tenant recovery code, self-service
  platform password reset or tenant ownership-transfer endpoint exists.** See document 02
  for the complete list of mechanisms that do exist.
- The shared outer access key is a gate, not a person and not network isolation.

## Related entry points

- Root documentation map: [`../README.md`](../README.md)
- Project working contract and phase index: [`../../CLAUDE.md`](../../CLAUDE.md)
- Whole-API monitoring and incident procedure: [`../MONITORING.md`](../MONITORING.md)
- System behaviour and tenant roles: [`../SYSTEM_SPECIFICATION.md`](../SYSTEM_SPECIFICATION.md)
