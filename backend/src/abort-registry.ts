/**
 * Module-level registry mapping datasetId → AbortController.
 *
 * Allows the /stop HTTP route to cancel an in-flight populate or update
 * workflow. The AbortSignal is retrieved inside Mastra workflow steps
 * (which receive no signal parameter from the framework) via `getSignal()`
 * and passed explicitly to each `agent.generate()` call.
 *
 * Keyed by datasetId because:
 *   - The /stop route knows the datasetId (from the request body).
 *   - Convex's atomic claim gates active work, while completed runners may
 *     still await notification or persistence responses after a new run starts.
 *     The entry therefore identifies the latest registered run, not every
 *     runner whose finally block has yet to finish.
 *   - Workflow steps have authorizedDatasetId in their inputData — no
 *     separate workflowRunId lookup needed.
 *
 * Design notes:
 *   - `abortDataset()` fires the signal but does NOT remove the entry.
 *     The background runner's `finally` block passes its own controller to
 *     `deregisterDataset()` so the catch block can still read `controller.signal.aborted` to
 *     distinguish a user stop from a genuine failure.
 *   - All operations are synchronous and safe within a single Node.js process.
 */

const controllers = new Map<string, AbortController>();

/** Register an active run for a dataset and return its AbortController. */
export function registerDataset(datasetId: string): AbortController {
  const controller = new AbortController();
  controllers.set(datasetId, controller);
  return controller;
}

/** Retrieve the AbortSignal for a dataset's active run (undefined if not running). */
export function getSignal(datasetId: string): AbortSignal | undefined {
  return controllers.get(datasetId)?.signal;
}

/**
 * Fire the abort signal for a dataset's active run.
 * Does NOT remove the entry — deregisterDataset() handles that.
 * Returns true if a run was found and aborted; false if the dataset is idle.
 */
export function abortDataset(datasetId: string): boolean {
  const controller = controllers.get(datasetId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Release only this run's registration. A previous runner can finish notification
 * or receive a delayed status response after its successor has registered.
 * Its cleanup must never remove the successor's cancellation signal.
 * Returns false when already released or superseded by another controller.
 */
export function deregisterDataset(datasetId: string, controller: AbortController): boolean {
  if (controllers.get(datasetId) !== controller) return false;
  return controllers.delete(datasetId);
}
