# 6. Scripts and commands

Every command this project ships that is **not about data**: starting the app, checking your work,
measuring the assistant, and maintenance. Putting data in, taking it out and handling logins have
their own guides.

| For | Read |
|---|---|
| Seeding data — development | [9. Seeding data — development](9-seeding-development.md) |
| Seeding data — production | [10. Seeding data — production](10-seeding-production.md) |
| Deleting data — development | [11. Deleting data — development](11-deleting-development.md) |
| Deleting data — production | [12. Deleting data — production](12-deleting-production.md) |
| Firebase logins | [13. Firebase identities](13-firebase-identities.md) |
| Which accounts exist | [4. Test accounts and mock data](4-test-accounts-and-mock-data.md) |
| A word you do not know | [5. Words explained](5-words-explained.md) |

## How to read a command

```bash
cd C:/Users/jeffe/inventory-ai/server                     # where to stand
npm run audit:indexes                                     # settings, then the command
NAME=value npm run some:command -- --flag=value           # a setting for one command only
```

- `cd` — commands only work from their own folder (`server/`, `mobile/`, or the project root).
- `NAME=value` — a setting for one command only.
- `--` — everything after it goes to the script; forget it and npm rejects the option.
- Options are `--name=value`.
- In **PowerShell**: `$env:NAME="value"`, run the command, then `$env:NAME=$null`. Settings are kept
  until you clear them, so clear any confirmation phrase straight after a run.

## Part 1 — Starting things

```bash
cd C:/Users/jeffe/inventory-ai/server
npm start        # backend on port 4000; no build step
npm run dev      # the same, restarting on edits
```

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx expo start --dev-client   # Metro; press "a" to open on a connected phone
npm start                     # same, without --dev-client
npm run android               # expo run:android — BUILDS and installs the native dev app
npm run ios                   # expo run:ios — the same, needs a Mac
npm run web                   # expo start --web
```

`npm run android` and `npm run ios` are **native builds**, not a Metro session: they compile, install
and then start the bundler. To open the bundle on a dev build that is already installed, use
`npm start` (or `npx expo start --dev-client`) and press `a`/`i` instead.

## Part 2 — Checking your work (read-only)

```bash
cd C:/Users/jeffe/inventory-ai/server
npm run typecheck        # silent when clean
npm run lint             # silent when clean
npm run test:unit        # fast, no database
npm test                 # everything, including database tests
npm run test:db          # database tests only
npm run check:extensions # half-finished file rename
npm run check:specifiers # import pointing at nothing
```

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run check:build-env                  # are this project's build settings complete?
node scripts/check-build-env.mjs --live  # …and what the EAS environment holds (needs sign-in)
```

`0 failures` is a pass; `typecheck` and `lint` print nothing when clean; the two `check:` commands print
an explicit `OK`. Database tests use the throwaway `inventoryai_test_db` and **fail loudly** if it is
unreachable — a green run means they really ran.

`check:build-env` verifies what a build profile needs: `EXPO_PUBLIC_API_URL` (a public `https://`
address for a release build), the four Firebase values (**all four or none**), and the two Google
files EAS supplies as file variables (`GOOGLE_SERVICES_JSON`, `GOOGLE_SERVICE_INFO_PLIST`). Without
`--live` it checks only what is written in the project; with it, what the EAS environment holds
([Guide 7 § EAS environments](7-over-the-air-updates.md), and [Guide 2](2-run-on-your-phone.md) for
the build that needs them).

### Label barcode — does it decode?

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/verify-label-barcode.mjs --html --expect=2000053337540
node scripts/verify-label-barcode.mjs --pdf=scripts/fixtures/label-2000053337540.pdf --expect=2000053337540
```

The first decodes the label the app draws now **and** checks geometry (both 11-module quiet zones, a
page large enough). The second decodes a real printed PDF. Exit `0` only on a match, `2` when it could
not look. Its own must-fail controls run first on every invocation.

### One command for the wireless session

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/device/wireless.mjs          # phone -> tunnels -> backend/Metro -> app -> scrcpy
node scripts/device/wireless.mjs --check  # read-only status; changes nothing
node scripts/device/wireless.mjs --stop   # stop the session the helper started
node scripts/device/wireless.mjs --self-test  # recovery, restart failure, and stop controls; no phone needed
```

The helper finds the wireless phone, recreates both reverse tunnels, reuses or starts the backend and
Metro, opens the development client and launches scrcpy. `--serial=<host:port>` selects one device when
more than one is attached; `--stop` closes the managed session from a second terminal; `--help` lists
the options. If ADB is hung at startup, it restarts the local server once; `--self-test` exercises
recovery, a failed restart, and the stop handshake without a phone. It never creates an Expo build.
Full setup and troubleshooting:
[Guide 15](15-wireless-phone-session.md).

### A phone pass you can re-run

Phone connected, development build installed, tunnels up (`adb reverse tcp:4000 tcp:4000`,
`adb reverse tcp:8081 tcp:8081`):

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/device/run.mjs --list
node scripts/device/run.mjs --self-test
node scripts/device/run.mjs                                   # read-only walk, 24 steps
node scripts/device/run.mjs --all --sku=SMOKE-1               # + print a label, decode its PDF
node scripts/device/run.mjs --journey=draft --allow-writes
node scripts/device/run.mjs --journey=stock --sku=SMOKE-1 --source="Smoke shelf" --allow-writes
node scripts/device/run.mjs --journey=transfer --sku=SMOKE-1 \
  --source="Smoke shelf" --destination="Smoke" --allow-writes
```

- Exit **0** all steps passed, **1** a step failed, **2** blocked (no device, no session, no debuggable
  build) — a block is never a pass. `--until=<n>` stops after step `n` and writes `state.json`.
- The write journeys are **net-zero** (`stock` 5 in/5 out; `transfer` stocks 1 in, moves it across and
  back, then stocks it out) and check the app's own confirmation arithmetic. `transfer` supplies its own
  unit because a transfer never creates stock.
- **No journey takes an internal id.** A product is named by its `--sku`, which the harness types into
  the products search the way a person would, and it proceeds only once the product screen prints that
  SKU back. The product must belong to the tenant you are signed in as — another business's slug simply
  has no row, and the run is BLOCKED (exit 2), not failed.
- A picker whose list is empty (a tenant with no supplier) is **BLOCKED** rather than failed: the app
  disables it, so there is nothing to tap and nothing was judged.
- Screens that may legitimately be empty are checked with `expectClean` (not loading, not the error
  state); a screen that never finishes is exit 2.
- The `label` journey reads the code off the screen, taps *Share PDF*, and decodes the PDF with the same
  decoder CI uses (read via `adb exec-out` — `adb shell cat` rewrites newlines).
- Each run writes `report.md`, `report.json` and screenshots to
  `docs/evidence/device-runs/<timestamp>-<journey>/`.
- Not covered: iOS, paper (no printer), the camera.

## Part 3 — Data

Putting data in, taking it out and handling logins are documented where they belong, so there is one
copy of each rule. Guides 9–13 own the rules and the complete invocations; the table below is the index:

| Task | Guide | The command, in one line |
|---|---|---|
| Check which accounts exist before writing | [9](9-seeding-development.md) | `npm run check:accounts [--with-production]` — reads only |
| Seed a tenant, any database | [9](9-seeding-development.md) / [10](10-seeding-production.md) | `npm run seed -- --plan=demo\|accounts\|roles --database=…` |
| Seed the three comparison accounts | [9](9-seeding-development.md) | `npm run seed:three -- --database=…` (preset; development only) |
| Seed accounts you name | [9](9-seeding-development.md) / [10](10-seeding-production.md) | `npm run seed:accounts -- --database=… --accounts="a@x.com:1000,…"` (any size per account) |
| Delete accounts' data, keeping the logins | [11](11-deleting-development.md) / [12](12-deleting-production.md) | `npm run cleanup:three` / `cleanup:account -- --accounts=…` |
| Seed the fixed-figure demo tenant | [9](9-seeding-development.md) | `npm run seed:demo-tenant -- --database=…` |
| Seed a large tenant you can sign into | [9](9-seeding-development.md) / [10](10-seeding-production.md) | `npm run seed:perf-tenant -- --database=… --size=…` |
| Seed the no-login measurement tenant | [9](9-seeding-development.md) | `npm run seed:perf -- --size=…` |
| Read a seed back | [9](9-seeding-development.md) | `npm run verify:demo -- --email=…` (one account) / `--accounts="…:1000[:codes=both],…" --expect-codes=…` (several) / `verify:roles -- --business=…` |
| Clear a whole database | [11](11-deleting-development.md) / [12](12-deleting-production.md) | `npm run cleanup -- --target=database --database=…` |
| Empty one tenant | [11](11-deleting-development.md) | `npm run cleanup:demo\|cleanup:roles\|…` |
| Delete a Firebase login | [13](13-firebase-identities.md) | `npm run cleanup -- --target=firebase --database=… --email=…` |

**The products' codes are a choice.** Each `--accounts` entry takes `codes=both|none|sku|barcode`, the
per-account field `--codes=` sets the run-wide default, and the default is `none` — the app's own barcode
generation then assigns the first code. A seeded barcode is a valid EAN-13, unique per tenant; full detail
and complete commands are in [Guide 9](9-seeding-development.md).

Two facts worth carrying between the guides, because every one of them depends on them:

- **The database is named, twice.** `--database=` must equal what `MONGODB_DB_NAME` resolves, or the run
  refuses before connecting.
- **Two confirmation phrases in development, three in production.** A dry run costs the same, because it
  proves the destination rather than skipping it.

### Comparing the assistant across tenants

The three comparison accounts ([Guide 4](4-test-accounts-and-mock-data.md)) exist to answer one
question: does the assistant stay correct and fast as a catalogue grows?

1. **Clear both stores, in this order** — database first ([Guide 11](11-deleting-development.md) /
   [Guide 12](12-deleting-production.md)), then the three identities by address
   ([Guide 13](13-firebase-identities.md)). The second command refuses
   while any user row still owns an address, which is why the order is a check and not advice.
2. **Register all three in the app** — Create Account → the 6-digit code from the mailbox → dashboard.
3. **Check them** with `npm run check:accounts` — read-only, and it names the tenant each account owns and
   prints the exact production seeding line ([Guide 9](9-seeding-development.md)).
4. **Seed them** with `npm run seed:three` ([Guide 9](9-seeding-development.md)). Dry-run first; production
   refuses the preset, and resolves each named address to its own tenant — which that account must own.
5. **Generate a barcode** on one seeded product: the seeders leave SKUs and barcodes blank unless asked
   (`--codes=both` seeds them), so by default the app's own generation is what assigns the first code.
6. **Compare** the sizes:

```bash
npm run perf:measure -- --business=<id> --label=small
npm run perf:golden -- --business=<id> --out=before.json
npm run perf:turns -- --business=<id> --only=2
```

Measured on a device, **95–97 % of a turn is the model, 3–5 % the queries**, and queries stay
sub-second even at tens of thousands of products — so `perf:measure` is what isolates data size, and
`perf:turns` is what describes the member's experience.

## Part 4 — Measuring the assistant

| Command | Measures |
|---|---|
| `npm run perf:measure -- --business=<id> --iterations=7 --label=before` | each data query's time — **no AI calls** |
| `npm run perf:golden -- --business=<id> --out=before.json` | fingerprints the answers; `--compare=before.json` later |
| `npm run perf:turns -- --business=<id> --only=1,3` | real assistant turns, end to end |
| `npm run ai:usage -- --log=<path>` | turns, failures, requests and the allowance left — nothing spent (`--no-provider` keeps it offline) |
| `npm run ai:usage -- --provider-only` | **just the allowance left today** — no log, database or model call |
| `npm run ai:usage -- --db --days=30` | what was actually answered, from the database |
| `npm run ai:models` | configured chain with live endpoint status and 5m/30m/1d uptime, plus free tool-capable ids |
| `npm run ai:models -- --check=<id>` | one model's health, then one tool-shaped request |
| `npm run ai:check` (`-- --probe`) | the configured models verified against the provider's catalogue |
| `npm run ai:health` (`-- --alert`) | one model-health check; exit 0 healthy, 1 degraded/unavailable, 2 could not check |
| `npm run eval:simple-inventory -- --limit=1` | small disposable fixture; paid baseline then free-first route (`--free-only` skips the baseline; `--validate-only` makes no call) |
| `npm run eval:simple-10k -- --phase=prepare` | disposable 10,256-product tenant and the gate/burst/sustained evaluator; `--phase=prepare` makes no model call |

`perf:golden --compare` exits 0 identical, 1 different, 2 different tenants (a re-seed changes ids).
`perf:turns` reads the allowance first and refuses with exit 2 when it provably cannot fit; `--force`
overrides. All three read the database only; only `perf:turns` spends quota.

**These tools need a database and refuse a guess.** They check a recognised non-production environment
and a resolved development or test database, printed before the first query; they need no phrase,
because measuring is not destructive, but a run that cannot say which database it read is not a
measurement.

### Evaluating the free-first simple route

The two evaluators create their own disposable tenant and remove it in `finally`; neither touches a
real tenant or production. Both need `AI_TEST_ALLOW_PAID_MODELS=true` only after the owner has
approved paid fallback, because the baseline intentionally uses the paid primary.

```bash
cd C:/Users/jeffe/inventory-ai/server

# Small fixture: one paid baseline question, then the free-first route.
AI_TEST_ALLOW_PAID_MODELS=true SIMPLE_EVAL_LIMIT=1 \
  npm run eval:simple-inventory

# Free-only comparison, no paid baseline; still validates the route.
AI_TEST_ALLOW_PAID_MODELS=true npm run eval:simple-inventory -- --free-only --limit=10

# 10,256-product tenant, model calls; prepare makes no call and is the safe first run.
SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
  npm run eval:simple-10k -- --phase=gate
SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
  npm run eval:simple-10k -- --phase=burst --concurrency=40
SEED_CONFIRM=seed-perf-ai AI_TEST_ALLOW_PAID_MODELS=true \
  npm run eval:simple-10k -- --phase=sustained --concurrency=10 --requests=30
```

`eval:simple-10k` accepts `--phase=prepare|gate|burst|sustained`, `--size`, `--seed`,
`--concurrency` (up to 40), `--requests` (up to 80), `--gap`, `--warmup`, `--transport=service|http`,
`--base`, `--out` and `--keep`. `--keep` is the only way to retain the seed tenant for inspection; otherwise a
failed phase also cleans it up. The evaluator writes `<out>.checkpoint.json` after each completed
request. A rerun with the same phase, size, seed, concurrency, requests, gap, transport, base and
models first removes any orphan seed tenant, reseeds the deterministic dataset, checks the dataset
fingerprint, and skips completed request indices. A changed config or dataset discards the old rows;
the checkpoint is removed when the completed artifact is written. `SIGINT`/`SIGTERM` clean up on a
best-effort basis; a hard `SIGKILL` leaves the tenant for the next run's preflight.

### Measuring the deployed server

`perf:turns` is the one measurement that may target production: the deployed `JWT_SECRET` is not on a
laptop, so it signs in like the phone and reads the database that server writes to. That is why it
needs `--database=` **and** `PERF_TURNS_CONFIRM=perf-turns:production`.

```bash
cd C:/Users/jeffe/inventory-ai/server

npm run ai:usage -- --provider-only

NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  PERF_TURNS_CONFIRM=perf-turns:production \
  PERF_ACCOUNT_PASSWORD='choose-a-strong-password' \
  node --env-file=../mobile/.env scripts/measure-ai-turns.mjs \
    --base=https://ai-inventory-l1mi.onrender.com \
    --database=inventoryai_prod_db \
    --business=<businessId> --login --only=1,2,3,4,5,6
```

`--login` signs in through Firebase REST and exchanges the ID token, as the phone does. The Firebase web
key can come from `EXPO_PUBLIC_FIREBASE_API_KEY=` or `--firebase-api-key=` (both public), or be loaded
from `mobile/.env` as above. `PERF_ACCOUNT_PASSWORD` is the seed's credential (`DEMO_ACCOUNT_PASSWORD`
is a fallback).

Questions 1–6: dashboard numbers, reorder total, one product by `SEEDSKU-0`, out-of-stock count and
percentage, total units on hand, products per location. `grounded` counts successful turns whose answer
held every expected fact; `MISSING …` is a real disagreement; `NOT CHECKED` means the turn did not
succeed (transport/quota/server) and is not a wrong answer.

Measured 2026-10-25 on production: at 60 000 documents **6/6 answered and grounded** (3275–13321 ms, one
tool call each); at 80 000 documents questions 1–2 **2/2 grounded** (8713, 16419 ms). A six-question run
cost **13 provider requests** — budget about two per question.

### Changing the AI models yourself, and the watchdog

```bash
# server/.env (and the deployed host's environment)
AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free,liquid/lfm-2.5-2.6b:free,nvidia/nemotron-3-super-120b-a12b:free
AI_MODEL_FAILURE_THRESHOLD=5     # default 5 failures open a cooldown
AI_MODEL_COOLDOWN_MS=30000       # first cooldown; backs off 30s, 60s, 2m, 4m, then ≤5m
AI_ATTEMPT_MAX_MS=0              # optional per-attempt slice; 0 = off
AI_QUOTA_BLOCK_MS=30000          # a zero-remaining refusal blocks calls this long
```

To change models: `npm run ai:models` to see health, `--check=<id>` to try one, edit the line, restart
the server (`.env` is read at boot), then `npm run ai:check` (`-- --probe`). On Render a changed variable
applies on the **next deploy**, not a restart.

Watchdog and alert variables:

```bash
AI_HEALTH_ALERT_EMAIL=owner@example.com
AI_HEALTH_WATCH_ENABLED=true            # production on; development/test off
AI_HEALTH_WATCH_INTERVAL_MS=1800000     # 30 minutes
AI_HEALTH_WATCH_INITIAL_DELAY_MS=60000
AI_HEALTH_MIN_UPTIME_5M=90
AI_HEALTH_MIN_UPTIME_30M=95
AI_HEALTH_UNKNOWN_ALERT_AFTER=2
```

The watchdog reads `GET /v1/models/{author}/{slug}/endpoints` (a GET, no quota), classifies each model
**ok / degraded / unavailable / unknown**, alerts only on state change, and emails through Brevo, or logs
at error level when mail is not configured. If every model is cooling, the assistant answers its normal
temporary-unavailability message without spending a request. A quota refusal (429/402) is never treated
as a model outage.

### Capturing the log the usage report needs

```bash
cd C:/Users/jeffe/inventory-ai/server
mkdir -p logs
npm start > logs/server.log 2>&1

npm run ai:usage -- --log=logs/server.log
npm start | npm run ai:usage --silent --      # or straight off a running server's output
grep 'AI turn outcome=' logs/server.log | grep -v outcome=ok
grep 'empty completion' logs/server.log
```

Turn lines exist only in stdout (never stored), so timeouts, abandoned turns and quota refusals appear
only here; the database half shows what was answered. The `empty completion` line names the model,
whether the body reported usage, which block types it carried and which top-level fields — never the body
itself.

## Part 5 — Maintenance (from the project root)

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/check-secrets.mjs           # 0 = clean; waive a line with "secret-guard:allow"
node scripts/audit-access.mjs            # repo privacy/access; needs gh signed in; run by hand
node scripts/check-upgrade-watches.mjs   # deferred upgrades; --json, --self-test; needs network
```

```bash
cd C:/Users/jeffe/inventory-ai/server
npm run audit:indexes
```

`audit:indexes` asks the **database** whether every declared index exists. Exit **0** all present, **1** a
real disagreement (never auto-fixed — the fix can drop an index someone added), **2** **NOT VERIFIED**,
the audit could not run. Nothing is created, changed or dropped.

### Backup and restore

```bash
cd C:/Users/jeffe/inventory-ai/server

BACKUP_DIR=C:/Users/jeffe/inventory-ai-backups CONFIRM=backup-db npm run backup:db

CONFIRM=restore-db npm run restore:db -- --from=<folder> --dry-run

CONFIRM=restore-db npm run restore:db -- --from=<a folder you already dry-ran>
```

The free Atlas tier has **no backups**; this pair is the answer. `backup:db` writes one gzipped file per
collection plus a `manifest.json` with every file's length and SHA-256; `restore:db` verifies those
fingerprints **before** dropping and inserting.

| | `backup:db` | `restore:db` |
|---|---|---|
| Database | any, including production | `inventoryai_test_db` or `inventoryai_dev_db` **only** |
| Folder | `BACKUP_DIR`, **outside the project** | `--from=` |
| Phrase | `CONFIRM=backup-db` | `CONFIRM=restore-db` |
| `--dry-run` | — | verifies and reports, writes nothing |

A dump inside the repository is refused (one `git add` from being committed). A name containing `prod` or
`live` is refused even if the list were edited. A long restore prints progress every 50 000 documents.
Watch the `size` line: a 525 750-document restore needs ≈240 MB, which fills a 512 MB free tier — the
command reports that and exits 1. The habit worth forming: restore into the test database and run
`npm test` before you need it.

### Files that are not commands

`server/scripts/perf/lib.mjs` (the perf tenant definition, the safety guard and teardown helpers),
`server/scripts/seed/lib.mjs` (the dataset shape shared by every full-tenant seeder — demo, accounts,
roles, perf-tenant),
`server/scripts/seed/guard.mjs` and `server/scripts/cleanup/guard.mjs` (the one target rule each),
`server/scripts/cleanup/lib.mjs` + `run.mjs` (the guarded delete sequence). Opening them does nothing, by
design. Also automatic: `npm install` in `mobile/` applies a `postinstall` patch.

## Part 6 — Destructive commands

The guides it points at hold all of it; nothing here repeats their rules.

| Family | What it destroys | Guide |
|---|---|---|
| `npm run cleanup -- --target=database` | every document in one named database, **logins included** | [11](11-deleting-development.md) / [12](12-deleting-production.md) |
| the tenant cleanups (`cleanup:demo`, `cleanup:perf-tenant`, `cleanup:demo-tenant`, `cleanup:roles`, `cleanup:perf`) | one named tenant, verified afterwards | [11](11-deleting-development.md) |
| the accounts cleanups (`cleanup:three`, `cleanup:account`) | the seeded data of the accounts you name — **their logins and business rows are kept** | [11](11-deleting-development.md) / [12](12-deleting-production.md) |
| `npm run cleanup -- --target=firebase` and `cleanup:test-firebase` | Firebase identities — **irreversible** | [13](13-firebase-identities.md) |
| `npm run restore:db` | the development or test database (it drops collections) | Part 5 above |

The shape they share: the target is named on the command line, the name must equal what the process
resolved, and the number of confirmation phrases follows the target — **two in development, three in
production**. There is no interactive prompt and no default target.

Two things a reader arriving here usually wants to know:

- **The old names are gone.** `cleanup:test-mongodb`, `cleanup:dev-mongodb`, `cleanup:prod-mongodb`,
  `cleanup:all-mongodb` and `cleanup:firebase-accounts` were each this command with a target baked in;
  `npm run` on them now fails with "missing script".
- **Order matters when logins are involved.** Clear the database first, delete identities second, or the
  address is locked out for good. The command refuses in the wrong order rather than trusting the
  operator — [Guide 13](13-firebase-identities.md).

## Part 7 — What runs by itself

CI has four jobs. The **server** job runs `typecheck`, `lint`, `check:extensions`, `check:specifiers`, the
full test suite and a boot smoke test. The **mobile** job runs `typecheck`, the build-environment contract,
Jest, the Metro/Expo bundle check, the printable-label barcode check and the wireless helper's
`--self-test`. The **secret-guard** job proves its scanner can fail before scanning, and the
**attribution-guard** job checks the commit messages the event introduces. Not automatic, because they
write or need your credentials: the seeders, cleanups, performance probes and `audit-access.mjs`.

Separately, the **TypeScript 7 watch** runs every Monday at **06:17 UTC** and on manual dispatch. It
runs the read-only `check-upgrade-watches` gate against both workspaces and opens **one** issue only
when the parser chain on both paths admits TypeScript 7 and a workspace is still below it. It fails
when the gate itself cannot be read, rather than treating that as deferred, and it never upgrades a
dependency. Start it by hand with `gh workflow run typescript-7-watch.yml`; the exact issue title and
the #32 ledger live in the workflow.

The **production health watch** runs every five minutes from GitHub Actions, outside Render and this
laptop. It probes `/api/health/ready` and `/api/health`; two consecutive failures open one GitHub issue
(the external notification), and recovery closes it. The same check can be run by hand:

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/check-production-health.mjs --attempts=2 --delay-ms=20000
gh workflow run production-health-watch.yml
```

`/api/health/ready` answers 200 only when the database is reachable now; `/api/health` must also say
`status: ok` and `db: connected`. The counters remain per process (reset on restart), public, and free
of names, paths, users or messages. GitHub can delay scheduled runs, so this is detection rather than a
five-minute SLA.

## Part 8 — The whole list

**`server/`**

| Command | Does | Safe? |
|---|---|---|
| `npm start` / `npm run dev` | backend on 4000 / restarting on edits | ✅ |
| `npm run typecheck`, `lint`, `test:unit`, `test:db`, `test` | checks and tests | ✅ |
| `npm run check:extensions`, `check:specifiers` | module-graph plumbing | ✅ |
| `npm run audit:indexes` | are declared indexes really there | ✅ reads |
| `npm run backup:db` | recoverable copy (needs `BACKUP_DIR` outside the project) | ✅ reads; safe on production |
| `npm run restore:db -- --from=…` | put a copy back (needs `CONFIRM=restore-db`) | ⚠️⚠️ test/dev only; `--dry-run` |
| `npm run ai:usage`, `ai:models`, `ai:check`, `ai:health` | cost, allowance, models, health | ✅ reads |
| `npm run perf:measure`, `perf:golden` | query timings / answer fingerprints | ✅ reads |
| `npm run perf:turns` | real turns (`--login` for a deployment) | ⚠️ spends AI quota |
| `npm run eval:simple-inventory`, `eval:simple-10k` | free-first simple-inventory evaluation on a disposable tenant | ⚠️ spends AI quota; dev database only |
| `npm run check:accounts`, `verify:demo`, `verify:roles` | whether the accounts exist, and read a seed back | ✅ reads |
| `npm run seed`, `seed:demo`, `seed:accounts`, `seed:three`, `seed:roles`, `seed:demo-tenant`, `seed:perf`, `seed:perf-tenant` | sample data in | → [Guides 9](9-seeding-development.md) and [10](10-seeding-production.md) |
| `npm run cleanup`, `cleanup:demo`, `cleanup:roles`, `cleanup:demo-tenant`, `cleanup:perf`, `cleanup:perf-tenant`, `cleanup:account`, `cleanup:three`, `cleanup:test-firebase` | data and identities out | → [Guides 11](11-deleting-development.md), [12](12-deleting-production.md) and [13](13-firebase-identities.md) |

**`mobile/`**: `npx expo start --dev-client`, `npm start`, `npm run android|ios|web`, `npm run typecheck`,
`npm run lint`, `npm test`, `npm run test:watch`, `npm run check:build-env`,
`node scripts/check-build-env.mjs --live` — all read-only or local.

**project root**: `node scripts/check-secrets.mjs`, `audit-access.mjs`, `check-upgrade-watches.mjs`,
`verify-label-barcode.mjs --html|--pdf --expect=…`, `scripts/device/wireless.mjs` (wireless session;
`--check` is read-only; `--stop` ends a managed session), `scripts/device/run.mjs` (device walk;
`--journey=draft|stock|transfer --allow-writes` writes).

## Part 9 — When a command refuses

Data commands explain their own refusals: [Guide 9](9-seeding-development.md),
[Guide 10](10-seeding-production.md), [Guide 11](11-deleting-development.md),
[Guide 12](12-deleting-production.md), [Guide 13](13-firebase-identities.md). The rest:

| Message | Meaning | Do |
|---|---|---|
| `NOT VERIFIED (exit 2)` | could not look (database/account) | not a data problem; check the connection |
| `connect ETIMEDOUT …:27017` | network/DNS to Atlas; nothing was written | re-run; seen intermittently on 2026-10-25, succeeding on retry |
| `is inside the repository` (`backup:db`) | `BACKUP_DIR` inside the project | choose a folder outside it |
| `is not an approved restore target` | restore aimed elsewhere | test or development database only |
| `has SHA-256 … the manifest recorded …` | the copy is damaged; **nothing was restored** | take a fresh copy |
| `NODE_ENV is not set, so the environment is ambiguous` | a measurement cannot say which database it would read | set `NODE_ENV=development` (or `test`) |
| `NODE_ENV=production. Refusing [perf:measure]` | the query measurements never target production | measure the deployment with `perf:turns` instead (Part 4) |
| `the resolved database is "…", which these measurements do not use by default` | a non-development database without being named | name it with `--database=` as well |
| `measuring against "…" needs PERF_TURNS_CONFIRM='perf-turns:production'` | `perf:turns` aimed at production without its phrase | add that phrase **and** `--database=` |

← [Guides index](README.md) · Related: [4. Test accounts](4-test-accounts-and-mock-data.md) ·
[5. Words explained](5-words-explained.md) · [9. Seeding data — development](9-seeding-development.md) ·
[10. Seeding data — production](10-seeding-production.md) ·
[11. Deleting data — development](11-deleting-development.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[13. Firebase identities](13-firebase-identities.md)
