#!/usr/bin/env node
/**
 * scripts/check-upgrade-watches.mjs — the deferred-upgrade watch list, as one command.
 *
 * WHY THIS EXISTS. The remaining deferred upgrades are not "not started": each is gated on something
 * outside this repository moving first, and the roadmap records each gate as prose to re-check by hand
 * (§27AH "Immediate next actions", §27AI Gate 0, §27AQ's measured blockers). Prose drifts; this reads
 * the registries and prints the same answers, so a session starts from a measurement instead of a
 * memory. It changes nothing — it is a read-only report.
 *
 * WHAT IT WATCHES, and what each one unblocks:
 *   1. `expo`               — `latest` must move to 58 before the SDK 58 train (§27AI) can run. The
 *                             gate is deliberately `latest`, not `next`: Expo promotes an SDK when it
 *                             is ready, and the runbook is written for that moment.
 *   2. `jest-expo`          — jest 30 arrives with the SDK 58 train, and the candidate it judges is the
 *                             one the INSTALLED SDK pins, never the registry's `latest`/`next`. The SDK
 *                             57 line (57.0.5) depends on `@jest/globals@^29.2.1`; 58.0.9 — the newest
 *                             58.x — depends on `^30.0.0`, so jest 30 is delivered by the promotion of
 *                             SDK 58 (§27AI Gate 0). This watch is where the corrected `READY` semantics
 *                             live; see the block above `decideJestExpo` for what it got wrong first.
 *   3. `typescript-eslint`  — TypeScript 7 is blocked until the linter each WORKSPACE actually resolves
 *                             declares a `typescript` peer that admits 7 — and those are two different
 *                             packages: `server/` depends on the meta package `typescript-eslint` and
 *                             never on the parser directly, while `mobile/` gets its parser from
 *                             `eslint-config-expo`, itself SDK-pinned. Measured 2026-10-11: both lines
 *                             read `>=4.8.4 <6.1.0`, so no published 9.x admits 7 on either path.
 *   4. `zod` (advisory)    — GHSA-mrhx-c7xc-m3w5 is inside the 3.x line `@expo/cli` declares and only
 *                             4.6.6+ is patched, so a fix is one Expo release away (§27FJ). `READY`
 *                             means a patched release the CLI's own range admits exists: a plain bump.
 *   5. `node-forge` (advisory) — GHSA-86w9-cpqp-85rv had **no patched release** until 1.4.2 was
 *                             published outside the `<= 1.4.0` range and admitted by the code-signing
 *                             consumer. That bump was taken on 2026-10-30 (mobile/package-lock.json),
 *                             so this watch now reports `CLOSED` for the installed tree (§27GX).
 *   6. `deepmerge` (advisory) — GHSA-gcqx-w48m-w2h4 has **no patched release**: 4.3.1 is both the
 *                             newest and inside `>= 4.2.0 <= 4.3.1`, so this stays `DEFERRED` until
 *                             one is published and `@expo/config`'s `^4.3.1` range admits it (§27GX).
 *
 * HOW TO RUN. `node scripts/check-upgrade-watches.mjs` (add `--json` for machine output, `--self-test`
 * to run the controls alone). It needs the network and is deliberately NOT part of CI: a pipeline that
 * fails when npm is unreachable would turn an upstream outage into a red build. Exit code is 0 for
 * "report produced" — a watch being READY is news, not a failure of this script. The one non-zero exit
 * is a **failed control**, which stops the report before it is printed, so a broken rule can never be
 * read as a clean bill of health (§27AR's rule, applied here).
 *
 * WHAT IT DOES NOT DO: it never installs, never edits `package.json`, and never decides. `READY` means
 * the gate recorded in the roadmap can be started, nothing more.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';

/** The slice of semver this file needs — deliberately narrow, and stated rather than approximated. */
function majorOf(version) {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : NaN;
}

/**
 * Does a simple range admit `version`? Handles exactly the forms the watched packages publish:
 * `^X.y.z`, `~X.y.z`, an exact version, and `>=A <B` (possibly `||`-joined). Anything else is
 * reported as "unparsed" rather than silently called a pass, because a wrong answer here would be
 * worse than no answer.
 */
function rangeAdmits(range, version) {
  const target = majorOf(version);
  if (Number.isNaN(target)) return { ok: false, unparsed: true };
  const clauses = String(range)
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (clause.startsWith('^')) {
      const floor = clause.slice(1);
      if (majorOf(floor) === target && compareMajorMinor(floor, version) <= 0) return { ok: true };
    } else if (clause.startsWith('~')) {
      const floor = clause.slice(1);
      if (majorOf(floor) === target && minorOf(floor) === minorOf(version) && compareMajorMinor(floor, version) <= 0) {
        return { ok: true };
      }
    } else if (/^\d+\.\d+\.\d+/.test(clause)) {
      if (clause === version) return { ok: true };
    } else if (clause.includes('>=') || clause.includes('<')) {
      const bounds = clause.split(/\s+/).filter(Boolean);
      let lowerOk = true;
      let upperOk = true;
      for (const bound of bounds) {
        if (bound.startsWith('>=') && compareSemver(bound.slice(2), version) > 0) lowerOk = false;
        if (bound.startsWith('<') && compareSemver(bound.slice(1), version) <= 0) upperOk = false;
      }
      if (lowerOk && upperOk) return { ok: true };
    } else {
      return { ok: false, unparsed: true, clause };
    }
  }
  return { ok: false };
}

function minorOf(version) {
  const m = /^\d+\.(\d+)\./.exec(version);
  return m ? Number(m[1]) : NaN;
}

/** Numeric compare of `a.b.c`-style versions (prerelease tags ignored — none are watched here). */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const compareMajorMinor = (a, b) => compareSemver(a, b);

// ---------------------------------------------------------------------------
// The jest-expo gate — what the SDK owns, and the false READY this corrects
// ---------------------------------------------------------------------------
//
// THE BUG THIS REPLACES. The first version of this watch asked the registry whether ANY jest-expo
// release admitted jest 30, reading `latest` and `next`, and set READY when one did. It found that
// `next` (58.0.9) depends on `@jest/globals@^30.0.0` and therefore printed **READY** on 2026-10-11 —
// while the SDK 58 promotion the roadmap gates jest 30 on (§27AI Gate 0) was still closed. The result
// was an instruction to take `jest-expo@58.0.9` onto Expo 57, and that version is not installable
// here: it also peers `@react-native/jest-preset@^0.88.0-rc.4` — SDK 58's React Native line, a release
// candidate — against this project's RN 0.86.3. That is the ISS-16 / ISS-17 class of change, both of
// which were declined for exactly this reason. The file's own header already said jest 30 "arrives with
// the SDK 58 train"; only the code disagreed. §27AQ recorded both the READY and the SDK-promotion
// sentence, one line apart, without noticing they contradict each other.
//
// WHY `next` WAS THE WRONG PLACE TO LOOK. The `expo` watch above reads only `latest` on the stated
// principle that "Expo promotes an SDK when it is ready". Reading a *prerelease* tag on a *pinned*
// package and calling it a green light applied the opposite rule to the same decision.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJsonIfPresent(absolutePath) {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What the installed mobile workspace actually has. Read from `node_modules` rather than from
 * `package.json`, because the pin table that owns these versions is the installed SDK's, and the RN
 * version that must satisfy a preset peer is the one that would run the tests.
 */
function readInstalledMobileFacts() {
  const sdkManifest = readJsonIfPresent(join(REPO_ROOT, 'mobile/node_modules/expo/package.json'));
  const pins = readJsonIfPresent(join(REPO_ROOT, 'mobile/node_modules/expo/bundledNativeModules.json'));
  const reactNative = readJsonIfPresent(join(REPO_ROOT, 'mobile/node_modules/react-native/package.json'));
  const jestPreset = readJsonIfPresent(join(REPO_ROOT, 'mobile/node_modules/@react-native/jest-preset/package.json'));
  const eslintConfigExpo = readJsonIfPresent(join(REPO_ROOT, 'mobile/node_modules/eslint-config-expo/package.json'));
  return {
    sdkVersion: sdkManifest?.version ?? null,
    jestExpoPin: pins?.['jest-expo'] ?? null,
    installedReactNative: reactNative?.version ?? null,
    installedJestPreset: jestPreset?.version ?? null,
    sdkEslintConfigExpoPin: pins?.['eslint-config-expo'] ?? null,
    installedEslintConfigExpo: eslintConfigExpo?.version ?? null,
    // The parser range `mobile/` may actually resolve. mobile/ never declares the parser itself, so its
    // own package.json cannot answer this — the import in `eslint.config.js` is `eslint-config-expo`.
    mobileParserRange: eslintConfigExpo?.dependencies?.['@typescript-eslint/parser'] ?? null,
  };
}

/** A dependency range declared in one of the workspace manifests, or `null`. */
function readDeclaredRange(relativeManifestPath, packageName) {
  const manifest = readJsonIfPresent(join(REPO_ROOT, relativeManifestPath));
  return manifest?.devDependencies?.[packageName] ?? manifest?.dependencies?.[packageName] ?? null;
}

/** The newest published version a simple range admits, or `null` when none does. */
function newestSatisfying(versions, range) {
  const admitted = versions.filter((version) => rangeAdmits(range, version).ok);
  if (!admitted.length) return null;
  return admitted.reduce((best, version) => (compareSemver(version, best) > 0 ? version : best));
}

/** The release triple of a version, prerelease tags dropped (`0.88.0-rc.4` → `0.88.0`). */
function releaseTriple(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Does the installed React Native reach the line a candidate's `@react-native/jest-preset` peer asks
 * for? Compared as release triples with prerelease tags dropped: the question is whether the installed
 * RN is at least the line the preset was built for, and for these `0.x` peers — npm's caret caps within
 * the minor — that floor comparison is the question. Anything unreadable answers `false`, never a pass,
 * so an unrecognised range defers the watch instead of clearing it.
 */
function rnPresetAdmits(range, installedReactNative) {
  if (typeof range !== 'string' || !installedReactNative) return false;
  const floor = /(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)/.exec(range.trim());
  if (!floor) return false;
  const installed = releaseTriple(installedReactNative);
  if (!installed) return false;
  return compareSemver(installed, releaseTriple(floor[1])) >= 0;
}

/**
 * The jest-expo gate as a pure function, so the controls below can drive it without the network.
 * `READY` requires BOTH halves: the installed SDK's own pin must reach a jest-30 line AND that
 * version's RN jest-preset peer must be satisfied here. The jest range alone was the wrong question.
 * Returns `{ status, detail }` with `status` one of `READY` / `DEFERRED` / `UNREADABLE`, and
 * `UNREADABLE` is never a pass.
 */
/**
 * The TypeScript 7 gate, per workspace, as a pure function so the controls can drive it.
 *
 * THE BUG THIS REPLACES. The first version read `@typescript-eslint/parser`'s `latest` and reported its
 * `typescript` peer for both workspaces. **Neither workspace depends on that package.** `server/`
 * depends on the meta package `typescript-eslint@^8.71.1`, and `mobile/` resolves the parser only
 * through `eslint-config-expo@57.0.2` (`^8.59.0`) — a package the SDK pins. The old question therefore
 * could not see a `typescript-eslint` 9.x that admits 7, and would have reported READY off a parser
 * release `mobile/` cannot load even if it existed. It answered correctly on 2026-10-11 by coincidence:
 * both lines happened to read `>=4.8.4 <6.1.0`.
 *
 * THE ASYMMETRY IS DELIBERATE, and it is the same rule the jest-expo gate uses — **the constraint the
 * project cannot choose is the gate.** `mobile/`'s parser arrives through the SDK-pinned
 * `eslint-config-expo`, so mobile's answer is resolved through that chain. `server/` declares the meta
 * package itself, so the project can bump it as part of taking TypeScript 7 and the gate is simply
 * whether a published release admits 7. `READY` needs both halves, and an unreadable input is never a
 * pass.
 */
function decideTypescript7({
  serverRange,
  serverLatest,
  serverPeer,
  sdkEslintConfigExpoPin,
  installedEslintConfigExpo,
  mobileParserRange,
  mobileParser,
  mobilePeer,
}) {
  const serverLine = `server: typescript-eslint declared ${serverRange ?? '(none)'}, latest ${serverLatest ?? '(unreadable)'} peer typescript=${serverPeer ?? '(missing)'}`;
  const mobileLine = mobileParserRange
    ? `mobile: eslint-config-expo ${installedEslintConfigExpo ?? '(unreadable)'} (SDK pins ${sdkEslintConfigExpoPin ?? '(none)'}) resolves parser ${mobileParser ?? '(none)'} peer typescript=${mobilePeer ?? '(missing)'}`
    : 'mobile: eslint-config-expo declares no @typescript-eslint/parser range (unreadable)';
  const detail = `${serverLine} | ${mobileLine}`;

  if (!serverLatest || !mobileParserRange) {
    return { status: 'UNREADABLE', detail: `${detail} — an input could not be read` };
  }

  const serverVerdict = rangeAdmits(serverPeer, '7.0.0');
  const mobileVerdict = rangeAdmits(mobilePeer, '7.0.0');
  if (serverVerdict.unparsed || mobileVerdict.unparsed) {
    return { status: 'UNREADABLE', detail: `${detail} — an unparsed peer range` };
  }
  if (serverVerdict.ok && mobileVerdict.ok) return { status: 'READY', detail };

  const blockers = [];
  if (!serverVerdict.ok) blockers.push('the server `typescript-eslint` line');
  if (!mobileVerdict.ok) blockers.push('the SDK-pinned `eslint-config-expo` line for mobile');
  return { status: 'DEFERRED', detail: `${detail} — TypeScript 7 waits on ${blockers.join(' and ')}` };
}

function decideJestExpo({ pin, installedReactNative, inLineVersion, inLineManifest, newestPublished, newestManifest }) {
  const newer =
    newestPublished && newestManifest
      ? `${newestPublished} (peer @react-native/jest-preset ${newestManifest.peerDependencies?.['@react-native/jest-preset'] ?? '(none)'})`
      : 'n/a';
  const suffix = `installed react-native=${installedReactNative ?? '(unreadable)'}; newest published stable: ${newer}`;

  if (!pin) return { status: 'UNREADABLE', detail: `the installed SDK declares no jest-expo pin — ${suffix}` };
  if (!inLineVersion || !inLineManifest) {
    return { status: 'DEFERRED', detail: `the pin ${pin} admits no published jest-expo — ${suffix}` };
  }

  const jestRange = inLineManifest.dependencies?.['@jest/globals'] ?? inLineManifest.dependencies?.['babel-jest'] ?? null;
  const jestVerdict = rangeAdmits(jestRange, '30.0.0');
  if (jestVerdict.unparsed) {
    return { status: 'UNREADABLE', detail: `unparsed jest range ${String(jestRange)} on pinned ${inLineVersion} — ${suffix}` };
  }

  const presetPeer = inLineManifest.peerDependencies?.['@react-native/jest-preset'] ?? null;
  const presetOk = rnPresetAdmits(presetPeer, installedReactNative);

  if (jestVerdict.ok && presetOk) {
    return {
      status: 'READY',
      detail: `pinned ${inLineVersion}: @jest/globals=${jestRange}, preset peer ${presetPeer} satisfied by react-native ${installedReactNative} — ${suffix}`,
    };
  }
  if (jestVerdict.ok) {
    return {
      status: 'DEFERRED',
      detail: `pinned ${inLineVersion} admits jest 30 but its preset peer ${presetPeer ?? '(none)'} is not satisfied by react-native ${installedReactNative} — ${suffix}`,
    };
  }
  return {
    status: 'DEFERRED',
    detail: `pinned ${inLineVersion}: @jest/globals=${jestRange ?? '(missing)'} — no jest 30 on the installed SDK's line — ${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Advisory gates (§27FJ) — a patch a bump cannot take, because the consumer will not admit it
// ---------------------------------------------------------------------------
//
// WHY THESE ARE WATCHES AND NOT OVERRIDES. Two high advisories sit inside Expo's build tooling:
// zod@3.25.76 under expo → @expo/cli (GHSA-mrhx-c7xc-m3w5 — patched only in 4.6.6+, while the CLI
// declares ^3.25.76), and node-forge@1.4.0 under expo-updates → @expo/code-signing-certificates and
// @expo/cli (GHSA-86w9-cpqp-85rv — no patched release published at all). Neither is in a shipped
// bundle, and that was measured rather than assumed: expo-updates' own runtime JS never references the
// code-signing package, the only importer of node-forge outside itself is @expo/cli's iOS signing
// path, and zod is reached by @expo/cli only through its DevTools-plugin schema. An overrides entry
// could force a version past each consumer's declared range — and that is exactly the unreviewed
// upgrade this project refuses: it would silence two alerts by breaking a build tool's dependency
// contract, for code that never runs in the app.
//
// The honest question is narrower and mechanical: is there a published release outside the advisory's
// range that the consumer itself admits? When both hold, a plain bump closes the alert with no
// override. Until then the alert stays open — not dismissed — and this line says why.

/**
 * Is `version` inside a vulnerable range? The inverse is "patched".
 *
 * Needed because the public advisory API does **not** always carry `first_patched_version` — measured
 * on both advisories this file now watches: Dependabot's alert for zod reports `4.6.6` while the public
 * advisory answers `null`, and node-forge has no patched release to report at all. The range it does
 * carry is authoritative and exact, so the floor is derived from it instead: a release is patched when
 * the advisory's own range does not admit it.
 *
 * Handles the forms npm advisories publish for this (`<= A`, `< A`, `>= A`, `> A`, and space-separated
 * compounds). Anything else answers `{ known: false }`, and the caller reports UNREADABLE rather than
 * guessing — a wrong "patched" would close a security alert that should have stayed open.
 */
function vulnerableAdmits(range, version) {
  const clauses = String(range)
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!clauses.length) return { known: false };

  for (const clause of clauses) {
    // Operator and version are TIGHTENED from a single expression rather than split on whitespace: the
    // first version of this split a `<=` bound on whitespace, gave the operator an empty version, and
    // reported the whole range unparsed — which the controls below caught, not the report.
    const bounds = [...clause.matchAll(/(<=|>=|<|>)\s*([0-9][^\s]*)/g)];
    if (!bounds.length) return { known: false, clause };
    const consumed = bounds.map(([, op, bound]) => `${op}${bound}`).join('');
    // Anything the expression did not consume is a form this file has not been taught — a git or
    // workspace range, say. Reported, never treated as "not vulnerable".
    if (consumed !== clause.replace(/\s+/g, '')) return { known: false, clause };

    const all = bounds.every(([, operator, bound]) => {
      const comparison = compareSemver(version, bound);
      if (operator === '<=') return comparison <= 0;
      if (operator === '<') return comparison < 0;
      if (operator === '>=') return comparison >= 0;
      return comparison > 0;
    });
    if (all) return { known: true, admitted: true };
  }
  return { known: true, admitted: false };
}

/**
 * The newest stable (three-part) release in a packument, or null.
 */
function newestStableRelease(packument) {
  const versions = Object.keys(packument?.versions ?? {}).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  return versions.reduce((best, version) => (best && compareSemver(version, best) <= 0 ? best : version), null);
}

/**
 * One advisory, one gate, as a pure function so the controls can drive it without the network.
 *
 * first_patched_version is preferred when the advisory carries one; when it does not (measured: it is
 * null for node-forge) the vulnerable range decides, and a release the range no longer admits counts
 * as patched. READY needs the second half as well — a release the CONSUMER's own declared range
 * admits — because that is the half an override would have to fake.
 */
function decideAdvisoryUpgrade({ newestPublished, firstPatchedVersion, vulnerableRange, consumerName, consumerRange, installedVersion = null }) {
  if (!newestPublished) return { status: 'UNREADABLE', detail: 'no published release could be read' };

  // The installed tree is the first thing that decides whether there is anything left to do. A gate
  // that keeps saying READY after its bump landed would send the next session to re-take a fix that is
  // already in the lockfile, so an installed release outside the vulnerable range reports CLOSED.
  const installed = installedVersion && vulnerableRange ? vulnerableAdmits(vulnerableRange, installedVersion) : null;
  if (installed?.known && installed.admitted === false) {
    return {
      status: 'CLOSED',
      detail: `installed ${installedVersion} is already outside the vulnerable range (${vulnerableRange}) — no bump is needed`,
    };
  }

  const byRange = firstPatchedVersion ? null : vulnerableAdmits(vulnerableRange ?? '', newestPublished);
  if (!firstPatchedVersion && !byRange?.known) {
    return {
      status: 'UNREADABLE',
      detail: `the advisory carries neither a patched version nor a usable range (${vulnerableRange ?? '(none)'}) — newest published: ${newestPublished}`,
    };
  }
  const patched = firstPatchedVersion
    ? compareSemver(newestPublished, firstPatchedVersion) >= 0
    : byRange.admitted === false;
  const floorWhy = firstPatchedVersion ? `patched floor ${firstPatchedVersion}` : `outside advisory range ${vulnerableRange}`;

  if (!patched) {
    return {
      status: 'DEFERRED',
      detail: `the newest published release ${newestPublished} is still inside the vulnerable range (${floorWhy})`,
    };
  }
  if (!consumerRange) {
    return {
      status: 'UNREADABLE',
      detail: `${newestPublished} is patched (${floorWhy}) but ${consumerName} declares no dependency on it, so there is nothing to bump against`,
    };
  }

  const verdict = rangeAdmits(consumerRange, newestPublished);
  if (verdict.unparsed) {
    return {
      status: 'UNREADABLE',
      detail: `${newestPublished} is patched (${floorWhy}) but ${consumerName} declares ${consumerRange}, which this file cannot parse`,
    };
  }
  if (!verdict.ok) {
    return {
      status: 'DEFERRED',
      detail: `${newestPublished} is patched (${floorWhy}) but ${consumerName} declares ${consumerRange} — a bump cannot reach it; closing it would need an override`,
    };
  }
  return {
    status: 'READY',
    detail: `${newestPublished} is patched (${floorWhy}) AND ${consumerName} declares ${consumerRange} — a plain bump closes the alert`,
  };
}

const ZOD_ADVISORY = 'GHSA-mrhx-c7xc-m3w5';
const NODE_FORGE_ADVISORY = 'GHSA-86w9-cpqp-85rv';
const DEEPMERGE_ADVISORY = 'GHSA-gcqx-w48m-w2h4';

/**
 * Read the advisory and the registry, then judge against the range the INSTALLED consumer declares.
 * The first manifest that declares the package wins, so the answer describes the tree this workspace
 * would actually install.
 */
async function readAdvisoryGate(packageName, advisoryId, consumerManifestPaths, consumerPackage, installedManifestPaths = []) {
  const advisory = await getJson(`https://api.github.com/advisories/${advisoryId}`);
  const npmEntry = (advisory.vulnerabilities ?? []).find(
    (v) => v.package?.ecosystem === 'npm' && v.package?.name === packageName
  );
  const newestPublished = newestStableRelease(await getJson(`${REGISTRY}/${scoped(packageName)}`));

  let installedVersion = null;
  for (const relativePath of installedManifestPaths) {
    const manifest = readJsonIfPresent(join(REPO_ROOT, relativePath));
    if (manifest?.version) {
      installedVersion = manifest.version;
      break;
    }
  }

  let consumerRange = null;
  let consumerName = consumerPackage;
  for (const relativePath of consumerManifestPaths) {
    const manifest = readJsonIfPresent(join(REPO_ROOT, relativePath));
    const range = manifest?.dependencies?.[packageName] ?? null;
    if (range) {
      consumerRange = range;
      consumerName = `${consumerPackage}@${manifest.version ?? '(unreadable)'}`;
      break;
    }
  }

  const firstPatchedVersion = npmEntry?.first_patched_version?.identifier ?? null;
  const vulnerableRange = npmEntry?.vulnerable_version_range ?? null;
  const { status, detail } = decideAdvisoryUpgrade({
    newestPublished,
    firstPatchedVersion,
    vulnerableRange,
    consumerName,
    consumerRange,
    installedVersion,
  });
  return {
    detail: `${detail} | advisory range: ${vulnerableRange ?? '(unreadable)'}, firstPatched: ${firstPatchedVersion ?? '(none published)'}, installed: ${installedVersion ?? '(unreadable)'}`,
    ready: status === 'READY',
    closed: status === 'CLOSED',
    unparsed: status === 'UNREADABLE',
    unblocks: `closing ${advisoryId} in mobile/ without an override`,
  };
}


async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const scoped = (name) => name.replace('/', '%2f');

/** Each watch: what to read, what READY means, and what it unblocks. */
const WATCHES = [
  {
    name: 'expo',
    gate: 'SDK 58 train (§27AI) — `latest` must be 58',
    async read() {
      const tags = await getJson(`${REGISTRY}/-/package/expo/dist-tags`);
      const latest = tags.latest;
      return {
        detail: `dist-tags: latest=${latest} next=${tags.next ?? '(none)'}`,
        ready: majorOf(latest) >= 58,
        unblocks: 'the SDK 58 upgrade runbook',
      };
    },
  },
  {
    name: 'jest-expo',
    gate: "jest 30 — the INSTALLED SDK's own jest-expo pin must reach a jest-30 line, installable here",
    async read() {
      const facts = readInstalledMobileFacts();
      const packument = await getJson(`${REGISTRY}/jest-expo`);
      const versions = Object.keys(packument.versions ?? {});
      const stable = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version));
      const newestPublished = stable.reduce(
        (best, version) => (best && compareSemver(version, best) <= 0 ? best : version),
        null
      );
      const newestManifest = newestPublished ? await getJson(`${REGISTRY}/jest-expo/${newestPublished}`) : null;
      const inLineVersion = newestSatisfying(versions, facts.jestExpoPin);
      const inLineManifest = inLineVersion ? await getJson(`${REGISTRY}/jest-expo/${inLineVersion}`) : null;

      const { status, detail } = decideJestExpo({
        pin: facts.jestExpoPin,
        installedReactNative: facts.installedReactNative,
        inLineVersion,
        inLineManifest,
        newestPublished,
        newestManifest,
      });
      return {
        detail: `installed SDK ${facts.sdkVersion ?? '(unreadable)'} pins jest-expo ${facts.jestExpoPin ?? '(none)'} | ${detail}`,
        ready: status === 'READY',
        unparsed: status === 'UNREADABLE',
        unblocks: 'jest 30 in mobile/',
      };
    },
  },
  {
    name: 'typescript-eslint',
    gate: 'TypeScript 7 — the linter EACH workspace resolves must declare a typescript peer that admits 7',
    async read() {
      const facts = readInstalledMobileFacts();
      const serverRange = readDeclaredRange('server/package.json', 'typescript-eslint');
      const serverManifest = await getJson(`${REGISTRY}/${scoped('typescript-eslint')}/latest`);
      const parserVersions = Object.keys(
        (await getJson(`${REGISTRY}/${scoped('@typescript-eslint/parser')}`)).versions ?? {}
      );
      const mobileParser = facts.mobileParserRange
        ? newestSatisfying(parserVersions, facts.mobileParserRange)
        : null;
      const mobileManifest = mobileParser
        ? await getJson(`${REGISTRY}/${scoped('@typescript-eslint/parser')}/${mobileParser}`)
        : null;

      const { status, detail } = decideTypescript7({
        serverRange,
        serverLatest: serverManifest.version,
        serverPeer: serverManifest.peerDependencies?.typescript ?? null,
        sdkEslintConfigExpoPin: facts.sdkEslintConfigExpoPin,
        installedEslintConfigExpo: facts.installedEslintConfigExpo,
        mobileParserRange: facts.mobileParserRange,
        mobileParser,
        mobilePeer: mobileManifest?.peerDependencies?.typescript ?? null,
      });
      return {
        detail,
        ready: status === 'READY',
        unparsed: status === 'UNREADABLE',
        unblocks: 'TypeScript 7 in mobile/ and server/',
      };
    },
  },
  {
    name: 'zod (advisory)',
    gate: `${ZOD_ADVISORY} — a release outside the vulnerable range that @expo/cli itself admits; only 4.6.6+ is patched and the CLI declares ^3.25.76`,
    async read() {
      return readAdvisoryGate(
        'zod',
        ZOD_ADVISORY,
        [
          'mobile/node_modules/expo/node_modules/@expo/cli/package.json',
          'mobile/node_modules/@expo/cli/package.json',
        ],
        '@expo/cli',
        [
          'mobile/node_modules/expo/node_modules/zod/package.json',
          'mobile/node_modules/zod/package.json',
        ]
      );
    },
  },
  {
    name: 'node-forge (advisory)',
    gate: `${NODE_FORGE_ADVISORY} — a release outside <= 1.4.0 must be published AND admitted by the code-signing consumer; taken on 2026-10-30 (1.4.2)`,
    async read() {
      return readAdvisoryGate(
        'node-forge',
        NODE_FORGE_ADVISORY,
        [
          'mobile/node_modules/@expo/code-signing-certificates/package.json',
          'mobile/node_modules/@expo/cli/package.json',
        ],
        '@expo/code-signing-certificates',
        ['mobile/node_modules/node-forge/package.json']
      );
    },
  },
  {
    name: 'deepmerge (advisory)',
    gate: `${DEEPMERGE_ADVISORY} — a release outside >= 4.2.0 <= 4.3.1 AND admitted by the config or jest consumer; none is published`,
    async read() {
      return readAdvisoryGate(
        'deepmerge',
        DEEPMERGE_ADVISORY,
        [
          'mobile/node_modules/@expo/config/package.json',
          'mobile/node_modules/jest-config/package.json',
        ],
        '@expo/config',
        ['mobile/node_modules/deepmerge/package.json']
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Controls — the correction's own proof
// ---------------------------------------------------------------------------
//
// The §27AR standard: a check that cannot fail proves nothing. The pair that matters is the last two
// must-not-fire cases — a version that admits jest 30 but whose RN preset this project cannot resolve
// must DEFER — and the must-fire case in which the same candidate on an SDK whose line IS RN 0.88
// turns READY. Without that pair, the fix would be a rule that only ever says DEFERRED.

const controlManifest = (jestRange, presetPeer) => ({
  dependencies: jestRange === undefined ? {} : { '@jest/globals': jestRange },
  peerDependencies: presetPeer === undefined ? {} : { '@react-native/jest-preset': presetPeer },
});

const CONTROLS = [
  {
    name: 'the installed SDK 57 line is not a jest-30 candidate (must not fire)',
    run: () =>
      decideJestExpo({
        pin: '~57.0.5',
        installedReactNative: '0.86.3',
        inLineVersion: '57.0.5',
        inLineManifest: controlManifest('^29.2.1', '^0.86.3'),
        newestPublished: '58.0.9',
        newestManifest: controlManifest('^30.0.0', '^0.88.0-rc.4'),
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'the false READY this fixes — jest 30 admitted, RN preset unreachable (must not fire)',
    run: () =>
      decideJestExpo({
        pin: '~58.0.9',
        installedReactNative: '0.86.3',
        inLineVersion: '58.0.9',
        inLineManifest: controlManifest('^30.0.0', '^0.88.0-rc.4'),
        newestPublished: '58.0.9',
        newestManifest: controlManifest('^30.0.0', '^0.88.0-rc.4'),
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'the promotion — same candidate on an SDK line that is RN 0.88 (must fire)',
    run: () =>
      decideJestExpo({
        pin: '~58.0.9',
        installedReactNative: '0.88.0',
        inLineVersion: '58.0.9',
        inLineManifest: controlManifest('^30.0.0', '^0.88.0-rc.4'),
        newestPublished: '58.0.9',
        newestManifest: controlManifest('^30.0.0', '^0.88.0-rc.4'),
      }),
    expect: 'READY',
  },
  {
    name: 'a pin with no published match (must not fire)',
    run: () => decideJestExpo({ pin: '~99.0.0', installedReactNative: '0.86.3', inLineVersion: null, inLineManifest: null }),
    expect: 'DEFERRED',
  },
  {
    name: 'no jest-expo pin at all — reported, never passed',
    run: () => decideJestExpo({ pin: null, installedReactNative: '0.86.3' }),
    expect: 'UNREADABLE',
  },
  {
    name: 'an unparsed jest range — reported, never passed',
    run: () =>
      decideJestExpo({
        pin: '~57.0.5',
        installedReactNative: '0.86.3',
        inLineVersion: '57.0.5',
        inLineManifest: controlManifest('workspace:^', '^0.86.3'),
      }),
    expect: 'UNREADABLE',
  },
  {
    name: 'an unreadable RN preset peer defers rather than clearing (must not fire)',
    run: () =>
      decideJestExpo({
        pin: '~58.0.9',
        installedReactNative: '0.88.0',
        inLineVersion: '58.0.9',
        inLineManifest: controlManifest('^30.0.0', undefined),
        newestPublished: '58.0.9',
        newestManifest: controlManifest('^30.0.0', undefined),
      }),
    expect: 'DEFERRED',
  },
];

const RANGE_CONTROLS = [
  {
    name: 'newestSatisfying picks the SDK line, not the newest overall',
    run: () => newestSatisfying(['57.0.4', '57.0.5', '58.0.9'], '~57.0.5'),
    expect: '57.0.5',
  },
  {
    name: 'newestSatisfying reports an empty line as null',
    run: () => newestSatisfying(['57.0.4', '58.0.9'], '~57.0.9'),
    expect: null,
  },
];

/**
 * The second control set, for the TypeScript 7 gate. Its must-not-fire pair is the whole point: a
 * `typescript-eslint` release that admits 7 must still DEFER while mobile's SDK-pinned chain resolves a
 * parser that does not, which is the case the version this replaced could not see at all.
 */
const TYPESCRIPT7_CONTROLS = [
  {
    name: 'both the server meta package and the mobile chain sit on the 8.x line (must not fire)',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '8.71.1',
        serverPeer: '>=4.8.4 <6.1.0',
        sdkEslintConfigExpoPin: '~57.0.2',
        installedEslintConfigExpo: '57.0.2',
        mobileParserRange: '^8.59.0',
        mobileParser: '8.71.1',
        mobilePeer: '>=4.8.4 <6.1.0',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'the bug — a 7-admitting release exists but mobile cannot load it (must not fire)',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '9.0.0',
        serverPeer: '>=4.8.4 <7.1.0',
        sdkEslintConfigExpoPin: '~57.0.2',
        installedEslintConfigExpo: '57.0.2',
        mobileParserRange: '^8.59.0',
        mobileParser: '8.71.1',
        mobilePeer: '>=4.8.4 <6.1.0',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'the server meta package is the only blocker (must not fire)',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '8.71.1',
        serverPeer: '>=4.8.4 <6.1.0',
        sdkEslintConfigExpoPin: '~58.0.0',
        installedEslintConfigExpo: '58.0.2',
        mobileParserRange: '^9.0.0',
        mobileParser: '9.0.0',
        mobilePeer: '>=4.8.4 <7.1.0',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'both paths admit 7 (must fire)',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '9.0.0',
        serverPeer: '>=4.8.4 <7.1.0',
        sdkEslintConfigExpoPin: '~58.0.0',
        installedEslintConfigExpo: '58.0.2',
        mobileParserRange: '^9.0.0',
        mobileParser: '9.0.0',
        mobilePeer: '>=4.8.4 <7.1.0',
      }),
    expect: 'READY',
  },
  {
    name: 'a missing mobile parser range is reported, never passed',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '9.0.0',
        serverPeer: '>=4.8.4 <7.1.0',
        sdkEslintConfigExpoPin: '~57.0.2',
        installedEslintConfigExpo: '57.0.2',
        mobileParserRange: null,
        mobileParser: null,
        mobilePeer: null,
      }),
    expect: 'UNREADABLE',
  },
  {
    name: 'an unparsed peer range is reported, never passed',
    run: () =>
      decideTypescript7({
        serverRange: '^8.71.1',
        serverLatest: '8.71.1',
        serverPeer: 'workspace:^',
        sdkEslintConfigExpoPin: '~57.0.2',
        installedEslintConfigExpo: '57.0.2',
        mobileParserRange: '^8.59.0',
        mobileParser: '8.71.1',
        mobilePeer: '>=4.8.4 <6.1.0',
      }),
    expect: 'UNREADABLE',
  },
];

/**
 * The advisory gates' controls. The must-fire pair is the point: a patched release the consumer admits
 * turns READY in BOTH shapes — a published first_patched_version (zod) and a range-only advisory
 * (node-forge) — so the rule is not a switch that can only ever say DEFERRED. The live shapes sit
 * beside them as must-not-fire.
 */
const ADVISORY_CONTROLS = [
  {
    name: 'the live zod shape — patched 4.6.x exists, @expo/cli declares ^3.25.76 (must not fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '4.6.7',
        firstPatchedVersion: '4.6.6',
        vulnerableRange: '< 4.6.6',
        consumerName: '@expo/cli@58.1.13',
        consumerRange: '^3.25.76',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'Expo moves to zod 4 and admits the patched release (must fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '4.6.7',
        firstPatchedVersion: '4.6.6',
        vulnerableRange: '< 4.6.6',
        consumerName: '@expo/cli@58.2.0',
        consumerRange: '^4.6.6',
      }),
    expect: 'READY',
  },
  {
    name: 'the live node-forge shape — no patched release, 1.4.0 is inside the range (must not fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '1.4.0',
        firstPatchedVersion: null,
        vulnerableRange: '<= 1.4.0',
        consumerName: '@expo/code-signing-certificates@0.0.7',
        consumerRange: '^1.4.0',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'the post-fix node-forge shape — installed 1.4.2 is outside <= 1.4.0 (must report CLOSED)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '1.4.2',
        firstPatchedVersion: null,
        vulnerableRange: '<= 1.4.0',
        consumerName: '@expo/code-signing-certificates@0.0.7',
        consumerRange: '^1.4.0',
        installedVersion: '1.4.2',
      }),
    expect: 'CLOSED',
  },
  {
    name: 'the live deepmerge shape — 4.3.1 is the newest and inside the range (must not fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '4.3.1',
        firstPatchedVersion: null,
        vulnerableRange: '>= 4.2.0 <= 4.3.1',
        consumerName: '@expo/config@58.0.8',
        consumerRange: '^4.3.1',
        installedVersion: '4.3.1',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'node-forge publishes 1.4.1 into the consumer range (must fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '1.4.1',
        firstPatchedVersion: null,
        vulnerableRange: '<= 1.4.0',
        consumerName: '@expo/code-signing-certificates@0.0.7',
        consumerRange: '^1.4.0',
      }),
    expect: 'READY',
  },
  {
    name: 'patched, but the consumer range cannot reach it (must not fire)',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '2.0.0',
        firstPatchedVersion: '2.0.0',
        vulnerableRange: '< 2.0.0',
        consumerName: 'consumer@1.0.0',
        consumerRange: '^1.0.0',
      }),
    expect: 'DEFERRED',
  },
  {
    name: 'patched, but the consumer range is unparseable — reported, never passed',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '4.6.7',
        firstPatchedVersion: '4.6.6',
        vulnerableRange: '< 4.6.6',
        consumerName: 'consumer@1.0.0',
        consumerRange: 'workspace:*',
      }),
    expect: 'UNREADABLE',
  },
  {
    name: 'no patched version and no usable range — reported, never passed',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '1.0.0',
        firstPatchedVersion: null,
        vulnerableRange: null,
        consumerName: 'consumer@1.0.0',
        consumerRange: '^1.0.0',
      }),
    expect: 'UNREADABLE',
  },
  {
    name: 'patched, but no consumer declares the package — reported, never passed',
    run: () =>
      decideAdvisoryUpgrade({
        newestPublished: '4.6.7',
        firstPatchedVersion: '4.6.6',
        vulnerableRange: '< 4.6.6',
        consumerName: 'consumer',
        consumerRange: null,
      }),
    expect: 'UNREADABLE',
  },
];

/** Everything the controls assert, in one list, so the summary counts are read from one place. */
const ALL_STATE_CONTROLS = [...CONTROLS, ...TYPESCRIPT7_CONTROLS, ...ADVISORY_CONTROLS];

const render = (value) => (value === null ? 'null' : JSON.stringify(value));

function runControls() {
  const failures = [];
  for (const control of [...ALL_STATE_CONTROLS, ...RANGE_CONTROLS]) {
    let value;
    try {
      const answer = control.run();
      value = answer && typeof answer === 'object' && 'status' in answer ? answer.status : answer;
    } catch (error) {
      value = `threw: ${error.message}`;
    }
    if (render(value) !== render(control.expect)) {
      failures.push(`${control.name}: expected [${render(control.expect)}], got [${render(value)}]`);
    }
  }
  return failures;
}

const argv = process.argv.slice(2);
const controlFailures = runControls();

if (argv.includes('--self-test') || controlFailures.length) {
  const total = ALL_STATE_CONTROLS.length + RANGE_CONTROLS.length;
  if (controlFailures.length) {
    console.log(`[upgrade-watches] ${controlFailures.length} control(s) FAILED — the report was not produced:`);
    for (const failure of controlFailures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  // Labelled by what each group actually asserts: how many must fire, how many must not, and how
  // many pin the range arithmetic. Calling the range controls "must-not-fire" would be a label that
  // does not match its contents.
  const mustFire = ALL_STATE_CONTROLS.filter((c) => c.expect === 'READY').length;
  const mustNotFire = ALL_STATE_CONTROLS.length - mustFire;
  console.log(
    `[upgrade-watches] ${total} control(s) passed (${mustFire} must-fire, ${mustNotFire} must-not-fire, ${RANGE_CONTROLS.length} range)`
  );
  process.exit(0);
}

const results = [];
let failed = 0;
for (const watch of WATCHES) {
  try {
    const { detail, ready, closed, unparsed, unblocks } = await watch.read();
    results.push({ package: watch.name, gate: watch.gate, detail, status: unparsed ? 'UNPARSED' : closed ? 'CLOSED' : ready ? 'READY' : 'DEFERRED', unblocks });
    if (unparsed) failed += 1;
  } catch (error) {
    // A watch that cannot be read is reported as such, never as a pass.
    results.push({ package: watch.name, gate: watch.gate, detail: `unreadable: ${error.message}`, status: 'UNREADABLE', unblocks: '' });
    failed += 1;
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
} else {
  console.log('[upgrade-watches] read-only report — re-read the roadmap gate before acting on it\n');
  for (const row of results) {
    console.log(`  ${row.status.padEnd(10)} ${row.package}`);
    console.log(`             gate:    ${row.gate}`);
    console.log(`             current: ${row.detail}`);
    if (row.unblocks) console.log(`             unblocks: ${row.unblocks}`);
    console.log('');
  }
  const ready = results.filter((r) => r.status === 'READY');
  const closed = results.filter((r) => r.status === 'CLOSED');
  console.log(
    ready.length
      ? `[upgrade-watches] ${ready.length} gate(s) open: ${ready.map((r) => r.package).join(', ')}${closed.length ? `; ${closed.length} already closed: ${closed.map((r) => r.package).join(', ')}` : ''}`
      : closed.length
        ? `[upgrade-watches] no gate is open; ${closed.length} already closed: ${closed.map((r) => r.package).join(', ')}`
        : '[upgrade-watches] every watch is still deferred — nothing to start today.'
  );
  if (failed) console.log(`[upgrade-watches] ${failed} watch(es) could not be read — reported above, not counted as a pass.`);
}
process.exit(0);
