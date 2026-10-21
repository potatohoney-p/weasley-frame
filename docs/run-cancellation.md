# Cancellation ownership during repeated runs

A dataset can become `live` or `failed` before its old background runner has
returned. In production, a ready-email request may still be pending. A persisted
terminal status may also become visible to another request before the mutation's
response arrives. In either case a new run can legitimately claim the dataset.

The abort registry stores the latest registered controller for each dataset.
Every runner must retain the controller it registered and pass that exact object
to `deregisterDataset` in its `finally` block. Cleanup only removes a matching
entry; cleanup from an old run or repeated cleanup is a no-op. This applies to
populate, manual update, and scheduled update runners.

Without this ownership check, the old runner removes the new run's controller.
The next Stop request incorrectly treats an active run as orphaned and can mark
the dataset failed without cancelling its work. This fix keeps the new run
stoppable; it does not add automatic retries or change authorization.

## Offline regression coverage

Install dependencies using the existing repository policy, then run:

```sh
npm ci --ignore-scripts --prefix backend
npm install --ignore-scripts --package-lock=false --prefix frontend
npm run test:backend
npm test
npm run build --prefix backend
```

`backend/tests/run-ownership.test.ts` compiles the actual background-runner
function declarations from `src/index.ts` with synthetic I/O. Importing the
entrypoint directly would start its server and scheduler. The fixture instead
controls notification and status-response timing without network, credentials,
Convex, or model calls. The tests use the production abort registry and cover:

- New runs starting while each old runner finishes a successful or failed run.
- Stopped populate cleanup followed by an independently stoppable new run.
- Repeated Stop and cleanup, incorrect ownership, and unrelated datasets.

The seven interrupted runner scenarios and registry-ownership case fail on the
previous implementation. This is one lifecycle bug, not a separate outcome for
each test. These synthetic checks do not establish live database transaction,
HTTP/auth, multi-process cancellation, or browser behavior. The registry remains
process-local. This is cancellation-registry ownership, not per-run fencing of
Convex writes: an old runner's delayed error path can still write a failed status
after another run starts. Distributed run leases, status-write fencing, and
startup-claim recovery are separate concerns.

## A successful terminal write is not undone by notification failure

After a manual update or stopped populate has acknowledged its `live` status
write, row-count reads and ready notifications are best-effort. Their errors are
logged without entering the workflow-failure handler or issuing a later `failed`
write. Otherwise a temporary count-query failure could mark completed work as
failed and overwrite the status of a successor that has already started.

This does not suppress workflow errors or rejected terminal writes: those still
use the existing failure/fallback paths. The stopped-populate policy is unchanged:
zero rows are allowed but no ready email is sent; stopped updates may notify with
zero rows. No notification retry or guaranteed delivery is introduced.

`backend/tests/terminal-notification.test.ts` compiles the production runner
declarations with synthetic database/notification I/O. Fourteen tests cover
post-live read/send errors with and without a successor, terminal-write rejection,
and the zero/nonzero row notification policy. Eight regressions fail on the prior
implementation. Run it with:

```sh
cd backend
node --import tsx --test tests/terminal-notification.test.ts
```

This boundary begins only after the status-write promise resolves successfully.
A write that commits remotely and then rejects locally is still an uncertain
outcome, not handled by this change. Global per-run status fencing, live Convex
transaction semantics, HTTP/auth and multi-process recovery remain unverified.
