# Firebase — Verified

**Service:** Firebase / Google Cloud
**Canonical email:** `jeffernmalinaoqwe@gmail.com`
**Project:** `inventoryai` (`inventoryai-d0d20`), project number `652114762453`
**Status:** verified — new Gmail accepted the project Owner invitation, opened the console, and is now the
project support email.
**Last checked:** 2026-11-12

## What changed

- Using the old owner account, `jeffernmalinaoqwe@gmail.com` was added to the project IAM policy as
  **Owner (Legacy)**. The old owner, `jefferndullamalinaozxc@gmail.com`, was retained for rollback.
- Google Cloud marked the grant as **“Invitation sent. Pending acceptance.”** The invitation was delivered to
  the new Gmail at 4:26 PM.
- The new Gmail accepted the invitation at
  `https://console.cloud.google.com/invitation?project=inventoryai-d0d20...`. Google Cloud then opened the
  project dashboard successfully.
- Firebase then opened at `/u/1/project/inventoryai-d0d20/overview`, showing the Spark plan and all **3 apps**
  (Android, iOS and web). The standard Firebase Terms and Conditions prompt was accepted for this account.
- The project **Support email** was changed from the old address to
  `jeffernmalinaoqwe@gmail.com` in **Project settings → General → Public settings**; Firebase reported
  **“Support email updated.”**

## Verified state

| Check | Result |
| --- | --- |
| Firebase overview with new Gmail | Loads successfully at `/u/1/project/inventoryai-d0d20/overview` |
| Apps visible | Android, iOS and web — 3 apps |
| Firebase Terms | Accepted for the new Gmail |
| Cloud IAM role | New Gmail has Owner (Legacy); old owner retained |
| Support email | `jeffernmalinaoqwe@gmail.com` |
| Production authentication | Not changed |
| Billing | Spark plan; no billing change |

## SHA certificate fingerprints

These are the **existing** Android fingerprints. They were read, not generated or changed. They were obtained from
Firebase Console → Project settings → General → Android app `inventoryai` (`com.inventoryai.app`) → **SHA
certificate fingerprints**.

| Type | Fingerprint |
| --- | --- |
| SHA-1 | `bb:c4:08:1a:d7:95:74:3e:d9:f2:75:ae:c5:cc:ce:c4:fe:62:11:92` |
| SHA-256 | `63:a9:bc:67:57:9f:72:9b:9f:bb:05:6a:f6:db:ab:26:ab:a6:c6:9a:b5:8d:22:bf:76:f2:3d:5b:a3:92:ab:29` |

The Android app ID is `1:652114762453:android:3d402c5491b99e6c0ba05c`. The iOS and web app entries remain in the
same project.

## Where the existing keys/configuration live

- Android SDK configuration: Firebase Console → Project settings → General → Android app
  `com.inventoryai.app` → **Download google-services.json**. The existing file was left in place.
- iOS/web SDK configuration: the same **Your apps** section contains the existing Apple and Web app entries.
- Server-side Admin credential: the existing `FIREBASE_SERVICE_ACCOUNT_JSON` Render environment variable; its
  source, verification and rotation rules are in `docs/FIREBASE_CREDENTIAL_RUNBOOK.md`. Its value was not read,
  changed or committed here.

## Keys, credentials and certificates

- **No new Firebase keys, service-account keys, OAuth clients or certificates were generated.**
- **No existing key was rotated or deleted.**
- The existing Android SDK configuration is available from the same Project settings page as
  `google-services.json`; it was not downloaded, modified or committed.
- The existing web/iOS SDK configurations and the existing Firebase Admin service account were left untouched.
  No key value is recorded in this repository.

## Remaining owner action

- Keep the old owner as rollback access until the owner explicitly decides the new Gmail is fully established.
  Remove the old owner only with separate approval.
- Do not rotate the Firebase Admin service account as part of this email migration; use
  `docs/FIREBASE_CREDENTIAL_RUNBOOK.md` if a rotation is ever required.
- No further support-email or Firebase-console action remains.
