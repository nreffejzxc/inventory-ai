# Developing on a Physical Android Device (Windows)

The developer reference for running Inventory AI on a real Android phone — no emulator. It changes
no product behaviour; the beginner walkthrough is [Guide 2](guides/2-run-on-your-phone.md).

§7's tunnel, launch and pre-flight steps were executed on this machine (2026-10-11) against an
**OPPO CPH1969, Android 11 (SDK 30)**; its journey table is derived from the code. §9b's headless
traps were measured on the same phone. Installation, mirroring and the wireless session are taught
step by step in [Guide 2](guides/2-run-on-your-phone.md) and
[Guide 15](guides/15-wireless-phone-session.md); this file keeps only the depth those guides do not
carry. Section numbers are stable so the roadmap's older citations still resolve.

---

## 0. The mental model

```text
  your phone                         your laptop
  ┌──────────────┐   USB cable   ┌──────────────────────────────┐
  │  Inventory   │◄─────────────►│ adb        (the bridge)      │
  │  AI (dev     │    Wi-Fi      │  └─ scrcpy  video ◄── input  │
  │  client)     │◄─────────────►│  └─ Metro  :8081  (JS)       │
  └──────────────┘               │  └─ API    :4000  (backend)  │
                                 └──────────────────────────────┘
```

| Piece | What it does | Why |
| --- | --- | --- |
| **adb** | Runs commands on the phone over USB | Everything else is built on it |
| **scrcpy** | Streams the screen back and sends your input | You watch and control the phone |
| **Expo dev client** | A build whose JS comes from your laptop | A standalone APK has the JS baked in and cannot load your edits |
| **Metro (`:8081`)** | Serves the JS bundle | Makes hot reload possible |
| **Backend (`:4000`)** | Serves the API | The phone never contacts MongoDB |

The commonest misunderstanding: **a `preview` or `production` build is not a dev client.** Only the
`development` profile (`developmentClient: true`) loads from Metro.

---

> **This is the developer reference, not the beginner walkthrough.** For the plain-language,
> step-by-step path (install adb, enable USB debugging, put a dev build on the phone, mirror the
> screen) read [Guide 2](guides/2-run-on-your-phone.md); for a cable-free session read
> [Guide 15](guides/15-wireless-phone-session.md).
> What follows is the depth those guides do not carry: the signed-in walkthrough and the log lines it
> must produce, the failure table, and the headless-harness traps.

## 7. The authenticated walkthrough

Getting the app **running** is [Guide 2](guides/2-run-on-your-phone.md). Getting it **signed in** crosses Firebase, the mail provider and
MongoDB, and the first successful run is what creates a tenant.

### 7a. Why the first run is special

```text
Firebase account → code mailed → you verify → MongoDB Business + User → Inventory AI JWT
```

No `Business`, `User`, JWT or session row exists until the address is verified; the first person to
verify **creates the tenant** and becomes its OWNER. Three things that look like bugs and are not:

- **The database is not empty just because your tenant is.** On this machine it is
  `inventoryai_dev_db`, which holds acceptance-test tenants. Read the name from the boot line (§7c
  probe 1b) rather than assuming it.
- Inventory, dashboard, history and audit are **legitimately empty** on a new tenant.
- An address that already exists in Firebase does not fail cleanly — see §7f.

### 7b. The USB tunnels (verified)

```powershell
adb reverse tcp:8081 tcp:8081
adb reverse tcp:4000 tcp:4000
adb -s $serial reverse --list          # MUST list both
```

`mobile/.env` → `EXPO_PUBLIC_API_URL=http://localhost:4000`, then restart Metro with `--clear` and
launch:

```powershell
adb shell am start -a android.intent.action.VIEW `
  -d "inventoryai://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

| Signal | Proves |
| --- | --- |
| `Android Bundled …` in Metro | the **phone** fetched JS from **this** Metro |
| `mResumedActivity: … com.inventoryai.app/.MainActivity` in `dumpsys activity activities` | the app is foreground, not a crash dialog |
| a new `{"type":"http",…}` line in the backend | the phone reached **this** laptop's API |

Two tunnel facts, both observed here: **tunnels do not survive an adb restart or a replug** (re-run
both and check `--list`), and **after an adb daemon restart the phone can drop to `unauthorized`**.

To test the tunnel independently of the app:

```powershell
adb shell am start -a android.intent.action.VIEW -d "http://localhost:4000/api/health/live"
# backend then logs GET /api/health/live -> 200 (plus GET /favicon.ico -> 404)
```

### 7c. Pre-flight — four probes, before you type anything

Run from the repository root; the `.env` paths are relative to it. All four passed on 2026-10-11.

```powershell
# 1. Server up and MongoDB reachable
curl.exe -s -o NUL -w "ready %{http_code}`n" http://localhost:4000/api/health/ready
# -> ready 200

# 1b. WHICH database. `MONGODB_DB_NAME` decides it; the URI's path segment does not, and a client
#     built from the URI alone falls back to a database named `test` that does not exist here.
#     Read the boot line: `[db] connected to MongoDB (database: inventoryai_dev_db)`.
#     Before 2026-10-11 it served inventoryai_test_db — the database `npm test` writes to and
#     (then) `cleanup:test-mongodb` emptied; that script is now `npm run cleanup -- --target=database`,
#     which reaches the test database only through `npm test`. Roadmap §27AV, §27FU.

# 2. THE decisive probe: a deliberately invalid token on a route that verifies one.
curl.exe -s -X POST http://localhost:4000/api/auth/email-verification/request `
  -H "Content-Type: application/json" -d "{\"idToken\":\"not-a-real-token\"}"

# 3. Is Email/Password enabled for the Firebase project?
$key = (Get-Content .\mobile\.env | Select-String '^EXPO_PUBLIC_FIREBASE_API_KEY=').ToString().Split('=',2)[1]
curl.exe -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$key" `
  -H "Content-Type: application/json" `
  -d "{\"email\":\"preflight-does-not-exist@example.invalid\",\"password\":\"not-a-real-password-1\",\"returnSecureToken\":false}"
# INVALID_LOGIN_CREDENTIALS / EMAIL_NOT_FOUND = enabled, proceed
# OPERATION_NOT_ALLOWED = BLOCKER: enable Email/Password in the console

# 4. Is the mail sender verified in Brevo?
$bk = (Get-Content .\server\.env | Select-String '^BREVO_API_KEY=').ToString().Split('=',2)[1]
curl.exe -s -H "api-key: $bk" -H "accept: application/json" `
  -H "User-Agent: InventoryAI-preflight/1.0" https://api.brevo.com/v3/senders
# -> {"senders":[{"email":"<your MAIL_FROM>","active":true}]}  MAIL_FROM must appear, active
```

Probe 2 is a configuration report:

| Answer | Meaning |
| --- | --- |
| `FIREBASE_TOKEN_INVALID` (HTTP 400) | Admin credentials, pepper and mail provider are all present — healthy |
| 503 `FIREBASE_NOT_CONFIGURED` | the service account is missing or unparseable |
| 503 `EMAIL_VERIFICATION_NOT_CONFIGURED` | the 32+ character pepper, or the mail provider, is missing |
| 503 `EMAIL_VERIFICATION_MAIL_FAILED` | provider refused a send — only reachable with a valid token |

> **Probe 4 answering 403 with a Cloudflare "Error 1010" page** is a request-shape block, not a Brevo
> refusal: a bare HTTP client is rejected before the API sees it. The `User-Agent` above is the fix.
> Do **not** read it as "the sender is unverified".

### 7d. The journey, and what each step must leave in the log

| # | On the phone | Backend must log | Note |
| --- | --- | --- | --- |
| 1 | Tap **Create one** | *nothing* | a line here means something else fired |
| 2 | Business name, name, email, password → **Create Account** | *nothing yet* | talks to **Firebase over the phone's internet** |
| 3 | *(auto)* request the code | `POST /api/auth/email-verification/request → 200`, then `email_verification_code_requested` | the code goes to the address the **token** names |
| 4 | Type the six digits | `POST /api/auth/email-verification/confirm → 200`, then `email_verification_completed` | 5 attempts, 10-minute TTL |
| 5 | *(auto)* tenant creation | `POST /api/auth/firebase/register → 201` | the only 201 in the flow |
| 6 | *(auto)* session exchange | `POST /api/auth/firebase/exchange → 200` | the JWT is minted here and nowhere else |
| 7 | Dashboard | `GET /api/auth/me → 200`, then the screen's list calls | empty lists are correct on a new tenant |

If step 2 works and step 3 logs **nothing**, the app could not reach the API — check
`adb reverse --list` first.

### 7e. Reading the log

**Boot lines**, printed once, and the only place the resolved database name appears:

```text
[db] connected to MongoDB (database: inventoryai_dev_db)
[server] environment=development listening on http://localhost:4000
```

**HTTP records**, one per request:

```json
{"ts":"2026-10-11T08:18:17.000Z","level":"info","type":"http","requestId":"…","method":"GET","path":"/api/health/live","status":200,"durationMs":1.9}
```

`path` excludes the query string and **the body is never logged**, so a token, password or code stays
out of the log by construction.

**Event records** — flow milestones from an allowlist:

| `type` | `reason` values | Means |
| --- | --- | --- |
| `email_verification_code_requested` | — | a code became the identity's current challenge |
| `email_verification_completed` | — | the code was right and Firebase recorded `email_verified` |
| `email_verification_failed` | `blank_code`, `invalid_code`, `mail_not_configured`, `mail_delivery_failure`, `mail_dispatch_error` | refused, or undeliverable |
| `email_verification_bridge_failed` | `firebase_token_invalid`, `firebase_not_configured`, `firebase_unavailable`, `firebase_unknown` | the code was **right** and the Admin write failed |
| `firebase_token_rejected` / `firebase_unavailable` / `firebase_not_configured` | e.g. `malformed-token` | the verifier's own verdict |

None carry a uid, address, code, HMAC, pepper or token, so a log can be pasted into an issue unedited.

```powershell
cd C:\Users\jeffe\inventory-ai\server
npm start *> "$env:TEMP\inventoryai-server.log"

Get-Content "$env:TEMP\inventoryai-server.log" -Wait |
  Select-String 'email_verification|api/auth|firebase_|"status":5'
```

Keep log files out of the repository; `$env:TEMP` is fine. In Git Bash:
`grep -aE 'email_verification|api/auth' file.log`.

**Three reading traps:**

- **Your own `curl` and the phone's requests land in the same log.** A request you made is not
  evidence the app is connected — that is why §7b uses the phone's browser.
- **`uiautomator` under Git Bash:** MSYS rewrites `/sdcard/w.xml` into a Windows path, and the dump
  reports `UI hierchary dumped to: /Files/Git/sdcard/w.xml`. Set **`MSYS_NO_PATHCONV=1`** or write
  `//sdcard/w.xml`. PowerShell never had this problem.
- **A failed dump leaves the previous file, so a naive reader returns a stale screen.** On
  2026-10-12 a stale dump showed Login while the phone sat on the dashboard; the server log caught
  it. Delete the file before every dump and treat a 0-byte read as failure. Dumps also fail
  intermittently with `ERROR: null root node returned by UiTestAutomationBridge`, and on the two
  six-digit screens — which repaint every second — they answer `ERROR: could not get idle state`.
  **Read the screenshot for those screens** and let the server log say what happened.

### 7f. Failure → log line → cause → fix

| You see | Backend log | Cause | Fix |
| --- | --- | --- | --- |
| *"Cannot reach the sign-in service"* | **no line** | the **phone has no internet**; Firebase does not use the tunnel | reconnect the phone's data/Wi-Fi |
| *"An account with this email already exists"* | no line | Firebase has the address and this password does not open it | sign in, or use another address |
| Silently adopted, verify screen, code in flight | `request → 200`, `code_requested` | the address existed and the **same password** opened it | expected — continue |
| Failure right after **Create Account** | `email_verification_failed` + `mail_delivery_failure`, or 503 | the send failed; the challenge was kept and its cooldown runs | wait out the cooldown, then **Resend** |
| Resend refused immediately | 429 `EMAIL_VERIFICATION_RATE_LIMITED` + `Retry-After` | the 60-second cooldown | wait the seconds the app shows |
| 429 persists | 429 on every verify route | the per-IP limiter: 30 requests / 15 min | wait, or restart the server (dev only) |
| *"That verification code is invalid or has expired"* | 400 `email_verification_failed` `invalid_code` | wrong, expired (10 min), used, or 5 attempts spent | request a new code — one answer deliberately covers all four |
| Code never arrived | `code_requested`, no failure | it left the server | check Spam/Promotions |
| 503 `EMAIL_VERIFICATION_NOT_CONFIGURED` | same | pepper or mail provider missing | fix `server\.env`, restart |
| 503 `FIREBASE_NOT_CONFIGURED` | same | service account missing/unparseable | fix `FIREBASE_SERVICE_ACCOUNT_JSON`, restart |
| 503 `FIREBASE_UNAVAILABLE` | `firebase_unavailable` | Google unreachable | transient; retry |
| 400 `FIREBASE_TOKEN_INVALID` | `firebase_token_rejected` | credential expired or **revoked** | **Wrong account? Sign out**, start again. It is 400, not 401, so a bad provider credential never looks like a lost session |
| Asked for the business name again | `exchange → 403 REGISTRATION_REQUIRED` | the registration context is **in memory** and an app restart clears it | type it again — this is the recovery path |
| `409 EMAIL_IN_USE` | same | a MongoDB account already owns the address | sign in to it |
| Spins, then fails, everything else fine | **no line** | the tunnel dropped | `adb reverse --list`, re-run both |

### 7g. What this proves

**Verified 2026-10-11:** the tunnels, Metro serving the device, the launch deep link, the phone's own
request reaching this laptop, `mobile\.env` pointed at `http://localhost:4000`, and all four
pre-flight probes. **Not performed:** the registration journey end to end on the device — §7d–§7f are
code-derived. **Outside this machine's reach:** the provider's daily quota, and whether the receiving
mailbox files the code as spam.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| scrcpy `Could not change "stay_on_while_plugged_in"` | ColorOS refuses `WRITE_SECURE_SETTINGS` | harmless — only stay-awake is skipped; raise the screen timeout |
| Mirroring fine, taps do nothing | OEM blocks input injection | enable **USB debugging (Security settings)**, restart scrcpy |
| `adb: failed to stat …` on install | a Git-Bash path was passed to Windows adb | Windows path, or `cygpath -w` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | different signing key | `adb uninstall com.inventoryai.app`, reinstall |
| App cannot reach the backend | IP changed, or firewall blocks 4000 | fix `EXPO_PUBLIC_API_URL` + `--clear`; allow Node on **Private**; or use `adb reverse` |
| `ping` fails but the app works | Windows drops ICMP, allows TCP | **do not trust ping** — test the port |
| `Could not parse Expo config: google-services.json` | those files are EAS-managed | non-fatal; ignore |
| Stale UI after `.env` | inlined at bundle time | `npx expo start --dev-client --clear` |
| `uiautomator dump` writes to `/Files/Git/sdcard/…` | Git Bash rewrote the path | `MSYS_NO_PATHCONV=1` (§7e) |
| `uiautomator`: `null root node …` | intermittent accessibility read | retry, fall back to scrcpy, `dumpsys activity activities`; never trust a stale file |
| Network error while the backend is healthy | the `adb reverse` tunnels were lost | re-run both, confirm with `--list` |
| A route the source contains answers **404** | **the server is older than the route** — a long-lived `npm start` never reloads | `curl` it from the laptop: 404 = restart (`npm run dev` watches) or deploy; only 200/400 makes the phone the suspect |
| *"Cannot reach the sign-in service"* while the API is reachable | Firebase Auth uses the phone's internet, not the tunnel | reconnect the phone |
| `scripts/device/run.mjs` reports the **Expo dev launcher** | a cold-started dev build opens the launcher; a route deep link cannot reach a stopped app | start Metro, pick the server in the launcher, re-run |
| `scripts/device/run.mjs` reports **"Session expired"** | the app holds a token the server no longer accepts | sign in on the phone; exit **2** means "could not check", not an app defect |

---

## 9b. Driving the app without the screen (headless)

Coordinates below are **this** phone's (1080×2340) — take them from the dump every time.

**Navigate by deep link:**

```bash
adb shell am start -a android.intent.action.VIEW -d "inventoryai://ai"
# "Activity not started, intent has been delivered to currently running top-most instance."
# is the SUCCESS message, not an error.
```

**Read the screen as text:**

```bash
MSYS_NO_PATHCONV=1 adb shell uiautomator dump /sdcard/ui.xml
MSYS_NO_PATHCONV=1 adb shell cat /sdcard/ui.xml | tr '>' '\n' \
  | grep -oE 'text="[^"]+"' | sed 's/text="//;s/"$//'
```

**Tap a node's centre.** `bounds="[48,2040][756,2172]"` → `adb shell input tap 402 2106`. The trap:
**opening the keyboard lifts the row**, so a Send button can sit at y≈2103 closed and y≈1338 open — a
tap at the old coordinates hits the keyboard and **the message silently never sends**.

**Confirm focus before typing.** `input text` goes to the focused view, and a tap does not always move
focus: once the password landed in the **email** field and login failed with nothing on screen to
explain it. Dump after the tap; check `focused="true"` and take the field's current bounds.

**A blank screen after `input text` is usually a reload, not a crash.** `input text` injects hardware
key events, and RN's development support maps a stray **`r`** to *reload*. Confirm focus first, and
read `adb logcat` for `Starting React Native reload` before calling it a crash. A password with no `r`
in it (`Testpass9021`) removes the trap.

**A floating `Tools` control is the dev client's overlay**, not your app (here at `[915,852][993,930]`).
Tapping it opens the dev menu and swallows the next tap too; `BACK` dismisses it.

**`uiautomator dump` can answer `null root node returned by UiTestAutomationBridge`.** Measured on
2026-10-26: four consecutive reads failed over several minutes while `dumpsys activity` still reported
the app resumed and a screenshot rendered normally — nothing was wrong with the phone or the app.
**HOME, then relaunching the app, restored it immediately**, and every run since has been clean. The
obvious suspect was on screen at the time — this OPPO keeps `AssistOverlayBottom` and
`ColorOSEdgeFloatBar` windows flagged `isVisible=true`, and TalkBack's Accessibility Menu was up —
**but that is not established as the cause**: those windows are visible while dumps work, and a full
24-step run passed with them up. Read it as "the accessibility tree was momentarily unavailable":
retry a few times, then background and relaunch before blaming the build.

**A modal left open swallows the next deep link.** The stock, transfer and PO confirmations ("Done. …
0 → 5" with an `OK`) are modal: `am start` still prints *"intent has been delivered to currently
running top-most instance"*, the dialog stays, and the screen you read is the dialog rather than the
route you asked for. Dismiss it first, or the next assertion is made against the wrong screen.

**Make sure the server you started is the one answering.** On Windows a second `npm start` can bind
`:4000` while a stale process keeps serving — the new one still prints its banner and `/health/ready`
still says ready, from the old process. Check:

```bash
netstat -ano | grep '0.0.0.0:4000'      # LISTENING <pid> — compare with the PID you started
tasklist //FI "IMAGENAME eq node.exe"
curl.exe -s -D - -o NUL http://localhost:4000/api/health/live | grep -i x-instance-id
```

The proof is always **the thing you pointed the config at**. Since 2026-10-18 every response carries
`x-instance-id`, the startup line prints the same id, and a boot asks the port it just bound to name
itself — a different id there is fatal, so the silent case is no longer silent. An already-running
stale process still has to be stopped by hand.

**Repeatable passes: use the harness.**

```bash
node scripts/device/run.mjs --list
node scripts/device/run.mjs                                # read-only: 7 screens, data on 2
node scripts/device/run.mjs --all --sku=SMOKE-1             # + label PDF decode (needs a barcode)
node scripts/device/run.mjs --journey=stock --sku=SMOKE-1 --source='Smoke shelf' --allow-writes
node scripts/device/run.mjs --journey=transfer --sku=SMOKE-1 \
  --source='Smoke shelf' --destination='Smoke' --allow-writes
node scripts/device/run.mjs --journey=draft --allow-writes
node scripts/device/run.mjs --journey=stock --until=9       # stop after step 9, write state.json
```

**No journey takes an internal id.** A product is named by its **SKU**, which is something a person
can read off the product screen: `findProduct` types it into the products search, opens the row, and
only proceeds once that screen prints the SKU back. The old `--product=<id>` flag is gone, and
supplying it is rejected as an unknown option. `transfer` then chooses the product in the form's own
picker by the **name** that screen printed — never a guess, and `optionTarget` refuses an ambiguous
match rather than moving the wrong product's stock.

It needs the phone and both tunnels, and exits **2** ("could not check") when a precondition is
missing — signed out, no debuggable build (the `label` journey reads the app's own PDFs), no product
with that SKU, no barcode on it, or a picker with nothing to choose. Evidence lives in
[`docs/evidence/device-runs`](evidence/device-runs/README.md).

A passing run means **data, not just screens**: `expectData` steps wait for a server-only label (a
stock row's `33 available · 33 on hand`, a product's `SKU … · Barcode …`) and fail on an error state.
That exists because a run once reported **17/17 on a phone where every request was refused 401** — a
heading renders over an empty list exactly as well as over a full one. `expectClean` covers screens
that may legitimately be empty and fails only if one **stopped on an error**.

The traps are encoded in it: `exec-out` for binaries (`adb shell cat` rewrote a PDF's newlines and a
good label was reported undecodable), distrust inverted dump boxes, close the keyboard only when
`dumpsys input_method` says it is open, and dismiss the app's own confirmation before the next journey.

**A picker's search box hides the results it just filtered — measured 2026-10-26.** With the IME up,
the product sheet was 530 px tall and its one row sat in the hierarchy at `[0,1422][1080,1575]` while
being painted **nowhere** (screenshot: empty space above the keyboard); with the keyboard down the
same row is at `[0,2055][1080,2208]` and tappable. So on this device you can type a filter and then
not see or press anything it found. `BACK` and `ESCAPE` do not help: both close the whole sheet (the
`Modal`'s request-close). Until the sheet is fixed, reach a row by **scrolling the list**, which is
what the harness's `pick` does — it never types into a sheet. This is an app defect, recorded rather
than worked around silently.

**`Done` is the only proof a sheet is open.** A form's own label carries the same word as the sheet
heading (`Supplier *`), so on a tenant with **no suppliers** the disabled picker never opened,
`tapFirst` read the form label as a heading, tapped a row under it and reported **PASS** — the
purchase order then failed with "Supplier is required.", pointing at the wrong control. The harness
now requires the sheet's `Done` control before it treats anything as a sheet, and calls an unopened
picker **BLOCKED** (nothing to choose here) instead of a defect.

---

## 10. Wireless

The complete runbook is [Guide 15](guides/15-wireless-phone-session.md); the one-command helper and
its measured setup are documented there. The measured fact this reference adds: the wireless
session was run on 2026-11-06 against this OPPO at `192.168.1.2:5555`, and the phone both loaded the
bundle from Metro and reached the backend through the wireless ADB reverse tunnel. Reverse tunnels
do not survive a new ADB connection; recreate both after any reconnect.

---

## 11. Local quota-refusal stub

[`scripts/device/quota-stub.mjs`](../scripts/device/quota-stub.mjs) is the reusable
OpenRouter-shaped provider for quota walkthroughs. It binds `127.0.0.1` only, never contacts a real
provider, and requires no credentials. The 2026-11-13 first- and second-refusal records used the same
wire shape, and the
[fresh revalidation](evidence/ai-quota-committed-stub-2026-11-13/README.md) used this helper end to
end. Future runs should use it instead of rebuilding a scratch server.

Start it from the repository root:

```bash
node scripts/device/quota-stub.mjs --port=5999 --log=.scratch/quota-stub.jsonl
```

`--log` is optional. Without it, one JSON request record per line goes to stdout. Records contain the
message text the app sent, so keep a log file under ignored `.scratch/` and never commit it.

Point the local API at it without changing production configuration:

```bash
cd server
AI_PROVIDER=openrouter \
OPENROUTER_BASE_URL=http://127.0.0.1:5999 \
OPENROUTER_API_KEY=local-stub-not-a-secret \
AI_MODEL_OPENROUTER=stub/model-1 \
AI_RATE_LIMIT_MAX=1000 \
node src/index.ts
```

The stub acknowledges model-health probes and serves an Anthropic-style SSE completion for
`POST /v1/messages`; `stream: false` gets the equivalent JSON body. Control the next completion:

```bash
curl.exe -s 'http://127.0.0.1:5999/control?fail=1'   # refuse the next completion
curl.exe -s 'http://127.0.0.1:5999/control?fail=0'   # clear a pending refusal
curl.exe -s 'http://127.0.0.1:5999/control'           # read { "failNext": ... }
```

A controlled refusal is HTTP `429` with `x-ratelimit-remaining: 0`, `x-ratelimit-limit: 50` and
`{"error":{"message":"stub daily allowance spent","type":"rate_limit_error"}}`. The refusal is
counted once; the following completion succeeds normally.

Run the helper's own checks with no phone, API, database or credentials:

```bash
node scripts/device/quota-stub.mjs --self-test
```

It exercises the control state, a streamed completion, a refusal with the expected headers, the
recovery on the next completion, and the JSON path. The required `server` CI job runs this self-test
before installing dependencies. For the device evidence pattern, see the
[quota recovery index](evidence/ai-quota-recovery-index.md).
