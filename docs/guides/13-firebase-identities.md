# 13. Firebase identities

Firebase holds the logins; MongoDB holds the data. This guide is about the logins only — which commands
create them, how to delete one safely, and how to prove it. Data is [Guide 9](9-seeding-development.md),
[Guide 10](10-seeding-production.md), [Guide 11](11-deleting-development.md) and
[Guide 12](12-deleting-production.md); the fixtures themselves are [Guide 4](4-test-accounts-and-mock-data.md).

Run everything from `server/`.

---

## How the two halves are joined

| System | Holds | Answers |
|---|---|---|
| **Firebase** | the email and password | *who is this person?* |
| **MongoDB** | business, user, role, products, stock | *what may they do, and what is their data?* |

The link is Firebase's **UID**, stored on the MongoDB user as `firebaseUid` at registration —
**never the email alone**. Sign-in resolves a user by that uid only.

One Firebase project serves **both** development and production. So one identity can be referenced by
a user row in either database, and deleting it affects both.

### The one irreversible mistake

**Deleting an identity while a MongoDB user row still owns the address locks that person out
permanently.** The row can never sign in (no identity can mint a token) and the address cannot be
re-registered (`409 EMAIL_IN_USE`). Nothing in the app can repair it.

> **Clear MongoDB first. Delete the login second — or not at all.**

That rule is enforced, not just documented: the commands below refuse when any user row in either
database still references the address.

The app's own **Profile → Delete account** is the supported self-service path and is not this admin
operation: the server deletes the Firebase identity first, then closes the account (and the business
when the caller is its only active member **and** OWNER), so the address can be registered again. Do not reproduce
it by deleting an identity from the console while the row survives.

---

## Which commands create identities

No command creates an identity on its own. The seeders do, as part of their own job.

| Command | Address | Password | Verified? |
|---|---|---|---|
| `seed --plan=demo` / `seed:demo` | the `--email=` you pass | `DEMO_ACCOUNT_PASSWORD`, on creation only | yes |
| `seed --plan=accounts` | each address in `--accounts=` | `DEMO_ACCOUNT_PASSWORD` | yes |
| `seed --plan=roles` / `seed:roles` | the four `role-*@example.invalid` addresses | `ROLE_TEST_PASSWORD` | yes |
| `seed:perf-tenant` | `perf-seed-ai@example.invalid` | `DEMO_ACCOUNT_PASSWORD`, refreshed when supplied | yes |
| `seed:demo-tenant` | `demo-preview@example.invalid` | `DEMO_ACCOUNT_PASSWORD`, set when supplied | yes |
| `seed:perf` | — (no identity) | — | — |

- **`emailVerified: true`** is set through Firebase's admin interface, which is the same write the app
  makes after a real six-digit code. No rule is weakened, and the `.invalid` fixtures need no mailbox.
- **An existing password is never rewritten by a production `seed --plan=demo`.** Only a brand-new
  identity gets one. The four commands that own their addresses (`seed:roles`, `seed:perf-tenant`,
  `seed:demo-tenant`) may rotate theirs, because the address exists only for that fixture.
- **A password is never accepted on the command line, printed, or written to a file** — set
  `DEMO_ACCOUNT_PASSWORD` / `ROLE_TEST_PASSWORD` in the environment.
- **The project is pinned.** Every seeder creates its identity in the approved project
  (`inventoryai-d0d20`) through one function, and refuses when the shell's credentials name another
  one — a login in a different project could never be joined to the tenant, because the app resolves
  a user by `firebaseUid` only. `check:accounts` refuses the same way, with `NOT CHECKED (exit 2)`, so
  it never reports "no identity" for an account that exists elsewhere.
- `seed --plan=demo` on a database row that carries a **stale** uid refuses rather than re-linking it;
  see [Guide 9](9-seeding-development.md) and [Guide 10](10-seeding-production.md).

---

## Deleting the identities you name

```bash
# PREVIEW — checks the phrases and the links, deletes nothing
NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db \
  CLEANUP_CONFIRM=cleanup:firebase CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup -- --target=firebase --database=inventoryai_dev_db \
    --email=person@example.com --dry-run

# EXECUTE — the same command, with --dry-run removed
NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db \
  CLEANUP_CONFIRM=cleanup:firebase CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup -- --target=firebase --database=inventoryai_dev_db \
    --email=person@example.com
```

Production is the same command with the third phrase and the production database named:

```bash
# PREVIEW — production, still nothing deleted
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  CLEANUP_CONFIRM=cleanup:firebase CLEANUP_DB_CONFIRM=inventoryai_prod_db \
  CLEANUP_PROD_CONFIRM=DELETE-PRODUCTION-DATA \
  npm run cleanup -- --target=firebase --database=inventoryai_prod_db \
    --email=person@example.com --dry-run

# EXECUTE — the same command, with --dry-run removed
NODE_ENV=production MONGODB_DB_NAME=inventoryai_prod_db \
  CLEANUP_CONFIRM=cleanup:firebase CLEANUP_DB_CONFIRM=inventoryai_prod_db \
  CLEANUP_PROD_CONFIRM=DELETE-PRODUCTION-DATA \
  npm run cleanup -- --target=firebase --database=inventoryai_prod_db \
    --email=person@example.com
```

- `--email=` repeats, or takes a comma-separated list. At least one is required.
- `--database=` is required and must equal the database this shell resolved. The phrase rules are
  [Guide 11](11-deleting-development.md)'s; this target's phrase is `cleanup:firebase`, and the production
  line above shows the third phrase.
- The Firebase project must be exactly the approved project — `inventoryai-d0d20` — and must not look
  like a production project. Any other id is refused.
- It authorises nothing else: it cannot delete a login you did not name, and it never touches MongoDB.

### What it prints, and what it refuses

One verdict per address:

| Verdict | Meaning | Outcome |
|---|---|---|
| `will delete` | an identity exists and nothing references the address | deleted |
| `REFUSED — still linked to a MongoDB user` | a user row still owns it, in development or production | **the whole run stops**, exit 1, nothing deleted |
| `ORPHANED — identity already gone, database row remains` | the damage is already done | **the whole run stops**, exit 1, nothing deleted |
| `no identity` | nothing to delete | skipped |

The link check is deliberately paranoid, because the alternative is unrecoverable:

- **Both databases are read** — `inventoryai_dev_db` and `inventoryai_prod_db` — since one identity can
  be referenced twice.
- **Both links are checked** — by `firebaseUid` **and** by the address. A uid goes stale whenever an
  identity is deleted and re-created under the same address. `email` is unique, lower-cased, indexed, and is what
  registration collides on, so the address is what decides.
- **One reference anywhere refuses everything.** A partial delete would leave the operator unsure which
  addresses are still usable.

`ORPHANED` is reported as a refusal rather than "0 deleted", because the address stays unusable and
"nothing to do" would read as success.

### Which addresses will be refused, and why

Every fixture owns a user row, so its identity cannot be deleted while that tenant exists:

| Address | Referenced by | To free it |
|---|---|---|
| `demo-preview@example.invalid` | the demo tenant's user row | `cleanup:demo-tenant` first |
| `role-*@example.invalid` (4) | the role fixture's rows | `cleanup:roles` first, then `--delete-firebase` |
| `perf-seed-ai@example.invalid` | the `seed:perf-tenant` user row **and** the `seed:perf` owner row | `cleanup:perf-tenant` **and** `cleanup:perf` first |

`seed:perf` creates a user with that address and **no** `firebaseUid` — it is not a login, but it is
still a reference by email, so it blocks the delete just the same.

---

## One cleanup command that deletes identities by itself

`cleanup:roles --delete-firebase` removes the four role identities only after the tenant's rows are gone
and no user still uses the addresses. Apart from the app's **Delete account**, it is the one automatic
identity deletion; without the flag, the logins are kept.

```bash
CLEANUP_CONFIRM=cleanup:roles CLEANUP_DB_CONFIRM=inventoryai_dev_db \
  npm run cleanup:roles -- --database=inventoryai_dev_db --delete-firebase
```

---

## Wiping the whole test project

```bash
npm run cleanup:test-firebase -- --dry-run   # count them first, delete nothing
npm run cleanup:test-firebase
```

`--dry-run` lists the users and prints how many would go, then stops before the prompt — it needs no
phrase, because it deletes nothing.

This deletes **every** identity in `inventoryai-d0d20`, including yours. It guards by:

- refusing unless `NODE_ENV` is an approved non-production value (`development`);
- refusing unless the project id is exactly the approved one, and not production-flavoured;
- requiring the phrase `cleanup:test-firebase` — typed at the prompt, or passed as
  `CLEANUP_CONFIRM=cleanup:test-firebase` together with `--yes`;
- deleting only Firebase users: it never touches MongoDB, and it never creates a user.

Use it only to reset the test project itself, never as a way to start over with your own account. For that,
use **Profile → Delete account**. `cleanup -- --target=database` is not a substitute: it deletes the `users`
rows and strands every login.

---

## Verifying

| Step | Command | Expect |
|---|---|---|
| 1. Before | the `--target=firebase` line with `--dry-run` | `will delete` for each address, nothing deleted |
| 2. Delete | the same line without `--dry-run` | `deleted  <address>` per identity, then `OK — N identity(ies) deleted` |
| 3. After | the dry run again | `no identity` for each address |
| 4. Proof of use | register that address in the app | a new account, a six-digit code, a new empty business |

The command re-reads every deleted uid with `getUser` before printing `OK`, so a silent failure
surfaces as an error rather than as success. For the `.invalid` fixtures, step 4 is not possible —
their proof is that the next seed recreates the identity and signs in with the password from the
environment.

---

## When it refuses

| Message | Meaning | Do |
|---|---|---|
| `--email=<address> is required` | no address named | add `--email=`, repeatable or comma-separated |
| `"…" is not an address` | a value has no `@` | fix the value; nothing was deleted |
| `two/three confirmation phrase(s) …` | a phrase is missing or wrong | the message lists all of them ([Guide 11](11-deleting-development.md)) |
| `Firebase is not configured` | the project cannot be verified | set the Firebase admin credentials |
| `Firebase project must be exactly "inventoryai-d0d20"` | the shell points at another project | fix `FIREBASE_PROJECT_ID`; nothing was deleted |
| `still have a MongoDB user: …` | the ordering rule was broken | clear those rows first, then retry |
| `NO Firebase identity … a MongoDB user still owns the address` | already orphaned | clear the database; Firebase cannot fix it |
| `N identity(ies) still exist after deletion` | the delete did not take | re-run; nothing else was changed |
| `Refusing to clean: NODE_ENV is …` (`cleanup:test-firebase`) | not a development shell | run it from the development environment |

---

## What no command does

No command repairs an orphaned address, creates an identity for an existing MongoDB user, or frees an
address whose row remains. Onboarding and invitation flows own identity creation; the guard exists to
prevent the last state.

← [Guides index](README.md) · Related: [4. Test accounts](4-test-accounts-and-mock-data.md) ·
[9. Seeding data — development](9-seeding-development.md) ·
[10. Seeding data — production](10-seeding-production.md) ·
[11. Deleting data — development](11-deleting-development.md) ·
[12. Deleting data — production](12-deleting-production.md) ·
[6. Everything else](6-scripts-and-commands.md)
