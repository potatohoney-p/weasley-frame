import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { buildPopulateTools } from "../src/mastra/tools/dataset-tools.js";

const auth = { authorizedUserId: "synthetic-user", workflowRunId: "synthetic-run", modelConfig: { schemaInference: "synthetic", populateOrchestrator: "synthetic", investigateSubagent: "synthetic" } };
const invoke = (tool: { execute?: (...args: any[]) => any }, input: unknown) => tool.execute!(input, {});
async function harness(ids: string[], text: string, failure?: Error, signal?: AbortSignal) {
  const source = await readFile(new URL("../src/mastra/tools/investigate-tool.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("tool.ts", source, ts.ScriptTarget.ES2022, true);
  const declarations = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join("\n");
  const compiled = ts.transpileModule(declarations, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const metrics = { investigateCalls: 0, rowsInserted: 0, countToolCalls() {}, addInvestigateResult() {} };
  const exports: Record<string, any> = {};
  runInNewContext(compiled, { exports, z, Error, Set, console: { log() {}, error() {} },
    createTool: (config: unknown) => config,
    internal: { datasetRows: { countByDataset: "count" } }, convex: { query: async () => 0 },
    getSignal: () => signal,
    buildInvestigateAgent: (...args: any[]) => ({ generate: async () => {
      const receipts = args[5] as Set<string> | undefined;
      for (const id of ids) receipts?.add(id);
      if (failure) throw failure;
      return { text, toolCalls: [], steps: [] };
    } }),
  });
  const promise = exports.buildSubagentTool("dataset", auth, [], "unused", 100, metrics).execute({
    entity_hint: "synthetic", primary_keys: { Name: "Example" }, context: "",
  });
  if (signal?.aborted && failure?.name === "AbortError") {
    await assert.rejects(promise, error => error === failure);
    return { result: undefined, metrics };
  }
  return { result: await promise, metrics };
}

test("generated INSERTED true without a receipt is not a successful insert", async () => {
  const h = await harness([], "INSERTED: true\nREASON: claimed");
  assert.equal(h.result.inserted, false); assert.equal(h.metrics.rowsInserted, 0);
});
test("confirmed write overrides generated false and missing markers", async () => {
  for (const text of ["INSERTED: false", "No final marker"]) {
    const h = await harness(["row-a"], text);
    assert.equal(h.result.inserted, true); assert.equal(h.metrics.rowsInserted, 1);
  }
});
test("unique acknowledged rows, not calls or prose, determine metrics", async () => {
  const h = await harness(["row-a", "row-a", "row-b"], "INSERTED: true");
  assert.equal(h.result.inserted, true); assert.equal(h.metrics.rowsInserted, 2);
});
test("provider failure preserves confirmed insertion accounting", async () => {
  const h = await harness(["row-a"], "", new Error("synthetic provider failure"));
  assert.equal(h.result.inserted, true); assert.equal(h.metrics.rowsInserted, 1);
  assert.match(h.result.reason, /failed after confirmed insertion/);
});
test("provider failure before a receipt remains unconfirmed", async () => {
  const h = await harness([], "", new Error("synthetic provider failure"));
  assert.equal(h.result.inserted, false); assert.equal(h.metrics.rowsInserted, 0);
});
test("receipt sets do not leak between invocations", async () => {
  assert.equal((await harness(["row-a"], "")).metrics.rowsInserted, 1);
  assert.equal((await harness([], "INSERTED: true")).metrics.rowsInserted, 0);
});
test("actual insert tool only records valid persistence acknowledgements", async () => {
  for (const response of [undefined, null, "", "  ", { id: "row-a" }, "row-a"]) {
    const receipts = new Set<string>();
    const tools = buildPopulateTools("dataset", auth, { confirmedInsertIds: receipts,
      dependencies: { convex: { mutation: async () => response } as any },
    });
    const result = await invoke(tools.insert_row, { data: { Name: "Example" } });
    assert.equal(result?.success, response === "row-a");
    assert.deepEqual([...receipts], response === "row-a" ? ["row-a"] : []);
  }
});
test("actual insert retry records one receipt after an uncertain response", async () => {
  const receipts = new Set<string>(); let calls = 0; const operations: unknown[] = [];
  const tools = buildPopulateTools("dataset", auth, { confirmedInsertIds: receipts,
    dependencies: { convex: { mutation: async (_ref: unknown, args: any) => {
      operations.push(args.operationId); if (++calls === 1) throw new Error("response lost"); return "row-a";
    } } as any },
  });
  const input = { data: { Name: "Example" } };
  assert.equal((await invoke(tools.insert_row, input))?.success, false);
  assert.equal(receipts.size, 0);
  assert.equal((await invoke(tools.insert_row, input))?.success, true);
  assert.equal(operations[0], operations[1]); assert.deepEqual([...receipts], ["row-a"]);
});

test("investigate agent passes the same private receipt set to persistence tools", async () => {
  const source = await readFile(new URL("../src/mastra/agents/investigate.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("agent.ts", source, ts.ScriptTarget.ES2022, true);
  const declarations = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join("\n");
  const compiled = ts.transpileModule(declarations, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports: Record<string, any> = {}; let options: any;
  runInNewContext(compiled, { exports, process: { env: {} },
    Agent: class { constructor(_config: unknown) {} },
    createOpenRouter: () => () => ({}), EvidenceCaptureRegistry: class {},
    buildEvidenceWebTools: () => ({}), buildPopulateTools: (_id: unknown, _auth: unknown, opts: unknown) => {
      options = opts; return { insert_row: {} };
    },
  });
  const receipts = new Set<string>();
  exports.buildInvestigateAgent("dataset", { ...auth, modelConfig: { investigateSubagent: "synthetic" } }, [], "unused", undefined, receipts);
  assert.equal(options.confirmedInsertIds, receipts);
});

test("cancellation after a confirmed write propagates while retaining its metric", async () => {
  const failure = new Error("Stopped"); failure.name = "AbortError";
  const h = await harness(["row-a"], "", failure, AbortSignal.abort());
  assert.equal(h.metrics.rowsInserted, 1);
});
