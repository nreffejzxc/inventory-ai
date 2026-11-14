# Staging reliability sequence — disposable tenant cleanup (2026-11-13)

**Status.** PASS. The single disposable PERF SEED tenant used by P4, the advanced-task evaluation
and the sustained-503 drill was removed with the guarded `cleanup:perf-tenant` command. The script’s
own post-removal verification re-counted the tenant’s documents and found **0 remaining**.

## What was removed

The dry run and the real run both resolved the same tenant, `6af75b052d094477c666284f`:

| Collection | Documents |
| --- | ---: |
| `ai_messages` | 84 |
| `ai_conversations` | 22 |
| `inventory` | 20,006 |
| `inventory_transactions` | 13,354 |
| `purchase_orders` | 889 |
| `products` | 10,000 |
| `categories` | 13 |
| `locations` | 4 |
| `suppliers` | 178 |
| `audit_logs` | 14 |
| `ai_turn_metrics` | 57 |
| `users` | 2 |
| `businesses` | 1 |
| **Total** | **44,624** |

The real run removed all **44,624** documents and immediately verified **0 remaining**. The Firebase
identity `perf-seed-ai@example.invalid` is deliberately retained by the cleanup command (F-50); it is
not a MongoDB document and cannot sign in as this tenant after the user row is gone. There is no real
user data in this tenant.

## Commands

```bash
# Count only; deletes nothing.
CLEANUP_CONFIRM=cleanup:perf-tenant \
CLEANUP_DB_CONFIRM=inventoryai_dev_db \
NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db \
npm run cleanup:perf-tenant -- --database=inventoryai_dev_db --dry-run

# Real removal, same guard.
CLEANUP_CONFIRM=cleanup:perf-tenant \
CLEANUP_DB_CONFIRM=inventoryai_dev_db \
NODE_ENV=development MONGODB_DB_NAME=inventoryai_dev_db \
npm run cleanup:perf-tenant -- --database=inventoryai_dev_db
```

The cleanup command refused nothing and found no second tenant matching both seed fingerprints.
No production database, production configuration, or Render service was touched.

## Evidence

- [`dry-run.txt`](dry-run.txt) — guarded count before deletion
- [`cleanup.txt`](cleanup.txt) — real removal and the **0 remaining** verification
- [P4 concurrency evidence](../staging-concurrency-2026-11-13/README.md)
- [Advanced-task evidence](../staging-advanced-2026-11-13/README.md)
- [Sustained-503 evidence](../staging-503-sustained-2026-11-13/README.md)

## Limits

- This proves the scoped tenant cleanup, not a whole-database wipe and not deletion of the retained
  Firebase identity.
- The tenant was synthetic; the 0-remaining result is the script’s own count over its declared
  collection set.
