# Scheduled refresh preparation

The scheduler loads each due dataset owner's model settings and creates a workflow
run before attempting the atomic scheduled-refresh claim. A settings read or
module-load failure is logged with the dataset ID and skips that item; later items
in the batch can still start. The affected dataset keeps its previous status and
schedule, so preparation can retry on the next poll without waiting for stale-run
recovery.

Previously the settings read happened after the claim. A rejected read left the
dataset `updating` with no running workflow or cancellation controller, and aborted
the rest of that poll. Its claim could remain busy until the stale threshold
(six hours by default) or a user Stop.

The due query already returns the owner ID. Dataset ownership is immutable through
the current application mutations. The fresh atomic claim still checks deletion,
scheduling eligibility and concurrent activity after preparation; workflow input
uses the claim's returned snapshot. Model settings are a preparation-time snapshot.
Existing cancellation ownership and notification handling are unchanged.

## Offline verification

```sh
cd backend
node --import tsx --test tests/scheduled-startup.test.ts
```

The tests compile the actual scheduler and scheduled runner declarations with
synthetic database, model-settings and timer I/O. They cover delayed and rejected
settings, import failure, next-poll retry, workflow creation failure, per-owner
configuration, fresh claim data and a rejected claim. Four of seven cases fail
before this fix; all seven pass afterward. They do not start the HTTP server, load
credentials, call providers or establish live Convex transaction/auth behavior.

This change prevents preparation failures from creating orphaned claims. It does
not recover previously orphaned claims, fence old runners' writes, handle a claim
whose response is lost, add preparation timeouts, or address manual-startup gaps.
A pending settings request still delays the rest of the current poll; the existing
tick guard prevents overlapping polls. No Convex deployment or schema change is
required for this backend-only change, and no live deployment was performed.
