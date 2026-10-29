# Manual run preparation

The `/populate` and `/update` routes prepare dataset context and model settings
before claiming a dataset. Previously a rejected settings import/read returned
502 after changing the dataset to `building`/`updating`, with no registered
controller or background runner. The dataset then needed recovery before retry.

The route now checks authentication and preflights existence, ownership and
active status, then reads settings. The existing atomic begin mutation rechecks
ownership/status after preparation. Only a `started` outcome creates a run,
registers its controller and dispatches the background runner. Competing requests
may both prepare settings, but only the claim winner starts work. Preparation
failure leaves dataset state unchanged, allowing a later request to retry.

Run creation intentionally remains **after** admission: Mastra 1.55.0 retains
created run objects, so allocating runs for rejected claims would introduce
abandoned runs. Its existing create-failure compensation remains unchanged.

## Compatibility and boundaries

- HTTP success and error shapes are retained. Populate's `already_updating`
  result now returns the intended 409 rather than falling into a generic 502.
- Unauthorized requests do not load model settings or create/dispatch a run.
  The internal preflight query returns no dataset body to the caller. The final
  atomic owner check remains authoritative; preflight is not a new auth gate.
- Populate's planning `maxRowCount` is the preflight snapshot. A concurrent cap
  change is not reflected in that run's planning input; row insertion continues
  to independently enforce the current stored cap. No quota rule changes.
- Settings are a snapshot, not transactionally coupled to admission. A failed
  or lost claim response remains uncertain. This does not fence stale status
  writes, repair orphaned runs, handle process crashes after admission, or fix
  the existing post-claim `createRun` failure compensation race.
- CLI startup and scheduled startup are unchanged. No schema, endpoint,
  credential, deployment or dependency changes are required.

## Reproduction and checks

```
npm test
npm run test:backend
npm run build --prefix backend
cd backend && node --import tsx --test tests/manual-startup.test.ts
```

The focused suite compiles actual route callbacks, rejects syntax diagnostics,
and invokes real begin-mutation handlers with synthetic storage and mocked I/O.
It covers preparation failure/pending/retry, rejected preflights, ownership,
status and deletion changes, competing preparations, controller-before-dispatch
ordering, and unchanged post-claim create-failure handling. Synthetic admission
is explicitly serialized; it is not evidence of live Convex transaction behavior.
No HTTP/auth integration, deployed database, browser, provider or paid-service
validation is claimed. The Docker development stack was not launched.
