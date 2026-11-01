# Security Dependency Decisions

**Status:** living decision record · **Advisories re-measured 2026-11-02** at `main`; the node-forge lockfile fix is from 2026-10-30 and the zod fix from 2026-11-02

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
| `mobile/` | **47 entries, 3 advisories — 0 high, 46 moderate, 1 low** | `deepmerge`, `glob`, `minimatch` |

The server tree was clean on 2026-10-30; the 2026-11-01 measurement is not. Two advisories published
since then reach it through two separate paths: `firebase-admin`'s production chain
(`google-gax → rimraf → glob → minimatch`) and the ESLint/TypeScript-ESLint development tooling.
Mobile carries the same two beside `deepmerge`, the one remaining low advisory.

On 2026-10-30 the **third** mobile advisory — `node-forge` (GHSA-86w9-cpqp-85rv, high) — was fixed in
the lockfile by a bump from `1.4.0` to `1.4.2`, inside its consumer's `^1.4.0` range. That fix stands.

On 2026-11-02 the **zod** high advisory was cleared by the Expo 58.0.22 patch: `expo@58.0.22` installs `@expo/cli@58.1.18`, whose manifest no longer declares `zod`, and the nested `zod@3.25.76` is gone. The only `zod` in the tree is `4.6.7`, outside the advisory range.

`npm audit` counts **dependents, not distinct defects**. The server's 16 entries are two advisories
seen through their parents; the mobile's 47 entries are three advisories, with **no high entry**
now that the `zod` chain is gone. Dependabot groups them into five package alerts across the two
manifests.

---

## 2. The open advisories — and the one cleared

| Advisory | Severity | Installed | Pulled in by | Patched / state |
| --- | --- | --- | --- | --- |
| **GHSA-mrhx-c7xc-m3w5** — `zod` exhausts memory validating an oversized array against a length-unconstrained schema (CWE-770) | high, 7.5 | **none** — the nested `3.25.76` was removed | Was `expo@58.0.19 → @expo/cli@58.1.15`; **cleared** by `expo@58.0.22 → @expo/cli@58.1.18`, which declares no `zod` | **CLEARED 2026-11-02** — only `zod@4.6.7` remains, via `eslint-plugin-react-hooks` |
| **GHSA-gcqx-w48m-w2h4** — `deepmerge` `mergeObject()` allows prototype poisoning of the returned object (CWE-1321) | low, 5.3 | `4.3.1` | `expo@58.0.22 → @expo/config@58.0.10`, and `jest@30.5.2 → jest-config@30.5.2`; both declare `deepmerge: ^4.2.2` | **none published** — `4.3.1` is both the newest release and inside `>= 4.2.0 <= 4.3.1` |
| **GHSA-3g3m-2fjr-6pw4** — `glob` abort-signal cancellation bypass allows post-timeout filesystem traversal | medium | `13.0.6` (mobile), `10.5.0` (both) | `expo-updates@58.0.20`, `@expo/cli`, `@expo/config`, `@expo/metro-config`, Jest reporters; server `google-gax@5.0.8 → rimraf@5.0.10` | `>= 14.0.2` |
| **GHSA-g3hv-75wg-m249** — `minimatch` denial of service via globparts amplification | medium | `10.2.6`, `9.0.9`, `3.1.5` | `eslint`, `@eslint/config-array`, `@typescript-eslint/typescript-estree`, `eslint-plugin-import` and `eslint-plugin-react`; every `glob` row above; Jest's `test-exclude` | `>= 11.0.1` |

**None of the three remaining is reachable from application code.** Measured on this tree, not assumed:

- No file under `mobile/app`, `mobile/lib`, `mobile/components` or `mobile/hooks` imports or requires
  any of these packages, and no file under `server/src` imports `glob` or `minimatch` (grep,
  2026-11-01).
- `node-forge` was required only by `@expo/code-signing-certificates/build/main.js`. Inside
  `expo-updates` that package is reached from **two CLI scripts** — `cli/build/configureCodeSigningAsync.js`
  and `cli/build/generateCodeSigningAsync.js` — and **not** from `expo-updates/build/index.js`, the
  module the app imports. Code signing is not enabled for this project (§27FN), so neither script runs
  here. The package is now `1.4.2` anyway.
- The vulnerable `zod` is **no longer installed**. `expo@58.0.22` installs `@expo/cli@58.1.18`,
  whose manifest declares no `zod`; the only `zod` in the tree is `4.6.7` at top level, reached through
  `eslint-config-expo → eslint-plugin-react-hooks → zod-validation-error`, outside the advisory's
  `< 4.6.6` range.
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
| **D-9** | **`node-forge` is FIXED IN THE LOCKFILE** by a bump to `1.4.2`. That change did not alter `mobile/package.json`; no override, no package added or removed. The consumer already admits the patched release, and the mobile suite passes on the new tree. The GitHub alert stays open until this change reaches the default branch. | **FIXED IN LOCKFILE 2026-10-30** |
| **D-4** | **The remaining D-4 mobile advisory is ACCEPTED AND DOCUMENTED** as residual risk — the low `deepmerge` advisory. `zod` is closed (D-11); no remediation is applied to `deepmerge`, and `glob`/`minimatch` remain under D-10. | **ACCEPTED — deepmerge only** |
| **D-5** | **`npm audit fix` is NOT run.** Its proposal is `expo@51.0.39` — a **downgrade of seven SDK majors** from the installed 58.0.22. That is not a fix; it would replace the whole supported SDK line with an older one. | **REJECTED** |
| **D-6** | **npm `overrides` are NOT used** to force `zod` 4.x into `@expo/cli` or to replace `deepmerge`. Both would install a dependency the parent never declared, against a consumer that has not been tested with it. | **REJECTED** |
| **D-7** | The decision is **watched, not remembered**. `scripts/check-upgrade-watches.mjs` carries `zod (advisory)`, `deepmerge (advisory)` and `node-forge (advisory)`, reports the gate each one needs, and reports `CLOSED` for a tree already outside the vulnerable range. The `glob`/`minimatch` advisories are not in that script: each has several consumers with different ranges, so a single-consumer watch would report `READY` on a fix only one parent admits. Their gates are the explicit conditions in §4. The `zod` row also reads the **published** `expo@latest` manifest, resolves the newest `@expo/cli` release that manifest admits, and inspects that CLI's zod range — so the pre-upgrade gate is detected before the CLI is installed. `READY` means that admitted CLI declares a range admitting `4.6.6+`; the registry's absolute latest CLI is reported beside it but only the admitted one can decide. On 2026-11-02 the nested `zod@3.25.76` is gone, the installed tree reports `4.6.7`, and the watch reports `CLOSED`; `node-forge` remains `CLOSED`, while `deepmerge` remains `DEFERRED`. | **ACTIVE — zod and node-forge CLOSED** |
| **D-8** | **The zod half is cleared; deepmerge remains.** Checked 2026-11-02: `expo@58.0.22` installs `@expo/cli@58.1.18`, which declares no `zod`; the nested `zod@3.25.76` is gone and the top-level `zod@4.6.7` is outside the advisory range. `deepmerge` 4.3.1 is still the newest release and still inside `>= 4.2.0 <= 4.3.1`, so no patched release exists. | **MEASURED 2026-11-02** |
| **D-10** | **`glob` and `minimatch` are ACCEPTED AND DOCUMENTED; no override, no `npm audit fix`.** The patched releases (`glob >= 14.0.2`, `minimatch >= 11.0.1`) are majors outside every declared range: `glob` consumers declare `^7`, `^10` or `^13`; `minimatch` consumers declare `^3` or `^10`. On `server/`, the non-forced audit fix proposes a `google-gax` downgrade (`5.0.8 → 5.0.4`) and leaves the `glob` advisory in place; `--force` offers `eslint@4.0.0` (mobile) or `expo-updates@0.27.5`. This supersedes D-4's older two-advisory count — the disposition (accepted, documented, not forced) is unchanged. | **ACCEPTED 2026-11-01** |
| **D-11** | **The `zod` high advisory is FIXED IN THE LOCKFILE** by the Expo 58.0.22 patch. `mobile/package.json` moves `expo` from `~58.0.19` to `~58.0.22`; `npm install` resolves `@expo/cli@58.1.18`, which no longer declares `zod`, and removes the nested `zod@3.25.76`. No override and no `npm audit fix` were used. | **FIXED IN LOCKFILE 2026-11-02** |

The reasoning for the remaining advisories is the same: the vulnerable API is never invoked by
application code, the package is confined to build or library-internal tooling, and every available
"fix" trades a non-exploitable advisory for a major that the consumer never declared. **A dependency
upgrade for a non-reachable advisory is a real risk taken to remove a theoretical one.** The upgrades
that were both patched and inside their consumer's ranges — `node-forge` 1.4.2 and the `expo` 58.0.22
patch that removed the nested `zod` 3.x — were taken.

---

## 4. When this is revisited

The acceptance ends automatically when any of these becomes true — the watch script reports the first
two:

1. **`@expo/cli` admits `zod >= 4.6.6`** in a published release (then the normal SDK patch train is
   enough, no override). **Met 2026-11-02 by `expo@58.0.22` / `@expo/cli@58.1.18`; the `zod` advisory is now closed.**
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
entries are not 16 distinct defects, and mobile's 47 are not 47.

---

## 5. Evidence

Read-only commands unless noted; commands 9 and 17 are the only installs in this section. Command 9
is the node-forge lockfile change; commands 17–20 are the Expo 58.0.22 patch. Rows 4–11 are the
2026-10-30 measurements that remain true. Rows 2, 7, 8 and 17–20 were measured on 2026-11-02; the
remaining rows are dated in place.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm audit --json` in `server/` (2026-11-01) | `{low:0, moderate:16, high:0, critical:0, total:16}` — two advisories, `glob` and `minimatch` |
| 2 | `npm audit --json` in `mobile/` (2026-11-02) | `{low:1, moderate:46, high:0, critical:0, total:47}` — three advisories: `deepmerge`, `glob`, `minimatch`; `zod` absent |
| 3 | `npm ls glob minimatch` in both trees (2026-11-01) | server: `glob@10.5.0`, `minimatch@9.0.9` and `10.2.6`; mobile: `glob@13.0.6` and `10.5.0`, `minimatch@10.2.6`, `9.0.9`, `3.1.5` |
| 4 | Source grep of `app/`, `lib/`, `components/`, `hooks/` | no import of `zod`, `node-forge` or `deepmerge` |
| 5 | `grep -rln node-forge node_modules/@expo/code-signing-certificates/build node_modules/expo-updates/build` | one file, `@expo/code-signing-certificates/build/main.js` — a build-time consumer |
| 6 | `grep -rln deepmerge node_modules/@expo/config/build node_modules/jest-config/build` | `Config.js` and `index.js` — build and test tooling only |
| 7 | `node scripts/check-upgrade-watches.mjs` (2026-11-02) | `zod` `CLOSED` — installed `4.6.7` is outside `< 4.6.6`; `node-forge` `CLOSED` at `1.4.2`; `deepmerge` `DEFERRED` at `4.3.1`; `expo` and `jest-expo` `READY`. |
| 8 | `npm view <pkg> version` for `@expo/cli`, `deepmerge`, `zod`, `node-forge` (2026-11-02) | `58.1.18`, `4.3.1`, `4.6.7`, `1.4.2` — `@expo/cli@58.1.18` declares no `zod`; deepmerge has no patched release |
| 9 | `cd mobile && npm install` after `node-forge` 1.4.2 was published | only `mobile/package-lock.json` changed, three lines for `node-forge` |
| 10 | `cd mobile && npm run typecheck` | exit **0** |
| 11 | `cd mobile && npm test -- --runInBand` | **97 suites, 1 172 tests, all pass** |
| 12 | `npm view rimraf@5.0.10 dependencies.glob` · `expo-updates@58.0.20 dependencies.glob` · `test-exclude@7.0.2 dependencies` | `^10.3.7` · `^13.0.0` · `glob ^10.4.1`, `minimatch ^10.2.2` — all below the patched 14.0.2 / 11.0.1 majors |
| 13 | `npm view eslint@10.13.0 dependencies.minimatch` · `@typescript-eslint/typescript-estree@8.72.0 dependencies.minimatch` · `eslint-plugin-import@2.32.0 dependencies.minimatch` | `^10.2.5` · `^10.2.2` · `^3.1.2` — no consumer admits 11.x |
| 14 | `npm view glob version` · `npm view minimatch version` | `14.0.3` · `11.0.3`; the patched floors are `14.0.2` and `11.0.1` |
| 15 | `cd server && npm audit fix --dry-run`; `npm audit fix --dry-run --json` in `mobile/` | server: 14 packages changed including `google-gax 5.0.8 → 5.0.4`, and the `glob` advisory remains; `--force` proposes `eslint@4.0.0` (mobile) or `expo-updates@0.27.5` |
| 16 | `grep` for `glob`/`minimatch` imports in `server/src`, `mobile/app`, `mobile/lib`, `mobile/components`, `mobile/hooks` | no matches — no direct application import on either side |
| 17 | `cd mobile && npm install expo@~58.0.22`; `npx expo install --fix`; three exact pins (`expo-constants`, `expo-font`, `jest-expo`) | `expo@58.0.22`; all 14 managed pins match `expo/bundledNativeModules.json`; no override |
| 18 | `cd mobile && npx expo install --check` (2026-11-02) | “Dependencies are up to date”; exit **0** |
| 19 | `cd mobile && npm ls zod --all`; `npm ls @expo/cli --all` (2026-11-02) | `@expo/cli@58.1.18` under `expo@58.0.22`; nested `zod` absent; only `zod@4.6.7` via `eslint-config-expo → eslint-plugin-react-hooks → zod-validation-error` |
| 20 | `cd mobile && npm run typecheck`; `npm test -- --runInBand` (2026-11-02) | typecheck exit **0**; **101 suites, 1 191 tests, all pass** — the first run exposed 1 suite / 3 pin failures before the 14 pins were aligned |

No credential, token or secret value appears in this record.
