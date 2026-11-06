# 4. Test accounts and mock data

Which accounts exist, which data each one owns, and what the sample data contains. This guide is a
reference — the commands live in their own guides:

| For | Read |
|---|---|
| Putting data in — development | [9. Seeding data — development](9-seeding-development.md) |
| Putting data in — production | [10. Seeding data — production](10-seeding-production.md) |
| Removing data — development | [11. Deleting data — development](11-deleting-development.md) |
| Removing data — production | [12. Deleting data — production](12-deleting-production.md) |
| Firebase logins | [13. Firebase identities](13-firebase-identities.md) |
| Everything else | [6. Scripts and commands](6-scripts-and-commands.md) |

---

## Part 1 — How accounts and data fit together

| System | Holds | Answers |
|---|---|---|
| **Firebase** | the email and password | *who is this person?* (the doorkeeper) |
| **MongoDB** | business, users, products, stock, history | *what may they do, and what is their data?* |

They are joined by Firebase's **UID**, stored on the MongoDB user at registration — **never by email**.

Three consequences:

1. **Deleting a login while its database record exists locks that person out permanently.** The app
   refuses to register the address again, and nothing can repair it. **This is the one irreversible
   mistake here** — [Guide 13](13-firebase-identities.md) explains the checks that prevent it.
   Clearing MongoDB is safe; clearing Firebase is not.
2. **Sample data belongs to a business, not an email.** Every row carries its business, and every query
   filters by it, so tenants never see each other.
3. **A new verified address creates a new empty business**, with that person as OWNER.

---

## Part 2 — Where data can live

| Where | Used by | Safe to delete? |
|---|---|---|
| **`inventoryai_dev_db`** | this laptop's backend, the phone, the seeders — your own account and data | whole-database wipe is ⚠️; per-tenant tools are safe |
| **`inventoryai_test_db`** | `npm test`; rebuilt every run | ✅ throwaway |
| **A seeded tenant in the dev database** | `seed:roles`, `seed:perf`, `seed:demo-tenant` | ✅ its own cleanup removes exactly it |
| **`inventoryai_prod_db`** | the deployed server and shipped app | ⚠️ only by **naming** the database (`--database=`) |

Development and production use the same commands. Production costs a third confirmation phrase, and
every command must name its database. The rule in full: [Guide 9](9-seeding-development.md) and
[Guide 10](10-seeding-production.md) (writing), [Guide 11](11-deleting-development.md) and
[Guide 12](12-deleting-production.md) (deleting).

---

## Part 3 — The accounts that exist

| Account | Created by | Holds |
|---|---|---|
| **Your own address** | `seed --plan=demo` | one tenant sized by `--total` (default 80 000 documents) |
| **A throwaway tester** (`tester-1@example.com`, …) | `seed --plan=demo` with a new address | its own separate tenant; a fresh address per tester |
| **Three comparison accounts** | `npm run seed:three` (development) / `seed:accounts` (production) | development: the preset's 30 000 / 50 000 / 90 000 products (≈133 000 / 222 000 / 400 000 documents); production: the sizes you name per run — the current run holds 1 000 products (≈4 444 documents) for each, 13 332 documents in total |
| **`demo-preview@example.invalid`** | `seed:demo-tenant` | the small fixed-figure demo tenant (14 curated products, 136 units) |
| **`role-owner@…` / `role-admin@…` / `role-manager@…` / `role-staff@…`** | `seed:roles` | one tenant, one working login per role, ~900 documents |
| **`perf-seed-ai@example.invalid`** | `seed:perf-tenant` | a large measurement tenant you can sign into |
| *no login* | `seed:perf` | a measurement tenant that cannot be signed into |

The fixtures the project creates use the reserved `example.invalid` domain, which can never receive
mail. Their logins are marked verified through Firebase's admin interface — the same write the app
makes after a real code — so no rule is weakened and no mailbox is needed. The `@example.com`
addresses in examples stand for an address you control, not a project fixture; seeding one creates
its login without sending any mail. Passwords come from `DEMO_ACCOUNT_PASSWORD` /
`ROLE_TEST_PASSWORD`, never from the command line.

The role fixture's value is the boundary, not the data: `verify:roles` checks **96 cells** (route ×
role). ADMIN's visible restriction is in **Users** — no creating another ADMIN, no changing its own
role, no editing an ADMIN or the OWNER.

### The three comparison accounts (preset sizes)

| Account | Preset products | ≈ Documents |
|---|---|---|
| `jefferndullamalinaozxc@gmail.com` | 30 000 | 133 333 |
| `jefferndullamalinao@gmail.com` | 50 000 | 222 222 |
| `jeffernmalinaoqwe@gmail.com` | 90 000 | 400 000 |

That table is the preset `seed:three` writes **in development**. Production refuses the preset, so
there the sizes are chosen per run and nothing checks them against this table — the current run holds
1 000 products / 4 444 documents for each, 13 332 documents in total. They exist to answer one question:
does the assistant stay correct and fast as a catalogue grows? The walkthrough is in
[Guide 6](6-scripts-and-commands.md#comparing-the-assistant-across-tenants).
The preset's addresses and sizes are defined once in `server/scripts/seed/lib.mjs`. Only `seed:three`
uses the sizes; `check:accounts` (do they exist?) and `cleanup:three` (empty them, keeping the logins)
use the addresses. They are in [Guide 9](9-seeding-development.md)/[Guide 10](10-seeding-production.md)
and [Guide 11](11-deleting-development.md)/[Guide 12](12-deleting-production.md).

---

## Part 4 — What the sample data looks like

Default `seed --plan=demo` (`--total=80000`, `--seed=1`):

| Collection | Documents |
|---|---|
| products | 18,000 (**2,777** at/below minimum, **1,109** at zero) |
| inventory rows | 36,104 |
| inventory movements | 23,966 |
| purchase orders | 1,600 |
| suppliers | 300 |
| categories | 24 |
| locations | 6 |
| **total** | **80,000** |

The dashboard should read 18,000 / 2,777 / 1,109. Products are ≈22.5 % of `--total`, so any size can be
predicted from it. Other `--total` or `--seed` values give other numbers; `verify:demo` prints the truth
for what is actually stored.

| Fixture | Shape |
|---|---|
| `seed:demo-tenant` | 14 curated products, 136 units, 3 locations, 30 ledger movements — every figure fixed and printed by the seeder |
| `seed:roles` | ~900 documents (≈200 products), four logins, one tenant |
| `seed:perf` | `--size` **products** (1–200 000), deterministic SKUs `SEEDSKU-…`, no login |
| `seed:perf-tenant` | `--size` **documents** (products ≈22 %), deterministic SKUs `SEEDSKU-…`, one OWNER login |

No SKUs or barcodes are seeded by `seed:three` / `seed:accounts` unless asked for: each `--accounts`
entry takes `codes=both|none|sku|barcode`, and `--codes=` sets the run-wide default — the only lever the
`seed:three` preset has, because it takes no entry list. So the app's own barcode generation is what
assigns them by default — that is deliberate, and worth one product per run.
When barcodes are asked for they are valid EAN-13 values (internal prefix-2 range, real check digit,
unique within the account), so they can be printed and scanned.

---

## Part 5 — The one irreversible mistake

A deleted login whose database record survives can never sign in again, and the address cannot be
re-registered. `cleanup:test-firebase` deletes **every** login in the project, including yours.

> **Never delete a Firebase identity while a MongoDB user row still uses its address.**

There are two safe ways to start over:

- **Same login, empty business:** a tenant-scoped cleanup such as `cleanup:demo` removes that tenant's
  data but keeps its user row, business row and login. Sign in again and the business is empty —
  [Guide 11](11-deleting-development.md).
- **Genuinely new account and business:** in the app, **Profile → Delete account** deletes the Firebase
  identity and the personal data; when you are the only active member **and** its OWNER, the business
  closes with the account, and the address can be registered again. [Guide 8](8-play-store-submission.md) §6.3
  describes the flow.

Registering a new address is still the simplest way to get a separate tenant, and the app has no admin
control that deletes somebody else's account. Do **not** clear the whole database and expect to sign in
afterwards: `cleanup -- --target=database` deletes the `users` rows and strands every login
([Guide 11](11-deleting-development.md)). When an identity genuinely must go through the admin
commands, [Guide 13](13-firebase-identities.md) has the guarded command and the refusals that make the
ordering impossible to get wrong.

---

## Part 6 — Starting over

| Want | Do |
|---|---|
| Fresh sample data in your own tenant | `seed --plan=demo --database=…` — [Guide 9](9-seeding-development.md) |
| Your data gone, same login and business | `cleanup:demo --database=… --email=… --business=…`, which removes one tenant and keeps its login — [Guide 11](11-deleting-development.md) |
| A genuinely new account and business | Profile → **Delete account**, then register again or use a new address — [Guide 8](8-play-store-submission.md) §6.3 |
| **Every** tenant in a database gone | `cleanup -- --target=database --database=…` — ⚠️ this also deletes the `users` rows and strands every login, so it is not a fresh-start path — [Guide 11](11-deleting-development.md) |
| One fixture tenant gone | its own cleanup (`cleanup:roles`, `cleanup:demo-tenant`, `cleanup:perf-tenant`, `cleanup:perf`) — [Guide 11](11-deleting-development.md) |
| A truly new user | register a new address in the app — a new empty business |
| A login gone, deliberately | [Guide 13](13-firebase-identities.md) — database first, identity second |

Ignore `--target=database` against `inventoryai_prod_db`, and `cleanup:test-firebase`, without a
specific reason.

---

## Part 7 — Words

**Firebase** (logins) · **MongoDB/Atlas** (data) · **UID** (the link) · **tenant** (one customer's data) ·
**seed** (fill with sample data) · **SKU/barcode** (optional product codes) ·
**fixture** (small fixed test data) · **environment** (development/test/production) ·
**destructive** (permanent). The full glossary is [Guide 5](5-words-explained.md).

← [Guides index](README.md) · Related: [9. Seeding data — development](9-seeding-development.md) ·
[10. Seeding data — production](10-seeding-production.md) ·
[11. Deleting data — development](11-deleting-development.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[13. Firebase identities](13-firebase-identities.md) · [5. Words explained](5-words-explained.md)
