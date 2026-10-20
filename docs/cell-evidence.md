# Captured cell evidence

Cell evidence records a bounded excerpt that a research tool actually returned,
and associates it with the typed value of one column. It is an observation
record, not a factual-accuracy score or proof that the excerpt entails the value.
Search snippets and fetched page text remain distinct source kinds.

## Capture and write boundary

Each investigate or refresh agent receives its own in-memory capture registry.
The backend assigns capture IDs, times and SHA-256 fingerprints. The model can
select a capture and an exact excerpt; it cannot supply the persisted URL,
timestamp, source kind or fingerprint. IDs from another agent, fabricated IDs,
absent excerpts and generated truncation notices cannot become evidence.
Orchestrator prose and legacy row URLs do not become captures.

`insert_row` and `update_row` accept optional `cell_evidence`:

```json
{
  "data": { "Price": 12 },
  "cell_evidence": {
    "Price": [{ "captureId": "returned-by-fetch-page", "excerpt": "Price: 12" }]
  }
}
```

Data and evidence column names pass through the same quote/backtick normalization.
Ambiguous normalized names are rejected. The existing internal Convex mutation
binds each submitted capture set to the actual typed value in the write. Values,
evidence and quota accounting use the same mutation; there is no separate
eventually consistent evidence write.

## Changes, refreshes and retries

- Unchanged values preserve their current evidence unless fresh evidence is
  supplied. Typed equality distinguishes `0`, `"0"`, `false`, null and absence.
- Changed values without new evidence lose their old binding. Removing a
  column from a full-row update removes its evidence. A row deletion removes
  its inline evidence; a late update cannot recreate the deleted row.
- An unchanged value with a fresh capture is an evidence-only update. It
  consumes the existing one-row-write quota but does not increase the refresh
  changed-row count.
- A completed refresh records which current columns have captures from that
  run. An unavailable source does not delete a fact or advance its capture
  time. A column with no new capture is displayed as not observed in that
  completed refresh. Cancellation and failed writes do not publish completion.
- Refresh tools retain the revision of the snapshot they investigated.
  Concurrent edits reject stale writes and stale completion records.
- Server-created operation IDs make an immediate identical update retry
  return its previous result without duplicate history or quota. Reusing an
  ID with different content, or replaying it after a newer revision, fails.
  This is bounded retry metadata, not an unlimited historical deduplication log.
  An insert retry returns the retained creation record's row ID without
  overwriting later edits. Deleting the row also removes that creation record;
  insert deduplication does not survive deletion.

The existing application has no general column-rename or computed-transform
mutation. The tested transformations are its actual tool-key normalization and
full-row replacement paths. A future transformation API must define how derived
values invalidate or acquire evidence rather than copying source bindings.

## Storage compatibility

All new document fields are optional. A legacy row remains readable with
revision zero and no captured evidence. No backfill, index replacement, existing
data rewrite or required-field migration is needed. Existing internal callers
may omit the new arguments; their changed values still invalidate evidence.
They do not gain optimistic concurrency protection unless they supply an
expected revision.

For a future permitted rollout, deploy the additive Convex schema and functions
before enabling the new backend tools. Old frontend/backend clients can continue
to use those expanded functions. Rolling back application clients can retain the
expanded schema/functions. Do not blindly roll the Convex schema back after new
documents have been written: the old schema does not accept the new metadata.
Removing metadata would require a separately reviewed data migration. No schema
deployment, migration or rollback was executed as part of offline validation.

Only bounded excerpts and metadata are persisted, not whole pages. Bounds on
capture count, excerpt length and aggregate evidence prevent unbounded archive
growth. Retry payload metadata is also bounded. The underlying Convex document
size limit still applies to the entire row, including existing data; a write
that exceeds it must fail. A fingerprint identifies the captured text but cannot
reconstruct it, establish authorship, or authenticate a remote publisher.

The cell drawer resolves its selected row and column from reactive data. It
does not keep an old copied value/evidence snapshot open after a row changes or
is deleted. Legacy row links are labeled separately from cell evidence.

## Validation scope

Install both locked dependency sets and run:

```bash
npm ci --ignore-scripts --prefix backend
npm ci --ignore-scripts --prefix frontend
npm test
npm run test:backend
npm run build --prefix backend
cd frontend && npx --no-install tsc --noEmit
```

The tests use synthetic page/snippet responses and synthetic storage, invoke
the actual tool and Convex handler paths, and render the cell drawer offline.
They require no credentials, provider calls or user data. Storage fixtures check
handler behavior and write ordering; they do not prove live Convex transaction
rollback, deployed authorization, or compatibility of an existing running stack.
Those integration checks require a separately permitted local stack and Convex
function deployment.
