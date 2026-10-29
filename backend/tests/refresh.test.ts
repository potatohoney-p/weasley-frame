import assert from "node:assert/strict";
import test from "node:test";
import { processWithConcurrency } from "../src/pipeline/concurrency.js";
import { finishRefreshObservation, refreshOutcome, refreshRunOutcome } from "../src/pipeline/refresh-outcome.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("refresh dispatch respects concurrency and waits for every active cleanup", async () => {
  const gate = deferred();
  const started = deferred();
  const seen: number[] = [];
  let active = 0;
  let peak = 0;
  const work = processWithConcurrency([1, 2, 3, 4], async (item) => {
    seen.push(item);
    peak = Math.max(peak, ++active);
    if (active === 2) started.resolve();
    await gate.promise;
    active--;
  }, 2);
  await started.promise;
  assert.deepEqual(seen, [1, 2]);
  gate.resolve();
  await work;
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("stop drains handlers that resolve normally without dispatching queued rows", async () => {
  const controller = new AbortController();
  const gate = deferred();
  const seen: number[] = [];
  let finished = 0;
  const work = processWithConcurrency([1, 2, 3, 4], async (item) => {
    seen.push(item);
    await gate.promise;
    finished++;
  }, 2, controller.signal);
  controller.abort();
  gate.resolve();
  await work;
  assert.deepEqual(seen, [1, 2]);
  assert.equal(finished, 2);
});

test("already stopped runs dispatch nothing", async () => {
  await processWithConcurrency([1], async () => assert.fail("dispatched"), 5, AbortSignal.abort());
});

test("stop during deleted-row cleanup cannot release more queued work", async () => {
  const controller = new AbortController();
  const seen: number[] = [];
  await processWithConcurrency([1, 2], async (item) => {
    seen.push(item);
    controller.abort();
    // Deleted-row cleanup may swallow an AbortError; the pool still stops.
  }, 1, controller.signal);
  assert.deepEqual(seen, [1]);
});

test("an unexpected worker rejection is surfaced after other active work drains", async () => {
  const gate = deferred();
  let finished = false;
  const work = processWithConcurrency([1, 2], async (item) => {
    if (item === 1) throw new Error("unexpected");
    await gate.promise;
    finished = true;
  }, 2);
  const rejection = assert.rejects(work, AggregateError);
  assert.equal(finished, false);
  gate.resolve();
  await rejection;
  assert.equal(finished, true);
});

test("a stopped worker can reject with a non-AbortError without restarting dispatch", async () => {
  const controller = new AbortController();
  const seen: number[] = [];
  await processWithConcurrency([1, 2], async (item) => {
    seen.push(item);
    controller.abort();
    throw new Error("provider closed the connection");
  }, 1, controller.signal);
  assert.deepEqual(seen, [1]);
});

test("empty runs and invalid concurrency are explicit", async () => {
  await processWithConcurrency([], async () => assert.fail("dispatched"), 2);
  for (const max of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(processWithConcurrency([1], async () => {}, max), RangeError);
  }
});

const call = (id: string, rowId = "row-a") => ({ payload: { toolCallId: id, toolName: "update_row", args: { rowId } } });
const result = (id: string, success: unknown, extra: object = {}) => ({
  payload: { toolCallId: id, toolName: "update_row", result: { success }, ...extra },
});

test("model prose and tool calls alone cannot claim a committed update", () => {
  assert.deepEqual(refreshOutcome({ toolCalls: [call("write")] }, "row-a"), { updated: false, failed: false });
});

test("successful result is attributed to the current row using its call id", () => {
  assert.deepEqual(refreshOutcome({ toolCalls: [call("write")], toolResults: [result("write", true)] }, "row-a"), { updated: true, failed: false });
});

test("a rejected write reports an error rather than unchanged or updated", () => {
  assert.deepEqual(refreshOutcome({ toolCalls: [call("write")], toolResults: [result("write", false)] }, "row-a"), { updated: false, failed: true });
});

test("a successful retry resolves earlier failed attempts and counts once", () => {
  assert.deepEqual(refreshOutcome({
    toolCalls: [call("first"), call("retry"), call("again")],
    toolResults: [result("first", false), result("retry", true), result("again", true)],
  }, "row-a"), { updated: true, failed: false });
});

test("a later rejected update remains an error after an earlier committed write", () => {
  assert.deepEqual(refreshOutcome({
    toolCalls: [call("first"), call("later")],
    toolResults: [result("first", true), result("later", false)],
  }, "row-a"), { updated: true, failed: true });
});

test("mixed failed and unchanged rows are partial success with visible errors", () => {
  assert.deepEqual(refreshRunOutcome(3, 1, false), { status: "success", error: "1 of 3 row(s) failed to refresh" });
});

test("all failed rows and stopped runs are errors, including a stop before dispatch", () => {
  assert.deepEqual(refreshRunOutcome(3, 3, false), { status: "error", error: "3 of 3 row(s) failed to refresh" });
  for (const total of [0, 3]) {
    assert.deepEqual(refreshRunOutcome(total, 0, true), { status: "error", error: "Refresh was stopped" });
  }
});

test("empty and successful runs do not fabricate errors", () => {
  for (const total of [0, 3]) {
    assert.deepEqual(refreshRunOutcome(total, 0, false), { status: "success", error: undefined });
  }
});

test("another row's write and other tools cannot mark the current row updated", () => {
  assert.deepEqual(refreshOutcome({
    toolCalls: [call("other", "row-b")],
    toolResults: [result("other", true), { payload: { toolName: "fetch_page", args: { rowId: "row-a" }, result: { success: true } } }],
  }, "row-a"), { updated: false, failed: false });
});

test("SDK error flags and nonboolean success values cannot imply a commit", () => {
  for (const output of [result("write", true, { isError: true }), result("write", "true")]) {
    assert.deepEqual(refreshOutcome({ toolCalls: [call("write")], toolResults: [output] }, "row-a"), { updated: false, failed: true });
  }
});

test("partial stream failures retain confirmed writes while reporting the error", () => {
  assert.deepEqual(refreshOutcome({ error: new Error("stream closed"), toolResults: [result("write", true, { args: { rowId: "row-a" } })] }, "row-a"), { updated: true, failed: true });
});

test("malformed or absent result chunks do not throw or fabricate success", () => {
  assert.deepEqual(refreshOutcome({ toolCalls: [null], toolResults: [null, {}, { payload: null }, result("missing", true)] }, "row-a"), { updated: false, failed: false });
});

test("an evidence-only observation does not count as a data update", () => {
  const evidence = result("observed", true, { result: { success: true, dataChanged: false, evidenceChanged: true } });
  assert.deepEqual(refreshOutcome({
    toolCalls: [call("observed")], toolResults: [evidence],
  }, "row-a"), { updated: false, failed: false });
  assert.deepEqual(refreshOutcome({
    toolCalls: [call("changed"), call("observed")],
    toolResults: [result("changed", true), evidence],
  }, "row-a"), { updated: true, failed: false });
});

test("completed attempts persist observation state without inventing changed data", async () => {
  let completed = 0;
  assert.deepEqual(await finishRefreshObservation({}, "row-a", undefined, async () => { completed++; }),
    { updated: false, failed: false });
  assert.equal(completed, 1);
});

test("cancellation and rejected writes do not advance observation state", async () => {
  const finish = async () => assert.fail("observation advanced");
  await finishRefreshObservation({}, "row-a", AbortSignal.abort(), finish);
  await finishRefreshObservation({ error: new Error("stream closed") }, "row-a", undefined, finish);
  await finishRefreshObservation({
    toolCalls: [call("write")], toolResults: [result("write", false)],
  }, "row-a", undefined, finish);
});

test("a stale completion rejection preserves confirmed changes and reports failure", async () => {
  assert.deepEqual(await finishRefreshObservation({
    toolCalls: [call("write")], toolResults: [result("write", true)],
  }, "row-a", undefined, async () => { throw new Error("stale revision"); }),
  { updated: true, failed: true });
});
