import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the production step with synthetic provider/metrics I/O, not a copy.
async function harness(generate: () => Promise<unknown>, signal: AbortSignal | (() => AbortSignal), key?: () => Promise<string>) {
  const source = await readFile(new URL("../src/mastra/workflows/populate.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("populate.ts", source, ts.ScriptTarget.ES2022, true);
  let execute: ts.ArrowFunction | undefined;
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(parsed) !== "agentStep") continue;
      const call = declaration.initializer as ts.CallExpression;
      const config = call.arguments[0] as ts.ObjectLiteralExpression;
      const property = config.properties.find((p) => p.name?.getText(parsed) === "execute") as ts.PropertyAssignment;
      execute = property.initializer as ts.ArrowFunction;
    }
  }
  assert.ok(execute);
  const compiled = ts.transpileModule(`const execute = ${execute.getText(parsed)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const saved: Record<string, unknown>[] = [];
  let generated = 0;
  let accumulated = 0;
  const run = runInNewContext(`${compiled}\nexecute`, {
    Error, Date, console: { error() {} },
    getSignal: typeof signal === "function" ? signal : () => signal,
    requireOpenRouterApiKey: key ?? (async () => "synthetic-unused"),
    buildPopulateAgent: () => ({ generate: async () => { generated++; return generate(); } }),
    RunMetrics: class { addOrchestratorResult() { accumulated++; } countToolCalls() {} },
    saveRunMetrics: async (record: Record<string, unknown>) => { saved.push(record); },
  }) as (input: unknown) => Promise<{ text: string }>;
  return {
    run: () => run({ inputData: { authorizedDatasetId: "synthetic", authContext: {
      workflowRunId: "run", authorizedUserId: "user",
    }, columns: [], maxRowCount: 10, prompt: "synthetic" } }),
    saved, generated: () => generated, accumulated: () => accumulated,
  };
}

test("populate propagates a resolved stream error and records failure, preserving usage", async () => {
  const failure = new Error("synthetic stream failure");
  const h = await harness(async () => ({ text: "partial", error: failure }), new AbortController().signal);
  await assert.rejects(h.run(), (error) => error === failure);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].status, "error");
  assert.equal(h.saved[0].error, failure.message);
  assert.equal(h.accumulated(), 1);
});

test("populate converts non-Error stream failures into workflow errors", async () => {
  const h = await harness(async () => ({ text: "partial", error: "provider disconnected" }), new AbortController().signal);
  await assert.rejects(h.run(), /provider disconnected/);
  assert.equal(h.saved[0].status, "error");
});

test("populate resolving after Stop does not publish successful metrics", async () => {
  const controller = new AbortController();
  const h = await harness(async () => { controller.abort(); return { text: "partial" }; }, controller.signal);
  await assert.rejects(h.run());
  assert.equal(h.saved[0].status, "error");
  assert.equal(h.saved[0].error, "Stopped by user");
  assert.equal(h.accumulated(), 1);
});

test("already stopped populate never starts the provider", async () => {
  const h = await harness(async () => ({ text: "unwanted" }), AbortSignal.abort());
  await assert.rejects(h.run());
  assert.equal(h.generated(), 0);
  assert.equal(h.saved[0].error, "Stopped by user");
});

test("Stop during credential preparation prevents provider dispatch", async () => {
  const controller = new AbortController();
  const h = await harness(async () => ({ text: "unwanted" }), controller.signal, async () => {
    controller.abort(); return "synthetic-unused";
  });
  await assert.rejects(h.run());
  assert.equal(h.generated(), 0);
  assert.equal(h.saved[0].error, "Stopped by user");
});

test("ordinary successful populate retains text and success metrics", async () => {
  const h = await harness(async () => ({ text: "done" }), new AbortController().signal);
  assert.equal((await h.run()).text, "done");
  assert.equal(h.saved[0].status, "success");
  assert.equal(h.saved[0].error, undefined);
});

test("spurious provider AbortError is a failure, not a user stop", async () => {
  const error = new Error("network aborted"); error.name = "AbortError";
  const h = await harness(async () => { throw error; }, new AbortController().signal);
  await assert.rejects(h.run(), /network aborted/);
  assert.equal(h.saved[0].status, "error");
  assert.equal(h.saved[0].error, "network aborted");
});

for (const oldStopped of [true, false]) {
  test(`populate keeps original signal when registry changes (old stopped=${oldStopped})`, async () => {
    const original = new AbortController();
    const successor = new AbortController();
    let current = original.signal;
    const h = await harness(async () => {
      (oldStopped ? original : successor).abort("synthetic stop reason");
      current = successor.signal;
      return { text: "done" };
    }, () => current);
    if (oldStopped) {
      await assert.rejects(h.run());
      assert.equal(h.saved[0].status, "error");
      assert.equal(h.saved[0].error, "Stopped by user");
    } else {
      assert.equal((await h.run()).text, "done");
      assert.equal(h.saved[0].status, "success");
    }
  });
}
