# 7. Updating the app without reinstalling (EAS Update)

Checked against the installed CLI (`eas-cli/24.7.0`, `expo-updates ~58.0.18`, Expo SDK 58).
`eas update:list` takes `--branch` (not `--channel`), and `eas update:rollback` takes a **group id**.

## 0. The short answer

**Saving a file updates nothing.** An installed app changes in one of three ways:

| You changed | To reach a phone |
|---|---|
| A screen, sentence, colour, form rule, API call, bug in `.ts`/`.tsx`, an image | **`eas update`** → the app picks it up on its next launches. No APK, no cable. |
| A native library, permission, config plugin, `app.json` native field, the Expo SDK, an `EXPO_PUBLIC_*` **value** | **A new build** (APK/AAB) and one install or store release. |
| A backend route, permission, database rule, mail template | **Neither** — deploy the server. |

There is no auto-publish: a save is a draft, `eas update` is a release. The installed app decides
what it can receive — channel and runtime version are compiled into it. Nothing tells the user,
unless you write a release note (§7).

## 1. How it works

Each build contains `expo-updates`, a native client, plus the JavaScript it was compiled with (the
**embedded bundle**). On each launch:

1. the native shell starts the last accepted update, or the embedded bundle;
2. `checkAutomatically: "ON_LOAD"` asks `https://u.expo.dev/607eca05-…` for a newer update **for this
   channel and runtime**;
3. it downloads while the current app keeps running;
4. the new bundle is used on the **next** start — never mid-session;
5. `fallbackToCacheTimeout: 0` means the launch never waits: offline, slow or EAS-down always starts
   from what is on the device.

So **the first launch after a publish still shows the old screen**; close and reopen (twice if you
count the check).

| Word | Here |
|---|---|
| **Channel** | compiled into the binary: `development`, `preview`, `production`. An install listens to exactly one. |
| **Branch** | where a group is stored; here each branch is named after its channel. |
| **Update group** | one publish: bundle, assets, message, commit, group id. What you roll back or republish. |
| **Runtime version** | the compatibility label; under `appVersion` policy it is `expo.version` — `1.0.2` in the tree, `1.0.1` in the shipped production and preview builds. The older production group is `1.0.0` (§3). Delivered only on an **exact** match. |
| **Embedded bundle** | the JavaScript inside the APK; the fallback that always exists. |

An install receives an update when its **channel** points at the branch **and** its **runtime**
matches. It must also contain `expo-updates`, have been built with a channel, and be opened — there is
no push.

## 2. Configuration

`mobile/app.json`:

```json
"version": "1.0.2",
"runtimeVersion": { "policy": "appVersion" },
"updates": {
  "url": "https://u.expo.dev/607eca05-1175-43ed-86a0-1829e91c9531",
  "checkAutomatically": "ON_LOAD",
  "fallbackToCacheTimeout": 0
},
"extra": { "eas": { "projectId": "607eca05-1175-43ed-86a0-1829e91c9531" } }
```

`version` **is** the runtime label: JavaScript change → keep it; native change → bump it. Do not set
`updates.enabled: false` — that compiles an app that ignores every update.

`mobile/eas.json`:

```json
"cli": { "appVersionSource": "remote" },
"build": {
  "development":   { "developmentClient": true, "channel": "development", "android": { "buildType": "apk" } },
  "ios-simulator": { "extends": "development", "ios": { "simulator": true } },
  "preview":       { "distribution": "internal", "channel": "preview",
                     "android": { "buildType": "apk" },
                     "env": { "EXPO_PUBLIC_API_URL": "https://ai-inventory-l1mi.onrender.com" } },
  "production":    { "autoIncrement": true, "channel": "production",
                     "env": { "EXPO_PUBLIC_API_URL": "https://ai-inventory-l1mi.onrender.com" } },
  "production-apk": { "extends": "production", "distribution": "internal",
                     "android": { "buildType": "apk" } }
}
```

Every profile listens to one channel. `ios-simulator` deliberately shares `development`, and
`production-apk` deliberately shares `production` — it is the same release packaged as an installable
APK instead of an AAB, so it must receive the same updates. Nothing else may share. `production`
builds an **AAB**; `preview` and `production-apk` build APKs. `appVersionSource: "remote"` means EAS
owns the Android `versionCode`; check it rather than assuming:

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx eas-cli build:version:get --platform android --profile production
```

`mobile/__tests__/ota-update-config.test.ts` pins all of it: `expo-updates` installed, a runtime
**policy** not a literal, this project's URL, a launch that never waits, and a distinct channel per
profile.

**Not the `fingerprint` policy.** A real build failed in *Configure expo-updates* with two hashes
(`6217b878…` on EAS, `e32953a7…` here) because [mobile/app.config.js](../../mobile/app.config.js)
resolves Firebase file paths that only exist on the builder. `appVersion` removes that mismatch.

## 3. Current build state

Check the live state instead of trusting a snapshot:

```bash
npx eas-cli channel:list
npx eas-cli branch:list
npx eas-cli update:list --branch production --limit 5
```

**The installed production APK is runtime `1.0.2` (versionName `1.0.2`, versionCode 10).** Build
`820251b4-dc8a-46a3-9b25-0faa0a9c1529` was compiled with Expo 58.0.22 and React Native 0.88.1, and the
development APK `76440404-167c-440c-be20-88801fe9b64b` shares fingerprint
`f5a6fddec17c97c1dabfe2fb9428108a41d9bd6e`. The newest production OTA is group
`0e4eca55-0e4f-47fc-b2d6-507f91b529b8` (Android update
`01a1c19d-06e8-79c9-9a46-7302c4be1c69`), published from `8b6353a` with the message
"Release notes: Clearer stock totals and restock counts"; its dashboard card has not yet been observed
on a phone. The previous group `58ab8e76-0b18-4e73-8822-7766e6dad7e3` was published from `162db9c` and
had shown "Cleaner details you can copy" after two cold starts.

Older groups remain as history; installs move forward to the newest group for their runtime. Channels
are unprotected because code signing is off; enabling it is a build-time change (§11).

## 4. EAS environments

`eas update` reads the **EAS environment** named by `--environment`, not `eas.json`'s build `env`.
The `production` environment holds these public variables (all `EXPO_PUBLIC_*`, visible in any bundle —
nothing secret may live there): `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_FIREBASE_API_KEY`,
`EXPO_PUBLIC_FIREBASE_APP_ID`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID`,
`EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.

```bash
npx eas-cli env:list --environment production
npx eas-cli env:list --environment preview
npx eas-cli env:set --environment production --name EXPO_PUBLIC_API_URL \
  --value https://ai-inventory-l1mi.onrender.com --visibility plaintext
```

- `EXPO_PUBLIC_API_URL` is defined **twice** (EAS production environment and the production build
  profile). The profile wins for builds. Keep them identical.
- `mobile/lib/config.ts` falls back to a platform default (`http://10.0.2.2:4000` on Android,
  `http://localhost:4000` elsewhere) when it is absent. On 2026-10-24 the production environment
  lacked it, so a production publish would have reached no server.
- Changing an `EXPO_PUBLIC_*` **value** is a build decision, not an OTA one.

## 5. Commands (from `mobile/`)

```bash
# publish — preview first, production after it is proven
npx eas-cli update --channel preview    --environment preview    --platform android -m "Say what changed"
npx eas-cli update --channel production --environment production --platform android -m "Describe the release"
```

| Flag | Why |
|---|---|
| `--channel` | which installs may receive it |
| `--environment` | **required on SDK 55+**; loads that environment's variables — never bypass the refusal |
| `--platform android` | **always**: without it the command also exports the **web** bundle this project does not ship, and fails |
| `--message` | the line you will read in `update:list` months later; never shown to users |

Extras: `--branch`, `--rollout-percentage 10`, `--clear-cache`, `--json`, `--non-interactive`,
`--skip-bundler --input-dir dist`, `--private-key-path` (code signing only).

```bash
# inspect
npx eas-cli update:list --branch production --limit 10    # NOT --channel
npx eas-cli update:list --all --limit 20
npx eas-cli update:insights <group-id> --days 7           # launches, crashes, users, size

# republish (first remedy when a phone says "no update")
npx eas-cli update:republish --group <group-id> --message "Republished"
npx eas-cli update:republish --group <group-id> --rollout-percentage 100

# roll back
npx eas-cli update:rollback <group-id> --platform android -m "Rolled back"
npx eas-cli update:roll-back-to-embedded --channel production --platform android \
  --runtime-version 1.0.0 --message "Back to embedded" --non-interactive

# delete a group (not a recall: installs that already have it keep running it)
npx eas-cli update:delete <group-id>

# version and diagnostics
npx eas-cli build:version:get --platform android --profile production
npx eas-cli diagnostics
npx expo config --type public --json
npx expo-updates runtimeversion:resolve
```

`update:rollback` takes the **group id**, not a channel. `roll-back-to-embedded` **needs
`--runtime-version`** in non-interactive mode; it was exercised on a production-profile build on
2026-10-24 and returned the phone to its embedded bundle after two cold launches. A rollback publishes
a **newer** group containing older code; it cannot reach into a phone that never launches again.

## 6. Safe release procedure

Nothing is published unverified, and nothing reaches production before it is proven elsewhere.

1. **Be on the commit you mean to ship.** `npm run check:ota` refuses any uncommitted path, re-checks
   the runtime/channel contract, prints the commit, the runtime and the exact command.
2. **Run the checks:** from `mobile/` — `npm run typecheck`, `npm run lint`, `npm test`,
   `npm run check:build-env`; from `server/` if the API changed — `npm run test:unit`.
3. **Confirm config:** `npx eas-cli channel:list`, `npx eas-cli env:list --environment <env>`,
   `npx expo config --type public --json | grep -A3 updates`.
4. **Publish to `preview`.**
5. **Prove it on a preview install** (§7).
6. **Publish to `production`.**
7. **Cold-start the production install twice**, then sign in or load the dashboard — which proves the
   bundle carries the right API URL.
8. **Record it:** group id, message, what was observed (roadmap or evidence README).
9. **If wrong:** roll back or publish a correction — one command, no store.

**Why step 1 is a tool.** On 2026-10-25 a release note was published to production, then the files
were undone locally and nothing was republished. `git status` was clean and `main` committed — but the
**channel** kept serving a bundle whose note read *A small test update*, which no commit contained.
`eas update` uploads the **working tree**, and `update:list --json` returns **no commit hash**, so a
live group cannot be joined back to git afterwards.

| `check:ota` refuses | Because |
|---|---|
| any modified or untracked path | the bundle would contain JavaScript no commit describes (`--allow-dirty` overrides and says so) |
| `runtimeVersion` not `appVersion` | the label decides which installs can receive it |
| `checkAutomatically` not `ON_LOAD`, or `fallbackToCacheTimeout` not `0` | installs would stop checking, or launches would wait |
| `updates.enabled: false`, or a missing project URL | the app would ignore every publish |
| a channel with no build profile | no install listens there |

It **warns** when the branch is not `main` or the commit is not on `origin/main`.

Staged release: `--rollout-percentage 10`, then `update:republish --group <id> --rollout-percentage 100`.

## 7. Proving an update arrived

1. Note something **visible** the update changes.
2. Publish; `npx eas-cli update:list --branch <branch> --limit 3` shows the new group at the top.
3. Force-stop and start the app **twice**:

```bash
adb shell am force-stop com.inventoryai.app
adb shell monkey -p com.inventoryai.app -c android.intent.category.LAUNCHER 1
```

4. The changed thing is on screen; then sign in or load the dashboard, which proves the bundle was
   built with the right `EXPO_PUBLIC_API_URL` (symptom if not: *"Cannot reach the server"* everywhere).
5. On a preview/development build, read the update client's log:

```bash
adb logcat -d | grep dev.expo.updates | tail -20
```

`Updates state change: Download` then `DownloadCompleteWithUpdate` with `isUpdateAvailable=true,
isUpdatePending=true` means it downloaded; `CheckCompleteUnavailable` / `No update available` after
the newest one is **correct**. Release builds log little — use the behaviour plus
`npx eas-cli update:insights <group-id>`.

**Which group is `production` serving right now?**

```bash
curl -sS -H "expo-platform: android"  -H "expo-runtime-version: 1.0.2" \
  -H "expo-channel-name: production" -H "accept: multipart/mixed" \
  -H "expo-protocol-version: 1" \
  https://u.expo.dev/607eca05-1175-43ed-86a0-1829e91c9531 \
  | grep -o '"updateGroup":"[^"]*"'
```

`accept: multipart/mixed` is **mandatory** (the host answers 406 without it), and the returned asset
URLs answer 403 to plain `curl`, so this proves **which group** a channel serves, not its contents.
For contents, read the phone or grep `mobile/dist/_expo/static/js/android/*.hbc`.

## 7A. What the person holding the phone sees

**By default, nothing.** No banner, toast, "new version" or restart prompt — `expo-updates` ships no
UI. A copy change simply appears after the next launch. `--message` is stored with the group and shown
in `update:list` and the dashboard: a note **to the team**, never to users.

**Profile → About → App version** shows the build's own version (`1.0.2` after this release, from
`expo-constants`), which changes only with a native build. Nothing displays `Updates.updateId`, so the
running *bundle* cannot be identified from the phone.

### Release notes — the "What's new" card (shipped 2026-10-25)

The note lives **inside the bundle**: no endpoint, no collection, no permission, renders offline.

| File | What it is |
|---|---|
| `mobile/lib/releaseNotes.ts` | the notes — the only file to edit to announce something |
| `mobile/lib/releaseNotesSeen.ts` | acknowledged ids in `expo-secure-store`, capped at 100 (newest kept) |
| `mobile/hooks/useReleaseNotes.ts` | `!seenIds.includes(latest.id)` |
| `mobile/components/WhatsNewCard.tsx` | the card |
| `mobile/app/(app)/whats-new.tsx` | the full list, newest first |

- The card appears **once per note** on the dashboard, below the stale-data warning. **Got it**
  dismisses; **See what's new** opens the list; either records the note.
- A bundle with no new note announces nothing — silent updates are the normal case.
- The permanent doorway is **Profile → About → What's new**.
- Dismissal is final in both directions: the marker is the **set** of ids, so a rollback or a
  republished older group re-announces nothing. A note this device never saw still appears.
- If storage cannot be read, the card is shown — missing a message is worse than repeating one.
- It is a card, not a modal or toast, and not on Login: it appears where a signed-in person lands.

**Writing one** — add an entry at the top of `mobile/lib/releaseNotes.ts`, then publish:

```ts
{
  id: '2026-11-02-return-counts',   // never reuse an id
  date: '2026-11-02',
  kind: 'feature',                  // 'feature' | 'improvement' | 'fix'
  title: 'Returns are counted again',
  summary: 'One sentence a shopkeeper would understand.',
  points: ['Optional detail.', 'Keep it short.'],
},
```

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx eas-cli update --channel production --environment production --platform android \
  -m "Release notes: Returns are counted again"
```

Write for the person using the app: no phase numbers, file names or acronyms.
`mobile/__tests__/release-notes.test.tsx` fails on duplicate ids, a wrong order or an empty title or
summary. **The id is the contract** — reusing one silently announces nothing. Wording cannot be
changed from a dashboard; it is bundle text, like all copy.

**Restart prompt — not implemented (deferred by the owner, 2026-10-25).** `ON_LOAD` downloads before
a screen is interactive, so a prompt would need `checkForUpdateAsync()`, `fetchUpdateAsync()` and
`reloadAsync()`. It may only be offered when nothing holds unsaved input, and hidden while a form is
dirty.

**Play Store users** see nothing different: an OTA publish creates no version, no review and no
listing "What's new" entry. That text belongs to a store release.

## 8. When something goes wrong

| Situation | What happens |
|---|---|
| No internet at launch | Starts from the device's bundle; the check silently retries later |
| Download interrupted | The previous bundle keeps running; the download resumes |
| Downloaded update crashes | Falls back to the embedded bundle; the app still opens — publish a fix or roll back |
| The update is live and wrong | Installs keep it until a newer group supersedes it; a correction is minutes, not a review |
| The app is never opened | It never updates — there is no push |
| Reinstalled from the store | Starts on the embedded bundle, picks up the newest update on the next launches |

## 9. Troubleshooting

| Symptom | Cause | Do |
|---|---|---|
| `404` from the update host | no branch/update for that channel, or runtime mismatch | `channel:list`, `branch:list`; compare the manifest runtime with `expo.version` |
| "No update available" though `update:list` is newer | the device's check was cached/refused; on 2026-10-24 a publish was refused for **19+ minutes** while `curl` got the manifest | wait, then `update:republish --group <id>` |
| `Nonexistent flag: --channel` on `update:list` | it lists by branch | `--branch production` |
| Publish fails building the web bundle | `--platform android` omitted | add it |
| `--environment` required | SDK 55+ | add it; never bypass |
| App says *"Cannot reach the server"* after an update | bundle built without `EXPO_PUBLIC_API_URL` | `env:list`, fix, republish |
| `--runtimeVersion is required in non-interactive mode` | `roll-back-to-embedded` without it | add `--runtime-version 1.0.2` |
| Changes appear once, then revert | wrong channel or runtime | check the build's channel/runtime, publish to the right one |
| A development build never updates | expected — it runs Metro | test OTA on a `preview`/`production` build |
| `eas update` published, phone unchanged | only launched once since | close and start it again |
| A deleted note is still on the phone | the channel serves an earlier publish, or it has not launched twice | `npm run check:ota`, publish from a clean tree, confirm the served group |

## 10. What still needs a new build

| Change | Build? |
|---|---|
| New/upgraded native dependency, config plugin or its options | **Yes** |
| `app.json` native fields: permissions, icon, splash, name, package id | **Yes** |
| Expo SDK upgrade | **Yes** |
| `EXPO_PUBLIC_*` **value** | **Yes** |
| Enabling code signing | **Yes** (certificate is compiled in) |
| Changing `expo.version` | **Yes** — that is the runtime label |
| Screens, components, styles, copy, client validation, API calls | No — publish |
| Server routes, permissions, mail templates, database rules | No — deploy the server |

Rule of thumb: **native dependencies or native `app.json` fields changed → build; only `.ts`/`.tsx`
and images → publish.** A native change **must bump `expo.version`** (`1.0.1` → `1.0.2`); without it
the new binary keeps runtime `1.0.0` and accepts updates built for the old native code, which crashes
after install. With it, the new build stops listening to `1.0.0` — the point.

### The native-runtime record (added 2026-10-25)

`npm run check:ota` also reads `mobile/ota-native-runtime.json`, a committed record of the versions the
**last build** was compiled with. It refuses to publish when `expo`, `expo-modules-core` or
`react-native` differ from that record, because EAS labels a bundle by `appVersion` and cannot see
which native modules the phone actually has. It currently records the two `1.0.2` builds:

```json
{
  "appVersion": "1.0.2",
  "expo": "58.0.22",
  "expoModulesCore": "58.0.29",
  "reactNative": "0.88.1",
  "recordedAt": "2026-11-09",
  "builds": {
    "development": "76440404-167c-440c-be20-88801fe9b64b",
    "production-apk": "820251b4-dc8a-46a3-9b25-0faa0a9c1529"
  }
}
```

`--allow-native-change` turns that refusal into a warning for a mismatch that is understood and
deliberate; it never excuses a version with no binary. This closes the hole measured on 2026-10-25: an
SDK patch moved `expo-modules-core` while every installed build still carried the old modules, and
nothing in EAS would have stopped the publish.

## 11. Security

- **Transport:** HTTPS from `https://u.expo.dev/<project-id>`; the id is public.
- **Contents:** only client code and `EXPO_PUBLIC_*` values. No database, mail or AI key travels this
  way. An update **cannot bypass the backend**: sessions, roles, permissions, tenant isolation and
  `requireAuth` are enforced per request.
- **Who can publish:** anyone with access to the Expo account/organisation — treat it as a deployment
  credential.
- **Code signing is off** (channels report *Unprotected*), and it cannot be turned on for free:
  Expo allows it on the **Production ($199/month)** or Enterprise plans only. A binary that carries a
  certificate **rejects every unsigned publish**, so enabling the config before the plan exists would
  freeze every install on its current bundle while the channel advertised a newer one. Treat the
  steps below as the procedure for the day the plan allows it — not as a switch to flip now.

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx expo-updates codesigning:generate \
  --key-output-directory ../keys --certificate-output-directory ../keys \
  --certificate-validity-duration-years 10 --certificate-common-name "Inventory AI"
npx expo-updates codesigning:configure \
  --certificate-input-directory ../keys --key-input-directory ../keys
# then rebuild (certificate compiled in) and publish signed:
npx eas-cli update --channel production --environment production --platform android \
  --private-key-path ../keys/private-key.pem --message "Signed release"
```

None of it has been done (§27FN measured the plan gate). When it is done, the certificate is compiled
in with a build at a **new runtime version**, and the private key is **not** uploaded to EAS: it signs
on the publishing machine, so it has to be backed up somewhere that is not this repository, and a new
machine needs it provisioned before it can publish. Staged releases (`--rollout-percentage`) are the
other safety lever.

### Code signing needs a paid plan

Expo allows EAS Update code signing only on the Production ($199/month) or Enterprise plans. The
verification happens on the phone; the paid part is the supported signed publish. Stay unsigned on the
free plan until the Play release and real tenants exist — that is a decision, not an oversight. The free
posture keeps HTTPS transport and channel isolation, but a compromised Expo account or CDN could serve
a bundle to an unsigned install. Revisit at the Play release, not on a date.

## 12. Current gaps

1. **The handset runs the production APK** — `1.0.2`, versionCode 10, signed in as the test user and
   receiving production OTA. The development APK was built and fingerprinted but is not installed; it
   would replace the production install and needs Metro.
2. **Code signing is off, blocked by plan** — Expo allows it on Production/Enterprise only; it waits on
   a paid-plan decision, not on work (§27FN).
3. **CLI is a major version behind** — `24.7.0`; re-read `--help` after upgrading.
4. **`EXPO_PUBLIC_API_URL` is defined twice** — harmless while identical.
5. **The Play path is unproven** — an OTA to store users needs a store build containing `expo-updates`.
6. **`update:list` cannot be joined to git** — hence the clean-tree preflight.
7. **No matching 1.0.2 preview install was exercised** — production OTA was published directly to the
   installed `1.0.2` APK; the older preview build is runtime `1.0.1` and cannot receive it.

## 13. Limits

No native changes; no app-store presence or review; no forced update (an app never opened keeps its
JavaScript); no rollback of a native change; no new permission prompt; a publish is not proof of
delivery. Both stores allow JavaScript that does not change the app's primary purpose — fixes and
shipped UI are the ordinary use. iOS is unverified here (no macOS).

## 14. Cost

Included in the free account: **1,000 monthly active users** and **15 Android / 15 iOS builds a
month**, no per-update charge. Beyond 1,000 MAU the next plan is $19/month; **code signing needs the
$199/month Production plan**, which is the only reason it is off.

## 15. Evidence

The device runs that proved preview and production OTA, the embedded-bundle rollback and the store AAB
are under [`docs/evidence/device-runs`](../evidence/device-runs/README.md). The publish-accident record
is §27FF in [`DEVELOPMENT_ROADMAP.md`](../DEVELOPMENT_ROADMAP.md). Not verified: code signing,
`update:rollback <group-id>` (only `roll-back-to-embedded` was exercised), the Play upload path, and iOS.

## 16. Cheat sheet

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx eas-cli channel:list
npx eas-cli branch:list
npx expo config --type public --json | grep -A3 '"updates"'
npx eas-cli env:list --environment production

npm run typecheck && npm run lint && npm test && npm run check:build-env
npm run check:ota

npx eas-cli update --channel preview    --environment preview    --platform android -m "…"
npx eas-cli update --channel production --environment production --platform android -m "…"

npx eas-cli update:list --branch production --limit 5
npx eas-cli update:insights <group-id>

npx eas-cli update:republish --group <group-id> -m "Republished"
npx eas-cli update:rollback <group-id> --platform android -m "Rolled back"
npx eas-cli update:roll-back-to-embedded --channel production --platform android \
  --runtime-version 1.0.2 -m "Back to embedded" --non-interactive

npx eas-cli build --platform android --profile preview          # APK, preview channel
npx eas-cli build --platform android --profile production-apk   # APK, production channel (phone)
npx eas-cli build --platform android --profile production       # AAB for Play
```

**Remember:** saving does nothing; `eas update` publishes; the phone applies it on its next launches.
JavaScript and images travel that way — native code never does, and a native change also needs
`expo.version` bumped.

← [Guides index](README.md) · Related: [8. Preparing the Play submission](8-play-store-submission.md)
