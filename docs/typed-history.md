# Typed cell-change history

A history entry's existing `oldValue` and `newValue` strings are display-only:
`0` and `"0"`, or missing, null and empty strings, can display identically.
New updates also write `oldCell` and `newCell`, each containing:

- `present`: whether the row had its own property for that column.
- `valueKey`: the existing versioned canonical cell representation. It encodes
  types, normalizes object-key order, and preserves array order. A missing cell
  uses `"missing"`; a null cell uses `v1:["null"]`.

A null **valueKey** means the representation is unavailable (unsupported type,
excessive depth/node count or over 16,384 UTF-16 code units), not that the cell
was null. Existing legacy history with absent `oldCell`/`newCell` has unknown
historical types and presence. Do not infer those facts from its display text.
This is bounded change evidence, not a universal replay format or factual
verification of the data. The canonical key itself contains the value, not a
cryptographic hash, and has the same access sensitivity as the original cell.

Unchanged typed rows create no history; accepted operation retries do not
create duplicate entries. This does not change which updates charge quota,
revision handling, evidence capture, row-identity rules or authorization.
New metadata can add at most two bounded value keys per changed column plus
small field overhead; existing display strings retain their original behavior.
Convex document and transaction limits still apply independently.

## Compatibility and rollout

The schema fields are optional: existing entries need no backfill and legacy
readers can continue reading display strings. No old history is reconstructed.
Deploy the additive schema/functions together before using the new mutation;
no deployment is performed by this PR. A schema rollback after new metadata
has been stored requires a separately reviewed migration, not an automatic
schema downgrade. No new public endpoint or history UI is introduced.

## Offline checks

`cd backend && node --import tsx --test tests/typed-history.test.ts`

The tests invoke actual Convex mutation handlers against synthetic storage.
They cover type-only changes, missing/null/empty distinctions, structured
values, unavailable representations, unchanged data, stale rejection and
idempotent replay. They do not establish deployed Convex transaction rollback,
concurrent writers, live auth or browser behavior.
