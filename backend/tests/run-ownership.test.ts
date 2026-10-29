import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import {
  abortDataset,
  deregisterDataset,
  getSignal,
  registerDataset,
} from "../src/abort-registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * index.ts starts the server and scheduler on import. Compile its actual runner
 * declarations, not copied implementations, with synthetic I/O instead. This
 * exercises their finally blocks without opening sockets, loading credentials,
 * connecting to Convex, or calling a provider. HTTP/auth are not exercised.
 */
async function runners(dependencies: Record<string, unknown>) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  const names = [
    "finaliseRunAsLive",
    "runPopulateWorkflowInBackground",
    "runUpdateWorkflowInBackground",
    "runScheduledUpdateWorkflowInBackground",
  ];
  const declarations = parsed.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""),
  );
  assert.equal(declarations.length, names.length, "all production runners must be exercised");
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(`${compiled}\n({ ${names.join(", ")} })`, {
    registerDataset, deregisterDataset, Error, Date, ...dependencies,
  }) as Record<string, (input: Record<string, unknown>) => Promise<void>>;
}

for (const kind of ["populate", "update", "scheduled"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`${kind} ${outcome}: delayed finalization cannot deregister a newer run`, async () => {
      const datasetId = `${kind}-${outcome}`;
      const finalizationStarted = deferred();
      const finishFinalization = deferred();
      let status = kind === "populate" ? "building" : "updating";
      let pendingNotifications = 0;
      const pause = async () => {
        finalizationStarted.resolve();
        await finishFinalization.promise;
      };
      const loaded = await runners({
        internal: {
          datasets: { getInternal: "get", completeScheduledRefreshInternal: "complete", failScheduledRefreshInternal: "fail" },
          datasetRows: { countByDataset: "count" },
        },
        convex: {
          query: async (reference: string) => reference === "count" ? 1 : { name: "Synthetic dataset" },
          mutation: async (reference: string) => {
            status = reference === "complete" ? "live" : "failed";
            // A durable status commit can be visible before its response arrives.
            await pause();
          },
        },
        setDatasetPopulateStatus: async (_id: string, next: string) => {
          status = next;
          if (outcome === "failure") await pause();
        },
        sendDatasetReadyNotification: async () => { pendingNotifications++; await pause(); },
        statusErrorMessage: (error: Error) => error.message,
      });
      const oldController = kind === "scheduled" ? undefined : registerDataset(datasetId);
      const running = loaded[kind === "populate" ? "runPopulateWorkflowInBackground"
        : kind === "update" ? "runUpdateWorkflowInBackground" : "runScheduledUpdateWorkflowInBackground"]({
        input: { datasetId },
        run: { runId: "old-run", start: async () => ({ status: outcome, steps: {} }) },
        controller: oldController,
        authorizedUserId: "synthetic-user",
        logger: { info() {}, error() {} },
        clerk: {}, modelConfig: {},
      });
      await finalizationStarted.promise;
      assert.equal(status, outcome === "success" ? "live" : "failed");
      if (outcome === "success" && kind !== "scheduled") assert.equal(pendingNotifications, 1);
      // The durable terminal status permits a new atomic dataset claim.
      const newerController = registerDataset(datasetId);
      finishFinalization.resolve();
      try {
        await running;
        assert.equal(getSignal(datasetId), newerController.signal);
        assert.equal(abortDataset(datasetId), true, "Stop must not classify the active run as orphaned");
        assert.equal(newerController.signal.aborted, true);
        if (oldController) assert.equal(oldController.signal.aborted, false);
      } finally {
        deregisterDataset(datasetId, newerController);
      }
    });
  }
}

test("stopped populate finalization leaves the next run independently stoppable", async () => {
  const datasetId = "stopped-populate";
  const notificationStarted = deferred();
  const finishNotification = deferred();
  const loaded = await runners({
    internal: { datasets: { getInternal: "get" }, datasetRows: { countByDataset: "count" } },
    convex: { query: async (reference: string) => reference === "count" ? 1 : { name: "Synthetic dataset" } },
    setDatasetPopulateStatus: async () => {},
    sendDatasetReadyNotification: async () => { notificationStarted.resolve(); await finishNotification.promise; },
  });
  const oldController = registerDataset(datasetId);
  oldController.abort();
  const running = loaded.runPopulateWorkflowInBackground({
    input: { datasetId }, controller: oldController,
    run: { runId: "stopped-run", start: async () => { throw new Error("stopped"); } },
    logger: { info() {}, error() {} }, clerk: {}, modelConfig: {}, authorizedUserId: "synthetic-user",
  });
  await notificationStarted.promise;
  const next = registerDataset(datasetId);
  assert.equal(next.signal.aborted, false, "new runs do not inherit an earlier cancellation");
  finishNotification.resolve();
  try {
    await running;
    assert.equal(abortDataset(datasetId), true);
    assert.equal(next.signal.aborted, true);
  } finally {
    deregisterDataset(datasetId, next);
  }
});

test("owner cleanup is idempotent and cannot affect another dataset or replacement", () => {
  const first = registerDataset("ownership-a");
  const other = registerDataset("ownership-b");
  try {
    assert.equal(deregisterDataset("ownership-a", other), false);
    assert.equal(getSignal("ownership-a"), first.signal);
    assert.equal(deregisterDataset("ownership-a", first), true);
    assert.equal(deregisterDataset("ownership-a", first), false);
    assert.equal(abortDataset("ownership-a"), false);
    const replacement = registerDataset("ownership-a");
    try {
      assert.equal(deregisterDataset("ownership-a", first), false);
      assert.equal(getSignal("ownership-a"), replacement.signal);
      assert.equal(getSignal("ownership-b"), other.signal);
      assert.equal(abortDataset("ownership-a"), true);
      assert.equal(abortDataset("ownership-a"), true);
      assert.equal(other.signal.aborted, false);
    } finally {
      deregisterDataset("ownership-a", replacement);
    }
  } finally {
    deregisterDataset("ownership-a", first);
    deregisterDataset("ownership-b", other);
  }
});

for (const kind of ["populate", "update", "scheduled"] as const) {
  test(`${kind}: ordinary completion releases its own registration`, async () => {
    const datasetId = `${kind}-ordinary`;
    const loaded = await runners({
      internal: {
        datasets: { getInternal: "get", completeScheduledRefreshInternal: "complete" },
        datasetRows: { countByDataset: "count" },
      },
      convex: {
        query: async (reference: string) => reference === "count" ? 1 : { name: "Synthetic dataset" },
        mutation: async () => {},
      },
      setDatasetPopulateStatus: async () => {},
      sendDatasetReadyNotification: async () => {},
    });
    const controller = kind === "scheduled" ? undefined : registerDataset(datasetId);
    await loaded[kind === "populate" ? "runPopulateWorkflowInBackground"
      : kind === "update" ? "runUpdateWorkflowInBackground" : "runScheduledUpdateWorkflowInBackground"]({
      input: { datasetId }, controller,
      run: { runId: "ordinary-run", start: async () => ({ status: "success", steps: {} }) },
      logger: { info() {}, error() {} }, clerk: {}, modelConfig: {}, authorizedUserId: "synthetic-user",
    });
    assert.equal(getSignal(datasetId), undefined);
    assert.equal(abortDataset(datasetId), false);
  });
}
