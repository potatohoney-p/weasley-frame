import type { RefreshCadence } from "@/lib/refresh-cadence";
import type { CellEvidence } from "@/convex/lib/cell-evidence";

export type { CapturedEvidence, CellEvidence } from "@/convex/lib/cell-evidence";

export type ColumnType = "text" | "number" | "boolean" | "url" | "date";

export interface DatasetColumn {
  name: string;
  type: ColumnType;
  description?: string;
  isPrimaryKey?: boolean;
}

export interface DatasetMeta {
  _id: string;
  name: string;
  description: string;
  status: "live" | "paused" | "building" | "updating" | "failed";
  lastStatusError?: string;
  refreshCadence: RefreshCadence;
  refreshEnabled: boolean;
  nextRefreshAt?: number;
  lastRefreshAt?: number;
  lastRefreshStartedAt?: number;
  lastRefreshRunId?: string;
  columns: DatasetColumn[];
}

export interface DatasetRow {
  _id: string;
  _creationTime: number;
  data: Record<string, unknown>;
  sources?: string[];
  updateStatus?: "pending";
  cellEvidence?: Record<string, CellEvidence>;
  revision?: number;
  lastEvidenceRefresh?: {
    runId: string;
    completedAt: number;
    observedColumns: string[];
  };
}
