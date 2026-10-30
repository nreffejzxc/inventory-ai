# Security Dependency Decisions

**Status:** living decision record · **Re-measured 2026-10-30** at `main`

An advisory that is not being fixed is **named, evidenced and dispositioned**, never left implied.
This file covers dependency advisories only; application security decisions are in
[`AUTH_SECURITY_MASTER_CHECKLIST.md`](AUTH_SECURITY_MASTER_CHECKLIST.md), and dated measurements in
[`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) §27AK, §27CA, §27CJ, §27FJ, §27GX.

Four questions stay separate for every item, because collapsing them is how an accepted risk becomes
an unexamined one: does a vulnerable package exist · is it a production dependency · is it reachable
from application runtime code · is the vulnerable API actually called.

---

## 1. Current result

| Tree | `npm audit` | Distinct advisories |
| --- | --- | --- |
| `server/` | **0** | 0 |
| `mobile/` | **17 entries, 2 advisories — 1 high, 1 low, 0 critical** | `zod`, `deepmerge` |

The server tree is clean. On 2026-10-30 the **third** mobile advisory — `node-forge`
(GHSA-86w9-cpqp-85rv, high) — was fixed in the lockfile by a bump from `1.4.0` to `1.4.2`. A patched
release had been published since the last measurement, and the only consumer,
`@expo/code-signing-certificates@0.0.7`, already declares `node-forge: ^1.4.0`, so no override was
needed. The GitHub alert closes when that lockfile change reaches the default branch.

The 17 mobile entries are **two advisories seen through their dependents** — `expo`, `@expo/cli`,
`expo-router`, `jest`, `jest-expo` and the rest are reported because they carry a vulnerable package,
not because each has its own defect. The high count is the one `zod` advisory seen through `expo`,
`@expo/cli` and `zod` itself; the fourteen lows are the one `deepmerge` advisory seen through its
consumers. Dependabot groups them into two package alerts.

---

## 2. The two open advisories

| Advisory | Severity | Installed | Pulled in by | Patched |
| --- | --- | --- | --- | --- |
| **GHSA-mrhx-c7xc-m3w5** — `zod` exhausts memory validating an oversized array against a length-unconstrained schema (CWE-770) | high, 7.5 | `3.25.76`, nested at `mobile/node_modules/expo/node_modules/zod` | `expo@58.0.19 → @expo/cli@58.1.15`, which declares `zod: ^3.25.76` | `>= 4.6.6` |
| **GHSA-gcqx-w48m-w2h4** — `deepmerge` `mergeObject()` allows prototype poisoning of the returned object (CWE-1321) | low, 5.3 | `4.3.1` | `expo@58.0.19 → @expo/config@58.0.8`, and `jest@30.5.2 → jest-config@30.5.2`; both declare `deepmerge: ^4.2.2` | **none published** — `4.3.1` is both the newest release and inside `>= 4.2.0 <= 4.3.1` |

**Neither is reachable from application code.** Measured on this tree, not assumed:

- No file under `mobile/app`, `mobile/lib`, `mobile/components` or `mobile/hooks` imports or requires
  any of the three packages.
- `node-forge` was required only by `@expo/code-signing-certificates/build/main.js`. Inside
  `expo-updates` that package is reached from **two CLI scripts** — `cli/build/configureCodeSigningAsync.js`
  and `cli/build/generateCodeSigningAsync.js` — and **not** from `expo-updates/build/index.js`, the
  module the app imports. Code signing is not enabled for this project (§27FN), so neither script runs
  here. The package is now `1.4.2` anyway.
- The vulnerable `zod` is **nested inside `expo/node_modules`** for the CLI, where exactly **two**
  files import it: `start/server/createMCPDevToolsExtensionSchema.js` and
  `start/server/DevToolsPlugin.schema.js` — the DevTools/MCP plugin-manifest validation that
  `expo start` performs on the developer machine. The top-level `zod` is `4.6.7`, already outside the
  advisory's range; the CLI cannot use it because it declares a 3.x range.
- `deepmerge` is imported by `@expo/config/build/Config.js` (the app-config loader, a build-time
  module) and by `jest-config/build/index.js` (the test runner). It is not in the shipped bundle.

---

## 3. Decisions

| ID | Decision | State |
| --- | --- | --- |
| **D-9** | **`node-forge` is FIXED IN THE LOCKFILE** by a bump to `1.4.2`. `mobile/package.json` is unchanged; no override, no package added or removed. The consumer already admits the patched release, and the mobile suite passes on the new tree. The GitHub alert stays open until this change reaches the default branch. | **FIXED IN LOCKFILE 2026-10-30** |
| **D-4** | **The two remaining mobile advisories are ACCEPTED AND DOCUMENTED** as residual risk — one high (`zod`), one low (`deepmerge`). No remediation is applied. | **ACCEPTED** |
| **D-5** | **`npm audit fix` is NOT run.** Its proposal is `expo@51.0.39` — a **downgrade of seven SDK majors** from the installed 58.0.19. That is not a fix; it would replace the whole supported SDK line with an older one. | **REJECTED** |
| **D-6** | **npm `overrides` are NOT used** to force `zod` 4.x into `@expo/cli` or to replace `deepmerge`. Both would install a dependency the parent never declared, against a consumer that has not been tested with it. | **REJECTED** |
| **D-7** | The decision is **watched, not remembered**. `scripts/check-upgrade-watches.mjs` carries `zod (advisory)`, `deepmerge (advisory)` and `node-forge (advisory)`, reports the gate each one needs, and reports `CLOSED` for a tree already outside the vulnerable range. | **ACTIVE** |
| **D-8** | **No published release can clear the two remaining advisories today.** Checked 2026-10-30: `@expo/cli` 58.1.15 is the newest and still declares `zod ^3.25.76` while the patch starts at `4.6.6`; `deepmerge` 4.3.1 is the newest and is inside the advisory range, so no patched release exists. | **MEASURED** |

The reasoning for the two remaining is the same: the vulnerable API is never invoked by application
code, the package is confined to build tooling, and every available "fix" trades a non-exploitable
advisory for a change that could break the Expo toolchain the app is built with. **A dependency
upgrade for a non-reachable advisory is a real risk taken to remove a theoretical one.** The one
upgrade that *was* both patched and inside its consumer's range — `node-forge` 1.4.2 — was taken.

---

## 4. When this is revisited

The acceptance ends automatically when any of these becomes true — the watch script reports the first
two:

1. **`@expo/cli` admits `zod >= 4.6.6`** in a published release (then the normal SDK patch train is
   enough, no override).
2. **A `deepmerge` release is published outside `>= 4.2.0 <= 4.3.1`** *and* `@expo/config` or
   `jest-config` admits it.
3. **Either package becomes runtime-reachable** — any import in app source, or a new consumer that
   loads it in the shipped bundle.
4. **The advisory is raised in severity**, or a new advisory names the same package.
5. **An Expo SDK upgrade is planned for any reason** — re-run the audit as part of that work rather
   than assuming the count is unchanged.

Watch the gate rather than the number: `npm audit` on `mobile/` counts **dependents** as well, so its
17 entries are not 17 distinct defects.

---

## 5. Evidence

Read-only commands unless noted; none of them writes, installs or removes anything. Command 9 is the
one lockfile change this record justifies.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm audit --json` in `server/` | `{low:0, moderate:0, high:0, critical:0, total:0}` |
| 2 | `npm audit --json` in `mobile/` | `{low:14, moderate:0, high:3, critical:0, total:17}` — the two advisories above |
| 3 | `npm ls zod deepmerge node-forge` | `zod@3.25.76` nested under `expo`, `deepmerge@4.3.1` under `@expo/config` and `jest-config`, `node-forge@1.4.2` under `@expo/code-signing-certificates` |
| 4 | Source grep of `app/`, `lib/`, `components/`, `hooks/` | no import of `zod`, `node-forge` or `deepmerge` |
| 5 | `grep -rln node-forge node_modules/@expo/code-signing-certificates/build node_modules/expo-updates/build` | one file, `@expo/code-signing-certificates/build/main.js` — a build-time consumer |
| 6 | `grep -rln deepmerge node_modules/@expo/config/build node_modules/jest-config/build` | `Config.js` and `index.js` — build and test tooling only |
| 7 | `node scripts/check-upgrade-watches.mjs` | `zod` `DEFERRED` at `3.25.76`; `deepmerge` `DEFERRED` at `4.3.1`; `node-forge` `CLOSED` at `1.4.2` |
| 8 | `npm view <pkg> version` for `@expo/cli`, `deepmerge`, `zod`, `node-forge` | `58.1.15`, `4.3.1`, `4.6.7`, `1.4.2` — the zod patch exists but is outside the CLI's 3.x range; deepmerge has no patched release |
| 9 | `cd mobile && npm install` after `node-forge` 1.4.2 was published | only `mobile/package-lock.json` changed, three lines for `node-forge` |
| 10 | `cd mobile && npm run typecheck` | exit **0** |
| 11 | `cd mobile && npm test -- --runInBand` | **97 suites, 1 172 tests, all pass** |

No credential, token or secret value appears in this record.
