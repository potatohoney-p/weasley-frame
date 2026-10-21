# Scheduled refresh finalization

A scheduled refresh can outlive its stale threshold. If run B reclaims a dataset
while run A is still finishing, A must not change B's lifecycle state or refresh
schedule. The same rule applies when a terminal mutation commits but its response
is lost: the runner's failure fallback must not overwrite the committed success.

`completeScheduledRefreshInternal` and `failScheduledRefreshInternal` require the
workflow's `runId`. Each checks the stored dataset inside its mutation and writes
only when all three conditions hold:

- The status is `updating`.
- `lastRefreshStartedAt` is present, marking an active scheduled claim.
- `lastRefreshRunId` matches the caller's run ID.

Otherwise they return `stale_run` without writing; a deleted dataset still returns
`not_found`. The first terminal write clears the active marker, so repeated or
contradictory terminal requests become no-ops. The backend supplies the same ID it
used when claiming and starting the workflow on both success and failure paths.

Successful manual populate/update claims and non-scheduled status transitions
(including Stop and public Pause/Resume) clear `lastRefreshStartedAt`. This prevents
Stop followed by manual Update from inheriting an orphan's stale-reclaim eligibility.
Manual claims also clear timestamps left by older backends. Rejected claims do not
change ownership. `lastRefreshRunId` remains available for historical correlation;
it alone does not indicate an active scheduled refresh.

An accepted finalizer still uses the dataset's current refresh cadence. Disabling
refresh while a run is active permits it to finish without scheduling another run.

## Compatibility and deployment

No schema migration is needed. The two internal terminal mutation contracts now
require `runId`, so mixed backend/Convex versions are incompatible: old backends omit
the argument, and old Convex validators reject the new argument. For a future
deployment, stop/drain existing scheduler workers, update the Convex functions, and
start the matching backend. Do not leave old workers running through that change.
This patch's offline verification does not deploy Convex or start a live stack.

## Verification and limits

Run `node --import tsx --test tests/scheduled-finalization.test.ts` from `backend/`.
The tests invoke the real Convex handlers against synthetic storage and compile the
actual background runner with injected workflow/transport dependencies. They cover
stale reclaim, duplicate and contradictory finalization, a lost response after a
successful commit, Stop/manual restart, legacy timestamps, and required ID forwarding.
Storage mocks do not simulate Convex transaction retries or network dispatch; argument
requirements are checked separately against the registered validators.

The invariant covers scheduled lifecycle and scheduling metadata. It does not cancel
a surviving old worker, fence its row writes, or solve manual-run finalization races.
The existing process-local controller registry and stale threshold remain unchanged.
