# Confirmed investigate insertion accounting

An investigate subagent's generated `INSERTED: true` text is not evidence that
persistence succeeded. Each invocation now owns a private receipt set. Its
`insert_row` tool adds a row ID only after the existing persistence response
validation succeeds. The agent builder passes this exact set through; it is not
part of a model-visible tool schema.

`inserted` means at least one acknowledged row, while `rowsInserted` counts unique
acknowledged row IDs for that invocation. Repeated acknowledgments of the same
row count once. If generation fails after a write, the error reason remains
explicit and the confirmed insertion is retained. Cancellation still propagates,
but its already acknowledged writes remain in metrics. Summary, clues and reason
on normal completion are generated annotations, not additional write evidence.

A write with a lost or malformed response remains unconfirmed until the existing
retry path receives a valid acknowledgment. This is not a durable reconciliation
journal, proof that a remote transaction did not commit, cross-invocation dedup,
or a rollback mechanism. There is no repair of previously saved metrics and no
change to insertion quotas or database/schema contracts. Late tool work after the
provider settles is outside this invocation completion proof. Existing abort
registry ownership and cancellation exception handling are unchanged.

## Offline reproduction

Run `cd backend && node --import tsx --test tests/investigate-accounting.test.ts`.
The suite compiles actual subagent/tool-builder declarations with synthetic
provider I/O and separately runs the real persistence tool with synthetic storage.
No credentials, live providers, Convex deployment, HTTP or browser are involved.
