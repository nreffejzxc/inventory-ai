# 8. Preparing the Google Play submission

The paperwork around the artifact. [Guide 7](7-over-the-air-updates.md) covers builds and updates.
It separates what the bundle **is** (measured), what the console **should say**, and what **blocks**
submission. **Nothing has been uploaded**; there is no Play Console access in this repository.

**The current blocker is the artifact.** Both existing AABs were built before 2026-10-24 20:56, when
the in-app account-deletion screen landed, so their JavaScript contains none of its copy. Uploading
either would answer Play's deletion requirement with a build where the feature does not exist. §1
is the proof and must run on every future artifact. The tree has since moved to **`1.0.2`**, so the next
artifact is a fresh production build rather than an upload of either old AAB; the Android build quota
is available again.

## 1. The artifact

| | |
|---|---|
| File | AAB, profile `production`, EAS `4b133d62…` (supersedes the `09d77d3d…` rehearsal, `versionCode 2`) |
| Package | `com.inventoryai.app` |
| Version | `versionName 1.0.0`, `versionCode 3` |
| SDK levels | `minSdk 24`, `targetSdk 36`, `compileSdk 37` |
| Signature | production keystore (EAS credentials) |
| Permissions | 11 declared — §5 |
| Ads / analytics / billing | none in `package.json` |
| Update channel | `production`, runtime `1.0.0` |
| Embedded JavaScript | **predates account deletion — not uploadable** |
| Next build | `versionName 1.0.2`, `versionCode` **9** — remote is 8; `production-apk` builds the installable APK for the phone, `production` the Play AAB. Both share the `production` channel |

`targetSdk 36` meets Play's rule that new apps and updates target Android 16 (API 36) from
31 August 2026.

### 1.1 Pre-upload gate — is this the app we think we built?

Packaging checks pass on a bundle that is still the wrong artifact, so the gate has two layers:

```bash
cd mobile
npm run check:aab -- /path/to/inventory-ai.aab          # the file you are about to upload
npm run check:aab -- --bundle path/to/index.android.bundle   # a bare Metro/Hermes bundle
npm run check:aab -- --self-test                        # the controls on their own
# 0 verified · 1 wrong (each failure named) · 2 not verified (could not read)
```

1. **Packaging**: package `com.inventoryai.app`; `versionName` equal to the embedded config; `minSdk 24`
   / `targetSdk ≥ 36`; a JAR signature; channel `production` on the project's `u.expo.dev` URL; runtime
   version equal to the version; no `SYSTEM_ALERT_WINDOW`; `CAMERA` and `INTERNET` present; the
   production API host in the bundle and no `localhost:4000`; no `expo-dev-menu`, `expo-dev-launcher`
   or `react-native-web`.
2. **Bundle parity**: four user-visible sentences must be in `base/assets/index.android.bundle` —
   `Delete my account`, `Type DELETE to confirm`, `Continue with Google`, `Create your workspace`.
   One control fails if a probe is no longer copy in `app/`/`components/`, so a reworded sentence
   cannot silently disarm it.

CI runs the bundle half by exporting the app's JavaScript with Metro/Hermes and checking the same
four sentences.

| Artifact | versionCode | Packaging | Deletion copy | Verdict |
|---|---|---|---|---|
| `09d77d3d…` | 2 | passes | **0** | WRONG (exit 1) |
| `4b133d62…` | 3 | passes | **0** | WRONG (exit 1) |
| Metro export of `HEAD` | — | — | 4/4 | VERIFIED (exit 0) |

Evidence: [`2026-10-24-release-aab`](../evidence/device-runs/2026-10-24-release-aab/README.md).

> **Both of those build records were deleted from EAS on 2026-10-26** (roadmap §27FN): their ids are
> now dead pointers and their artifacts answer `400`. The table above is the *evidence that the gate
> works*, not a pair of files anyone can download. The authoritative store artifact is the **next**
> build — run §1.1 on it, and record its id only after `eas build:view <id>` resolves.

## 2. Store listing

| Field | Value |
|---|---|
| App name (30) | `Inventory AI` |
| Short description (80) | `Track stock, scan barcodes and ask an AI assistant about your inventory.` (77) |
| Category | Business |
| Contact email | the owner's Play account email |
| Privacy policy URL | `https://ai-inventory-l1mi.onrender.com/privacy` — live, measured |
| Account deletion URL | `https://ai-inventory-l1mi.onrender.com/account-deletion` — live, measured |
| Terms URL | `https://ai-inventory-l1mi.onrender.com/terms` — live, measured (no console field; linked from the privacy policy) |

**Full description (draft, 4,000 max).** Adjust tone, keep facts:

> Inventory AI keeps a small business's stock accurate without a spreadsheet.
>
> Record stock in and out, transfer quantities between locations, and see what is running low before
> it runs out. Scan a product barcode to find it instantly, and print a shelf label with its barcode
> as a PDF you can share.
>
> Products, categories, locations, suppliers and purchase orders live in one place, and every
> movement writes a transaction, so the history of a product can be read back rather than guessed.
> An audit trail records who changed what.
>
> The built-in assistant answers questions about your own inventory — what to reorder, what a
> product's stock is at each location, how much stock is tied up — and it is read-only: it can look,
> summarise and explain, and it cannot change your data.
>
> Roles decide what each person can do: an owner or admin manages users and settings, managers run
> stock movements, staff can look things up. Each business sees only its own data.

| Graphic | Status |
|---|---|
| App icon 512×512 | `mobile/assets/icon.png` is 1024×1024 — downscale |
| Feature graphic 1024×500 | **MISSING** |
| Phone screenshots (≥2) | candidates in `docs/evidence/device-runs/2026-10-24-release-build/` show auth flows; capture clean Dashboard / Inventory / Product / Assistant screens |

## 3. App content declarations

| Section | Answer |
|---|---|
| Privacy policy | the `/privacy` URL above; must match §4 |
| Account deletion | in-app **Profile → Delete account**, plus `/account-deletion` |
| App access | all functions need sign-in → provide a review account (§7) |
| Ads | No |
| Content rating | no violence, sexuality, gambling, drugs, profanity or user-to-user chat; expect *Everyone* / PEGI 3 |
| Target audience | 18+ (business tool) |
| News / health / financial / government features | No |
| Advertising ID | not used; no `AD_ID` permission |
| Data safety | §4 — an owner decision, not a guess |

## 4. Data safety — what the app handles

| Data | Collected | Goes to | Purpose |
|---|---|---|---|
| Name, email | yes, at creation | our MongoDB + Firebase | account, sign-in, mail |
| Password | never seen by our code | Firebase only | sign-in |
| Inventory records | yes | our MongoDB | the core function |
| Assistant questions/answers | yes | our MongoDB + **OpenRouter** (question and the inventory data read) | answering |
| Audit trail | yes | our MongoDB, owner/admin visible | governance |
| Device/installation ids | via Firebase / Play services | Google | sign-in |
| Crash logs, analytics, advertising data | **no SDK installed** | — | — |

Recommended conservative answers: collected = name, email, and "other user-generated content"
(inventory records, assistant messages); shared with service providers for app functionality —
Google (Firebase), Brevo (email delivery), OpenRouter (the assistant); encrypted in transit (HTTPS
only; release refuses cleartext); deletion via the in-app flow and the public page.

## 5. Permissions the reviewer sees

| Permission | Why |
|---|---|
| `CAMERA` | barcode scanning while the scan screen is open; no photos stored or uploaded |
| `READ/WRITE_EXTERNAL_STORAGE` | Expo template + `expo-file-system`, **capped at API 32** |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `VIBRATE` | normal, install-time |
| `USE_BIOMETRIC` / `USE_FINGERPRINT` | `androidx.biometric`, a dependency of the token store; not used in V1 |
| `DUMP` | `androidx.profileinstaller`, signature-level |
| `…READ_GSERVICES` | Google Play services |
| `com.inventoryai.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | the app's own |

No location, SMS, call log, contacts, microphone or all-files access. `SYSTEM_ALERT_WINDOW` was
removed on 2026-10-24 ([evidence](../evidence/device-runs/2026-10-24-permission-trim/README.md)).

## 6. The Play requirements

### 6.1 Privacy policy — live

`GET /privacy` (`server/src/pages/privacyPolicy.ts`), outside `/api`, names the processors (Firebase,
Brevo, OpenRouter, MongoDB Atlas, Render), what is not collected, the camera's barcode-only use,
retention, security, 18+, and how to delete an account and what happens to the data.

Measured 2026-10-24: **200 text/html**, CSP with the stylesheet hash, `no-store`, `no-referrer`,
`frame-ancestors 'none'`, no `X-Powered-By`; `POST /privacy` is 404; no script, so it renders signed out.

Still to do: confirm `CONTACT_EMAIL`; decide whether to add a legal entity/jurisdiction line (the
draft claims neither); paste the URL into the console and open it in a **private window**.

### 6.2 Terms of use — live

`GET /terms` (`server/src/pages/termsOfUse.ts`). Play has no field for it, so it is linked from the
privacy policy, the deletion page and **Profile → Legal** — all asserted by tests. It states that the
assistant is **read-only and can be wrong** (not accounting, tax, legal or safety advice), that a
**sole member's business is deleted with their account**, and that no consumer right is limited.
Measured 2026-10-25: **200**, `no-store`, `no-referrer`, `nosniff`, CSP hash, both links 200, no
placeholder; opened on the phone. Tests: `TERMS-page.test.mjs`, `legal-pages-in-app.test.tsx`.

### 6.3 Account deletion — live and measured on production

Play requires **both** an in-app path and a web URL.

- **In the app:** Profile → **Delete account** (`mobile/app/(app)/delete-account.tsx`) states what is
  deleted and what stays, requires the word `DELETE` and re-authentication (Firebase ID token for a
  linked account, current password for a legacy one), then signs out.
- **On the web:** `GET /account-deletion` (`server/src/pages/accountDeletionPage.ts`), public and
  unauthenticated.
- **On the server:** `DELETE /api/auth/me` (`accountDeletion.service.ts`). The account is always
  `req.user.id` and the operation is a **tombstone**:

| Removed | Kept |
|---|---|
| name, real email, password hash, Firebase identity, all sessions, reset/verification records, AI conversations and messages | the business's stock, movements, purchase orders and audit trail, with the person's `userId` set to `null`; the `User` row survives anonymously |

Ownership decides the rest: if another member remains, records stay, and a sole OWNER is refused
`409 LAST_OWNER_TRANSFER_REQUIRED` until someone else is made owner; if nobody else remains and the
caller is the OWNER, the account **and the whole business** are deleted, which the screen states
before the button. A repeat request converges (`changed: false`).

Measured on production 2026-10-24 with a disposable tenant: 12/12 checks (register 201, sign-in 200,
STAFF 201/200, mistyped word 400, wrong password 400 `INVALID_CURRENT_PASSWORD`, session still valid
after refusals, deletion 200, dead token 403 `ACCOUNT_DISABLED`, deleted login 401, owner unaffected
200, deleted member absent from `GET /api/users`), leftovers 0. Device-tested with a throwaway
account, including the Google Sign-In branch (provider identity answered `auth/user-not-found`; the
same Google account could not get back in). The Google chooser fix and this screen reached the phone
by **OTA**, not a build — neither AAB contains them.

## 7. The review account

Give Play reviewers, in "App access": an `OWNER` account on a **seeded demo tenant** (products, stock,
a supplier, a purchase order, a low-stock product, so the assistant has something to answer), the
steps sign in → dashboard → inventory → product → assistant, and a note that the data is disposable.
Never give a real customer account. `server/scripts/seed-demo-tenant.mjs` creates this;
`cleanup:demo-tenant` removes it.

## 8. Upload checklist

0. **Build from a commit containing what you submit** (`eas build --profile production`; needs quota,
   resetting 2026-11-01).
1. **Run the parity gate on the file you upload** (§1.1). Exit 1 means it predates a required feature.
2. **Back up the production keystore and passwords.** Lost before Play App Signing, the package name
   is unrecoverable.
3. Create the app with package `com.inventoryai.app` and enroll in **Play App Signing**; the current
   keystore becomes the upload key.
4. Complete §2–§5, including both URLs.
5. Upload to **Internal testing** first (download and upload by hand is simplest).
6. Add yourself as an internal tester, install **from Play**, and run the journeys: sign-in, dashboard,
   scanner, assistant, offline launch, password reset.
7. Promote to closed/production. Every later upload needs a higher `versionCode`; `autoIncrement` is
   on, so each build produces one.

**Unproven:** nothing has been uploaded, so Play App Signing, the pre-launch report and a
store-installed build have never been exercised. The AAB validates with `bundletool` but has never
been installed from Play.

← [Guides index](README.md) · Related: [7. Updating the app](7-over-the-air-updates.md)
