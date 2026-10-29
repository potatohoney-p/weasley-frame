/** Drain active work after a stop, but never dispatch another item. */
export async function processWithConcurrency<T>(
  items: readonly T[],
  handler: (item: T) => Promise<void>,
  max: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }
  let index = 0;
  const workers = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (index < items.length && !signal?.aborted) {
      const item = items[index++];
      await handler(item);
    }
  });
  // Wait for all cleanup before allowing the owning workflow to finish.
  const results = await Promise.allSettled(workers);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0 && !signal?.aborted) {
    throw new AggregateError(failures, "Refresh workers failed");
  }
}
