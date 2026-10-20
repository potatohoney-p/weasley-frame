import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getFunctionName } from "convex/server";
import { EvidenceCaptureRegistry } from "../src/pipeline/evidence-capture.js";
import { buildEvidenceWebTools } from "../src/mastra/tools/web-tools.js";
import { buildPopulateTools, type PopulateToolOptions } from "../src/mastra/tools/dataset-tools.js";
import { fixture, invoke as invokeStored } from "./fixtures/cell-evidence-store.js";

const auth = { authorizedUserId: "synthetic-user", workflowRunId: "synthetic-run" };
const registry = () => new EvidenceCaptureRegistry(auth.workflowRunId);
const credentials = async () => ({ apiKey: "synthetic-test-key", headers: { "X-Test": "fixture" } });
type Tool = { execute?: (...args: any[]) => any };
const invoke = (tool: Tool, input: unknown) => tool.execute!(input, {});
const previousLocalMode = process.env.WEASLEY_FRAME_LOCAL_MODE;
before(() => { delete process.env.WEASLEY_FRAME_LOCAL_MODE; });
after(() => {
  if (previousLocalMode === undefined) delete process.env.WEASLEY_FRAME_LOCAL_MODE;
  else process.env.WEASLEY_FRAME_LOCAL_MODE = previousLocalMode;
});

function harness(extra: PopulateToolOptions = {}, mutation?: (args: Record<string, any>) => Promise<any>) {
  const writes: Record<string, any>[] = [];
  const reads: Record<string, any>[] = [];
  const events: unknown[] = [];
  const convex = {
    async query(_reference: unknown, args: Record<string, any>) {
      reads.push(args);
      return { _id: args.id, datasetId: "dataset-a", revision: 3, data: { Seats: 30 } };
    },
    async mutation(_reference: unknown, args: Record<string, any>) {
      writes.push(args);
      return mutation ? mutation(args) : { dataChanged: false, evidenceChanged: true, revision: args.expectedRevision + 1 };
    },
  };
  const tools = buildPopulateTools("dataset-a", auth, {
    ...extra,
    dependencies: { convex: convex as any, capture: event => { events.push(event); }, ...extra.dependencies },
  });
  return { tools, writes, reads, events };
}

test("actual web tools capture observed page/snippet content before presentation truncation", async () => {
  const captures = registry();
  const requests: unknown[] = [];
  const tools = buildEvidenceWebTools(captures, {
    credentials,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(String(url).includes("api.fetch")
        ? { results: [{ title: "Fixture", text: "Seats: 30. " + "x".repeat(15000) + "hidden tail" }] }
        : { results: [{ title: "Search", url: "https://example.test/source", snippet: "Thirty seats in the hall." }] }));
    },
  });
  const page = await invoke(tools.fetch_page, { url: "https://example.test/source" });
  assert.match(page.text, /\[Truncated/);
  assert.equal(captures.resolve(page.captureId, "Seats: 30.").kind, "page");
  assert.throws(() => captures.resolve(page.captureId, "hidden tail"), /not present/);
  assert.throws(() => captures.resolve(page.captureId, "[Truncated"), /not present/);
  const search = await invoke(tools.search_web, { query: "synthetic hall" });
  assert.equal(captures.resolve(search.results[0].captureId, "Thirty seats").kind, "search_snippet");
  assert.equal(requests.length, 2);
});

test("actual update normalizes evidence/data keys together and returns only persisted change flags", async () => {
  const captures = registry();
  const capture = captures.capture({ kind: "page", url: "https://example.test", text: "Seats: 30. Available: false." });
  const h = harness({ evidenceRegistry: captures });
  const result = await invoke(h.tools.update_row, {
    rowId: "row-a", data: { '"Seats"': 30, Available: false },
    cell_evidence: { "`Seats`": [{ captureId: capture.captureId, excerpt: "Seats: 30." }] },
  });
  assert.deepEqual(result, { success: true, dataChanged: false, evidenceChanged: true, revision: 4 });
  assert.deepEqual(h.writes[0].data, { Seats: 30, Available: false });
  assert.equal(h.writes[0].cellEvidence.Seats[0].capturedAt, captures.resolve(capture.captureId, "Seats: 30.").capturedAt);
  assert.equal(h.writes[0].cellEvidence.Seats[0].runId, auth.workflowRunId);
  assert.equal(h.writes[0].cellEvidence.Seats[0].valueKey, undefined, "binding belongs to the atomic persistence layer");
  assert.equal(h.writes[0].expectedRevision, 3);
  assert.match(h.writes[0].operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.reads, [{ id: "row-a" }]);
});

test("fabricated/cross-agent excerpts and normalized column collisions fail before writes", async () => {
  const captures = registry();
  const capture = captures.capture({ kind: "page", url: "https://example.test", text: "Seats: 30." });
  const h = harness({ evidenceRegistry: captures });
  const badInputs = [
    { data: { Seats: 30, '"Seats"': 40 } },
    { data: { Seats: 30 }, cell_evidence: { Seats: [], '"Seats"': [] } },
    { data: { Seats: 30 }, cell_evidence: { Missing: [] } },
    { data: { Seats: 30 }, cell_evidence: { Seats: [{ captureId: capture.captureId, excerpt: "Seats: 60." }] } },
    { data: { Seats: 30 }, cell_evidence: { Seats: [{ captureId: "not-captured", excerpt: "Seats: 30." }] } },
  ];
  for (const input of badInputs) assert.equal((await invoke(h.tools.update_row, { rowId: "row-a", ...input })).success, false);
  assert.equal(h.writes.length, 0);
  const other = harness({ evidenceRegistry: registry() });
  assert.equal((await invoke(other.tools.update_row, {
    rowId: "row-a", data: { Seats: 30 },
    cell_evidence: { Seats: [{ captureId: capture.captureId, excerpt: "Seats: 30." }] },
  })).success, false);
  assert.equal(other.writes.length, 0);
});

test("refresh revision advances after success only, preserving quota failures and distinct operation IDs", async () => {
  const refreshRow = { id: "row-a", revision: 1 };
  let fail = true;
  const h = harness({ refreshRow }, async args => {
    if (fail) throw new Error("Quota exhausted");
    return { dataChanged: true, evidenceChanged: false, revision: args.expectedRevision + 1 };
  });
  const first = await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 30 } });
  assert.equal(first.success, false);
  assert.equal(first.dataChanged, undefined);
  assert.equal(refreshRow.revision, 1);
  fail = false;
  assert.equal((await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 31 } })).revision, 2);
  assert.equal((await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 32 } })).revision, 3);
  assert.deepEqual(h.writes.map(write => write.expectedRevision), [1, 1, 2]);
  assert.equal(new Set(h.writes.map(write => write.operationId)).size, 3);
  assert.equal(refreshRow.revision, 3);
});

test("general updates reject cross-dataset rows; refresh tools reject a different row", async () => {
  const h = harness({ dependencies: { convex: {
    query: async () => ({ datasetId: "dataset-b", revision: 7 }),
    mutation: async () => assert.fail("cross-dataset write"),
  } as any } });
  assert.equal((await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 30 } })).success, false);
  assert.equal(h.events.length, 1);
  const refresh = harness({ refreshRow: { id: "row-a", revision: 0 } });
  assert.equal((await invoke(refresh.tools.update_row, { rowId: "row-b", data: { Seats: 30 } })).success, false);
  assert.equal(refresh.reads.length, 0);
  assert.equal(refresh.writes.length, 0);
});

test("cancellation before or during row lookup causes no persistence", async () => {
  const controller = new AbortController();
  let writes = 0;
  const h = harness({ abortSignal: controller.signal, dependencies: { convex: {
    query: async () => { controller.abort(); return { datasetId: "dataset-a", revision: 0 }; },
    mutation: async () => { writes++; },
  } as any } });
  assert.equal((await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 30 } })).success, false);
  assert.equal((await invoke(h.tools.insert_row, { data: { Seats: 30 } })).success, false);
  assert.equal(writes, 0);
});

test("old callers can insert without evidence; explicit empty evidence clears a bound cell", async () => {
  const h = harness({}, async () => "row-created");
  assert.deepEqual(await invoke(h.tools.insert_row, { data: { Seats: 30 } }), { success: true, rowId: "row-created" });
  assert.equal(Object.hasOwn(h.writes[0], "cellEvidence"), false);
  const clear = harness({ evidenceRegistry: registry() });
  assert.equal((await invoke(clear.tools.update_row, {
    rowId: "row-a", data: { Seats: 30 }, cell_evidence: { Seats: [] },
  })).success, true);
  assert.deepEqual(clear.writes[0].cellEvidence, { Seats: [] });
});

test("schema bounds and forged metadata are rejected by actual tool execution", async () => {
  const captures = registry();
  const capture = captures.capture({ kind: "page", url: "https://example.test", text: "Seats: 30." });
  const h = harness({ evidenceRegistry: captures });
  for (const sources of [
    Array.from({ length: 5 }, () => ({ captureId: capture.captureId, excerpt: "Seats: 30." })),
    [{ captureId: capture.captureId, excerpt: "Seats: 30.", capturedAt: 0 }],
    [{ captureId: capture.captureId, excerpt: "x".repeat(1025) }],
  ]) {
    const result = await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 30 }, cell_evidence: { Seats: sources } });
    assert.ok(result.error);
  }
  assert.equal(h.writes.length, 0);
});

test("cancellation while a response body is pending settles without recording a capture", async () => {
  const controller = new AbortController();
  const captures = registry();
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let releaseBody!: (value: unknown) => void;
  const body = new Promise<unknown>(resolve => { releaseBody = resolve; });
  const tools = buildEvidenceWebTools(captures, {
    credentials, abortSignal: controller.signal,
    fetch: async () => ({ ok: true, json: () => { markStarted(); return body; } }) as Response,
  });
  let settled = false;
  const pending = invoke(tools.fetch_page, { url: "https://example.test/source" }).then((value: any) => {
    settled = true; return value;
  });
  await started;
  controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, true, "an uncooperative response body must not block cancellation");
    assert.equal(captures.remainingCaptures, 32);
  } finally {
    releaseBody({ results: [{ text: "body eventually arrived" }] });
    await pending;
  }
});

test("unconfirmed mutation outcomes never report success or advance refresh revision", async () => {
  for (const outcome of [undefined, {}, { dataChanged: true }, { dataChanged: true, evidenceChanged: false, revision: 1.5 }]) {
    const refreshRow = { id: "row-a", revision: 3 };
    const h = harness({ refreshRow }, async () => outcome);
    const result = await invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 31 } });
    assert.equal(result.success, false);
    assert.match(result.error, /outcome unconfirmed/i);
    assert.equal(result.dataChanged, undefined);
    assert.equal(refreshRow.revision, 3);
  }
});

test("an unconfirmed insert response cannot report a successful captured row", async () => {
  for (const returned of [undefined, null, "", {}, 12]) {
    const h = harness({}, async () => returned);
    const result = await invoke(h.tools.insert_row, { data: { Seats: 30 } });
    assert.equal(result.success, false);
    assert.match(result.error, /unconfirmed/);
    assert.match(result.error, /may have been written/);
  }
});

// These exercise real handlers over synthetic storage, not Convex transactions
// or transport. The injected failure occurs only after the handler has returned.
function lostResponseHarness(refresh = false, invalidResponse = false) {
  const state = fixture({ name: "Alpha" }, auth.authorizedUserId);
  const sent: Record<string, any>[] = [];
  let reads = 0;
  let loseResponse = true;
  const refreshRow = refresh ? { id: "row", revision: 0 } : undefined;
  const tools = buildPopulateTools("dataset", auth, {
    refreshRow,
    dependencies: {
      capture: () => {},
      convex: {
        query: async (_reference: unknown, args: Record<string, any>) => {
          reads++;
          return invokeStored("get", state, args);
        },
        mutation: async (reference: any, args: Record<string, any>) => {
          sent.push(structuredClone(args));
          const name = getFunctionName(reference).split(":")[1] as "update" | "insert";
          const result = await invokeStored(name, state, args);
          if (loseResponse) {
            loseResponse = false;
            if (invalidResponse) return undefined;
            throw new Error("Synthetic committed response lost");
          }
          return result;
        },
      } as any,
    },
  });
  return {
    state, tools, sent, refreshRow, reads: () => reads,
    consumed: () => [...state.documents.values()].find(row => row.userId === auth.authorizedUserId)?.rowsConsumed ?? 0,
  };
}

test("identical update retries recover lost committed responses with the original revision and operation", async () => {
  for (const refresh of [false, true]) {
    for (const invalidResponse of [false, true]) {
      const h = lostResponseHarness(refresh, invalidResponse);
      const data = { name: "Beta", detail: { b: 2, a: 1 } };
      assert.equal((await invoke(h.tools.update_row, { rowId: "row", data, row_summary: "Updated" })).success, false);
      data.detail.a = 99; // Caller mutation must not alter the retained prepared request.
      const replay = await invoke(h.tools.update_row, {
        rowId: "row", data: { detail: { a: 1, b: 2 }, '"name"': "Beta" }, row_summary: "Updated",
      });
      assert.deepEqual(replay, { success: true, dataChanged: true, evidenceChanged: false, revision: 1 });
      assert.equal(h.state.row().revision, 1);
      assert.equal(h.consumed(), 1);
      assert.equal(h.reads(), 1, "retry must not prepare from a newer durable revision");
      assert.deepEqual(h.sent[1], h.sent[0]);
      if (h.refreshRow) assert.equal(h.refreshRow.revision, 1);
      const next = await invoke(h.tools.update_row, {
        rowId: "row", data: { name: "Beta", detail: { a: 1, b: 2 } }, row_summary: "Updated",
      });
      assert.equal(next.success, true);
      assert.equal(next.revision, 2);
      assert.equal(h.consumed(), 2, "a call after confirmed success is an intentional new write");
      assert.notEqual(h.sent[2].operationId, h.sent[0].operationId);
    }
  }
});

test("identical insert retries recover one created row after thrown or malformed responses", async () => {
  for (const invalidResponse of [false, true]) {
    const h = lostResponseHarness(false, invalidResponse);
    const input = { data: { name: "Beta" }, sources: ["https://example.test"], how_found: "Synthetic fixture" };
    assert.equal((await invoke(h.tools.insert_row, input)).success, false);
    const replay = await invoke(h.tools.insert_row, input);
    assert.equal(replay.success, true);
    assert.equal([...h.state.documents.values()].filter(row => row.data?.name === "Beta").length, 1);
    assert.equal(h.consumed(), 1);
    assert.deepEqual(h.sent[1], h.sent[0]);
    const next = await invoke(h.tools.insert_row, input);
    assert.equal(next.success, true);
    assert.notEqual(next.rowId, replay.rowId);
    assert.notEqual(h.sent[2].operationId, h.sent[0].operationId);
    assert.equal(h.consumed(), 2);
  }
});

test("an unresolved update cannot overwrite an intervening write on retry", async () => {
  const h = lostResponseHarness();
  const input = { rowId: "row", data: { name: "Beta" } };
  assert.equal((await invoke(h.tools.update_row, input)).success, false);
  await invokeStored("update", h.state, {
    id: "row", expectedDatasetId: "dataset", data: { name: "Gamma" },
  });
  const replay = await invoke(h.tools.update_row, input);
  assert.equal(replay.success, false);
  assert.match(replay.error, /stale/i);
  assert.equal(h.state.row().data.name, "Gamma");
  assert.equal(h.consumed(), 2);
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.sent[1], h.sent[0]);
});

test("unresolved writes are bounded without eviction and can be retried while full", async () => {
  let confirm = false;
  const h = harness({}, async () => confirm ? "row-created" : undefined);
  for (let index = 0; index < 32; index++) {
    assert.equal((await invoke(h.tools.insert_row, { data: { Seats: index } })).success, false);
  }
  const full = await invoke(h.tools.insert_row, { data: { Seats: 32 } });
  assert.equal(full.success, false);
  assert.match(full.error, /unresolved write limit/i);
  assert.equal(h.writes.length, 32);
  confirm = true;
  assert.equal((await invoke(h.tools.insert_row, { data: { Seats: 0 } })).success, true);
  assert.deepEqual(h.writes[32], h.writes[0]);
  assert.equal((await invoke(h.tools.insert_row, { data: { Seats: 32 } })).success, true);
  const oversized = await invoke(h.tools.insert_row, { data: { text: "x".repeat(512 * 1024) } });
  assert.equal(oversized.success, false);
  assert.match(oversized.error, /retained write.*limit/i);
  assert.equal(h.writes.length, 34);
});

test("concurrent identical requests share pending preparation before the initial row read resolves", async () => {
  let releaseRead!: () => void;
  let markRead!: () => void;
  const readStarted = new Promise<void>(resolve => { markRead = resolve; });
  const blockedRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let reads = 0;
  const writes: Record<string, any>[] = [];
  const h = harness({ dependencies: { convex: {
    query: async () => {
      reads++;
      markRead();
      await blockedRead;
      return { datasetId: "dataset-a", revision: 0 };
    },
    mutation: async (_reference: unknown, args: Record<string, any>) => {
      writes.push(args);
      return undefined; // Both calls retain the same unresolved operation.
    },
  } as any } });
  const first = invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 31 } });
  await readStarted;
  const second = invoke(h.tools.update_row, { rowId: "row-a", data: { Seats: 31 } });
  releaseRead();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
});

test("a delayed original response cannot regress a refresh revision after replay and a newer write", async () => {
  const state = fixture({ name: "Alpha" }, auth.authorizedUserId);
  const refreshRow = { id: "row", revision: 0 };
  let releaseResponse!: () => void;
  let markCommitted!: () => void;
  const committed = new Promise<void>(resolve => { markCommitted = resolve; });
  const heldResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
  let holdFirst = true;
  const tools = buildPopulateTools("dataset", auth, {
    refreshRow,
    dependencies: { capture: () => {}, convex: {
      query: async (_reference: unknown, args: Record<string, any>) => invokeStored("get", state, args),
      mutation: async (_reference: unknown, args: Record<string, any>) => {
        const result = await invokeStored("update", state, args);
        if (holdFirst) {
          holdFirst = false;
          markCommitted();
          await heldResponse;
        }
        return result;
      },
    } as any },
  });
  const first = invoke(tools.update_row, { rowId: "row", data: { name: "Beta" } });
  await committed;
  try {
    assert.equal((await invoke(tools.update_row, { rowId: "row", data: { name: "Beta" } })).revision, 1);
    assert.equal((await invoke(tools.update_row, { rowId: "row", data: { name: "Gamma" } })).revision, 2);
  } finally {
    releaseResponse();
    await first;
  }
  assert.equal(refreshRow.revision, 2);
  assert.equal(state.row().revision, 2);
  assert.equal(state.row().data.name, "Gamma");
});

test("a refresh request pins its revision before an awaited row lookup", async () => {
  const state = fixture({ name: "Alpha" }, auth.authorizedUserId);
  const refreshRow = { id: "row", revision: 0 };
  let releaseRead!: () => void;
  let markRead!: () => void;
  const readStarted = new Promise<void>(resolve => { markRead = resolve; });
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let holdFirst = true;
  const sent: Record<string, any>[] = [];
  const tools = buildPopulateTools("dataset", auth, {
    refreshRow,
    dependencies: { capture: () => {}, convex: {
      query: async (_reference: unknown, args: Record<string, any>) => {
        const row = await invokeStored("get", state, args);
        if (holdFirst) {
          holdFirst = false;
          markRead();
          await heldRead;
        }
        return row;
      },
      mutation: async (_reference: unknown, args: Record<string, any>) => {
        sent.push(structuredClone(args));
        return invokeStored("update", state, args);
      },
    } as any },
  });
  const staleInput = { rowId: "row", data: { name: "Gamma" } };
  const pending = invoke(tools.update_row, staleInput);
  await readStarted;
  assert.equal((await invoke(tools.update_row, { rowId: "row", data: { name: "Beta" } })).success, true);
  releaseRead();
  const stale = await pending;
  assert.equal(stale.success, false);
  assert.match(stale.error, /stale/i);
  assert.equal((await invoke(tools.update_row, staleInput)).success, false);
  assert.equal(state.row().data.name, "Beta");
  assert.equal(refreshRow.revision, 1);
  assert.equal(sent[1].expectedRevision, 0);
  assert.deepEqual(sent[2], sent[1]);
});
