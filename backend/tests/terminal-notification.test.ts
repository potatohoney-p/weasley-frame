import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { deregisterDataset, getSignal, registerDataset } from "../src/abort-registry.js";

// Compile the real runners without importing index.ts (which starts the server).
// Only database and notification I/O are synthetic; no provider or live DB calls.
async function loadRunners(dependencies: Record<string, unknown>) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  const names = ["finaliseRunAsLive", "runUpdateWorkflowInBackground", "runPopulateWorkflowInBackground"];
  const declarations = parsed.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(declarations.length, names.length);
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(`${compiled}\n({ ${names.join(", ")} })`, {
    Error, Date, deregisterDataset, ...dependencies,
  }) as Record<string, (input: Record<string, unknown>) => Promise<void>>;
}

for (const kind of ["update", "stopped-populate"] as const) {
  for (const nextRun of [false, true]) {
    for (const failurePoint of ["count", "notification"] as const) {
      test(`${kind}: ${failurePoint} failure preserves ${nextRun ? "successor" : "live"} status`, async () => {
        const datasetId = `${kind}-notification-${nextRun}`;
        const controller = registerDataset(datasetId);
        if (kind === "stopped-populate") controller.abort();
        let successor: AbortController | undefined;
        let status = kind === "update" ? "updating" : "building";
        const writes: string[] = [];
        const logs: unknown[] = [];
        let notificationCalls = 0;
        const runners = await loadRunners({
          internal: { datasets: { getInternal: "get" }, datasetRows: { countByDataset: "count" } },
          convex: { query: async (ref: string) => {
            if (ref === "get") return { name: "Synthetic dataset" };
            if (failurePoint === "notification") return 2;
            assert.equal(status, "live", "failure occurs after acknowledged terminal write");
            if (nextRun) { successor = registerDataset(datasetId); status = "updating"; }
            throw new Error("synthetic row-count read failure");
          } },
          setDatasetPopulateStatus: async (_id: string, next: string) => { writes.push(next); status = next; },
          sendDatasetReadyNotification: async () => {
            notificationCalls++;
            assert.equal(status, "live");
            if (nextRun) { successor = registerDataset(datasetId); status = "updating"; }
            throw new Error("synthetic notification failure");
          },
          statusErrorMessage: (err: Error) => err.message,
        });
        try {
          await runners[kind === "update" ? "runUpdateWorkflowInBackground" : "runPopulateWorkflowInBackground"]({
            input: { datasetId }, controller,
            run: { runId: "old", start: async () => {
              if (kind === "stopped-populate") throw new Error("stopped");
              return { status: "success", steps: {} };
            } },
            logger: { info() {}, error(...args: unknown[]) { logs.push(args); } },
            clerk: {}, authorizedUserId: "synthetic-user", modelConfig: {},
          });
          assert.deepEqual(writes, ["live"], "notification reads cannot trigger failed status writes");
          assert.equal(status, nextRun ? "updating" : "live");
          assert.equal(notificationCalls, failurePoint === "count" ? 0 : 1);
          assert.ok(logs.length > 0, "notification preparation failure is observable");
          assert.equal(getSignal(datasetId), successor?.signal);
        } finally {
          deregisterDataset(datasetId, successor ?? controller);
        }
      });
    }
  }

  test(`${kind}: failed terminal write still records workflow failure`, async () => {
    const datasetId = `${kind}-write-failure`;
    const controller = registerDataset(datasetId);
    if (kind === "stopped-populate") controller.abort();
    const writes: string[] = [];
    let countQueries = 0;
    const runners = await loadRunners({
      internal: { datasets: { getInternal: "get" }, datasetRows: { countByDataset: "count" } },
      convex: { query: async (ref: string) => {
        if (ref === "count") countQueries++;
        return ref === "get" ? { name: "Synthetic dataset" } : 1;
      } },
      setDatasetPopulateStatus: async (_id: string, next: string) => {
        writes.push(next);
        if (next === "live") throw new Error("synthetic write rejection");
      },
      sendDatasetReadyNotification: async () => { assert.fail("must not notify before live write succeeds"); },
      statusErrorMessage: (err: Error) => err.message,
    });
    await runners[kind === "update" ? "runUpdateWorkflowInBackground" : "runPopulateWorkflowInBackground"]({
      input: { datasetId }, controller,
      run: { runId: "failed", start: async () => {
        if (kind === "stopped-populate") throw new Error("stopped");
        return { status: "success", steps: {} };
      } },
      logger: { info() {}, error() {} }, clerk: {}, authorizedUserId: "synthetic-user", modelConfig: {},
    });
    assert.deepEqual(writes, ["live", "failed"]);
    assert.equal(countQueries, 0);
    assert.equal(getSignal(datasetId), undefined);
  });
}

for (const workflowType of ["populate", "update"] as const) {
  for (const rowCount of [0, 2]) {
    test(`stopped ${workflowType}: ${rowCount} rows preserves notification policy`, async () => {
      const writes: string[] = [];
      const notifications: Record<string, unknown>[] = [];
      const runners = await loadRunners({
        internal: { datasets: { getInternal: "get" }, datasetRows: { countByDataset: "count" } },
        convex: { query: async (ref: string) => ref === "get" ? { name: "Synthetic dataset" } : rowCount },
        setDatasetPopulateStatus: async (_id: string, next: string) => { writes.push(next); },
        sendDatasetReadyNotification: async (args: Record<string, unknown>) => { notifications.push(args); },
      });
      await runners.finaliseRunAsLive({
        datasetId: "policy", workflowType, logger: { error() {} }, clerk: {}, authorizedUserId: "synthetic-user",
      });
      assert.deepEqual(writes, ["live"]);
      assert.equal(notifications.length, workflowType === "update" || rowCount > 0 ? 1 : 0);
      if (notifications.length) assert.equal(notifications[0].rowCount, rowCount);
    });
  }
}
