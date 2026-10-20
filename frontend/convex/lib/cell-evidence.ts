import { v } from "convex/values";

export const MAX_EVIDENCE_COLUMNS = 64;
export const MAX_SOURCES_PER_CELL = 4;
export const MAX_EXCERPT_LENGTH = 1024;
export const MAX_SOURCE_URL_LENGTH = 2048;
// String bounds use JavaScript UTF-16 code units. Convex document byte limits
// still apply independently to the final row and its retained retry metadata.
export const MAX_EVIDENCE_LENGTH = 64 * 1024;
export const MAX_VALUE_KEY_LENGTH = 16 * 1024;
export const MAX_OPERATION_KEY_LENGTH = 128 * 1024;

export interface CapturedEvidence {
  captureId: string;
  kind: "page" | "search_snippet";
  url: string;
  excerpt: string;
  capturedAt: number;
  contentSha256: string;
  runId: string;
}

export interface CellEvidence {
  valueKey: string;
  sources: CapturedEvidence[];
}

export const capturedEvidenceValidator = v.object({
  captureId: v.string(),
  kind: v.union(v.literal("page"), v.literal("search_snippet")),
  url: v.string(),
  excerpt: v.string(),
  capturedAt: v.number(),
  contentSha256: v.string(),
  runId: v.string(),
});
export const cellEvidenceValidator = v.record(v.string(), v.object({
  valueKey: v.string(),
  sources: v.array(capturedEvidenceValidator),
}));
export const cellEvidenceInputValidator = v.record(
  v.string(), v.array(capturedEvidenceValidator),
);
export const lastEvidenceRefreshValidator = v.object({
  runId: v.string(),
  completedAt: v.number(),
  observedColumns: v.array(v.string()),
});
export const lastWriteValidator = v.object({
  operationId: v.string(),
  payloadKey: v.string(),
  dataChanged: v.boolean(),
  evidenceChanged: v.boolean(),
  revision: v.number(),
});
export const creationOperationValidator = v.object({
  operationId: v.string(),
  payloadKey: v.string(),
});

/**
 * Canonical typed JSON, not display formatting. Unsupported values never acquire
 * a binding. Missing is distinct from null; an own property is still required
 * before attaching evidence to a row.
 */
export function cellValueKey(value: unknown): string | null {
  if (value === undefined) return "missing";
  return canonicalKey(value, MAX_VALUE_KEY_LENGTH);
}

function canonicalKey(value: unknown, maxLength: number): string | null {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 32) throw new Error("Unsupported value");
    if (current === null) return ["null"];
    if (typeof current === "string") {
      if (current.length > maxLength) throw new Error("Unsupported value");
      return ["string", current];
    }
    if (typeof current === "boolean") return ["boolean", current];
    if (typeof current === "number" && Number.isFinite(current)) {
      return ["number", Object.is(current, -0) ? "-0" : String(current)];
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      throw new Error("Unsupported value");
    }
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new Error("Unsupported value");
    }
    ancestors.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      const items = [];
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) throw new Error("Unsupported value");
        items.push(visit(current[index], depth + 1));
      }
      result = ["array", items];
    } else {
      result = ["object", Object.keys(current).sort().map((key) => [
        key, visit((current as Record<string, unknown>)[key], depth + 1),
      ])];
    }
    ancestors.delete(current);
    return result;
  }
  try {
    const key = `v1:${JSON.stringify(visit(value, 0))}`;
    return key.length <= maxLength ? key : null;
  } catch {
    return null;
  }
}

export function operationPayloadKey(payload: unknown): string {
  const key = canonicalKey(payload, MAX_OPERATION_KEY_LENGTH);
  if (key === null) throw new Error("Operation payload is unsupported or exceeds 131072 UTF-16 code units");
  return key;
}

export function validateOperationId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error("Operation id must contain 1–128 characters");
  }
}

export function rowRevision(value: number | undefined): number {
  const revision = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid row revision");
  return revision;
}

export function nextRowRevision(value: number | undefined): number {
  const revision = rowRevision(value);
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Row revision is exhausted");
  return revision + 1;
}

export function assertExpectedRevision(actual: number, expected: number | undefined): void {
  if (expected !== undefined && rowRevision(expected) !== actual) {
    throw new Error("Stale row revision. Reload the row before writing.");
  }
}

function boundedString(value: unknown, max: number, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Invalid captured evidence ${field}`);
  }
}

function validateSource(source: CapturedEvidence): CapturedEvidence {
  if (!source || typeof source !== "object") throw new Error("Invalid captured evidence source");
  boundedString(source.captureId, 128, "captureId");
  boundedString(source.runId, 128, "runId");
  boundedString(source.url, MAX_SOURCE_URL_LENGTH, "url");
  boundedString(source.excerpt, MAX_EXCERPT_LENGTH, "excerpt");
  if (source.kind !== "page" && source.kind !== "search_snippet") {
    throw new Error("Invalid captured evidence kind");
  }
  let parsed: URL;
  try { parsed = new URL(source.url); } catch { throw new Error("Invalid captured evidence url"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid captured evidence url");
  }
  if (!Number.isSafeInteger(source.capturedAt) || source.capturedAt < 0
    || !Number.isFinite(new Date(source.capturedAt).getTime())) {
    throw new Error("Invalid captured evidence capturedAt");
  }
  if (typeof source.contentSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.contentSha256)) {
    throw new Error("Invalid captured evidence contentSha256");
  }
  return {
    captureId: source.captureId, kind: source.kind, url: source.url,
    excerpt: source.excerpt, capturedAt: source.capturedAt,
    contentSha256: source.contentSha256, runId: source.runId,
  };
}

/** Omitted evidence preserves matching bindings; [] explicitly clears one cell. */
export function reconcileCellEvidence(
  data: Record<string, unknown>,
  existing: Record<string, CellEvidence> | undefined,
  submitted: Record<string, CapturedEvidence[]> | undefined,
): Record<string, CellEvidence> | undefined {
  const entries = new Map<string, CellEvidence>();
  for (const [column, evidence] of Object.entries(existing ?? {})) {
    if (!Object.hasOwn(data, column)) continue;
    const key = cellValueKey(data[column]);
    if (key !== null && evidence.valueKey === key) entries.set(column, evidence);
  }
  if (submitted !== undefined) {
    if (submitted === null || typeof submitted !== "object" || Array.isArray(submitted)
      || Object.keys(submitted).length > MAX_EVIDENCE_COLUMNS) {
      throw new Error("Captured evidence exceeds 64 columns or is not an object");
    }
    for (const [column, sources] of Object.entries(submitted)) {
      boundedString(column, 256, "column");
      if (!Object.hasOwn(data, column) || data[column] === undefined) {
        throw new Error("Captured evidence column is absent from row data");
      }
      const valueKey = cellValueKey(data[column]);
      if (valueKey === null) throw new Error("Captured evidence cell value is unsupported or oversized");
      if (!Array.isArray(sources) || sources.length > MAX_SOURCES_PER_CELL) {
        throw new Error("Captured evidence requires at most 4 sources per cell");
      }
      if (sources.length === 0) entries.delete(column);
      else entries.set(column, { valueKey, sources: sources.map(validateSource) });
    }
  }
  if (entries.size > MAX_EVIDENCE_COLUMNS) throw new Error("Captured evidence exceeds 64 columns");
  if (!entries.size) return undefined;
  const result = Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (JSON.stringify(result).length > MAX_EVIDENCE_LENGTH) {
    throw new Error("Captured evidence exceeds 65536 UTF-16 code units");
  }
  return result;
}

export function evidenceEqual(
  left: Record<string, CellEvidence> | undefined,
  right: Record<string, CellEvidence> | undefined,
): boolean {
  const leftKey = canonicalKey(left ?? {}, MAX_OPERATION_KEY_LENGTH);
  return leftKey !== null && leftKey === canonicalKey(right ?? {}, MAX_OPERATION_KEY_LENGTH);
}

/** Scalar equality does not depend on the smaller evidence-binding size limit. */
export function cellValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const leftKey = cellValueKey(left);
  return leftKey !== null && leftKey === cellValueKey(right);
}

export function rowDataEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && cellValuesEqual(left[key], right[key]));
}
