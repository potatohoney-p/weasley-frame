import assert from "node:assert/strict";
import test from "node:test";
import * as mutations from "../../frontend/convex/datasetRows.js";
import {
  cellValueKey, reconcileCellEvidence, type CapturedEvidence,
} from "../../frontend/convex/lib/cell-evidence.js";

import { fixture, invoke, type RecordDoc } from "./fixtures/cell-evidence-store.js";

function source(runId = "run-1", extra: Partial<CapturedEvidence> = {}): CapturedEvidence {
  return {
    captureId: "capture-1", kind: "page", url: "https://example.test/source",
    excerpt: "Alpha was observed.", capturedAt: 1700000000000,
    contentSha256: "a".repeat(64), runId, ...extra,
  };
}

function bound(value: unknown, runId = "run-1") {
  return { valueKey: cellValueKey(value)!, sources: [source(runId)] };
}

function updateArgs(data: Record<string, unknown>, extra: RecordDoc = {}) {
  return { id: "row", expectedDatasetId: "dataset", data, ...extra };
}

test("canonical cell bindings distinguish types, absence and object key order", () => {
  const values = [undefined, null, 0, false, "0", -0, "", [], {}];
  assert.equal(new Set(values.map(cellValueKey)).size, values.length);
  assert.equal(cellValueKey({ b: [false, null], a: 0 }), cellValueKey({ a: 0, b: [false, null] }));
  assert.notEqual(cellValueKey([1, 2]), cellValueKey([2, 1]));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [cycle, NaN, Infinity, 1n, new Date(), new Array(1), "x".repeat(20000)]) {
    assert.equal(cellValueKey(value), null);
  }
});

test("real update removes changed and omitted bindings while preserving unchanged typed values", async () => {
  const state = fixture({ name: "Alpha", value: 0, removed: true, object: { b: 2, a: 1 } });
  state.row().cellEvidence = {
    name: bound("Alpha"), value: bound(0), removed: bound(true), object: bound({ a: 1, b: 2 }),
  };
  const result = await invoke("update", state, updateArgs({
    name: "Alpha", value: "0", object: { a: 1, b: 2 },
  }));
  assert.deepEqual(Object.keys(state.row().cellEvidence), ["name", "object"]);
  assert.deepEqual(result, { dataChanged: true, evidenceChanged: true, revision: 1 });
  const history = state.writes.filter((write) => write.table === "datasetHistory");
  assert.deepEqual(history.map((write) => write.value!.columnName).sort(), ["removed", "value"]);
});

test("real update binds fresh evidence to the stored value and reports evidence-only writes", async () => {
  const state = fixture({ value: null });
  const result = await invoke("update", state, updateArgs({ value: null }, {
    expectedRevision: 0, cellEvidence: { value: [source()] },
  }));
  assert.deepEqual(state.row().cellEvidence.value, bound(null));
  assert.deepEqual(result, { dataChanged: false, evidenceChanged: true, revision: 1 });
  assert.equal(state.writes.some((write) => write.table === "datasetHistory"), false);
});

test("empty submitted sources clear a binding and omitted evidence keeps a matching binding", async () => {
  const state = fixture();
  state.row().cellEvidence = { name: bound("Alpha") };
  const preserved = await invoke("update", state, updateArgs({ name: "Alpha" }));
  assert.equal(preserved.evidenceChanged, false);
  const cleared = await invoke("update", state, updateArgs({ name: "Alpha" }, { cellEvidence: { name: [] } }));
  assert.equal(cleared.evidenceChanged, true);
  assert.equal(state.row().cellEvidence, undefined);
});

test("unsupported legacy data remains writable but cannot retain or receive a captured binding", async () => {
  const state = fixture({ value: NaN });
  state.row().cellEvidence = { value: bound(0) };
  await invoke("update", state, updateArgs({ value: NaN }));
  assert.ok(Number.isNaN(state.row().data.value));
  assert.equal(state.row().cellEvidence, undefined);
  state.writes.length = 0;
  await assert.rejects(invoke("update", state, updateArgs({ value: NaN }, {
    cellEvidence: { value: [source()] },
  })), /unsupported/);
  assert.deepEqual(state.writes, []);
});

test("unchanged large or special scalar values do not fabricate changed-row counts", async () => {
  const state = fixture({ value: "x".repeat(20000), special: NaN });
  const result = await invoke("update", state, updateArgs({
    value: "x".repeat(20000), special: NaN,
  }));
  assert.equal(result.dataChanged, false);
  assert.equal(state.writes.some((write) => write.table === "datasetHistory"), false);
});

test("captured evidence validates actual columns and bounded source fields before any write", async (t) => {
  const invalid = [
    { absent: [source()] },
    { name: Array.from({ length: 5 }, () => source()) },
    { name: [source("run", { excerpt: "x".repeat(1025) })] },
    { name: [source("run", { url: "https://example.test/" + "x".repeat(2048) })] },
    { name: [source("run", { url: "javascript:alert(1)" })] },
    { name: [source("run", { capturedAt: Infinity })] },
    { name: [source("run", { contentSha256: "wrong" })] },
    { name: [source("run", { captureId: "" })] },
  ];
  for (const [index, cellEvidence] of invalid.entries()) {
    await t.test(String(index), async () => {
      const state = fixture();
      await assert.rejects(invoke("update", state, updateArgs({ name: "Alpha" }, { cellEvidence })));
      assert.deepEqual(state.writes, []);
    });
  }
});

test("aggregate evidence and column limits include preserved bindings", () => {
  const data = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`c${index}`, index]));
  const evidence = Object.fromEntries(Object.keys(data).map((column) => [column, [source()]]));
  assert.throws(() => reconcileCellEvidence(data, undefined, evidence), /64 columns/);
  const huge = Object.fromEntries(Object.keys(data).slice(0, 20).map((column) => [
    column, Array.from({ length: 4 }, () => source("run", { excerpt: "x".repeat(1024) })),
  ]));
  assert.throws(() => reconcileCellEvidence(data, undefined, huge), /65536 UTF-16 code units/);
});

test("same update operation replays before quota/history but conflicting payload is rejected", async () => {
  const state = fixture({ name: "Alpha" }, "user-one");
  const args = updateArgs({ name: "Beta" }, {
    expectedRevision: 0, operationId: "operation-1", cellEvidence: { name: [source()] },
  });
  const first = await invoke("update", state, args);
  const writes = structuredClone(state.writes);
  assert.deepEqual(await invoke("update", state, args), first);
  assert.deepEqual(state.writes, writes);
  await assert.rejects(invoke("update", state, { ...args, data: { name: "Other" } }), /operation.*conflict/i);
  assert.deepEqual(state.writes, writes);
});

test("a retry after a later write is stale and cannot restore old content or evidence", async () => {
  const state = fixture();
  const old = updateArgs({ name: "Beta" }, { expectedRevision: 0, operationId: "operation-1" });
  await invoke("update", state, old);
  await invoke("update", state, updateArgs({ name: "Gamma" }, { expectedRevision: 1 }));
  const before = structuredClone(state.writes);
  await assert.rejects(invoke("update", state, old), /Stale/);
  assert.equal(state.row().data.name, "Gamma");
  assert.deepEqual(state.writes, before);
});

test("operation-tagged updates require a revision and cannot replay after refresh completion", async () => {
  const state = fixture();
  await assert.rejects(invoke("update", state, updateArgs({ name: "Beta" }, {
    operationId: "write",
  })), /require an expected revision/);
  assert.deepEqual(state.writes, []);
  const args = updateArgs({ name: "Beta" }, { operationId: "write", expectedRevision: 0 });
  await invoke("update", state, args);
  await invoke("completeEvidenceRefresh", state, {
    id: "row", expectedDatasetId: "dataset", expectedRevision: 1, runId: "run-1",
  });
  const writes = structuredClone(state.writes);
  await assert.rejects(invoke("update", state, args), /Stale/);
  assert.deepEqual(state.writes, writes);
});

test("reordered object keys preserve binding and allow an identical operation replay", async () => {
  const state = fixture({ object: { a: 1, b: 2 } });
  const first = await invoke("update", state, updateArgs({ object: { b: 2, a: 1 } }, {
    expectedRevision: 0, operationId: "write", cellEvidence: { object: [source()] },
  }));
  assert.equal(first.dataChanged, false);
  const writes = structuredClone(state.writes);
  const replay = await invoke("update", state, updateArgs({ object: { a: 1, b: 2 } }, {
    operationId: "write", expectedRevision: 0, cellEvidence: { object: [source()] },
  }));
  assert.deepEqual(replay, first);
  assert.deepEqual(state.writes, writes);
});

test("missing or cross-dataset row rejects before any storage mutation", async (t) => {
  for (const action of ["update", "completeEvidenceRefresh"] as const) {
    for (const mode of ["deleted", "foreign"]) {
      await t.test(`${action} ${mode}`, async () => {
        const state = fixture();
        if (mode === "deleted") state.documents.delete("row");
        else state.row().datasetId = "other";
        const args = action === "update" ? updateArgs({ name: "Beta" })
          : { id: "row", expectedDatasetId: "dataset", expectedRevision: 0, runId: "run-1" };
        await assert.rejects(invoke(action, state, args), /^Error: Row not found$/);
        assert.deepEqual(state.writes, []);
      });
    }
  }
});

test("stale, invalid and exhausted revisions reject before quota or history", async (t) => {
  for (const expected of [1, -1, 0.5, NaN]) {
    await t.test(String(expected), async () => {
      const state = fixture();
      await assert.rejects(invoke("update", state, updateArgs({ name: "Beta" }, { expectedRevision: expected })), /revision/);
      assert.deepEqual(state.writes, []);
    });
  }
  const state = fixture();
  state.row().revision = Number.MAX_SAFE_INTEGER;
  await assert.rejects(invoke("update", state, updateArgs({ name: "Beta" })), /exhausted/);
  assert.deepEqual(state.writes, []);
});

test("quota rejection leaves row, evidence and history untouched before writes", async () => {
  const previousMode = process.env.WEASLEY_FRAME_LOCAL_MODE;
  delete process.env.WEASLEY_FRAME_LOCAL_MODE;
  try {
    const state = fixture({ name: "Alpha" }, "user-one");
    const now = new Date();
    state.documents.set("usage:existing", {
      _id: "usage:existing", userId: "user-one", rowsConsumed: 2500,
      periodStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    });
    state.row().cellEvidence = { name: bound("Alpha") };
    const before = structuredClone(state.row());
    await assert.rejects(invoke("update", state, updateArgs({ name: "Beta" }, {
      expectedRevision: 0, cellEvidence: { name: [source()] }, operationId: "write",
    })), /quota exceeded/);
    assert.deepEqual(state.row(), before);
    assert.deepEqual(state.writes, []);
  } finally {
    if (previousMode === undefined) delete process.env.WEASLEY_FRAME_LOCAL_MODE;
    else process.env.WEASLEY_FRAME_LOCAL_MODE = previousMode;
  }
});

test("accepted evidence-only update charges once and refresh completion does not charge", async () => {
  const previousMode = process.env.WEASLEY_FRAME_LOCAL_MODE;
  delete process.env.WEASLEY_FRAME_LOCAL_MODE;
  try {
    const state = fixture({ name: "Alpha" }, "user-one");
    const args = updateArgs({ name: "Alpha" }, {
      expectedRevision: 0, operationId: "write", cellEvidence: { name: [source()] },
    });
    await invoke("update", state, args);
    await invoke("update", state, args);
    const usage = [...state.documents.values()].find((row) => row.userId === "user-one")!;
    assert.equal(usage.rowsConsumed, 1);
    await invoke("completeEvidenceRefresh", state, {
      id: "row", expectedDatasetId: "dataset", expectedRevision: 1, runId: "run-1",
    });
    assert.equal(usage.rowsConsumed, 1);
  } finally {
    if (previousMode === undefined) delete process.env.WEASLEY_FRAME_LOCAL_MODE;
    else process.env.WEASLEY_FRAME_LOCAL_MODE = previousMode;
  }
});

test("completed refresh records only matching current captures from its run without changing capture times", async () => {
  const state = fixture({ name: "Alpha", old: false, stale: 3 });
  state.row().cellEvidence = {
    name: bound("Alpha", "new-run"), old: bound(false, "old-run"), stale: bound(2, "new-run"),
  };
  const beforeData = structuredClone(state.row().data);
  const result = await invoke("completeEvidenceRefresh", state, {
    id: "row", expectedDatasetId: "dataset", expectedRevision: 0, runId: "new-run",
  });
  assert.deepEqual(result, { revision: 1 });
  assert.deepEqual(state.row().data, beforeData);
  assert.deepEqual(state.row().lastEvidenceRefresh.observedColumns, ["name"]);
  assert.equal(state.row().cellEvidence.name.sources[0].capturedAt, 1700000000000);
  assert.equal(state.row().cellEvidence.old.sources[0].capturedAt, 1700000000000);
  assert.equal(state.writes.some((write) => write.table === "datasetHistory"), false);
  const writes = structuredClone(state.writes);
  await assert.rejects(invoke("completeEvidenceRefresh", state, {
    id: "row", expectedDatasetId: "dataset", expectedRevision: 0, runId: "new-run",
  }), /Stale/);
  assert.deepEqual(state.writes, writes);
});

test("legacy completed refresh records no observations and does not invent evidence", async () => {
  const state = fixture();
  await invoke("completeEvidenceRefresh", state, {
    id: "row", expectedDatasetId: "dataset", expectedRevision: 0, runId: "run-1",
  });
  assert.deepEqual(state.row().lastEvidenceRefresh.observedColumns, []);
  assert.equal(state.row().cellEvidence, undefined);
});

test("insert creates bound evidence and same creation operation replays even at the row limit", async () => {
  const state = fixture();
  state.documents.get("dataset")!.maxRowCount = 2;
  const args = {
    datasetId: "dataset", data: { name: "Beta" }, cellEvidence: { name: [source()] },
    operationId: "insert-1",
  };
  const id = await invoke("insert", state, args);
  assert.deepEqual(state.documents.get(id)!.cellEvidence.name, bound("Beta"));
  assert.equal(state.documents.get(id)!.revision, 1);
  const writes = structuredClone(state.writes);
  assert.equal(await invoke("insert", state, args), id);
  assert.deepEqual(state.writes, writes);
  await assert.rejects(invoke("insert", state, { ...args, data: { name: "Other" } }), /operation.*conflict/i);
  assert.deepEqual(state.writes, writes);
});

test("insert validates evidence and operations before quota and keeps legacy inserts supported", async () => {
  const state = fixture();
  for (const extra of [
    { cellEvidence: { missing: [source()] } },
    { operationId: "" },
    { operationId: "insert", data: { name: "x".repeat(140000) } },
  ]) {
    await assert.rejects(invoke("insert", state, { datasetId: "dataset", data: { name: "Beta" }, ...extra }));
    assert.deepEqual(state.writes, []);
  }
  const id = await invoke("insert", state, { datasetId: "dataset", data: { name: "Beta" } });
  assert.equal(state.documents.get(id)!.cellEvidence, undefined);
  assert.equal(state.documents.get(id)!.revision, 1);
});

test("source kinds, source order and Unicode excerpts survive storage serialization", async () => {
  const state = fixture();
  const sources = [source("run-1", { kind: "search_snippet", excerpt: "안녕하세요 🌱" }), source()];
  await invoke("update", state, updateArgs({ name: "Alpha" }, { cellEvidence: { name: sources } }));
  assert.deepEqual(JSON.parse(JSON.stringify(state.row().cellEvidence.name)), {
    valueKey: cellValueKey("Alpha"), sources,
  });
});

test("pending-status mutations preserve evidence, revision and completed refresh marker", async () => {
  const state = fixture();
  state.row().cellEvidence = { name: bound("Alpha") };
  state.row().revision = 5;
  state.row().lastEvidenceRefresh = { runId: "run-1", completedAt: 1700000000010, observedColumns: ["name"] };
  const before = structuredClone(state.row());
  await invoke("markForUpdate", state, { datasetId: "dataset" });
  await invoke("clearUpdateStatus", state, { id: "row", expectedDatasetId: "dataset" });
  await invoke("markForUpdate", state, { datasetId: "dataset" });
  await invoke("clearAllPendingUpdateStatus", state, { datasetId: "dataset" });
  assert.deepEqual(state.row(), before);
});

test("row removal and dataset clearing remove inline evidence and reject later updates", async (t) => {
  for (const action of ["remove", "clearByDataset"] as const) {
    await t.test(action, async () => {
      const state = fixture();
      state.row().cellEvidence = { name: bound("Alpha") };
      await invoke(action, state, action === "remove"
        ? { id: "row", expectedDatasetId: "dataset" } : { datasetId: "dataset" });
      assert.equal(state.row(), undefined);
      const writes = structuredClone(state.writes);
      await assert.rejects(invoke("update", state, updateArgs({ name: "Beta" })), /Row not found/);
      assert.deepEqual(state.writes, writes);
    });
  }
});

test("evidence mutations retain internal registration", () => {
  for (const name of ["insert", "update", "completeEvidenceRefresh"] as const) {
    assert.equal((mutations[name] as unknown as { isInternal: boolean }).isInternal, true);
  }
});
