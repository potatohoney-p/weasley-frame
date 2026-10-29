import {
  datasetRowSchema,
  datasetSchemaSchema,
  type ColumnType,
} from "../pipeline/types.js";

export interface QualityIssue {
  code: string;
  path: (string | number)[];
  message: string;
  row_indexes?: number[];
}

export interface QualitySummary {
  rows: number;
  valid_rows: number;
  missing_cells: number;
  unknown_cells: number;
  null_violations: number;
  type_violations: number;
  incomplete_key_rows: number;
  duplicate_identity_groups: number;
  duplicate_rows: number;
  evidence_rows: number;
  evidence_coverage: number | null;
}

export interface QualityReport {
  version: 1;
  passed: boolean;
  schema_valid: boolean;
  summary: QualitySummary | null;
  issues: QualityIssue[];
}

export class QualityInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This checks syntax only. It does not make a request or judge source quality.
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hour, minute, second, offsetHour, offsetMinute] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && (hour === undefined || (Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60))
    && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
    && Number.isFinite(Date.parse(value));
}

function matchesType(value: unknown, type: ColumnType): boolean {
  switch (type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "url": return isHttpUrl(value);
    case "date": return typeof value === "string" && isIsoDate(value);
    case "string":
    case "enum": return typeof value === "string";
  }
}

/** Evaluate a snapshot without providers, environment loading, storage, or network calls. */
export function evaluateDatasetQuality(input: unknown): QualityReport {
  if (!isRecord(input) || !Object.hasOwn(input, "schema") || !Array.isArray(input.rows)) {
    throw new QualityInputError("Expected an object containing schema and a rows array.");
  }
  const parsedSchema = datasetSchemaSchema.safeParse(input.schema);
  if (!parsedSchema.success) {
    return {
      version: 1,
      passed: false,
      schema_valid: false,
      summary: null,
      issues: parsedSchema.error.issues.map((issue) => ({
        code: "invalid_schema",
        path: ["schema", ...issue.path.map((part) => typeof part === "number" ? part : String(part))],
        message: issue.message,
      })),
    };
  }

  const schema = parsedSchema.data;
  const issues: QualityIssue[] = [];
  const invalidRows = new Set<number>();
  const identities = new Map<string, number[]>();
  const columns = new Set(schema.columns.map((column) => column.name));
  const keyColumns = Array.isArray(schema.primary_key) ? schema.primary_key : [schema.primary_key];
  const summary: QualitySummary = {
    rows: input.rows.length,
    valid_rows: 0,
    missing_cells: 0,
    unknown_cells: 0,
    null_violations: 0,
    type_violations: 0,
    incomplete_key_rows: 0,
    duplicate_identity_groups: 0,
    duplicate_rows: 0,
    evidence_rows: 0,
    evidence_coverage: null,
  };
  function rowIssue(row: number, code: string, path: (string | number)[], message: string) {
    invalidRows.add(row);
    issues.push({ code, path: ["rows", row, ...path], message });
  }

  if (input.rows.length === 0) {
    issues.push({ code: "empty_dataset", path: ["rows"], message: "At least one row is required to evaluate coverage." });
  }

  for (const [index, row] of input.rows.entries()) {
    if (!isRecord(row)) {
      rowIssue(index, "invalid_row", [], "Expected a row object with data and optional sources.");
      summary.incomplete_key_rows++;
      continue;
    }
    const parsedRow = datasetRowSchema.safeParse(row.data);
    if (!parsedRow.success) {
      for (const issue of parsedRow.error.issues) {
        rowIssue(index, "invalid_row_data", ["data", ...issue.path.map((part) => typeof part === "number" ? part : String(part))], "Row data must be an object of string, finite number, boolean, or null values.");
      }
    }
    if (!isRecord(row.data)) {
      summary.incomplete_key_rows++;
    } else {
      const data = row.data;
      const invalidCells = new Set<string>();
      for (const column of schema.columns) {
        if (!Object.hasOwn(data, column.name)) {
          summary.missing_cells++;
          invalidCells.add(column.name);
          rowIssue(index, "missing_cell", ["data", column.name], "Declared column is missing; use explicit null when nullable.");
        } else if (data[column.name] === null) {
          if (!column.nullable) {
            summary.null_violations++;
            invalidCells.add(column.name);
            rowIssue(index, "null_not_allowed", ["data", column.name], "Column is not nullable.");
          }
        } else if (!matchesType(data[column.name], column.type)) {
          summary.type_violations++;
          invalidCells.add(column.name);
          rowIssue(index, "type_mismatch", ["data", column.name], `Expected ${column.type}.`);
        }
      }
      for (const name of Object.keys(data).filter((name) => !columns.has(name)).sort()) {
        summary.unknown_cells++;
        rowIssue(index, "unknown_column", ["data", name], "Column is not declared in the schema.");
      }
      const keyComplete = keyColumns.every((name) => {
        const value = data[name];
        return Object.hasOwn(data, name) && !invalidCells.has(name) && value !== null
          && !(typeof value === "string" && value.trim() === "");
      });
      if (!keyComplete) {
        summary.incomplete_key_rows++;
        rowIssue(index, "incomplete_primary_key", ["data"], "Every primary-key component must be present, non-null, non-blank, and type-valid.");
      } else {
        const identity = JSON.stringify(keyColumns.map((name) => data[name]));
        const group = identities.get(identity) ?? [];
        group.push(index);
        identities.set(identity, group);
      }
    }

    let hasEvidence = false;
    if (row.sources !== undefined) {
      if (!Array.isArray(row.sources)) {
        rowIssue(index, "invalid_sources", ["sources"], "Sources must be an array of absolute HTTP(S) URL strings.");
      } else {
        for (const [sourceIndex, source] of row.sources.entries()) {
          if (isHttpUrl(source)) hasEvidence = true;
          else rowIssue(index, "invalid_source_url", ["sources", sourceIndex], "Expected an absolute HTTP(S) URL without whitespace.");
        }
      }
    }
    if (hasEvidence) summary.evidence_rows++;
    else rowIssue(index, "missing_source_evidence", ["sources"], "Row has no syntactically valid HTTP(S) source URL.");
  }

  for (const group of identities.values()) {
    if (group.length < 2) continue;
    summary.duplicate_identity_groups++;
    summary.duplicate_rows += group.length;
    group.forEach((index) => invalidRows.add(index));
    issues.push({ code: "duplicate_identity", path: ["rows"], message: "Rows share a complete primary key.", row_indexes: group });
  }
  summary.valid_rows = summary.rows - invalidRows.size;
  summary.evidence_coverage = summary.rows === 0 ? null : summary.evidence_rows / summary.rows;
  return { version: 1, passed: issues.length === 0, schema_valid: true, summary, issues };
}
