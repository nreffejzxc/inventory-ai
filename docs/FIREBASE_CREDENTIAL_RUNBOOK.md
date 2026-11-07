# Firebase Credential Runbook

How Inventory AI stores, verifies and rotates the Firebase Admin service-account credential — the one
secret that lets the server verify Firebase ID tokens. Server-side only; the app never receives it.

**The decision.** One variable, `FIREBASE_SERVICE_ACCOUNT_JSON`, holding the **minified raw JSON**
(not base64). One value cannot half-update: the project, client email, key id and private key always
come from the same download.

**Last verified:** 2026-11-07.

---

## 1. Where the values come from

| Field | Where to find it | Secret? |
| --- | --- | --- |
| `project_id` | Firebase Console → Project settings → General, or the JSON | No — `inventoryai-d0d20` |
| `client_email` | Firebase Console → Project settings → Service accounts, or the JSON | No — `firebase-adminsdk-fbsvc@inventoryai-d0d20.iam.gserviceaccount.com` |
| `private_key_id` | The JSON, and the console's Keys page | No |
| `private_key` | **Only** the JSON download | **Yes** |

Google never shows an existing key's private material again. If the JSON is lost, create a new key.

**Create one:** Google Cloud Console → IAM & Admin → Service Accounts →
`firebase-adminsdk-fbsvc@inventoryai-d0d20` → **Keys** → **Add key** → **Create new key** → **JSON**.
Equivalent: Firebase Console → Project settings → Service accounts → **Generate new private key**.

Record the key id from the filename or the console's Keys page. It is how you tell a stale key from a
mis-pasted one.

---

## 2. Put it in `server/.env`

The file is one line per variable, so the JSON must be minified. `JSON.stringify` does that, and it
keeps the `\n` escapes inside `private_key` as two characters rather than real line breaks.

Run from the repository root, replacing the path with your download:

```bash
node - "$HOME/Downloads/inventoryai-d0d20-KEYID.json" <<'NODE'
const fs = require('fs');
const sa = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const field of ['project_id', 'client_email', 'private_key']) {
  if (typeof sa[field] !== 'string' || !sa[field].trim()) {
    console.error('missing field:', field); process.exit(1);
  }
}
const path = 'server/.env';
const text = fs.readFileSync(path, 'utf8');
if (!/^FIREBASE_SERVICE_ACCOUNT_JSON=/m.test(text)) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON line not found in', path); process.exit(1);
}
fs.mkdirSync('server/logs', { recursive: true });
fs.copyFileSync(path, 'server/logs/.env.before-key.bak');
const line = 'FIREBASE_SERVICE_ACCOUNT_JSON=' + JSON.stringify(sa);
fs.writeFileSync(path, text.replace(/^FIREBASE_SERVICE_ACCOUNT_JSON=.*$/m, () => line));
console.log('updated', path, '| project', sa.project_id, '| key id', sa.private_key_id, '| chars', line.length);
NODE
```

Rules:

- Do **not** wrap the value in quotes.
- Keep `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` empty. When the JSON
  variable is set they are ignored, and an empty line is not "set".
- The backup in `server/logs/` is git-ignored but still contains the key. Delete it once verification
  passes.

---

## 3. Verify before deploying

```bash
cd server
npm run verify:firebase
```

It sends **one** request to Google and prints one of three verdicts:

| Output | Exit | Meaning | What to do |
| --- | --- | --- | --- |
| `VERIFIED — Google issued an access token` | 0 | The credential is live | continue |
| `FAILED — Google rejected this key (invalid_grant)` | 1 | Deleted, revoked, or another account's key | create a new key |
| `NOT VERIFIED — not configured …` | 2 | Value absent or unparseable | fix the variable |
| `NOT VERIFIED — Google could not be reached` | 2 | Network problem | retry |

**Never update Render until this prints `VERIFIED`.** This is the check whose absence allowed a dead
key to reach production on 2026-11-07.

Run it against the **exact value you are about to paste** in Render: the checker uses the same parser
and the same request the server does, so a local `VERIFIED` is the same evidence the deployed build
would produce. (Render's Pre-Deploy Command is paid-plan only; see §4.)

---

## 4. Render

1. Dashboard → the `ai-inventory` service → **Environment**.
2. Edit `FIREBASE_SERVICE_ACCOUNT_JSON`; paste the same single line from `server/.env`; **Save**.
3. Wait for the deploy, then confirm `GET /api/health` returns 200 with `status: ok` and `db: connected`.
4. On a **paid** plan, set Settings → **Pre-Deploy Command** to `npm run verify:firebase`; a dead key
   then aborts the deploy and the running service keeps serving. The Free plan has no such hook, so §3
   is the gate: verify locally before you save the value.
5. Sign in on a device. A new row in the `sessions` collection of `inventoryai_prod_db` proves the
   exchange minted a real session.

Only authorized people may open the Environment tab: anyone who can read it can read the credential.

---

## 5. Rotation — in this order

1. Create a new key (§1). **Do not delete the old one yet.**
2. Put the new JSON in `server/.env` (§2).
3. `npm run verify:firebase` → `VERIFIED`.
4. Update Render and deploy; `/api/health` must be 200.
5. Sign in on a device; confirm a new session row.
6. Delete the old key in the console, leaving exactly one.
7. `npm run verify:firebase` again, then sign in again.
8. Delete `server/logs/.env.before-key.bak` and any older `.env` backups.

Deleting the old key before step 5 removes your rollback. That is the one ordering rule.

---

## 6. Reading a failure

| Symptom | Cause | Fix |
| --- | --- | --- |
| Sign-in 503 *"We could not verify your sign-in right now"* | Server's credential rejected at the revocation check | run `npm run verify:firebase` |
| Sign-in 503 *"Sign-in is temporarily unavailable"* | No usable service account (value missing or unparseable) | check the variable parses |
| Sign-in 401 *"This sign-in could not be verified"* | The **client's** ID token was rejected | sign in again on the device |
| `invalid_grant` from the checker | Key deleted, revoked, or from a different account | new key |

A green `/api/health` proves nothing about Firebase: it never touches the credential.

---

## 7. Security rules

- Never paste the credential into chat, an issue, a pull request, a ticket or a terminal transcript.
- `server/.env` stays git-ignored and out of cloud-synced folders.
- Backups belong in `server/logs/` (git-ignored) and are deleted after verification.
- Exactly one live key at a time; delete dead keys.
- Enable 2FA on Google Cloud and Render, and restrict who can view Render's Environment tab.

---

## 8. Why one variable, not three

`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` are supported and tested,
but they reintroduce two failure modes: a PEM pasted through a web dashboard can lose its line breaks,
and the fields can be mixed from different downloads. One JSON cannot be mis-paired, carries
`private_key_id`, and a damaged paste fails to parse instead of half-working. `server/.env.example`
recommends the single variable for the same reason.

---

## 9. Related

- [`ACCOUNT_MIGRATION_RUNBOOK.md`](ACCOUNT_MIGRATION_RUNBOOK.md) — owner, providers and approval gates
- [`AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md`](AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md) — how identity and sessions work
- [`SOURCE_PROTECTION.md`](SOURCE_PROTECTION.md) — what protects the credential and what does not
