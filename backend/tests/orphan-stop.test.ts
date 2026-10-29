import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { abortDataset, deregisterDataset, registerDataset } from "../src/abort-registry.js";

type Options = { status?: string; active?: boolean; failClear?: boolean; failStatus?: boolean; lostStatusResponse?: boolean };
async function harness(options: Options = {}) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  let callback: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "instance.post" &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/stop") callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  const compiled = ts.transpileModule(`const route = ${callback.getText(ast)};`, {
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  const id = `orphan-${Math.random()}`;
  const document = { ownerId: "owner", status: options.status ?? "updating" };
  const controller = options.active ? registerDataset(id) : undefined;
  const events: string[] = []; const errors: unknown[] = [];
  const route = runInNewContext(`${compiled.outputText}\nroute`, {
    Error, abortDataset,
    internal: { datasets: { getInternal: "get" }, datasetRows: { clearAllPendingUpdateStatus: "clear" } },
    convex: {
      query: async () => ({ ...document }),
      mutation: async (ref: string) => { assert.equal(ref, "clear"); events.push("clear"); if (options.failClear) throw new Error("private storage detail"); },
    },
    setDatasetPopulateStatus: async (_id: string, status: string) => {
      events.push("status"); if (options.failStatus) throw new Error("private storage detail");
      document.status = status;
      if (options.lostStatusResponse) throw new Error("lost acknowledgment");
    },
  }) as (req: any, reply: any) => Promise<unknown>;
  return { document, events, errors, controller, options,
    cleanup() { if (controller) deregisterDataset(id, controller); },
    async request(owner: string | null = "owner", body: unknown = { datasetId: id }) {
      let status = 200; let payload: any;
      const reply = { code(n: number) { status = n; return this; }, send(value: unknown) { payload = value; return this; } };
      await route({ body, auth: owner ? { userId: owner } : undefined,
        log: { warn() {}, info() {}, error(...args: unknown[]) { errors.push(args); } } }, reply);
      return { status, payload };
    },
  };
}

for (const status of ["building", "updating"]) {
  test(`${status} orphan: status-write failure is not acknowledged as successful stop`, async () => {
    const h = await harness({ status, failStatus: true });
    const result = await h.request();
    assert.equal(result.status, 502); assert.equal(result.payload.success, undefined);
    assert.match(result.payload.error, /stop/i); assert.doesNotMatch(result.payload.error, /private storage/);
    assert.equal(h.document.status, status); assert.equal(h.errors.length, 1);
    h.options.failStatus = false;
    assert.equal((await h.request()).status, 200); assert.equal(h.document.status, "failed");
  });
  test(`${status} orphan: acknowledged recovery retains success contract`, async () => {
    const h = await harness({ status }); const result = await h.request();
    assert.equal(result.status, 200); assert.equal(result.payload.success, true);
    assert.equal(h.document.status, "failed");
    assert.deepEqual(h.events, status === "updating" ? ["clear", "status"] : ["status"]);
  });
  test(`${status} active: stop only signals its controller`, async t => {
    const h = await harness({ status, active: true, failClear: true, failStatus: true }); t.after(() => h.cleanup());
    const result = await h.request(); assert.equal(result.status, 202); assert.equal(result.payload.success, true);
    assert.equal(h.controller!.signal.aborted, true); assert.deepEqual(h.events, []); assert.equal(h.document.status, status);
  });
}
test("updating orphan: cleanup failure does not claim success or continue status transition", async () => {
  const h = await harness({ failClear: true });
  assert.equal((await h.request()).status, 502); assert.deepEqual(h.events, ["clear"]); assert.equal(h.document.status, "updating");
  h.options.failClear = false; assert.equal((await h.request()).status, 200); assert.equal(h.document.status, "failed");
});
test("orphan: lost status acknowledgment reports uncertainty, not success or rollback", async () => {
  const h = await harness({ lostStatusResponse: true });
  assert.equal((await h.request()).status, 502); assert.equal(h.document.status, "failed");
  assert.deepEqual(h.events, ["clear", "status"]);
  assert.equal((await h.request()).status, 409); assert.deepEqual(h.events, ["clear", "status"]);
});
test("stop validation, ownership and inactive guards remain side-effect free", async () => {
  const h = await harness();
  assert.equal((await h.request("owner", {})).status, 400);
  assert.equal((await h.request(null)).status, 401);
  assert.equal((await h.request("other")).status, 403);
  h.document.status = "live"; assert.equal((await h.request()).status, 409);
  assert.deepEqual(h.events, []);
});

test("frontend Stop client rejects failed recovery and accepts acknowledged retry", async () => {
  const source = await readFile(new URL("../../frontend/lib/backend.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("backend.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "stopPopulation");
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const h = await harness({ failClear: true });
  const stop = runInNewContext(`${compiled}\nstopPopulation`, {
    Error, BACKEND_URL: "http://synthetic.invalid",
    fetch: async () => { const r = await h.request(); return { ok: r.status < 400, status: r.status, json: async () => r.payload }; },
  }) as (id: string, token: string) => Promise<{ success: boolean }>;
  await assert.rejects(stop("dataset", "synthetic"), /Failed to stop dataset run/);
  h.options.failClear = false;
  assert.equal((await stop("dataset", "synthetic")).success, true);
});
