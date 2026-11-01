# Security Dependency Decisions

**Status:** living decision record · **Advisories re-measured 2026-11-01** at `main`; the lockfile fix below is from 2026-10-30

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
| `server/` | **16 entries, 2 advisories — 0 high, 16 moderate** | `glob`, `minimatch` |
| `mobile/` | **48 entries, 4 advisories — 2 high, 45 moderate, 1 low** | `zod`, `deepmerge`, `glob`, `minimatch` |

The server tree was clean on 2026-10-30; the 2026-11-01 measurement is not. Two advisories published
since then reach it through two separate paths: `firebase-admin`'s production chain
(`google-gax → rimraf → glob → minimatch`) and the ESLint/TypeScript-ESLint development tooling.
Mobile carries the same two beside the two already documented.

On 2026-10-30 the **third** mobile advisory — `node-forge` (GHSA-86w9-cpqp-85rv, high) — was fixed in
the lockfile by a bump from `1.4.0` to `1.4.2`, inside its consumer's `^1.4.0` range. That fix stands.

`npm audit` counts **dependents, not distinct defects**. The server's 16 entries are two advisories
seen through their parents; the mobile's 48 entries are four advisories, and its 2 high entries are
the one high `zod` advisory seen through two chains. Dependabot groups them into six package alerts
across the two manifests.

---

## 2. The four open advisories

| Advisory | Severity | Installed | Pulled in by | Patched |
| --- | --- | --- | --- | --- |
| **GHSA-mrhx-c7xc-m3w5** — `zod` exhausts memory validating an oversized array against a length-unconstrained schema (CWE-770) | high, 7.5 | `3.25.76`, nested at `mobile/node_modules/expo/node_modules/zod` | `expo@58.0.19 → @expo/cli@58.1.15`, which declares `zod: ^3.25.76` | `>= 4.6.6` |
| **GHSA-gcqx-w48m-w2h4** — `deepmerge` `mergeObject()` allows prototype poisoning of the returned object (CWE-1321) | low, 5.3 | `4.3.1` | `expo@58.0.19 → @expo/config@58.0.8`, and `jest@30.5.2 → jest-config@30.5.2`; both declare `deepmerge: ^4.2.2` | **none published** — `4.3.1` is both the newest release and inside `>= 4.2.0 <= 4.3.1` |
| **GHSA-3g3m-2fjr-6pw4** — `glob` abort-signal cancellation bypass allows post-timeout filesystem traversal | medium | `13.0.6` (mobile), `10.5.0` (both) | `expo-updates@58.0.18`, `@expo/cli`, `@expo/config`, `@expo/metro-config`, Jest reporters; server `google-gax@5.0.8 → rimraf@5.0.10` | `>= 14.0.2` |
| **GHSA-g3hv-75wg-m249** — `minimatch` denial of service via globparts amplification | medium | `10.2.6`, `9.0.9`, `3.1.5` | `eslint`, `@eslint/config-array`, `@typescript-eslint/typescript-estree`, `eslint-plugin-import` and `eslint-plugin-react`; every `glob` row above; Jest's `test-exclude` | `>= 11.0.1` |

**None of the four is reachable from application code.** Measured on this tree, not assumed:

- No file under `mobile/app`, `mobile/lib`, `mobile/components` or `mobile/hooks` imports or requires
  any of these packages, and no file under `server/src` imports `glob` or `minimatch` (grep,
  2026-11-01).
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
- The server's production `glob`/`minimatch` sit under `google-gax → rimraf`, used for library-internal
  temporary-file cleanup. No API request, product name or other user-supplied pattern reaches them.
- On mobile, `glob` and `minimatch` are used by Expo CLI/config/Metro, Jest and ESLint — build and
  test tooling. Neither is imported by the app, and neither is in the shipped bundle.

---

## 3. Decisions

| ID | Decision | State |
| --- | --- | --- |
| **D-9** | **`node-forge` is FIXED IN THE LOCKFILE** by a bump to `1.4.2`. `mobile/package.json` is unchanged; no override, no package added or removed. The consumer already admits the patched release, and the mobile suite passes on the new tree. The GitHub alert stays open until this change reaches the default branch. | **FIXED IN LOCKFILE 2026-10-30** |
| **D-4** | **The two remaining mobile advisories are ACCEPTED AND DOCUMENTED** as residual risk — one high (`zod`), one low (`deepmerge`). No remediation is applied. | **ACCEPTED** |
| **D-5** | **`npm audit fix` is NOT run.** Its proposal is `expo@51.0.39` — a **downgrade of seven SDK majors** from the installed 58.0.19. That is not a fix; it would replace the whole supported SDK line with an older one. | **REJECTED** |
| **D-6** | **npm `overrides` are NOT used** to force `zod` 4.x into `@expo/cli` or to replace `deepmerge`. Both would install a dependency the parent never declared, against a consumer that has not been tested with it. | **REJECTED** |
| **D-7** | The decision is **watched, not remembered**. `scripts/check-upgrade-watches.mjs` carries `zod (advisory)`, `deepmerge (advisory)` and `node-forge (advisory)`, reports the gate each one needs, and reports `CLOSED` for a tree already outside the vulnerable range. The `glob`/`minimatch` advisories are not in that script: each has several consumers with different ranges, so a single-consumer watch would report `READY` on a fix only one parent admits. Their gates are the explicit conditions in §4. | **ACTIVE** |
| **D-8** | **No published release can clear the two remaining advisories today.** Checked 2026-10-30: `@expo/cli` 58.1.15 is the newest and still declares `zod ^3.25.76` while the patch starts at `4.6.6`; `deepmerge` 4.3.1 is the newest and is inside the advisory range, so no patched release exists. | **MEASURED** |
| **D-10** | **`glob` and `minimatch` are ACCEPTED AND DOCUMENTED; no override, no `npm audit fix`.** The patched releases (`glob >= 14.0.2`, `minimatch >= 11.0.1`) are majors outside every declared range: `glob` consumers declare `^7`, `^10` or `^13`; `minimatch` consumers declare `^3` or `^10`. On `server/`, the non-forced audit fix proposes a `google-gax` downgrade (`5.0.8 → 5.0.4`) and leaves the `glob` advisory in place; `--force` offers `eslint@4.0.0` (mobile) or `expo-updates@0.27.5`. This supersedes D-4's *two* advisory count — the disposition (accepted, documented, not forced) is unchanged. | **ACCEPTED 2026-11-01** |

The reasoning for the remaining advisories is the same: the vulnerable API is never invoked by
application code, the package is confined to build or library-internal tooling, and every available
"fix" trades a non-exploitable advisory for a major that the consumer never declared. **A dependency
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
6. **`glob` publishes a patched release inside a declared range** (`^7`, `^10` or `^13`) — none exists;
   the floor is `14.0.2` — or a parent (`expo-updates`, `@expo/cli`, `rimraf`, `test-exclude`)
   widens to admit it.
7. **`minimatch` publishes a patched release inside a declared range** (`^3` or `^10`) — none exists;
   the floor is `11.0.1` — or a parent (`eslint`, `@typescript-eslint`, `test-exclude`, the `glob`
   line) widens to admit it.
8. **`firebase-admin` or its `google-gax`/`rimraf` chain moves** — that is the server production path,
   and it should be re-audited with the upgrade.

Watch the gate rather than the number: `npm audit` counts **dependents** as well, so the server's 16
entries are not 16 distinct defects, and mobile's 48 are not 48.

---

## 5. Evidence

Read-only commands unless noted; none of them writes, installs or removes anything. Command 9 is the
one lockfile change this record justifies. Rows 4–11 are the 2026-10-30 measurements that remain
true; rows 1–3 and 12–16 were re-run on 2026-11-01.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm audit --json` in `server/` (2026-11-01) | `{low:0, moderate:16, high:0, critical:0, total:16}` — two advisories, `glob` and `minimatch` |
| 2 | `npm audit --json` in `mobile/` (2026-11-01) | `{low:1, moderate:45, high:2, critical:0, total:48}` — four advisories: `zod`, `deepmerge`, `glob`, `minimatch` |
| 3 | `npm ls glob minimatch` in both trees (2026-11-01) | server: `glob@10.5.0`, `minimatch@9.0.9` and `10.2.6`; mobile: `glob@13.0.6` and `10.5.0`, `minimatch@10.2.6`, `9.0.9`, `3.1.5` |
| 4 | Source grep of `app/`, `lib/`, `components/`, `hooks/` | no import of `zod`, `node-forge` or `deepmerge` |
| 5 | `grep -rln node-forge node_modules/@expo/code-signing-certificates/build node_modules/expo-updates/build` | one file, `@expo/code-signing-certificates/build/main.js` — a build-time consumer |
| 6 | `grep -rln deepmerge node_modules/@expo/config/build node_modules/jest-config/build` | `Config.js` and `index.js` — build and test tooling only |
| 7 | `node scripts/check-upgrade-watches.mjs` | `zod` `DEFERRED` at `3.25.76`; `deepmerge` `DEFERRED` at `4.3.1`; `node-forge` `CLOSED` at `1.4.2` |
| 8 | `npm view <pkg> version` for `@expo/cli`, `deepmerge`, `zod`, `node-forge` | `58.1.15`, `4.3.1`, `4.6.7`, `1.4.2` — the zod patch exists but is outside the CLI's 3.x range; deepmerge has no patched release |
| 9 | `cd mobile && npm install` after `node-forge` 1.4.2 was published | only `mobile/package-lock.json` changed, three lines for `node-forge` |
| 10 | `cd mobile && npm run typecheck` | exit **0** |
| 11 | `cd mobile && npm test -- --runInBand` | **97 suites, 1 172 tests, all pass** |
| 12 | `npm view rimraf@5.0.10 dependencies.glob` · `expo-updates@58.0.18 dependencies.glob` · `test-exclude@7.0.2 dependencies` | `^10.3.7` · `^13.0.0` · `glob ^10.4.1`, `minimatch ^10.2.2` — all below the patched 14.0.2 / 11.0.1 majors |
| 13 | `npm view eslint@10.13.0 dependencies.minimatch` · `@typescript-eslint/typescript-estree@8.72.0 dependencies.minimatch` · `eslint-plugin-import@2.32.0 dependencies.minimatch` | `^10.2.5` · `^10.2.2` · `^3.1.2` — no consumer admits 11.x |
| 14 | `npm view glob version` · `npm view minimatch version` | `14.0.3` · `11.0.3`; the patched floors are `14.0.2` and `11.0.1` |
| 15 | `cd server && npm audit fix --dry-run`; `npm audit fix --dry-run --json` in `mobile/` | server: 14 packages changed including `google-gax 5.0.8 → 5.0.4`, and the `glob` advisory remains; `--force` proposes `eslint@4.0.0` (mobile) or `expo-updates@0.27.5` |
| 16 | `grep` for `glob`/`minimatch` imports in `server/src`, `mobile/app`, `mobile/lib`, `mobile/components`, `mobile/hooks` | no matches — no direct application import on either side |

No credential, token or secret value appears in this record.
