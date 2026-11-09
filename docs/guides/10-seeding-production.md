# 10. Seeding data — production

Putting sample data into **`inventoryai_prod_db`**, the database the deployed server and the shipped app
use. Development is [Guide 9](9-seeding-development.md); deleting data is [Guide 12](12-deleting-production.md);
Firebase logins are [Guide 13](13-firebase-identities.md); the accounts are [Guide 4](4-test-accounts-and-mock-data.md).

The commands are the same as development. Three things differ: **the phrases**, **the environment** and
**what is refused**.

The complete production invocations are below; this guide also explains the rules behind them.

Run everything from `server/`.

---

## The production rule

```bash
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db   # both, enforced by config/env.ts
--database=inventoryai_prod_db                           # and named again on the command line
```

- **Three phrases.** Both of development's, plus `SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA`. They answer
  three different questions — *what* is written, *where*, and *is this real data* — so no single exported
  variable can reach production by habit. A refusal names every phrase that is missing and how many that
  target needs.
- **A preset is refused.** `seed:three` (and `seed --plan=accounts` with no list) would reset three real
  businesses in one command, so production requires every account to be **named by address**. Its tenant is
  **resolved from the database**, and the account must be that tenant's OWNER.
- **Every write is scoped by `businessId`.** Nothing outside the tenants you name is read or reset.
- **The Firebase project is pinned** to `inventoryai-d0d20`; a login created elsewhere could never be
  joined to the tenant ([Guide 13](13-firebase-identities.md)).

PowerShell keeps variables until you clear them, so set, run, then clear `NODE_ENV`, `MONGODB_DB_NAME`,
`SEED_CONFIRM`, `SEED_DB_CONFIRM` and `SEED_PROD_CONFIRM`.

---

## Phrase and safety matrix

One table for every seeding and cleanup outcome. The **own phrase** column is the value that command
requires in `SEED_CONFIRM` or `CLEANUP_CONFIRM`; the short list after the table adds the phrases every
allowed row of that family also needs.

| What you want | Production | What it touches | Its own phrase |
|---|---|---|---|
| A large tenant of its own, with a login | allowed | one tenant of its own (created if absent), with a login | `SEED_CONFIRM=seed:perf-tenant` |
| One existing account's tenant | allowed; the tenant is named with `--business` | that account's tenant data | `SEED_CONFIRM=seed-demo-account` |
| The accounts you name | allowed | the tenants of the accounts you name | `SEED_CONFIRM=seed-accounts` |
| One login per role | allowed | the role-fixture tenant and its four logins | `SEED_CONFIRM=seed-roles` |
| The fixed-figure demo tenant | allowed — **the one-phrase exception** | the fixed fourteen-product demo tenant and its login | `SEED_CONFIRM=seed-demo-tenant` |
| The three-account comparison preset | **refused** | the three presets | development only: `SEED_CONFIRM=seed-three-accounts` + `SEED_DB_CONFIRM` |
| A no-login measurement tenant | **refused** | a no-login measurement tenant | development only: `SEED_CONFIRM=seed-perf-ai` |
| Every document in one database | allowed | every collection in one database | `CLEANUP_CONFIRM=cleanup:database` |
| The Firebase identities you name | allowed | the identities you name (both databases checked) | `CLEANUP_CONFIRM=cleanup:firebase` |
| The tenants of the accounts you name | allowed; preset refused | the tenants of the accounts you name | `CLEANUP_CONFIRM=cleanup-account-data` |
| One account's tenant data | allowed | one account's tenant data | `CLEANUP_CONFIRM=cleanup:demo-account` |
| The performance tenant | allowed | the performance tenant | `CLEANUP_CONFIRM=cleanup:perf-tenant` |
| The fixed demo tenant | allowed | the fixed demo tenant | `CLEANUP_CONFIRM=cleanup:demo-tenant` |
| The role-fixture tenant | allowed | the role-fixture tenant (and four identities with `--delete-firebase`) | `CLEANUP_CONFIRM=cleanup:roles` |
| The three presets | **refused** | the three presets | development only: `CLEANUP_CONFIRM=cleanup-three-accounts` + `CLEANUP_DB_CONFIRM` |
| The no-login measurement tenant | **refused** | the no-login measurement tenant | development only: `SEED_CONFIRM=seed-perf-ai` (this cleanup reads the seed phrase) |
| Every identity in the test project | **not allowed** — test project only | every identity in the test project | interactive `cleanup:test-firebase`, or `CLEANUP_CONFIRM=cleanup:test-firebase` with `--yes` |

The first column names the outcome, not a command to copy. Every full invocation for a seeding row is in
the sections below; the cleanup rows name their own phrase, and the destructive commands themselves are
documented in [Guide 11](11-deleting-development.md), [Guide 12](12-deleting-production.md) and [Guide 13](13-firebase-identities.md).

**The other phrases every allowed row also needs.**

- An allowed production seeder: `SEED_DB_CONFIRM=inventoryai_prod_db` and `SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA` — **except `seed:demo-tenant`**, whose single phrase is the whole cost.
- An allowed production cleanup: `CLEANUP_DB_CONFIRM=inventoryai_prod_db` and `CLEANUP_PROD_CONFIRM=DELETE-PRODUCTION-DATA`.
- Every allowed row: `NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db` and `--database=inventoryai_prod_db`, which must equal the resolved name.
- `--dry-run` checks the target and prints the plan; it never skips a phrase.
- `check:accounts` (which selects production with `--with-production` and takes no `--database=`)
  and `verify:demo` take **no phrase**. `verify:roles` writes no products, inventory or lasting
  users, but takes `SEED_CONFIRM=seed-roles`: it mints four sessions and removes them, and its
  user-management probes create and delete users, which leaves audit rows in the fixture tenant.

Two cautions belong on their own lines:

- `cleanup -- --target=database` is the only command that removes **every** tenant in the database. It also deletes the `users` rows, which strands every login.
- `cleanup:test-firebase` deletes **every** identity in the test project, yours included. It never touches MongoDB.

---

## Step 0 — check, read-only, no phrase

```bash
npm run check:accounts -- --with-production
```

It reads **the production database only** and Firebase, and prints each account's tenant id and the
size that tenant currently holds. `--with-production` selects production instead of development, so a
tenant that exists only in development never fails this check. Exit **0** every account ready, **1**
missing or mismatched, **2** could not check.

| Account | Products | ≈ Documents | `businessId` |
|---|---|---|---|
| `jefferndullamalinaozxc@gmail.com` | 0 | 33 | `6aeef1185f91b09470af0832` |
| `jefferndullamalinao@gmail.com` | 0 | 4 | `6aef22959c304aea601245a6` |
| `jeffernmalinaoqwe@gmail.com` | 0 | 4 | `6aef231c9c304aea601245ab` |

That table is a **measurement of what the tenants held on 2026-11-09**, not a target: nothing reads it.
All three comparison accounts were empty on that date. `seed:accounts` uses the size you type in
`--accounts`, and re-seeding replaces whatever is there. The `seed:three` preset (30 000 / 50 000 /
90 000) is a separate, development-only convenience. For the large production test tenant, use
`seed:perf-tenant` below; it owns a separate login and does not touch these accounts.

The id is the tenant's own `_id`, not the login's. `seed:accounts` resolves the address to that row and
needs no id; `seed --plan=demo` still names it with a `--business` flag carrying that id. A supplied id
is checked against the resolved tenant and refused if it disagrees — the lookup is the source, an id is
only a claim it checks. A production address with **no tenant is refused** too: registration in the app creates it, a
seeder does not.

---

## Naming a tenant that already exists

| Command | How the tenant is named |
|---|---|
| `seed --plan=demo` | a `--business` flag carrying the tenant id |
| `seed:accounts` / `seed:three`'s place | resolved from each address; an optional `:businessId` is checked |
| `seed:perf-tenant`, `seed --plan=roles` | not needed — each owns the tenant it creates |

The address resolves to its user row and that row's own `businessId` is what is written. In production the
row must be the **OWNER of exactly one** business: the resolver refuses a missing tenant, a second
association, or a non-OWNER before any write. If you do supply an id, it must **agree** with that row.
In production the run says the password was left alone — `password unchanged` in `seed:accounts`,
`password NOT changed` in `seed --plan=demo`. An existing login's password is never rewritten.

---

## Seeding the three accounts, all three in one run

**The counts are yours on every run.** `--accounts` is the only thing that sets a size — there is no
preset or documentation value behind it. Each entry is
`address:products[:businessId][:codes=both|none|sku|barcode]`
(an optional `:businessId` is checked, not required; the id and the code choice may be given in either
order), and any whole number from **5 to 112 500 products** per account is accepted.
The unit is products, so `1000` means 1 000 products (≈4 444 documents across the collections) and the
console prints both figures before it writes. Change the three numbers to whatever you need,
independently; the command below is an example, not a required set. One account is the same command with a
one-entry list.

**Effect:** writes. Each named tenant's inventory, movements, purchase orders, products, categories,
locations and suppliers are replaced; user rows, business rows and Firebase identities are kept.

```bash
# PREVIEW — checks every phrase, prints the plan, writes nothing
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-accounts SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed:accounts -- --database=inventoryai_prod_db --dry-run \
    --accounts="jefferndullamalinaozxc@gmail.com:1000,jefferndullamalinao@gmail.com:2000,jeffernmalinaoqwe@gmail.com:3000"

# EXECUTE — the same command, with --dry-run removed
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-accounts SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed:accounts -- --database=inventoryai_prod_db \
    --accounts="jefferndullamalinaozxc@gmail.com:1000,jefferndullamalinao@gmail.com:2000,jeffernmalinaoqwe@gmail.com:3000"
```

- **A size is PRODUCTS.** `:400000d` asks in documents instead; the ceiling is **112 500 products ≈ 500 000
  documents** per account.
- **The run proves what it wrote.** After each tenant it re-counts every collection and compares the
  database with what the writer reported; a disagreement stops the run and names the collection
  (`wrote X, found Y`), and `Result : SUCCESS` is printed only after every tenant passes. The counts are
  checked against the plan from your own command, never against a documented figure.
- Each tenant is emptied and rewritten only after its address has resolved to exactly one tenant the
  account owns, so the run is the documented way to start over for that tenant.
- Expect `Database : inventoryai_prod_db (PRODUCTION)`, `Products`/`Documents`, a preflight line per
  account (`… — OWNER — N documents to reset`), an `Identity : … — verified — password unchanged` line, a
  `wrote … documents (… products)` line, and `Result : SUCCESS`. Name, members and roles are untouched.
  (The `scope : …` and `OK` lines belong to `seed --plan=accounts`, which is a different command.)
- **SKUs and barcodes are chosen per entry, independently**: `codes=both`, `codes=sku`, `codes=barcode`
  or `codes=none`. An entry that says nothing takes the run-wide default: none, or the mode named with
  `--codes=both|none|sku|barcode`. (`seed --plan=demo` has the same flag but defaults to `both` because
  that is what it has always written.) `--include-sku` was removed and is **refused** — not ignored — with the
  replacement in the message, so a saved command line cannot quietly seed neither field. A SKU is a
  readable test value (`ACCTSKU-0`); a barcode is a valid **EAN-13** in the
  internal prefix-2 range — unique within the tenant, with a computed check digit — so it renders,
  prints and scans like any other code.
- `verify:demo` ([Guide 9](9-seeding-development.md#verify--read-only-always)) is the independent
  check afterwards: it validates ledger arithmetic, references and emptiness, and prints the counts it
  read. It does not require any particular size, so it works for every size this command accepts.
- Historical measurement: on 2026-10-29 the three accounts held **5 000 / 10 000 / 15 000** products
  (**22 222 / 44 444 / 66 667 documents**, 133 333 in all), and `verify:demo` returned **SUCCESS** for
  each with 0 bad ledger rows and 0 missing references. That describes that run, not a requirement or
  the current state; the Step 0 table is the live measurement. The earlier 30 000 / 50 000 / 90 000 run
  on 2026-10-27 wrote **755 555 documents** in **23 min 6 s**.

---

## The account you sign in with (`seed --plan=demo`)

**Effect:** writes. The one tenant that address owns is replaced; the user row, business row and Firebase
identity are kept, and an existing password is never rewritten.

```bash
# PREVIEW — reads the named tenant, checks --business, writes nothing
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed -- --plan=demo --database=inventoryai_prod_db --dry-run \
    --email=jefferndullamalinaozxc@gmail.com \
    --business=6ae15d1b6f2be6b817771e97 --total=60000 --codes=both

# EXECUTE — the same command, with --dry-run removed
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed -- --plan=demo --database=inventoryai_prod_db \
    --email=jefferndullamalinaozxc@gmail.com \
    --business=6ae15d1b6f2be6b817771e97 --total=60000 --codes=both
```

The address and id above are one real pair, measured on 2026-10-29; `check:accounts --with-production`
reprints the current id. A stale id is refused, never trusted.

`--total` is **documents** (100–400 000). Naming the tenant is the fourth deliberate act when the run would
replace data that already exists. A brand-new tenant has no id to name — `--business` is required only when
the account already owns one.

`--codes=both` is this command's default; `--codes=none`, `--codes=sku` and `--codes=barcode` select neither
field, SKU only, or barcode only. The four values are the same ones `seed:accounts` accepts — only the
default differs (`seed:accounts` defaults to `none`). A barcode is a valid, unique EAN-13 in the internal
prefix-2 range, so it scans.

---

## Which command, in production

Pick the outcome. Every seeding route below is written out in full, with both blocks; no line here is a
fragment to complete by hand.

- **A large tenant of its own, with a login** — `seed:perf-tenant`, both blocks under **The measurement
  tenant** below. The recommended route: it never touches a tenant it did not create.
- **One existing account's tenant** — `seed --plan=demo`, both blocks under **The account you sign in
  with** above.
- **The accounts you name** — `seed:accounts`, both blocks under **Seeding the three accounts** above.
- **One login per role** — `seed --plan=roles`, both blocks immediately below.
- **The fixed-figure demo tenant** — `seed:demo-tenant`, both blocks under **The fixed-figure demo
  tenant** below.
- **The comparison preset** — refused: `seed:three` may not run against production. Its development
  command is in [Guide 9](9-seeding-development.md).
- **A no-login measurement tenant** — refused: `seed:perf` is development only. Its command is in
  [Guide 9](9-seeding-development.md).

### One login per role (`seed --plan=roles`)

**Effect:** writes. The role-fixture tenant and its four logins (OWNER, ADMIN, MANAGER, STAFF) are
created or refreshed, and only that tenant's data is replaced. Three phrases; `ROLE_TEST_PASSWORD` is
required for the real run and is never printed.

```bash
# PREVIEW — no password is needed, no connection is opened, nothing is written
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-roles SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed -- --plan=roles --database=inventoryai_prod_db --dry-run

# EXECUTE — the same command plus the password, and without --dry-run
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  ROLE_TEST_PASSWORD='choose-a-strong-password' \
  SEED_CONFIRM=seed-roles SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed -- --plan=roles --database=inventoryai_prod_db
```

### The measurement tenant (`seed:perf-tenant`)

**Effect:** writes. Its own tenant and OWNER login are created or replaced, in any named database — the
recommended production route because it never touches a tenant it did not create.

```bash
# PREVIEW — checks every phrase, counts what would be replaced, writes nothing
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed:perf-tenant SEED_DB_CONFIRM=inventoryai_prod_db \
  SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed:perf-tenant -- --database=inventoryai_prod_db --size=44444 --dry-run

# EXECUTE — the same command, plus the password, without --dry-run
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  DEMO_ACCOUNT_PASSWORD='choose-a-password' SEED_CONFIRM=seed:perf-tenant \
  SEED_DB_CONFIRM=inventoryai_prod_db SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA \
  npm run seed:perf-tenant -- --database=inventoryai_prod_db --size=44444
```

- It follows the **same three-phrase rule** as every command above.
- `--size` is **documents**, 50–400 000, default 4 000; products land at ≈22.5 %. `44444` therefore
  writes **10 000 products**. Deterministic (`--seed`, default 1). SKUs are `SEEDSKU-…`; names, brands,
  descriptions and specifications come from the curated bulk catalogue, which includes computer
  components and peripherals, home appliances, hardware/power tools and automotive/car care.
- It creates a verified OWNER login (`perf-seed-ai@example.invalid`) in that tenant only, and refreshes its
  password from `DEMO_ACCOUNT_PASSWORD` when that variable is supplied.
- Re-counts every collection, re-checks every movement's arithmetic and requires its anchor before saying
  `OK`.
- Its teardown is `cleanup:perf-tenant` ([Guide 12](12-deleting-production.md)); it keeps the identity.

Measured on production 2026-11-09: `--size=44444` → **10 000 products**, 20 006 inventory rows, 13 354
movements, 889 purchase orders, 13 categories and 4 locations in **68.9 s**; the command re-counted every
collection, checked all 13 354 movements and reported no problems. The tenant was
`6af18628a9a409131a84235b`, with **1,535** products low on stock and **632** out of stock.

### The fixed-figure demo tenant (`seed:demo-tenant`)

**Effect:** writes. The fixed fourteen-product demo tenant and its login are created or replaced; the identity
is never deleted. Its one phrase is the whole cost: no `SEED_DB_CONFIRM` and no `SEED_PROD_CONFIRM`,
because the command names and matches the database itself. Its figures are in
[Guide 9](9-seeding-development.md); teardown is `cleanup:demo-tenant`.

```bash
# PREVIEW — counts what would be replaced, writes nothing
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  SEED_CONFIRM=seed-demo-tenant \
  npm run seed:demo-tenant -- --database=inventoryai_prod_db --dry-run

# EXECUTE — the same command, with --dry-run removed
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  DEMO_ACCOUNT_PASSWORD='choose-a-password' SEED_CONFIRM=seed-demo-tenant \
  npm run seed:demo-tenant -- --database=inventoryai_prod_db
```

`DEMO_ACCOUNT_PASSWORD` is needed when the demo identity does not exist yet, and refreshes its password
when supplied on a re-run. The command never deletes the identity.

---

## Dry run — prove the destination first

Each **PREVIEW** block checks the target and every phrase the command requires — all three for most
seeders, the single phrase for `seed:demo-tenant` — prints the plan, and writes nothing. A credential that
only a real run needs, such as `DEMO_ACCOUNT_PASSWORD` or `ROLE_TEST_PASSWORD`, is absent from the preview
because the preview must not create or refresh an identity. `seed:accounts` also reads — never writes — to resolve every address to
its own tenant, require an OWNER, refuse an ambiguous association, check any supplied `:businessId`
against that row, and count what a run would reset. A wrong or missing mapping fails the preview rather
than the write. In production, `seed --plan=demo` reads the named tenant to check `--business` and
count what it would replace (development still opens no connection). `seed:perf-tenant` and
`seed:demo-tenant` also read the database to count what they would replace. None of them touches
Firebase.

`--dry-run` is not a verification: it reports what *would* happen. Verification reads the rows back.

---

## Verify in production

The seed prints counts, but only a read-back proves the rows. Run the same verifier used in
development; it writes nothing.

```bash
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  npm run verify:demo -- --database=inventoryai_prod_db \
    --email=jefferndullamalinaozxc@gmail.com
```

To check all three tenants in one run, name each address and the product count it should hold — the
same sizes passed to `seed:accounts`:

```bash
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  npm run verify:demo -- --database=inventoryai_prod_db \
  --accounts="jefferndullamalinaozxc@gmail.com:1000,jefferndullamalinao@gmail.com:2000,jeffernmalinaoqwe@gmail.com:3000"
```

Expect `SUCCESS — 3 account(s) verified` and exit **0**. An entry may also carry
`:codes=both|none|sku|barcode`. A size or code-mode mismatch, an empty tenant, or a ledger/reference
violation exits **1**; an account or database that cannot be read exits **2**. The output, code-mode
semantics and barcode checks are the same as [Guide 9's verifier](9-seeding-development.md#verify--read-only-always),
so they are not repeated here.

The role fixture has its own check. It writes no products, inventory or lasting users, but it is not
phrase-free: it mints four sessions and removes them, so it requires `SEED_CONFIRM=seed-roles`; its
user-management probes create and delete users, leaving audit rows in the fixture tenant. In production
it must use `--signin`, because a session minted on this laptop is signed with a different `JWT_SECRET`.

```bash
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  ROLE_TEST_PASSWORD='choose-a-strong-password' \
  FIREBASE_WEB_API_KEY='the public Firebase web key' \
  SEED_CONFIRM=seed-roles \
  npm run verify:roles -- --database=inventoryai_prod_db \
    --business=<roleFixtureBusinessId> \
    --base=https://ai-inventory-l1mi.onrender.com --signin
```

`--business` is the role fixture's own tenant id, printed when `seed --plan=roles` runs; it is not one
of the three account tenants. Exit **0** every cell matched, **1** a cell disagreed or the fixture is not
in the shape it must have.

## Room on the cluster

The cluster is a shared **512 MB Atlas M0**: development and production compete for the same space. Seed
one environment at full size and keep the other small, or empty one first. An M0 that fills **blocks
writes** rather than degrading. Measurements and the index-reclaim procedure are in
[Guide 12](12-deleting-production.md).

## What resets and what is kept

| Command | Existing data | Account rows | Firebase identities |
|---|---|---|---|
| The account you sign in with (`seed --plan=demo`) | **replaced** for that tenant | kept; created if absent | never deleted; password never rewritten |
| `seed:accounts` (resolved tenants) | **replaced** for each account's own tenant | kept | never deleted |
| `seed:perf-tenant` | **replaced** for its own tenant | kept | created if absent; its own password refreshed when `DEMO_ACCOUNT_PASSWORD` is supplied |
| `seed --plan=roles` | **replaced** for the role fixture tenant | four role logins reused | reused |
| `seed:demo-tenant` | **replaced** for the demo tenant | kept | password set or refreshed when `DEMO_ACCOUNT_PASSWORD` is supplied |
| `verify:demo` / `verify:roles` / `check:accounts` | untouched | untouched | untouched |

---

## When it refuses

| Message | Meaning | Do |
|---|---|---|
| `the seed:three preset … is refused in production` | a preset against real businesses | name every account in `--accounts`, as `address:products` |
| `no business exists for … and a production run will not create one` | the address has no tenant in this database | register it in the app first; registration creates the business |
| `… requires the OWNER` | the account is a member, not the tenant's owner | seed the owner's address — the whole tenant is replaced |
| `… is linked to 2 businesses …` | more than one row associates the address with a tenant | fix the association deliberately; nothing was written |
| `names business …, but this account owns …` | a supplied id is not that account's tenant | omit the id (the run resolves it), or use the row's own |
| `three confirmation phrase(s) … SEED_PROD_CONFIRM=SEED-PRODUCTION-DATA` | a phrase is missing or wrong | the message lists every one it needs |
| `--database is "…" but this process resolved "…"` | the flag and `MONGODB_DB_NAME` disagree | set `MONGODB_DB_NAME` to the database you mean |
| `MONGODB_URI names the database "…"` | the connection string is configured for the other environment | fix the URI; nothing was written |
| `NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db` (the env pair in the message) | production was selected without both | export both, then re-run |
| `not a seeding target` | an unknown database name | only `inventoryai_dev_db` / `inventoryai_prod_db` |
| `asks for 1,000,000 products. The ceiling is 112,500` | over the per-account ceiling | split the plan across accounts |
| `this shell is configured for Firebase project "…"` | the credentials name a project other than the approved one | fix `FIREBASE_PROJECT_ID`; nothing was read or written |
| `no Firebase identity exists … a production seed will not create one` | the address has no login in this Firebase project | register it in the app first; production never creates one |
| `the database account for … is linked to Firebase uid …` | the identity was deleted and re-created, so the row holds a stale uid | seed a different address, or repair the link through an approved flow |
| `Writes are blocked on your cluster` (from MongoDB) | the M0 filled up | empty a tenant or rebuild the empty collections' indexes ([Guide 12](12-deleting-production.md)) |

---

← [Guides index](README.md) · Related: [4. Test accounts](4-test-accounts-and-mock-data.md) ·
[9. Seeding data — development](9-seeding-development.md) ·
[11. Deleting data — development](11-deleting-development.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[13. Firebase identities](13-firebase-identities.md) · [6. Everything else](6-scripts-and-commands.md)
