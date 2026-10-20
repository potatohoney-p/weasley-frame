function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

/** Use executed tool results, never the model's unverified final prose. */
export function refreshOutcome(
  result: { toolCalls?: unknown[]; toolResults?: unknown[]; error?: unknown },
  rowId: string,
): { updated: boolean; failed: boolean } {
  const calls = new Map((result.toolCalls ?? []).map((chunk) => {
    const payload = object(object(chunk).payload);
    return [payload.toolCallId, payload];
  }));
  let updated = false;
  let writeFailed = false;
  for (const chunk of result.toolResults ?? []) {
    const payload = object(object(chunk).payload);
    const call = calls.get(payload.toolCallId);
    const args = object(payload.args ?? call?.args);
    if (payload.toolName !== "update_row" || args.rowId !== rowId) continue;
    if (payload.isError !== true && object(payload.result).success === true) {
      updated = true;
    } else {
      writeFailed = true;
    }
  }
  // A successful retry resolves an earlier write rejection. A stream error
  // remains an error even when a write was already committed.
  return { updated, failed: Boolean(result.error) || (writeFailed && !updated) };
}
