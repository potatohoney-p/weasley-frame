import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { EvidenceCaptureRegistry } from "../src/pipeline/evidence-capture.js";
import { buildEvidenceWebTools } from "../src/mastra/tools/web-tools.js";
import { buildPopulateTools, type PopulateToolOptions } from "../src/mastra/tools/dataset-tools.js";
import { finishRefreshObservation } from "../src/pipeline/refresh-outcome.js";
import { getCellDetailView } from "../../frontend/lib/cell-evidence-view.js";
import { fixture, invoke } from "./fixtures/cell-evidence-store.js";

const auth = {
  authorizedUserId: "synthetic-user", workflowRunId: "synthetic-run",
  modelConfig: { schemaInference: "unused", populateOrchestrator: "unused", investigateSubagent: "unused" },
};
const columns = [{ name: "Name", type: "text" as const }, { name: "Seats", type: "number" as const }];

function client(state: ReturnType<typeof fixture>) {
  const run = (reference: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
    const name = getFunctionName(reference).split(":")[1];
    assert.ok(["get", "update", "insert", "remove"].includes(name));
    return invoke(name as "get" | "update" | "insert" | "remove", state, args);
  };
  return { query: run, mutation: run } as NonNullable<PopulateToolOptions["dependencies"]>["convex"];
}

test("captured tools, real row mutations, serialized reload and current-cell views agree", async () => {
  const state = fixture({ Name: "Hall", Seats: 0, Obsolete: true });
  let next = 0;
  const registry = new EvidenceCaptureRegistry(auth.workflowRunId, { now: () => 1700000000000, id: () => `capture-${++next}` });
  const web = buildEvidenceWebTools(registry, {
    credentials: async () => ({ apiKey: "fixture", headers: {} }),
    fetch: async (_url, options) => {
      const requested = JSON.parse(String(options?.body)).urls[0];
      return new Response(JSON.stringify({ results: [{ text: requested.endsWith("name") ? "Name: Hall" : "Seats: 30" }] }));
    },
  });
  const nameCapture = await web.fetch_page.execute!({ url: "https://example.test/name" }, {});
  const seatCapture = await web.fetch_page.execute!({ url: "https://example.test/seats" }, {});
  const tools = buildPopulateTools("dataset", auth, {
    evidenceRegistry: registry, dependencies: { convex: client(state), capture: () => {} },
  });
  const data = { Name: "Hall", Seats: 30 };
  const first = await tools.update_row.execute!({
    rowId: "row", data: { '"Name"': "Hall", Seats: 30 },
    cell_evidence: {
      "`Name`": [{ captureId: nameCapture.captureId!, excerpt: "Name: Hall" }],
      Seats: [{ captureId: seatCapture.captureId!, excerpt: "Seats: 30" }],
    },
  }, {});
  assert.equal(first.success, true);
  assert.equal(first.dataChanged, true);
  assert.equal(first.evidenceChanged, true);
  // Reload only serialized durable state; capture registry is not consulted.
  state.documents.set("row", JSON.parse(JSON.stringify(state.row())));
  const view = (columnName: string) => getCellDetailView({ rowId: "row", columnName }, columns, [state.row()] as any);
  assert.equal(view("Name")?.evidence[0].url, "https://example.test/name");
  assert.equal(view("Seats")?.evidence[0].url, "https://example.test/seats");
  assert.deepEqual(state.row().data, data);
  const unchanged = await tools.update_row.execute!({ rowId: "row", data }, {});
  assert.equal(unchanged.dataChanged, false);
  assert.equal(unchanged.evidenceChanged, false);
  await tools.update_row.execute!({ rowId: "row", data: { Name: "Hall", Seats: "30" } }, {});
  assert.equal(view("Seats")?.evidence.length, 0, "number-to-string change invalidates the binding");
  assert.equal(view("Name")?.evidence.length, 1, "unmodified cell keeps its own source");
  await tools.update_row.execute!({ rowId: "row", data: { Seats: "30" } }, {});
  assert.equal(view("Name")?.evidence.length, 0, "omitted column loses evidence");
  await invoke("remove", state, { id: "row", expectedDatasetId: "dataset" });
  assert.equal(getCellDetailView({ rowId: "row", columnName: "Seats" }, columns, []), null);
  assert.equal((await tools.update_row.execute!({ rowId: "row", data }, {})).success, false);
});

test("unavailable refresh source records no observation without deleting earlier captured support", async () => {
  const state = fixture({ Name: "Hall" });
  const old = new EvidenceCaptureRegistry("prior-run", { now: () => 1700000000000, id: () => "old-capture" });
  const capture = old.capture({ kind: "page", url: "https://example.test/name", text: "Name: Hall" });
  await invoke("update", state, {
    id: "row", expectedDatasetId: "dataset", data: { Name: "Hall" },
    cellEvidence: { Name: [old.resolve(capture.captureId, "Name: Hall")] },
  });
  const before = structuredClone(state.row().cellEvidence);
  const web = buildEvidenceWebTools(new EvidenceCaptureRegistry("new-run"), {
    credentials: async () => ({ apiKey: "fixture", headers: {} }),
    fetch: async () => new Response(JSON.stringify({ errors: [{ error: "page_not_found" }] })),
  });
  const failedSource = await web.fetch_page.execute!({ url: "https://example.test/name" }, {});
  assert.match(failedSource.error ?? "", /404/);
  assert.equal(failedSource.captureId, undefined);
  await finishRefreshObservation({}, "row", undefined, () => invoke("completeEvidenceRefresh", state, {
    id: "row", expectedDatasetId: "dataset", expectedRevision: state.row().revision, runId: "new-run",
  }));
  assert.deepEqual(state.row().cellEvidence, before);
  const view = getCellDetailView({ rowId: "row", columnName: "Name" }, columns, [state.row()] as any);
  assert.equal(view?.latestRefresh?.observed, false);
  assert.equal(view?.evidence[0].capturedAt, 1700000000000);
});
