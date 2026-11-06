# 11. Deleting data — development

Removing data from **`inventoryai_dev_db`**. Production is [Guide 12](12-deleting-production.md); seeding is
[Guide 9](9-seeding-development.md) and [Guide 10](10-seeding-production.md); deleting Firebase logins is
[Guide 13](13-firebase-identities.md); the accounts are [Guide 4](4-test-accounts-and-mock-data.md).

Run everything from `server/`.

---

## The development rule

- **Name the database twice, and let it agree.** `--database=inventoryai_dev_db` must equal what
  `MONGODB_DB_NAME` resolved; if they disagree the run refuses **before connecting**. Only
  `inventoryai_dev_db` and `inventoryai_prod_db` can be cleaned — `inventoryai_test_db` is refused because
  `npm test` owns it.
- **Two phrases:** `CLEANUP_CONFIRM=<the command's own phrase>` (which command) and
  `CLEANUP_DB_CONFIRM=inventoryai_dev_db` (where). Production adds a third
  ([Guide 12](12-deleting-production.md)).
- **Every command has a `--dry-run`**, and the preview counts through the **same** collection plan the real
  run executes — so the numbers it prints are the deletion's numbers, not a second opinion. A dry run still
  requires the phrases: it is there to prove the destination, not to skip it.
- **A real run re-counts afterwards** and prints `0 remaining`. Anything left **fails** the run rather than
  being reported as done.

`cleanup:test-mongodb`, `cleanup:dev-mongodb`, `cleanup:prod-mongodb`, `cleanup:all-mongodb` and
`cleanup:firebase-accounts` no longer exist — each was one command with the target baked in, so `npm run` on
those names now fails with "missing script". Use the forms below.

---

## Which command?

| You want | Command |
|---|---|
| Every document in the database | `npm run cleanup -- --target=database --database=inventoryai_dev_db` ⚠️ |
| The three comparison accounts' data | `npm run cleanup:three -- --database=inventoryai_dev_db` |
| The data of accounts you name | `npm run cleanup:account -- --database=inventoryai_dev_db --accounts="a@x.com,b@y.com"` |
| One tenant's data, keeping its login | `npm run cleanup:demo -- --database=… --email=… --business=…` |
| The measurement tenant removed | `npm run cleanup:perf-tenant -- --database=inventoryai_dev_db` |
| The fixed-figure demo tenant removed | `npm run cleanup:demo-tenant -- --database=inventoryai_dev_db` |
| The role fixture removed | `npm run cleanup:roles -- --database=inventoryai_dev_db` |
| The no-login measurement tenant removed | `npm run cleanup:perf` (development only) |
| A Firebase login removed | [Guide 13](13-firebase-identities.md) |

`npm run cleanup` is the dispatcher: `--target` is required and has no default, so a forgotten flag cannot
pick one for you. The rest are one tenant each.

### The phrase each command uses

Each command's own phrase is in the one [phrase and safety matrix](10-seeding-production.md#phrase-and-safety-matrix).
A phrase that belongs to a different command is refused, so `CLEANUP_CONFIRM=cleanup:database` cannot run
`--target=firebase`.

---

## ⚠️ Clearing the whole database

```bash
# look first
CLEANUP_CONFIRM=cleanup:database CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup -- --target=database --database=inventoryai_dev_db --dry-run

# then delete — the same line without --dry-run
CLEANUP_CONFIRM=cleanup:database CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup -- --target=database --database=inventoryai_dev_db
```

- Structure, collections and indexes survive; documents do not.
- **It deletes the `users` rows too.** Firebase is untouched, so clearing this database strands every login
  it held. Use it only when you mean to remove the accounts as well; see *Order* below and
  [Guide 13](13-firebase-identities.md).
- `--yes` is accepted and does nothing — there is no interactive prompt any more.

---

## Emptying the accounts you name

`cleanup:three` and `cleanup:account` remove the **seeded data** of accounts by address — the other half of
`seed:three` and `seed:accounts` — and keep everything that makes them accounts: the login, the business
row, its members and their sessions.

```bash
# the three comparison accounts: preview, then the same line without --dry-run
CLEANUP_CONFIRM=cleanup-three-accounts CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:three -- --database=inventoryai_dev_db --dry-run

# accounts you name
CLEANUP_CONFIRM=cleanup-account-data CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:account -- --database=inventoryai_dev_db \
    --accounts="a@x.com,b@y.com" --dry-run
```

- In development the **addresses alone are enough**; production also reads each address's own tenant and
  requires that account to be its **OWNER** ([Guide 12](12-deleting-production.md)).
- An address with no account in that database is **refused before any delete** — a named account must exist.
- Add `--witness="<an account outside the plan>"` to either `cleanup:account` line for a read-only proof
  that another tenant was untouched. The witness must exist and must not share a business with any account
  being emptied; its data counts, login row, business row, role, status and Firebase linkage are compared
  before and after, and any difference **fails** the run. It is never modified or deleted.
- It never deletes a user row, a business row, a session or a Firebase identity.

---

## Emptying one tenant, keeping its login (`cleanup:demo`)

```bash
CLEANUP_CONFIRM=cleanup:demo-account CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:demo -- --database=inventoryai_dev_db \
  --email=you@example.com --business=THE_BUSINESS_ID --dry-run
```

Both identifiers are required and must **agree** — the email and the business id are two fingerprints of the
same tenant. Drop `--dry-run` to delete; the post-delete read prints `verification found 0 remaining`.

---

## The other fixture cleanups

Each follows the rule above; the table gives what changes.

| Command | Removes | Keeps |
|---|---|---|
| `cleanup:perf-tenant` | the `seed:perf-tenant` tenant | the Firebase identity |
| `cleanup:demo-tenant` | the `seed:demo-tenant` fixture | the Firebase identity |
| `cleanup:roles` | the role fixture tenant | its four identities unless `--delete-firebase` |
| `cleanup:perf` | the no-login `seed:perf` tenant (development only) | — |

```bash
CLEANUP_CONFIRM=cleanup:demo-tenant CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:demo-tenant -- --database=inventoryai_dev_db --dry-run

CLEANUP_CONFIRM=cleanup:perf-tenant CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:perf-tenant -- --database=inventoryai_dev_db --dry-run

CLEANUP_CONFIRM=cleanup:roles CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:roles -- --database=inventoryai_dev_db --dry-run
```

`cleanup:perf --dry-run` counts that tenant over the same plan and deletes nothing; without the flag it
removes the rows and proves `0 remaining`. It says `nothing to clean` when nothing was ever seeded, and
exits 0 either way. `cleanup:roles --delete-firebase` removes the four identities **only after** the
database rows are gone, and only after re-querying that no user row still uses the addresses.

---

## Order: database first, identities second

A surviving MongoDB row with a deleted identity is unrecoverable; [Guide 13](13-firebase-identities.md)
explains why. Delete the rows first (`--target=database` or a tenant cleanup), then the identities with
`--target=firebase`. The second command refuses while any row still references the address.

---

## Proving it worked

| After | Run | Expect |
|---|---|---|
| a tenant cleanup | the command again with `--dry-run` | every collection at 0, or `nothing to clean` |
| a tenant cleanup | `npm run verify:demo -- --email=… --database=inventoryai_dev_db` (one tenant) or `--accounts="…"` (several) | `FAILED — the tenant is empty` (exit 1) is the proof the data is gone; exit 2 if the rows are gone too |
| an accounts cleanup | `npm run check:accounts` | the accounts are still `READY`, with 0 documents a seed would reset |
| a database wipe | `npm run seed -- … --dry-run` or a fresh seed | a clean target; the app shows an empty business |
| firebase deletion | the same `--target=firebase` line with `--dry-run` | `no identity` for each address |

Each real run re-queries its plan and prints `0 remaining`; that is the proof, and the checks need no phrase
because they only read. An empty tenant is not a verification pass: `verify:demo` checks a seeded dataset,
so it reports that state as a failure (exit 1). Read it as the deletion's proof, not as a data defect.

For a tenant **outside** the plan, use the `--witness` check described above, or record `check:accounts`
before and after; the `READY` line and the products/documents counts must be identical.

---

## What a delete does not free

Documents go; the space their **indexes** were allocated does not. On the shared 512 MB M0 that residue is
why a later re-seed can be refused for space even though every document is gone — the index residue and
the reclaim are in [Guide 12 § The space a delete does not give back](12-deleting-production.md), and they
apply to this database too.

---

## When it refuses

| Message | Do |
|---|---|
| `two confirmation phrase(s) are required` | export the command's **own** phrase from the [phrase matrix](10-seeding-production.md#phrase-and-safety-matrix) — for example `cleanup-account-data`, not `cleanup:account` — and `CLEANUP_DB_CONFIRM=inventoryai_dev_db`; the refusal names the exact value it wanted |
| `three confirmation phrase(s) … CLEANUP_PROD_CONFIRM=DELETE-PRODUCTION-DATA` | the target is production — add the third phrase ([Guide 12](12-deleting-production.md)) |
| `--database is "…" but this process resolved "…"` | set `MONGODB_DB_NAME` to match; do not retype the flag |
| `MONGODB_URI names the database "…"` | the URI points the shell at another database; fix it before retrying |
| `is the test database … "npm test" owns` | name development or production |
| `CLEANUP_CONFIRM names "…", but this run is [cleanup:firebase]` | the phrase belongs to the other target; use the target's own phrase |
| `no such tenant` / `nothing to clean` | the fixture is not in that database — check `--database=` first |
| `--accounts="address[:businessId],…" is required` | a bare `cleanup:account` named nothing — add the list, or use `cleanup:three` |
| `the cleanup:three preset … is refused in production` | a preset against real businesses — name every account with `--accounts=` |
| `belongs to business …, not …` | the id named is not the tenant that account owns; nothing was deleted |
| `resolve to the same business … Name one account per tenant` | two addresses in the plan are members of one tenant, so its documents would be counted and reported twice; nothing was deleted |
| `verification failed: N document(s) still reference the fixture tenant` | the delete was partial; re-run and read the collections named |
| `still have a MongoDB user` | clear the database first, then the login ([Guide 13](13-firebase-identities.md)) |

---

← [Guides index](README.md) · Related: [9. Seeding data — development](9-seeding-development.md) ·
[10. Seeding data — production](10-seeding-production.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[13. Firebase identities](13-firebase-identities.md) · [4. Test accounts](4-test-accounts-and-mock-data.md) ·
[6. Everything else](6-scripts-and-commands.md)
