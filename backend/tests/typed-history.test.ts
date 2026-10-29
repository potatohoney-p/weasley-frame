import assert from "node:assert/strict";
import test from "node:test";
import { cellValueKey, MAX_VALUE_KEY_LENGTH } from "../../frontend/convex/lib/cell-evidence.js";
import { fixture, invoke } from "./fixtures/cell-evidence-store.js";

const changes: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["number to string", { value: 0 }, { value: "0" }],
  ["boolean to string", { value: false }, { value: "false" }],
  ["null to empty string", { value: null }, { value: "" }],
  ["missing to null", {}, { value: null }],
  ["null to missing", { value: null }, {}],
  ["missing to empty string", {}, { value: "" }],
  ["empty string to missing", { value: "" }, {}],
  ["structured values", { value: { a: 1 } }, { value: { a: 2 } }],
  ["array order", { value: [1, 2] }, { value: [2, 1] }],
];
for (const [name, oldData, newData] of changes) {
  test(`history preserves typed and presence evidence: ${name}`, async () => {
    const state = fixture(oldData);
    await invoke("update", state, { id: "row", expectedDatasetId: "dataset", data: newData });
    const history = state.writes.filter(w => w.table === "datasetHistory");
    assert.equal(history.length, 1);
    const entry = history[0].value!;
    for (const [side, data] of [["old", oldData], ["new", newData]] as const) {
      assert.deepEqual(entry[`${side}Cell`], {
        present: Object.hasOwn(data, "value"),
        valueKey: cellValueKey(data.value),
      });
      assert.equal(entry[`${side}Value`], String(data.value ?? ""), "legacy display field stays compatible");
    }
    assert.notDeepEqual(entry.oldCell, entry.newCell);
  });
}

test("unrepresentable legacy values record unknown rather than a false typed value", async () => {
  const oldData = { value: "x".repeat(MAX_VALUE_KEY_LENGTH + 1) };
  const state = fixture(oldData);
  await invoke("update", state, { id: "row", expectedDatasetId: "dataset", data: { value: "short" } });
  const history = state.writes.find(w => w.table === "datasetHistory")!.value!;
  assert.deepEqual(history.oldCell, { present: true, valueKey: null });
  assert.deepEqual(history.newCell, { present: true, valueKey: cellValueKey("short") });
});

test("unchanged typed data creates no change history", async () => {
  const state = fixture({ value: { a: 1, b: false } });
  await invoke("update", state, { id: "row", expectedDatasetId: "dataset", data: { value: { b: false, a: 1 } } });
  assert.equal(state.writes.filter(w => w.table === "datasetHistory").length, 0);
});

test("idempotent replay does not duplicate typed history", async () => {
  const state = fixture({ value: 0 });
  const args = { id: "row", expectedDatasetId: "dataset", data: { value: "0" }, expectedRevision: 0, operationId: "history-retry" };
  const first = await invoke("update", state, args);
  assert.deepEqual(await invoke("update", state, args), first);
  assert.equal(state.writes.filter(w => w.table === "datasetHistory").length, 1);
});

test("rejected stale update creates no typed history", async () => {
  const state = fixture({ value: 0 });
  state.row().revision = 2;
  await assert.rejects(invoke("update", state, { id: "row", expectedDatasetId: "dataset", data: { value: "0" }, expectedRevision: 1 }), /Stale/);
  assert.deepEqual(state.writes, []);
});
