import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as datasets from "../../frontend/convex/datasets.js";

type Kind = "populate" | "update";
type Options = {
  prepare?: () => Promise<void>;
  create?: () => Promise<void>;
  query?: () => void;
  importing?: () => void;
};

// Compile the real route callback without importing the server or using live I/O.
// The admission gate executes the real Convex mutation against synthetic storage.
async function harness(kind: Kind, options: Options = {}) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  const syntax = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  assert.equal(syntax.diagnostics?.length ?? 0, 0, "production entrypoint must parse without recovery");
  let callback: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "instance.post" &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === `/${kind}`) callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  const compiled = ts.transpileModule(`const route = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let document: Record<string, any> | null = { _id: "dataset", ownerId: "owner", status: "live", maxRowCount: 37 };
  const events: string[] = [];
  const starts: any[] = [];
  const writes: any[] = [];
  let runNumber = 0;
  const ctx = { db: {
    get: async () => document && structuredClone(document),
    patch: async (_id: string, values: any) => { writes.push(values); Object.assign(document!, values); },
  } };
  let admission: Promise<unknown> = Promise.resolve();
  async function begin(_id: string, ownerId: string) {
    events.push("claim");
    const fn = kind === "populate" ? datasets.beginPopulateInternal : datasets.beginUpdateInternal;
    const outcome = admission.then(() => (fn as any)._handler(ctx, { id: "dataset", ownerId }));
    admission = outcome;
    return (await outcome).outcome;
  }
  const workflow = { createRun: async () => {
    events.push("create"); await options.create?.(); return { runId: `run-${++runNumber}` };
  } };
  const route = runInNewContext(`${compiled}\nroute`, {
    Error, console, datasetContextSchema: { safeParse: (body: any) => ({ success: true, data: body }) },
    ensureLocalSetupReady: async () => true,
    internal: { datasets: { getInternal: "get" } },
    convex: { query: async () => { events.push("query"); options.query?.(); return document && structuredClone(document); } },
    require: (name: string) => {
      assert.equal(name, "./config/models.js"); options.importing?.();
      return { getModelConfig: async (owner: string) => {
        assert.equal(owner, "owner"); events.push("settings"); await options.prepare?.(); return { model: "synthetic" };
      } };
    },
    beginDatasetPopulate: begin, beginDatasetUpdate: begin,
    populateWorkflow: workflow, updateWorkflow: workflow,
    registerDataset: () => { events.push("register"); return new AbortController(); },
    runPopulateWorkflowInBackground: (input: any) => { events.push("start"); starts.push(input); },
    runUpdateWorkflowInBackground: (input: any) => { events.push("start"); starts.push(input); },
    setDatasetPopulateStatus: async (_id: string, status: string) => { events.push("compensate"); document!.status = status; },
    statusErrorMessage: (error: Error) => error.message,
  }) as (req: any, reply: any) => Promise<unknown>;
  return {
    events, starts, writes,
    get document() { return document; },
    set document(value) { document = value; },
    async request(userId: string | null = "owner") {
      let status = 200; let body: any;
      const reply = { code(value: number) { status = value; return this; }, send(value: any) { body = value; return this; } };
      await route({ body: { datasetId: "dataset", columns: [], maxRowCount: 100 }, auth: userId ? { userId } : undefined,
        log: { error() {} }, server: { clerk: {} } }, reply);
      return { status, body };
    },
  };
}

for (const kind of ["populate", "update"] as const) {
  for (const boundary of ["query", "importing", "prepare"] as const) {
    test(`${kind}: ${boundary} failure cannot strand an active claim`, async () => {
      const h = await harness(kind, { [boundary]: () => { throw new Error("synthetic preparation outage"); } });
      assert.equal((await h.request()).status, 502);
      assert.equal(h.document!.status, "live");
      assert.equal(h.writes.length, 0);
      assert.equal(h.starts.length, 0);
      assert.ok(!h.events.includes("claim"));
      assert.ok(!h.events.includes("register"));
      assert.ok(!h.events.includes("compensate"));
    });
  }
  test(`${kind}: preparation stays unclaimed and a later request can retry`, async () => {
    let release!: () => void;
    let pending = true;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const h = await harness(kind, { prepare: async () => { if (pending) { await wait; throw new Error("outage"); } } });
    const first = h.request(); await setImmediate();
    const pendingState = { status: h.document!.status, writes: h.writes.length, registered: h.events.includes("register") };
    release(); const failed = await first;
    assert.deepEqual(pendingState, { status: "live", writes: 0, registered: false });
    assert.equal(failed.status, 502);
    pending = false;
    assert.equal((await h.request()).status, 202);
    assert.equal(h.starts.length, 1);
  });
  test(`${kind}: denied requests never prepare or dispatch work`, async () => {
    for (const [state, owner, status] of [
      ["live", null, 401], ["missing", "owner", 404], ["live", "other", 403],
      ["building", "owner", 409], ["updating", "owner", 409],
    ] as const) {
      const h = await harness(kind);
      if (state === "missing") h.document = null; else h.document!.status = state;
      assert.equal((await h.request(owner)).status, status);
      assert.equal(h.writes.length, 0); assert.equal(h.starts.length, 0);
      assert.ok(!h.events.includes("settings")); assert.ok(!h.events.includes("create"));
    }
  });
  test(`${kind}: a competing preparation starts only the atomic-claim winner`, async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const h = await harness(kind, { prepare: () => wait });
    const first = h.request(); const second = h.request(); await setImmediate();
    const pendingWrites = h.writes.length; release();
    // Synthetic storage is sequential: make its claim call serialize like a mutation.
    const results = await Promise.all([first, second]);
    assert.equal(pendingWrites, 0);
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
    assert.equal(h.starts.length, 1); assert.equal(h.writes.length, 1);
  });
  test(`${kind}: ownership changed during preparation is rechecked before dispatch`, async () => {
    const h = await harness(kind, { prepare: async () => { h.document!.ownerId = "new-owner"; } });
    assert.equal((await h.request()).status, 403);
    assert.equal(h.writes.length, 0); assert.equal(h.starts.length, 0);
    assert.ok(!h.events.includes("register"));
  });
  test(`${kind}: active status acquired during preparation is rechecked`, async () => {
    for (const status of ["building", "updating"]) {
      const h = await harness(kind, { prepare: async () => { h.document!.status = status; } });
      assert.equal((await h.request()).status, 409);
      assert.equal(h.writes.length, 0); assert.equal(h.starts.length, 0);
      assert.ok(!h.events.includes("create"));
    }
  });
  test(`${kind}: deletion during preparation is rechecked before dispatch`, async () => {
    const h = await harness(kind, { prepare: async () => { h.document = null; } });
    assert.equal((await h.request()).status, 404);
    assert.equal(h.writes.length, 0); assert.equal(h.starts.length, 0);
  });
  test(`${kind}: run creation remains after admission with existing failure compensation`, async () => {
    const h = await harness(kind, { create: async () => { throw new Error("synthetic create failure"); } });
    assert.equal((await h.request()).status, 502);
    assert.equal(h.document!.status, kind === "populate" ? "failed" : "live");
    assert.equal(h.starts.length, 0);
    assert.ok(h.events.indexOf("claim") < h.events.indexOf("create"));
    assert.ok(h.events.includes("compensate"));
  });
  test(`${kind}: successful startup registers before dispatch and uses prepared settings`, async () => {
    const h = await harness(kind);
    assert.equal((await h.request()).status, 202);
    assert.deepEqual(h.events, ["query", "settings", "claim", "create", "register", "start"]);
    assert.equal(h.starts[0].modelConfig.model, "synthetic");
    if (kind === "populate") assert.equal(h.starts[0].input.maxRowCount, 37);
  });
}

// Planning uses a snapshot; persistence still enforces the current dataset cap.
test("populate retains its preflight planning cap when settings change during preparation", async () => {
  const h = await harness("populate", { prepare: async () => { h.document!.maxRowCount = 12; } });
  assert.equal((await h.request()).status, 202);
  assert.equal(h.starts[0].input.maxRowCount, 37);
  assert.equal(h.document!.maxRowCount, 12);
});
