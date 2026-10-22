import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getFunctionName } from "convex/server";
import { buildPopulateTools, type PopulateToolOptions } from "../src/mastra/tools/dataset-tools.js";
import { finishRefreshObservation } from "../src/pipeline/refresh-outcome.js";
import { cellValueKey } from "../../frontend/convex/lib/cell-evidence.js";
import { fixture, invoke, type RecordDoc } from "./fixtures/cell-evidence-store.js";

const previousLocalMode = process.env.WEASLEY_FRAME_LOCAL_MODE;
before(() => { delete process.env.WEASLEY_FRAME_LOCAL_MODE; });
after(() => {
  if (previousLocalMode === undefined) delete process.env.WEASLEY_FRAME_LOCAL_MODE;
  else process.env.WEASLEY_FRAME_LOCAL_MODE = previousLocalMode;
});

// Reuse the synthetic store to execute real handlers; no transaction retries,
// deployed validators, credentials or providers are simulated here.
function stateWithPeer(original: RecordDoc = { Name: "Alpha", Seats: 10 }, peer: RecordDoc = { Name: "Beta", Seats: 20 }, keys = ["Name"]) {
  const state = fixture(original, "synthetic-owner");
  const dataset = state.documents.get("dataset")!;
  dataset.columns = keys.map((name) => ({ name, isPrimaryKey: true }));
  dataset.rowCount = 2;
  state.documents.set("datasetRows:peer", { _id: "datasetRows:peer", datasetId: "dataset", data: peer, revision: 0 });
  return state;
}

function updateArgs(data: RecordDoc, extra: RecordDoc = {}) {
  return { id: "row", expectedDatasetId: "dataset", data, expectedRevision: 0, operationId: "update-1", ...extra };
}

const captured = {
  captureId: "capture-1", kind: "page" as const, url: "https://example.test/alpha",
  excerpt: "Alpha has ten seats", capturedAt: 1700000000000,
  contentSha256: "a".repeat(64), runId: "prior-run",
};

test("a refresh cannot replace a row with another entity's primary key or publish its evidence", async () => {
  const state = stateWithPeer();
  state.row().updateStatus = "pending";
  state.row().cellEvidence = { Name: { valueKey: cellValueKey("Alpha"), sources: [captured] } };
  state.row().lastEvidenceRefresh = { runId: "prior-run", completedAt: 1700000000001, observedColumns: ["Name"] };
  const before = structuredClone(state.documents);
  await assert.rejects(invoke("update", state, updateArgs({ Name: "bETA", Seats: 30 }, {
    cellEvidence: { Name: [{ ...captured, runId: "new-run", excerpt: "Beta has thirty seats" }] },
    sources: ["https://example.test/beta"], rowSummary: "Wrong entity",
  })), /Duplicate/i);
  assert.deepEqual(state.documents, before, "row, evidence, revision, history and quota stay unchanged");
  assert.deepEqual(state.writes, []);
});

test("insert and update enforce the same existing identity comparison policy", async () => {
  const cases = [
    { existing: "Beta", incoming: "bETA", duplicate: true },
    { existing: 0, incoming: "0", duplicate: true },
    { existing: false, incoming: "false", duplicate: true },
    { existing: null, incoming: null, duplicate: true },
    { existing: " Beta", incoming: "Beta", duplicate: false },
    { existing: "", incoming: "", duplicate: false },
    { existing: undefined, incoming: undefined, duplicate: false },
  ];
  for (const { existing, incoming, duplicate } of cases) {
    for (const mutation of ["insert", "update"] as const) {
      const state = stateWithPeer({ Name: "Alpha" }, existing === undefined ? {} : { Name: existing });
      const data = incoming === undefined ? { Seats: 30 } : { Name: incoming };
      const args = mutation === "insert" ? { datasetId: "dataset", data } : updateArgs(data);
      if (duplicate) {
        await assert.rejects(invoke(mutation, state, args), /Duplicate/i, `${mutation}: ${JSON.stringify(existing)}`);
        assert.deepEqual(state.writes, []);
      } else await invoke(mutation, state, args);
    }
  }
});

test("composite keys collide only when every component matches", async () => {
  const state = stateWithPeer({ Name: "Alpha", Region: "East" }, { Name: "Beta", Region: "West" }, ["Name", "Region"]);
  await assert.rejects(invoke("update", state, updateArgs({ Name: "bETA", Region: "WEST" })), /Duplicate/i);
  assert.deepEqual(state.writes, []);
  const result = await invoke("update", state, updateArgs({ Name: "Beta", Region: "East" }));
  assert.equal(result.dataChanged, true);
  assert.deepEqual(state.row().data, { Name: "Beta", Region: "East" });
});

test("incomplete composite identities retain the existing insert behavior", async () => {
  for (const data of [{ Name: "Beta" }, { Name: "Beta", Region: "" }]) {
    const state = stateWithPeer({ Name: "Alpha", Region: "East" }, { Name: "Beta", Region: "West" }, ["Name", "Region"]);
    assert.equal((await invoke("update", state, updateArgs(data))).dataChanged, true);
  }
});

test("unchanged identity excludes the current row and permits evidence-only refresh", async () => {
  const state = stateWithPeer();
  const result = await invoke("update", state, updateArgs({ Name: "Alpha", Seats: 10 }, { cellEvidence: { Name: [captured] } }));
  assert.deepEqual(result, { dataChanged: false, evidenceChanged: true, revision: 1 });
  assert.equal(state.writes.some((write) => write.table === "datasetHistory"), false);
});

test("identity checks are scoped to the dataset and absent primary keys impose no uniqueness", async () => {
  const otherDataset = stateWithPeer();
  otherDataset.documents.get("datasetRows:peer")!.datasetId = "elsewhere";
  assert.equal((await invoke("update", otherDataset, updateArgs({ Name: "Beta" }))).dataChanged, true);
  const noKeys = stateWithPeer(undefined, undefined, []);
  assert.equal((await invoke("update", noKeys, updateArgs({ Name: "Beta" }))).dataChanged, true);
});

test("two serialized updates to one new identity accept only the first", async () => {
  const state = stateWithPeer();
  await invoke("update", state, updateArgs({ Name: "Gamma", Seats: 11 }));
  const committed = structuredClone(state.documents);
  const writes = structuredClone(state.writes);
  await assert.rejects(invoke("update", state, updateArgs({ Name: "gAMMA", Seats: 22 }, {
    id: "datasetRows:peer", operationId: "update-2",
  })), /Duplicate/i);
  assert.deepEqual(state.documents, committed);
  assert.deepEqual(state.writes, writes);
});

test("legacy duplicate rows can be repaired to a unique identity without deleting peers", async () => {
  const state = stateWithPeer({ Name: "Beta", Seats: 10 });
  await assert.rejects(invoke("update", state, updateArgs({ Name: "Beta", Seats: 11 })), /Duplicate/i);
  assert.deepEqual(state.writes, []);
  await invoke("update", state, updateArgs({ Name: "Gamma", Seats: 11 }));
  assert.equal(state.row().data.Name, "Gamma");
  assert.equal(state.documents.get("datasetRows:peer")!.data.Name, "Beta");
  assert.equal(state.documents.get("dataset")!.rowCount, 2);
});

test("revision and replay checks retain precedence over identity validation", async () => {
  const state = stateWithPeer();
  const args = updateArgs({ Name: "Gamma", Seats: 11 });
  const first = await invoke("update", state, args);
  // An older client could introduce a collision after this committed operation.
  // A replay acknowledges the earlier result; it must never write or charge again.
  state.documents.get("datasetRows:peer")!.data.Name = "Gamma";
  const writes = structuredClone(state.writes);
  assert.deepEqual(await invoke("update", state, args), first);
  await assert.rejects(invoke("update", state, { ...args, data: { Name: "Beta" } }), /operation.*conflict/i);
  await assert.rejects(invoke("update", state, updateArgs({ Name: "Gamma" }, { operationId: "other" })), /Stale row revision/);
  assert.deepEqual(state.writes, writes);
});

function toolsFor(state: ReturnType<typeof fixture>, loseFirstResponse = false) {
  let lost = false;
  const dispatch = async (reference: Parameters<typeof getFunctionName>[0], args: RecordDoc) => {
    const name = getFunctionName(reference).split(":")[1];
    assert.ok(name === "get" || name === "update");
    const result = await invoke(name as "get" | "update", state, args);
    if (name === "update" && loseFirstResponse && !lost) { lost = true; throw new Error("Synthetic lost response"); }
    return result;
  };
  return buildPopulateTools("dataset", {
    authorizedUserId: "synthetic-owner", workflowRunId: "refresh-run",
    modelConfig: { schemaInference: "unused", populateOrchestrator: "unused", investigateSubagent: "unused" },
  }, {
    refreshRow: { id: "row", revision: 0 },
    dependencies: { convex: { query: dispatch, mutation: dispatch } as NonNullable<PopulateToolOptions["dependencies"]>["convex"], capture: () => {} },
  });
}

async function updateViaTool(tools: ReturnType<typeof toolsFor>, input: { rowId: string; data: RecordDoc }) {
  const result = await tools.update_row.execute!(input, {
    observe: { async span(_name, fn) { return fn(); }, log() {} },
  });
  assert.ok(result && "success" in result, "the tool must return a write result");
  return result;
}

test("actual update tool reports identity rejection as a failed refresh without marking observation", async () => {
  const state = stateWithPeer();
  const tools = toolsFor(state);
  const result = await updateViaTool(tools, { rowId: "row", data: { Name: "Beta", Seats: 30 } });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Duplicate/i);
  let observations = 0;
  const outcome = await finishRefreshObservation({ toolResults: [{ payload: {
    toolName: "update_row", args: { rowId: "row" }, result,
  } }] }, "row", undefined, async () => { observations++; });
  assert.deepEqual(outcome, { updated: false, failed: true });
  assert.equal(observations, 0);
  assert.deepEqual(state.writes, []);
});

test("a legitimate identity change still recovers a lost response without duplicate history or quota", async () => {
  const state = stateWithPeer();
  const tools = toolsFor(state, true);
  const args = { rowId: "row", data: { Name: "Gamma", Seats: 11 } };
  assert.equal((await updateViaTool(tools, args)).success, false);
  const committed = structuredClone(state.documents);
  const writes = structuredClone(state.writes);
  const retry = await updateViaTool(tools, args);
  assert.equal(retry.success, true);
  assert.equal(retry.dataChanged, true);
  assert.deepEqual(state.documents, committed);
  assert.deepEqual(state.writes, writes);
});
