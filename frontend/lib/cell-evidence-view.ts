import { cellValueKey } from "../convex/lib/cell-evidence";
import type { CapturedEvidence, DatasetColumn, DatasetRow } from "../components/table/types";

export interface SelectedCell {
  rowId: string;
  columnName: string;
}

export interface CellDetailView {
  rowId: string;
  column: DatasetColumn;
  value: unknown;
  evidence: CapturedEvidence[];
  rowLinks: string[];
  latestRefresh: { completedAt: number; observed: boolean } | null;
}

/** Resolve identity against live query results; never retain a value/evidence snapshot. */
export function getCellDetailView(
  selected: SelectedCell | null,
  columns: readonly DatasetColumn[] | undefined,
  rows: readonly DatasetRow[] | undefined,
): CellDetailView | null {
  if (!selected || !columns || !rows) return null;
  const column = columns.find((candidate) => candidate.name === selected.columnName);
  const row = rows.find((candidate) => candidate._id === selected.rowId);
  if (!column || !row) return null;

  const hasValue = Object.hasOwn(row.data, column.name);
  const value = hasValue ? row.data[column.name] : undefined;
  const valueKey = hasValue ? cellValueKey(value) : null;
  const stored = row.cellEvidence && Object.hasOwn(row.cellEvidence, column.name)
    ? row.cellEvidence[column.name]
    : undefined;
  const evidence = valueKey !== null && stored?.valueKey === valueKey ? stored.sources : [];
  const refresh = row.lastEvidenceRefresh;

  return {
    rowId: row._id,
    column,
    value,
    evidence,
    rowLinks: row.sources ?? [],
    latestRefresh: refresh ? {
      completedAt: refresh.completedAt,
      observed: refresh.observedColumns.includes(column.name)
        && evidence.some((source) => source.runId === refresh.runId),
    } : null,
  };
}
