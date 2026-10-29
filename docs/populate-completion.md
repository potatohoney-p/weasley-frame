# Populate completion integrity

The populate agent step treats a resolved Mastra stream error as a failed
workflow step, even if partial text was returned. Token and tool usage already
reported by the provider is retained before the failure is propagated. This
result-error guard is defensive: the inspected Mastra 1.55.0 `generate()`
implementation already throws its output error. The currently reproduced bug is
a normally resolved response after cancellation being recorded as success.

The step captures its dataset cancellation signal before credential preparation.
It checks that signal before preparation, before provider dispatch, and after
receiving the provider result. A provider resolving normally after Stop does not
turn the stopped attempt into successful run metrics. A cancelled step records
`Stopped by user`; a network AbortError without the captured signal being aborted
remains a provider failure.

The existing background runner still decides dataset lifecycle: ordinary failed
populate becomes failed, while user-stopped populate uses its existing live
partial-results path. This change does not roll back rows already committed,
change quotas, or guarantee interruption of an in-flight provider request. It
does not change the preceding clear/enumerate steps or fence database writes
across separate processes.

## Offline verification

From the repository root, run `npm run test:backend`. The focused suite is:

`cd backend && node --import tsx --test tests/populate-completion.test.ts`

The tests compile the production step callback and substitute synthetic provider,
credential and metrics I/O. They cover resolved Error/string failures, successful
partial responses after cancellation, pre-cancelled work, cancellation during
credential preparation, replacement registry signals, custom abort reasons,
normal success, and spurious provider AbortError.
No credentials, live database, provider calls, deployment or browser are involved.
