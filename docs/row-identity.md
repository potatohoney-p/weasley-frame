# Row identity during refresh

Schema inference defines primary key columns as the combined identity of a row.
Inserts already reject collisions, but updates previously did not: refreshing one
entity could replace its key with another row's key, publish evidence for that
replacement, consume quota, and report a successful changed row.

Updates now use the same collision predicate as inserts. The check reads the
dataset's current key columns and peer rows inside the row mutation, excludes the
row being updated, and rejects a matching identity before quota, history, evidence,
revision or row writes. Existing operation-replay and revision checks run first;
an acknowledged replay returns its original result without another write.

The existing comparison policy is preserved:

- Every component of a composite key must match.
- Values are compared using case-insensitive string conversion, without trimming.
  For example, `0` and `"0"` collide; `false` and `"false"` collide. `null` is also
  compared as a value, as it already was for inserts.
- Missing (`undefined`) and empty-string components do not form a collision.
- Datasets without primary keys have no identity uniqueness check.

This is collision enforcement, not new schema/type/completeness validation. A
unique identity change and an evidence-only update to a unique row still work.
Rows in other datasets do not collide. An existing duplicate cannot accept even
an unchanged-key or evidence-only update until its identity is made unique. A
unique-key repair remains possible; this change does not delete or backfill rows.

The existing `update_row` tool surfaces rejection as `success: false`; refresh
accounting therefore records a failure and does not publish a successful refresh
observation for that rejected write.

## Verification and deployment

From `backend/`, run:

```sh
node --import tsx --test tests/row-identity.test.ts
```

The tests execute real row handlers and the actual tool/refresh outcome path with
synthetic storage. They cover single/composite keys, existing comparison behavior,
self/dataset isolation, no-write rejection, sequential contenders, legacy repair,
and replay after a lost response. They do not simulate Convex transaction retries
or prove concurrent behavior against a deployed database.

The check adds a dataset-wide indexed row read to updates with primary keys. This
has the same linear scan shape as insert deduplication and can add transaction
contention during concurrent refreshes. No additional index or schema migration
is introduced. Existing mutation arguments and return shapes stay the same, but
previously accepted duplicate updates now reject for older callers too. A future
deployment must update the Convex functions to activate this behavior; no live
Convex or provider calls or deployment were performed for offline verification.
