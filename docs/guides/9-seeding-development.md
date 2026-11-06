# 9. Seeding data — development

Putting sample data into **`inventoryai_dev_db`**, the database this laptop's backend and the phone use.
Production is [Guide 10](10-seeding-production.md); deleting data is [Guide 11](11-deleting-development.md)
and [Guide 12](12-deleting-production.md); Firebase logins are [Guide 13](13-firebase-identities.md); the
accounts themselves are [Guide 4](4-test-accounts-and-mock-data.md).

Run everything from `server/`.

---

## The development rule

- **Name the database twice, and let it agree.** `--database=inventoryai_dev_db` must equal what
  `MONGODB_DB_NAME` resolved. If they disagree, the run refuses *before connecting* — so a typo in one
  cannot quietly seed the other. Only `inventoryai_dev_db` and `inventoryai_prod_db` are seedable;
  `inventoryai_test_db` is refused because `npm test` clears it.
- **Two phrases:** `SEED_CONFIRM` (what is written) and `SEED_DB_CONFIRM=inventoryai_dev_db` (where).
  Production adds a third — see [Guide 10](10-seeding-production.md).
- **`--dry-run` is available everywhere.** It checks the target and the phrases, prints the plan, and
  writes nothing.
- **Seeders never delete a login, a business row or a Firebase identity.** Re-running one replaces that
  tenant's *data*; it is the documented way to start over.

---

## Which command?

| You want | Command |
|---|---|
| To know which accounts exist before writing | `npm run check:accounts` |
| Data in the three comparison accounts | `npm run seed:three -- --database=inventoryai_dev_db` |
| Data in accounts you name, at any size | `npm run seed:accounts -- --database=inventoryai_dev_db --accounts="a@x.com:1000,b@y.com:2000"` |
| Data in the account you sign in with | `npm run seed -- --plan=demo --database=inventoryai_dev_db --email=YOU@example.com` |
| One working login per role | `npm run seed -- --plan=roles --database=inventoryai_dev_db` |
| A small tenant with fixed figures | `npm run seed:demo-tenant -- --database=inventoryai_dev_db` |
| A large tenant you can sign into | `npm run seed:perf-tenant -- --database=inventoryai_dev_db --size=60000` |
| A disposable tenant with no login | `npm run seed:perf -- --size=1000` |

`seed --plan=…` is the one command; `seed:demo`, `seed:three` and `seed:accounts` are that script with the
plan or the preset already chosen. `seed:perf-tenant`, `seed:demo-tenant` and `seed:perf` are separate
commands with their own terms.

### The phrase each command uses

| Command | `SEED_CONFIRM` |
|---|---|
| `seed -- --plan=demo` | `seed-demo-account` |
| `seed:three` | `seed-three-accounts` |
| `seed:accounts`, `seed -- --plan=accounts` | `seed-accounts` |
| `seed -- --plan=roles`, `seed:roles` | `seed-roles` |
| `seed:perf-tenant` | `seed:perf-tenant` |
| `seed:demo-tenant` | `seed-demo-tenant` (one phrase, its own guard) |
| `seed:perf` | `seed-perf-ai` (its own guard) |

A phrase that belongs to a different command is refused, so `SEED_CONFIRM=seed-roles` cannot seed the demo
plan.

---

## Before you write: check the accounts

```bash
npm run check:accounts                       # the development database
npm run check:accounts -- --with-production   # production INSTEAD (one database per run)
npm run check:accounts -- --accounts="a@x.com,b@y.com"
```

Read-only, and it needs no phrase because it changes nothing. For every address it prints the Firebase
identity (uid, verified, enabled, how it signs in), the user row **in the selected database** (role,
business, the stored uid) and how many documents a seed would reset there. Exit codes: **0** every
account ready, **1** something missing or mismatched (a state, not an error), **2** could not check.

`--with-production` **replaces** the development database rather than adding to it: the verdict and the
exit code describe only the environment you are about to write to, so a tenant missing in development
cannot fail a production check. Run it once per environment.

`MISSING` means there is no row yet: a seed would **create** that tenant. `STALE LINK`, `NOT LINKED` and
`NO BUSINESS` are states a seed refuses on. `SHARED TENANT` means two addresses in the plan resolve to one
business: the seed refuses that plan (its datasets would not be separate), so the check reports both as
not ready rather than promising a run that would stop.

---

## The three comparison accounts (`seed:three`)

```bash
# preview — the plan only, nothing connected
SEED_CONFIRM=seed-three-accounts SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:three -- --database=inventoryai_dev_db --dry-run

# write
SEED_CONFIRM=seed-three-accounts SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:three -- --database=inventoryai_dev_db
```

Add `--codes=both` (or `--codes=sku` / `--codes=barcode`) to either command to give every seeded product
those codes. The preset has no per-account field, so `--codes=` is its only lever; the per-entry detail
is in the next section.

| Account | Products | ≈ Documents |
|---|---|---|
| `jefferndullamalinaozxc@gmail.com` | 30 000 | 133 333 |
| `jefferndullamalinao@gmail.com` | 50 000 | 222 222 |
| `jeffernmalinaoqwe@gmail.com` | 90 000 | 400 000 |

That is the **preset** `seed:three` writes in development. Production refuses the preset, so there the
sizes are chosen per run; the tenants held 5 000 / 10 000 / 15 000 on 2026-10-29
([Guide 10](10-seeding-production.md)). The addresses and preset sizes live together in
`server/scripts/seed/lib.mjs`, and `check:accounts` and `cleanup:three` read the same list — so all
three commands describe the same three addresses.

**Registering an account creates ONE row, in the database that app is talking to.** The Firebase identity
is shared by both databases, so each account needs at most one registration and the other side is a seed:
`check:accounts` reports `MISSING` there and this command creates it. That is why a fresh development
database reads `MISSING` for accounts that already exist in production — nothing is wrong, and nothing
needs registering twice.

---

## Accounts you name (`seed:accounts`)

```bash
SEED_CONFIRM=seed-accounts SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:accounts -- --database=inventoryai_dev_db \
    --accounts="a@x.com:100000,b@y.com:40000" --dry-run
```

One account is the same command with a one-entry list. A mixed run sets a different count and code
mode per entry; preview first, then drop `--dry-run` to write:

```bash
SEED_CONFIRM=seed-accounts SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:accounts -- --database=inventoryai_dev_db \
    --accounts="a@x.com:1000:codes=both,b@y.com:2000:codes=none,c@z.com:3000:codes=sku" --dry-run
```

- **A size is PRODUCTS**, and every entry needs one:
  `--accounts="address:products[:businessId][:codes=both|none|sku|barcode]"`. The dry run prints the products
  *and* an estimate of the documents each entry will write. `:400000d` asks in **documents** instead. The
  `:businessId` field is only needed in production ([Guide 10](10-seeding-production.md)), and the
  id and the code choice are accepted in either order. If you do give one, it is a claim, checked in
  **both** environments: it must be the tenant that address already owns, and an id that names no
  tenant is refused rather than replaced by a generated one. A preview opens no connection, so it
  cannot check an id — the run does, before its first write. `--seed=N` changes the generated data and
  defaults to `1`, so two runs at the same size describe the same tenant.
- **The document figure is an estimate, and the command now says so.** Ordinary runs match it exactly
  (1 000 products → 4 444 documents, measured 2026-10-29), but the generator also writes fixed
  per-collection minimums (4 categories, 2 locations, 5 suppliers, 5 purchase orders). At the smallest
  size, 5 products plan 22 documents and write 34. The summary line was always labelled *estimated*;
  the per-entry and write lines now say it too.
- **An address that already has a verified identity needs no `DEMO_ACCOUNT_PASSWORD`.** That variable
  exists only to create an identity that does not exist yet. An account registered in the app is reused as
  it is — the run reads its `uid` from Firebase and writes nothing back, so a Google-only login seeds
  exactly like a password one and no credential is changed.
- **Each account chooses its own SKUs and barcodes, and the two fields are independent.** `codes=both`
  writes both, `codes=sku` writes only the SKU, `codes=barcode` only the barcode, and `codes=none` omits
  both (which leaves the app's own barcode generation to assign the first code — deliberate, and worth one
  product per run). Without a `codes=` field an entry takes the run-wide default — **none**, unless
  `--codes=both`, `--codes=sku` or `--codes=barcode` is passed; `--codes=` is also the only way to give
  the `seed:three` preset codes, because it takes no entry list. One run can mix them:
  `--accounts="a@x.com:1000:codes=both,b@y.com:2000:codes=none,c@z.com:3000:codes=sku"`.
  The old `--include-sku` is gone: it is refused with the replacement named, rather than ignored, because
  a run that asked for both fields would otherwise seed neither.
- **A generated barcode is a real EAN-13**, unique within the account: 13 digits in the internal
  prefix-2 range with a computed check digit, so it renders, prints and scans. Thirteen digits is what
  the label renderer requires; the check digit is what a scanner verifies. The SKU stays a readable
  test value (`ACCTSKU-0`).
- Each account gets its own business; the command refuses if two accounts resolve to the same one.
- A missing login stops the run (unless you supply `DEMO_ACCOUNT_PASSWORD`); an existing password is never
  changed.
- The ceiling is **112 500 products ≈ 500 000 documents** per account. A million products is refused with
  its reason: ≈4 400 000 documents, built in memory before a single row is inserted. A plan of 90 000
  products or more prints a `LARGE RUN` line with an estimated duration before it starts.

---

## The account you sign in with (`seed --plan=demo`)

```bash
SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed -- --plan=demo --database=inventoryai_dev_db \
  --email=you@example.com --total=80000
```

`--total=80000` is the default (range **100–400 000**, in **documents**); `--seed=1` makes the data identical
every run. `--email=` must be the address you sign in with — the tenant is found through the Firebase UID.
Expect `OK` and `TOTAL 80000 (target 80000)`.

`--codes=both` is the default for this command, so products carry a readable SKU and a valid EAN-13.
Use `--codes=none` for neither field, `--codes=sku` for SKU only, or `--codes=barcode` for barcode only.
The flag means the same four things as the per-account `codes=` field; only the default differs
(`seed:accounts` defaults to `none`). The line above can take `--codes=barcode` beside `--total=80000`.

For a brand-new address the login is created; supply its password through a setting, never on the command
line:

```bash
DEMO_ACCOUNT_PASSWORD='choose-a-strong-password' \
  SEED_CONFIRM=seed-demo-account SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed -- --plan=demo --database=inventoryai_dev_db \
  --email=tester-1@example.com --total=500
```

---

## One login per role (`seed --plan=roles`)

```bash
ROLE_TEST_PASSWORD='choose-a-password' SEED_CONFIRM=seed-roles SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed -- --plan=roles --database=inventoryai_dev_db --dry-run
ROLE_TEST_PASSWORD='choose-a-password' SEED_CONFIRM=seed-roles SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed -- --plan=roles --database=inventoryai_dev_db

npm run verify:roles -- --business=<id the seeder printed>
```

| Role | Address |
|---|---|
| OWNER | `role-owner@example.invalid` |
| ADMIN | `role-admin@example.invalid` |
| MANAGER | `role-manager@example.invalid` |
| STAFF | `role-staff@example.invalid` |

One tenant, `ROLE TEST — role boundary fixture (do not use)`, ~900 documents (≈200 products). The
`.invalid` addresses cannot receive mail, so the four logins are marked verified through Firebase's admin
interface — the same write the app makes after a real code. `verify:roles` checks **96 cells** (route ×
role) and exits 0 only when all match; add `--signin` with `FIREBASE_WEB_API_KEY` and `ROLE_TEST_PASSWORD`
to prove the real sign-in path.

ADMIN's visible restriction is in **Users**: no creating another ADMIN, no changing its own role, no
editing an ADMIN or the OWNER.

---

## The fixed-figure demo tenant (`seed:demo-tenant`)

Its own tool with **one phrase** — it does not follow the two/three-phrase rule.

```bash
DEMO_ACCOUNT_PASSWORD='choose-a-strong-password' SEED_CONFIRM=seed-demo-tenant \
  npm run seed:demo-tenant -- --database=inventoryai_dev_db --dry-run   # preview first
DEMO_ACCOUNT_PASSWORD='choose-a-strong-password' SEED_CONFIRM=seed-demo-tenant \
  npm run seed:demo-tenant -- --database=inventoryai_dev_db
```

- The database must be **named** and must equal the resolved one; the test database is refused. If
  `MONGODB_URI` names a database, it must name the same one — a URI ending in
  `inventoryai_prod_db` beside a resolved `inventoryai_dev_db` is refused before connecting.
- **One phrase**, `SEED_CONFIRM=seed-demo-tenant` — there is no `SEED_DB_CONFIRM` for this tool.
- It may also run against production, because the database is named and matched.
- Supplying `DEMO_ACCOUNT_PASSWORD` sets the password on every run; without it, an existing identity
  keeps its current password.

Sign in as `demo-preview@example.invalid` (owner `Demo Tester`). Every figure is fixed:

| | |
|---|---|
| Products | **14** active, 13 with stock (ASUS ROG Strix Flare II Animate has no inventory row) |
| On hand | **136 units** |
| Locations | **Demo Warehouse 99** (12 products) · **Demo Shop 30** (8) · **Demo Van 7** (2) |
| Health | 9 in stock · 5 at/below minimum (**1 out of stock**) |
| Restock | ASUS ROG Strix Flare II Animate (0 vs min 3) · Keychron K8 Pro (6 vs 6) · Logitech MX Master 3S (4 vs 5) · Dell UltraSharp U2723QE (2 vs 2) · Elgato Stream Deck MK.2 (2 vs 3) |
| Ledger | 30 movements, each ending at the figures above |

The seeder prints these figures itself; compare them with the screen. Teardown is `cleanup:demo-tenant`
([Guide 11](11-deleting-development.md)), which keeps the Firebase identity.

---

## The measurement tenants

### `seed:perf-tenant` — a large tenant with a working login

```bash
DEMO_ACCOUNT_PASSWORD='choose-a-password' SEED_CONFIRM=seed:perf-tenant \
  SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:perf-tenant -- --database=inventoryai_dev_db --size=60000 --dry-run

DEMO_ACCOUNT_PASSWORD='choose-a-password' SEED_CONFIRM=seed:perf-tenant \
  SEED_DB_CONFIRM=inventoryai_dev_db \
  npm run seed:perf-tenant -- --database=inventoryai_dev_db --size=60000
```

- It follows the **same two/three-phrase rule** as everything above; the production form is in
  [Guide 10](10-seeding-production.md).
- `--size` is **documents**, 50–400 000, default 4 000; products land at ≈22 %. Deterministic (`--seed`,
  default 1). SKUs are `SEEDSKU-…`; names, brands, descriptions and specifications come from the curated
  catalogue.
- It creates a verified OWNER login (`perf-seed-ai@example.invalid`) in that tenant only, and refreshes its
  password from `DEMO_ACCOUNT_PASSWORD` when that variable is supplied.
- Re-counts every collection, re-checks every movement's arithmetic and requires its anchor before saying
  `OK`.
- Its teardown is `cleanup:perf-tenant` ([Guide 11](11-deleting-development.md)); it keeps the identity.

Measured on production 2026-10-25: `--size=60000` → 13 500 products, 27 200 inventory rows, 17 836 movements,
1 200 purchase orders in **110 s**.

### `seed:perf` — no login, development only

```bash
SEED_CONFIRM=seed-perf-ai npm run seed:perf -- --size=1000 --dry-run   # products, 1–200000
SEED_CONFIRM=seed-perf-ai npm run seed:perf -- --size=1000
SEED_CONFIRM=seed-perf-ai npm run cleanup:perf -- --dry-run            # count it first
SEED_CONFIRM=seed-perf-ai npm run cleanup:perf
```

Named `PERF SEED — AI assistant stress test (do not use)`, **no Firebase identity**, so it cannot be signed
into. Products cycle the curated catalogue, so the stress tenant carries real brands, descriptions and
specifications. It prints the `businessId` the query measurements need. Development only: its guard refuses production
outright. `cleanup:perf` proves `0 remaining` and says `nothing to clean` when there was nothing.

---

## Dry run — plan without writing

Add `--dry-run` to any plan. The target and every required phrase are checked, the plan is printed, and
nothing is written; a real run creates or refreshes identities. `seed --plan=…`, `seed:three`,
`seed:accounts` and `seed:perf` preview without connecting. `seed:perf-tenant` and `seed:demo-tenant`
read the database to count what they would replace, but never touch Firebase. `--dry-run` is not
verification: verification reads the rows back.

## Verify — read-only, always

```bash
npm run verify:demo -- --email=you@example.com --database=inventoryai_dev_db
```

To verify several accounts in one read-only run, name each address and (optionally) the product count it
should hold:

```bash
npm run verify:demo -- --database=inventoryai_dev_db \
  --accounts="jefferndullamalinaozxc@gmail.com:1000,jefferndullamalinao@gmail.com:1000,jeffernmalinaoqwe@gmail.com:1000"
```

An entry is `address[:products][:codes=both|none|sku|barcode]`; `--expect-products=<n>` supplies the
default for entries that omit a count, and `--expect-codes=<mode>` supplies the default mode for entries
that omit `:codes=`. `--email` and `--accounts` are alternatives — naming both is a usage error (exit
**2**). The run prints one block per account and exits **0** only when every account verified; **1** when
any account has a violation, is empty, holds a different product count from the one named, or does not
carry the expected code mode; **2** when nothing failed but an account could not be read.

To prove the SKU/barcode mode as well as the size, name it in the entry or with `--expect-codes=`:

```bash
npm run verify:demo -- --database=inventoryai_dev_db \
  --accounts="jefferndullamalinaozxc@gmail.com:1000:codes=both"

npm run verify:demo -- --database=inventoryai_dev_db \
  --accounts="jefferndullamalinaozxc@gmail.com:1000" --expect-codes=both
```

The block prints the mode and the barcode values it read from the products:

```text
Codes    : 1,000 both, 0 SKU only, 0 barcode only, 0 neither — both (expected both)
Barcodes : 1,000 present — 1,000 valid EAN-13, 0 invalid check digits, 0 duplicate values, 0 non-EAN-13
```

The four `Codes` counts are disjoint: `both`, SKU only, barcode only, and neither. A mode can be `both`,
`sku`, `barcode`, `none`, `MIXED` or `empty`; `MIXED` is a tenant containing more than one combination.
Only the four seed modes can be named as an expectation — `MIXED` and `empty` are observed results, not
valid `--expect-codes` values. Without `--expect-codes` or `:codes=`, the line still prints but no mode can
fail the run. `Codes` counts a non-empty `sku` or `barcode` string, so it proves presence, not validity.

`Barcodes` checks the values behind those counts. A 13-digit value whose mod-10 check digit is correct or
wrong is counted as `valid EAN-13` or `invalid check digit`; a value carried by more than one product is a
`duplicate value`; every other string is `non-EAN-13`. A wrong check digit or a duplicate value **fails**
the run (exit 1). A non-EAN-13 value is reported but does not fail on its own, because a manufacturer code
need not be EAN-13. Immediately after a `none` seed the line reads `0 present`; the app's own barcode
generation can add values later.

It reads the database and checks counts, ledger arithmetic (`newQuantity = previous ± quantity`),
referential integrity (inventory → product/location, receipts → real movements), the code coverage and
the barcode values above. It writes nothing, so it needs no phrase. Exit codes are a contract:

- **0** verified — the data is what the seeder claimed
- **1** a violation was found, a code-mode or product-count expectation did not match, **or the tenant is empty** — an empty tenant cannot verify a seed
- **2** not verified — the database, account or business could not be read (not a data problem)

Run it after every seed. It is the only thing that proves the rows, rather than the seeder's own count of
its inserts. For the three-account workflow, one `--accounts` run is the whole verification. `verify:roles`
is the equivalent for the role fixture.

---

## What resets and what does not

| Command | Existing data | Account rows | Firebase identities |
|---|---|---|---|
| `seed --plan=demo` | **replaced** for that one tenant | created if absent, else kept | never deleted; created only if absent |
| `seed:three` / `seed:accounts` | **replaced** for each named tenant | same | same |
| `seed --plan=roles` | **replaced** for the role fixture tenant | four role logins reused | same |
| `seed:perf-tenant` | **replaced** for its own tenant | created if absent | created if absent; password refreshed when `DEMO_ACCOUNT_PASSWORD` is supplied |
| `seed:demo-tenant` | **replaced** for the demo tenant | created if absent | created if absent; password set when `DEMO_ACCOUNT_PASSWORD` is supplied |
| `seed:perf` | **replaced** for its own tenant | recreated, no login | never touched |
| `verify:demo` / `verify:roles` | untouched | untouched | untouched |

Every write is scoped by `businessId`, so no tenant's data is ever removed by another tenant's seed.

---

## Sizes, units and ceilings

**Two units, and each command says which it uses.** `--accounts` (and `seed:three`) count **products** — the
number the app's own product list shows. `seed --plan=demo --total` and `seed:perf-tenant --size` count
**documents** (all seven collections), and products land at roughly 22.5 % of that (`--total=80000` ≈ 18 000
products). Every command prints both figures, so nothing has to be converted by hand.

| Want | Command | Ceiling |
|---|---|---|
| Your own account, big | `--plan=demo --email=you@example.com --total=80000` (documents) | 400 000 |
| The `seed:three` preset | `seed:three` (30 000 / 50 000 / 90 000 products, development only) | — |
| Your own list, by product count | `seed:accounts --accounts="a@x.com:100000,b@x.com:40000"` | 112 500 each |
| A size given in documents | `seed:accounts --accounts="a@x.com:444444d"` | 500 000 each |
| The measurement tenant | `seed:perf-tenant --size=60000` (documents) | 400 000 |

The dataset is deterministic (`--seed=1` by default), so two measurements describe the same tenant. Seed in
the morning rather than mid-measurement: a run replaces the tenant's data, and the assistant would be
measured against a half-written catalogue.

**Every bulk seeder now writes real products.** `seed`, `seed:accounts`, `seed:three`, `seed:perf-tenant` and
`seed:perf` cycle the curated catalogue in `server/scripts/seed/catalog.mjs` — 14 sourced products across four
categories, each with a real name, brand, description and recorded specifications. Large runs repeat the
catalogue rather than inventing rows, so a 90 000-product tenant still gives the assistant facts it can
search and compare.

**The cluster is shared.** Development and production live on the same 512 MB Atlas M0, so a full development
copy of the three comparison accounts (~338 MB) on top of a full production one exceeds the ceiling, and an
M0 that runs out of storage **blocks writes**. Seed one environment at full size at a time, or keep
development smaller — [Guide 12 § The space a delete does not give back](12-deleting-production.md) has the
measurements.

---

## When it refuses

| Message | Meaning | Do |
|---|---|---|
| `--plan=<demo\|accounts\|roles> is required` | no plan chosen | add `--plan=…` |
| `--accounts="address:products[:businessId][:codes=…],…" is required` | a bare `seed:accounts` named nothing | add the list, or use `seed:three` for the preset |
| `--include-sku is gone` | an old command line still passes the removed flag | use `--codes=both`, or `--codes=sku` / `--codes=barcode` for one field |
| `names business …, but this account owns …` | the `:businessId` given is not the tenant that address owns | remove the id, or name the tenant `check:accounts` prints; nothing was written |
| `names business …, but no tenant is linked to …` | an id was given for an address that has no tenant yet | drop the id — a run that must create a tenant prints the id it created |
| `--codes=… is not a choice` | the run-wide default is not a mode | use `both`, `none`, `sku` or `barcode` |
| `asks for 1,000,000 products. The ceiling is 112,500` | over the ceiling | ask for 112 500 or fewer, or split the plan across accounts |
| `two/three confirmation phrase(s) … SEED_CONFIRM=seed-three-accounts` | the preset is its own mode, so it wants its own phrase | export the phrase the refusal names — the mode decides which |
| `--database=<name> is required` | the target was not named | add `--database=` with the resolved name |
| `--database is "…" but this process resolved "…"` | the flag and `MONGODB_DB_NAME` disagree | set `MONGODB_DB_NAME` to the database you mean |
| `MONGODB_URI names the database "…"` | the connection string is configured for the other database | fix the URI or the environment; nothing was written |
| `two/three confirmation phrase(s) … missing or wrong` | a phrase is absent or mistyped | the message lists every one it needs |
| `set SEED_CONFIRM=<phrase> to proceed` | a tool with its own guard wants its own phrase | use `seed-perf-ai` or `seed-demo-tenant` as appropriate |
| `--total must be a whole number …` | a size or seed is not a whole number | digits only; `900abc` and `1.5` are refused rather than read as 900 and 1 |
| `the read-back does not match what was written` | an insert was partly rejected | nothing is reported as done; re-run and read the collections named |
| `test database … npm test clears` | the test database was selected | use `inventoryai_dev_db` |
| `not a seeding target` | an unknown database name | only `inventoryai_dev_db` / `inventoryai_prod_db` |
| `this shell is configured for Firebase project "…"` | the credentials name a project other than the approved one | fix `FIREBASE_PROJECT_ID` (or the service account); nothing was read or written |
| `--email=<address> is required, and nothing was read` (`verify:demo`) | the verifier was run without an address | add `--email=`; it refuses before connecting, so nothing was read |
| `no Firebase identity exists … DEMO_ACCOUNT_PASSWORD is not set` | the address has no login | register it first (recommended) or set the password |
| `the database account for … is linked to Firebase uid …` | the Firebase identity was deleted and re-created under the same address, so the row still holds the old uid | see below — the seeder will not re-link it for you |

### If an account is stranded

That last message is a **data state**, not a command mistake: the database row carries a `firebaseUid` that
no longer exists in Firebase. Measured on 2026-10-26, all three development accounts were in it. Such a row
can neither sign in (the exchange resolves by `firebaseUid` only) nor register again (`409 EMAIL_IN_USE`),
and re-pointing an identity link is an identity operation — deliberately not something a data seeder
performs as a side effect.

The ways out are deliberate ones: seed a **different** address, or repair the link through an approved flow.
Do not "fix" it by deleting the Firebase identity; that keeps the address unusable
([Guide 13](13-firebase-identities.md)).

---

← [Guides index](README.md) · Related: [4. Test accounts](4-test-accounts-and-mock-data.md) ·
[10. Seeding data — production](10-seeding-production.md) ·
[11. Deleting data — development](11-deleting-development.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[13. Firebase identities](13-firebase-identities.md) · [6. Everything else](6-scripts-and-commands.md)
