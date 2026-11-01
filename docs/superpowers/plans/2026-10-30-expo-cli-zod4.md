# Expo CLI zod-4 upgrade implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `mobile/` onto a published Expo CLI that declares `zod >= 4.6.6`, close Dependabot alert #10, and keep the native/OTA boundary intact.

**Architecture:** The gate is a **published `@expo/cli` release**, not an SDK number. Prefer an in-range CLI patch inside SDK 58; only escalate to SDK 59 if the CLI fix ships there. Any move of `expo-modules-core` or `react-native` is a native change: new app version, new build, device pass. A CLI-only move is build tooling and needs no binary.

**Tech Stack:** Expo SDK 58, `@expo/cli`, npm, EAS Build, GitHub Actions.

**Spec:** [Security Dependency Decisions](../../SECURITY_DEPENDENCY_DECISIONS.md) §2–4; roadmap §27AI (SDK upgrade runbook) and §27GX; [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Gate Z — status on 2026-10-30 (closed)

Measured, not assumed:

| Fact | Value |
| --- | --- |
| Latest `expo` | **58.0.21** |
| Latest `@expo/cli` | **58.1.17** |
| CLI's declared `zod` | **`^3.25.76`** — still vulnerable |
| Latest SDK | **58**; no SDK 59 published and no official release date announced |
| Installed mobile tree | `expo@58.0.19`, `@expo/cli@58.1.15`, nested `zod@3.25.76` |
| Upstream fix | [PR #52287](https://github.com/expo/expo/pull/52287) (draft, `zod ^4.6.6`, needs `@expo/mcp-tunnel ~0.3.1`); SDK 57 backport [PR #52316](https://github.com/expo/expo/pull/52316) (draft) |
| Tracking issue | [expo/expo#52470](https://github.com/expo/expo/issues/52470) (open) |

**No Expo upgrade available today closes alert #10.** A bump to `expo@58.0.21` would move `expo-modules-core` **58.0.26 → 58.0.28** (a native change) and still install `@expo/cli@58.1.17` with `zod ^3.25.76`. Do not take that bump "for the alert."

**Gate Z opens when both are true:**

1. `npm view @expo/cli@latest dependencies.zod` returns a range that admits **4.6.6 or newer**.
2. `npm view expo@latest dependencies.@expo/cli` returns a range that admits that CLI version.

Both questions are automated in `node scripts/check-upgrade-watches.mjs` (the `zod (advisory)` row). Re-run both commands at execution as a cross-check. A draft PR is not a release; do not install from a PR branch or force zod through `overrides`.

## Global Constraints

- No `overrides` entry for `zod`, and no `npm audit fix` — decision **D-6** and **D-5**.
- `@expo/cli` stays a transitive dependency; do not add it to `mobile/package.json`.
- `runtimeVersion` is `{ "policy": "appVersion" }`. A native change **requires** a new `app.json` version and a new binary; a CLI-only change does not.
- Keep `mobile/android/` and `mobile/ios/` absent (Expo CNG).
- Four required checks on `main`: `server`, `mobile`, `secret-guard`, `attribution-guard`.
- Never dismiss the Dependabot alert by hand. It closes when the default branch's lockfile no longer resolves a vulnerable zod.
- No attribution trailers in commits.

## Review Focus

- **The gate is not an SDK number.** SDK 58.0.21 is the latest SDK and still ships zod 3; a newer SDK is not automatically the fix.
- **The watch now sees this release before installation.** `scripts/check-upgrade-watches.mjs` reads the **published** `expo@latest` manifest and resolves the newest `@expo/cli` it admits, so `READY` appears while the installed tree is still on zod 3. It judges the admitted CLI rather than the registry's absolute latest tag, so a backport is not missed and an unreachable new major cannot produce a false `READY`; the installed manifest still decides `CLOSED`.
- **A second zod copy can hide.** The vulnerable package is nested at `node_modules/expo/node_modules/zod`; the top-level `zod@4.6.7` is already patched. Assert every lockfile zod entry, not just the top-level one.
- **`npm update @expo/cli` is broad.** A dry run currently changes about a dozen Expo build packages. Accept it only when `expo`, `expo-modules-core` and `react-native` are unchanged.
- **MCP compatibility.** The draft PR pairs zod 4 with `@expo/mcp-tunnel ~0.3.1`; forcing zod 4 into an older tunnel breaks the DevTools/MCP path. Verify `npx expo config` and the app bundle after upgrading.
- **No OTA record exists.** `mobile/ota-native-runtime.json` is absent, so `npm run check:ota` already fails. Do not describe a CLI-only bump as an OTA release; if a native build is cut, create the record then.

## File Structure

- `mobile/__tests__/expo-cli-zod-advisory.test.ts` — new lockfile guard; fails while any zod < 4.6.6 exists.
- `mobile/package.json` / `mobile/package-lock.json` — the dependency move.
- `mobile/app.json` — version bump **only** if native modules move.
- `mobile/ota-native-runtime.json` — created **only** after a native build.
- `docs/SECURITY_DEPENDENCY_DECISIONS.md` — D-4/D-8/D-10 and evidence.
- `SECURITY.md`, `CLAUDE.md`, `README.md` — current alert status.
- `docs/DEVELOPMENT_ROADMAP.md` — the next free record after §27GY and the record-count header.

---

### Task 1: Write the lockfile guard (start after Gate Z opens)

Start this task **on the upgrade branch**, not on `main`: the guard is meant to fail until Task 2
lands, so pushing it alone would turn the PR red before the upgrade exists.

**Files:**
- Create: `mobile/__tests__/expo-cli-zod-advisory.test.ts`

**Interfaces:**
- Consumes: `mobile/package-lock.json` only; no network, no `node_modules`.
- Produces: a test that fails on any zod version below `4.6.6`, and on a CLI entry still declaring a 3.x range.

- [ ] **Step 1: Branch and write the failing test**

```bash
git checkout main
git pull --ff-only
git checkout -b chore/expo-cli-zod4
```

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = { version?: string; dependencies?: Record<string, string> };
const lock = JSON.parse(
  readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8')
) as { packages: Record<string, Entry> };

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const zodEntries = Object.entries(lock.packages).filter(
  ([path]) => path === 'node_modules/zod' || path.endsWith('/node_modules/zod')
);

it('resolves no zod below the patched 4.6.6', () => {
  expect(zodEntries.length).toBeGreaterThan(0);
  expect(
    zodEntries
      .filter(([, entry]) => compare(entry.version ?? '0.0.0', '4.6.6') < 0)
      .map(([path, entry]) => `${path}@${entry.version}`)
  ).toEqual([]);
});

it('has an Expo CLI that declares a 4.x zod range', () => {
  const cli = Object.entries(lock.packages).find(
    ([path]) => path === 'node_modules/@expo/cli' || path.endsWith('/node_modules/@expo/cli')
  );
  expect(cli).toBeDefined();
  expect(cli?.[1].dependencies?.zod).toBeDefined();
  expect(cli?.[1].dependencies?.zod).not.toMatch(/^\^?3\./);
});
```

- [ ] **Step 2: Run it and prove it fails before the upgrade**

Run: `cd mobile && npx jest __tests__/expo-cli-zod-advisory.test.ts --runInBand`

Expected: the first test fails naming `node_modules/expo/node_modules/zod@3.25.76`; the second fails on `^3.25.76`.

- [ ] **Step 3: Commit the guard alone**

```bash
git add mobile/__tests__/expo-cli-zod-advisory.test.ts
git commit -m "test: pin the Expo CLI zod floor"
```

Do not push yet. This commit is expected to be red until Task 2 changes the lockfile.

---

### Task 2: Move the dependency graph

**Files:**
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`
- Test: `mobile/__tests__/expo-cli-zod-advisory.test.ts`

**Interfaces:**
- Consumes: the Gate Z versions.
- Produces: every zod entry at `>= 4.6.6`; no native change unless Task 3 is triggered.

- [ ] **Step 1: Stay on the upgrade branch**

You are already on `chore/expo-cli-zod4` from Task 1. Do not branch again; the guard and the
lockfile move must ship in one PR.

- [ ] **Step 2: Re-read Gate Z, then record the baseline**

```bash
cd mobile
npm view @expo/cli@latest version dependencies.zod
npm view expo@latest version dependencies.@expo/cli dependencies.expo-modules-core
node ../scripts/check-upgrade-watches.mjs
node -e 'console.log({expo: require("./node_modules/expo/package.json").version, core: require("./node_modules/expo-modules-core/package.json").version, rn: require("./node_modules/react-native/package.json").version})'
```

Expected: CLI zod range admits 4.6.6+; latest `expo`'s CLI range admits that CLI. Stop if either is false.

- [ ] **Step 3: Try the CLI-only route without touching `expo`**

The installed `expo@58.0.19` declares `@expo/cli: ^58.1.15`, so a patched `58.1.x` CLI is in range. Preview the update:

```bash
npm update @expo/cli --dry-run
```

Accept it only if the change list does **not** include `expo`, `expo-modules-core` or `react-native`. Then apply:

```bash
npm update @expo/cli
```

If the dry run moves a native package, or the patched CLI is not admitted without a new `expo`, skip to Step 4 instead.

- [ ] **Step 4: Use the SDK patch route when the CLI-only route is impossible**

Choose the first published `expo` version whose `dependencies.@expo/cli` admits the patched CLI:

```bash
npx expo install expo@~<version-from-the-gate>
npx expo install --fix
```

Do **not** run `npm audit fix` and do not add an `overrides` entry. Record the `expo`, `expo-modules-core` and `react-native` versions again; if either native field moved, Task 3 is required.

- [ ] **Step 5: Align and verify the graph**

```bash
npx expo install --check
npx expo-doctor
npm ls zod --all
npm audit --json
npx jest __tests__/expo-cli-zod-advisory.test.ts --runInBand
```

Expected:

- `expo install --check` reports no mismatches.
- `npm ls zod --all` shows no `3.25.76`; every path is `4.6.6` or newer.
- `npm audit` has no `zod` entry; the only remaining distinct advisory is `deepmerge`.
- The new test passes.

- [ ] **Step 6: Run the full mobile checks**

```bash
npx tsc --noEmit
npx eslint .
npx jest --ci
npx expo config --type public > /dev/null
npx expo export --platform android --output-dir .expo/export-zod4
```

All five must pass without weakening assertions. The export proves the CLI still resolves and bundles
the app; it writes only to ignored `.expo/` output.

- [ ] **Step 7: Decide the native boundary**

Compare the before/after values from Steps 2 and 4:

- **No native field moved** — CLI-only. Do not bump `app.json`, do not cut a build. State "no native change" in the PR.
- **`expo-modules-core` or `react-native` moved** — complete Task 3 before merging.

- [ ] **Step 8: Commit the dependency move**

```bash
git add mobile/package.json mobile/package-lock.json
git commit -m "chore: move Expo CLI to the zod-4 release"
```

---

### Task 3: Native boundary (only if `expo-modules-core` or `react-native` moved)

**Files:**
- Modify: `mobile/app.json` — version `1.0.1` → `1.0.2`
- Create: `mobile/ota-native-runtime.json`
- Test: the existing device journeys and OTA gate

**Interfaces:**
- Consumes: the native versions from Task 2.
- Produces: a binary that matches the new native modules, and a committed record for `check:ota`.

- [ ] **Step 1: Bump the runtime label**

Change `expo.version` in `mobile/app.json` from `1.0.1` to `1.0.2`. Do not change `runtimeVersion.policy`.

- [ ] **Step 2: Build a development client**

```bash
cd mobile
npx eas-cli build --profile development --platform android
```

Record the build id only after `npx eas-cli build:view <id>` resolves. Do not retry a quota refusal; the free plan allows 15 Android builds a month.

- [ ] **Step 3: Run the §27AI device pass**

Install the APK, set up `adb reverse` for ports 4000 and 8081, start the backend and Metro, then check: Firebase sign-in, AUTH-03 renewal, AUTH-04 verification, one stock-in, one stock-out, one transfer, one label print-and-scan, and logcat free of `addAuthStateListener:eventBody`.

- [ ] **Step 4: Record the native runtime and commit the boundary**

Create `mobile/ota-native-runtime.json` with the versions the build actually compiled:

```json
{
  "appVersion": "1.0.2",
  "expo": "<installed expo>",
  "expoModulesCore": "<installed expo-modules-core>",
  "reactNative": "<installed react-native>",
  "recordedAt": "<YYYY-MM-DD>",
  "builds": { "development": "<build id>" }
}
```

Commit both files first, then run the OTA gate on a clean tree:

```bash
git add mobile/app.json mobile/ota-native-runtime.json
git commit -m "chore: record the zod-4 native runtime"
cd mobile && npm run check:ota
```

Expected: no `native-record-missing` and no version mismatch. A branch warning is fine; an
uncommitted finding means the commit did not include both files. Do not publish an OTA in this task.

---

### Task 4: Update the decision record and current-status documents

**Files:**
- Modify: `docs/SECURITY_DEPENDENCY_DECISIONS.md`
- Modify: `SECURITY.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/DEVELOPMENT_ROADMAP.md`

**Interfaces:**
- Consumes: the measured versions and alert state.
- Produces: one place that says zod is closed, one that says deepmerge remains, and a new roadmap record.

- [ ] **Step 1: Update the dependency decision record**

- Remove `zod` from the open table; leave `deepmerge` only.
- Change **D-4** to cover `deepmerge` only.
- Add the next free decision row (currently **D-10**): `zod` is fixed by the published CLI/lockfile move; cite the installed versions and the gate.
- Remove `zod` from **D-8** and from the revisit triggers.
- Add evidence rows for the new `npm ls zod --all`, `npm audit`, test and watch outputs.

- [ ] **Step 2: Update current status**

- `SECURITY.md`: move `zod` from the open row to a closed note; only `deepmerge` remains open.
- `CLAUDE.md`: open items mention only `deepmerge`; note `zod` closed.
- `README.md`: one remaining Dependabot advisory.
- `docs/DEVELOPMENT_ROADMAP.md`: add the next free record (after **§27GY**) before `# 28. Phase Gate System`, with the gate, versions, native decision, commands and results. Increment the header count by one (currently `205` → `206`).

- [ ] **Step 3: Run the documentation and decision guards**

```bash
cd server
TEST_MODE=unit node --test test/phase-docs-fact-drift.test.mjs test/phase-docs-section-integrity.test.mjs test/phase-issue-record-integrity.test.mjs
cd ..
node scripts/check-secrets.mjs
node scripts/check-upgrade-watches.mjs
git diff --check
```

Expected: documentation tests pass, secret guard clean, watch reports `zod` `CLOSED`, `deepmerge` `DEFERRED`, `node-forge` `CLOSED`.

- [ ] **Step 4: Commit the records**

```bash
git add docs/SECURITY_DEPENDENCY_DECISIONS.md SECURITY.md CLAUDE.md README.md docs/DEVELOPMENT_ROADMAP.md
git commit -m "docs: record the zod-4 closure"
```

---

### Task 5: PR, CI, merge and alert closure

**Files:** none.

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin chore/expo-cli-zod4
gh pr create --base main --head chore/expo-cli-zod4 \
  --title "chore: move Expo CLI to the zod-4 release" \
  --body "Closes Dependabot alert #10 by moving @expo/cli to a published zod >= 4.6.6. Records whether the move is CLI-only or native. Verification: ..."
```

The PR body must say which route was taken and paste the Gate Z command output.

- [ ] **Step 2: Wait for the four required checks**

```bash
gh pr checks --watch --interval 15
```

Do not merge unless `server`, `mobile`, `secret-guard` and `attribution-guard` all pass.

- [ ] **Step 3: Merge and confirm the alert**

```bash
gh pr merge --merge --delete-branch
gh api repos/jeffernqwerty/ai-inventory/dependabot/alerts/10 \
  --jq '{state,fixed_at,package:.dependency.package.name}'
```

Expected: `state: "fixed"`. If it does not close within a few minutes, inspect the default-branch lockfile and the alert's manifest; do not dismiss it manually.

- [ ] **Step 4: Confirm post-merge `main` CI**

```bash
gh run list --branch main --limit 1
```

Expected: the merge-commit run completes with `success`.

---

## Rollback

Revert the single upgrade PR with `git revert <merge-sha>`, run `npm ci` in `mobile/`, and restore the previous binary if a native build was installed. Do not remove the pin guard or the Dependabot decision records: a revert should leave the gate visible, not erase the reason. The alert reopens if the reverted lockfile resolves a vulnerable zod; that is the correct signal.

## Evidence to record

- Gate Z commands and outputs, with the date.
- Diff of `expo`, `expo-modules-core`, `react-native` before/after.
- `npm ls zod --all`, `npm audit --json`, the new Jest test, typecheck, lint, full Jest.
- Whether a build was required; if so, EAS build id, device-pass notes, `ota-native-runtime.json`.
- PR number, CI run URL, merge commit, Dependabot alert #10 state and `fixed_at`.
- The new roadmap record (the next free number after §27GY) and the updated record count.
