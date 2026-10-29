# Orphan Stop acknowledgment

When an authorized Stop request sees a building/updating dataset but no controller
in this backend process, it attempts orphan recovery. Updating datasets first
clear pending row statuses; both kinds then write the failed terminal status.

HTTP 200 with `success: true` is returned only after those required operations
resolve. A rejected cleanup or status write now returns HTTP 502 with the normal
Stop error message, rather than falsely acknowledging successful recovery. The
server retains the detailed error log; storage error contents are not returned.
A later request may retry recovery. Active runs still receive their abort signal
and HTTP 202, which acknowledges the cancellation request, not completion.

A rejected response is an uncertain outcome: the remote write may already have
committed. The route does not roll back or repeat it automatically. A subsequent
Stop may return 409 if the dataset is already terminal. Refresh/read the current
state before deciding whether another recovery is needed. Cleanup and the status
write remain separate operations; this change adds no atomicity, distributed
ownership, stale-write fencing, or process-crash recovery guarantee.

## Offline reproduction

```
cd backend
node --import tsx --test tests/orphan-stop.test.ts
```

The tests compile the actual registered route callback without starting the
server, inject synthetic query/mutation failures, and use the real process-local
abort registry. They cover cleanup and status failures, retry after repair, lost
status acknowledgments, successful recovery, active cancellation, validation,
and ownership/inactive guards. The actual frontend Stop client is also checked
against the route response through synthetic fetch, so failed recovery rejects
rather than resolving as success. They do not establish live HTTP authentication,
deployed Convex concurrency/transactions, browser behavior, or provider outcomes.
