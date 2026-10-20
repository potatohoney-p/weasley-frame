import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceCaptureRegistry } from "../src/pipeline/evidence-capture.js";
import { buildEvidenceWebTools } from "../src/mastra/tools/web-tools.js";
import { buildPopulateTools, type PopulateToolOptions } from "../src/mastra/tools/dataset-tools.js";

const auth = { authorizedUserId: "synthetic-user", workflowRunId: "synthetic-run" };
const registry = () => new EvidenceCaptureRegistry(auth.workflowRunId);
const credentials = async () => ({ apiKey: "synthetic-test-key", headers: { "X-Test": "fixture" } });
type Tool = { execute?: (...args: any[]) => any };
const invoke = (tool: Tool, input: unknown) => tool.execute!(input, {});

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
