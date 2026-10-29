import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { deregisterDataset, getSignal, registerDataset } from "../src/abort-registry.js";

type ModelConfig = { schemaInference: string; populateOrchestrator: string; investigateSubagent: string };
const configFor = (owner: string): ModelConfig => ({
  schemaInference: `${owner}-schema`, populateOrchestrator: `${owner}-populate`, investigateSubagent: `${owner}-investigate`,
});

type Dataset = {
  _id: string; ownerId: string; status: string; name: string; description: string;
  columns: unknown[]; maxRowCount?: number; nextRefreshAt: number; lastRefreshStartedAt?: number;
};
type Options = {
  getModelConfig?: (owner: string) => Promise<ModelConfig>;
  importModels?: () => void;
  createRun?: (attempt: number) => void;
  claimOutcome?: (dataset: Dataset) => string;
};

// Compile the actual scheduler and runner declarations, avoiding the entrypoint's
// server, credential loading, real interval, database, and provider calls.
async function scheduler(options: Options = {}) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  const names = ["startLocalRefreshScheduler", "runScheduledUpdateWorkflowInBackground"];
  const declarations = parsed.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
  );
  assert.equal(declarations.length, names.length);
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const datasets: Dataset[] = ["first", "second"].map((id) => ({
    _id: id, ownerId: `owner-${id}`, name: `Listed ${id}`, status: "live",
    description: "Synthetic dataset", columns: [], nextRefreshAt: 1,
  }));
  const claims: string[] = [];
  const starts: Array<{ inputData: { datasetId: string; datasetName: string; maxRowCount: number; authContext: { modelConfig: ModelConfig } } }> = [];
  const configOwners: string[] = [];
  const errors: unknown[][] = [];
  let intervalTick!: () => void;
  let runAttempts = 0;
  const loaded = runInNewContext(`${compiled}\nstartLocalRefreshScheduler`, {
    registerDataset, deregisterDataset, Error, Date: { now: () => 1000 },
    env: { REFRESH_SCHEDULER_ENABLED: true, IS_LOCAL_MODE: false, REFRESH_SCHEDULER_BATCH_SIZE: 10, REFRESH_SCHEDULER_STALE_AFTER_MS: 6000, REFRESH_SCHEDULER_POLL_MS: 100 },
    setInterval: (callback: () => void) => { intervalTick = callback; return 1; },
    statusErrorMessage: (error: Error) => error.message,
    require: (path: string) => {
      assert.equal(path, "./config/models.js");
      options.importModels?.();
      return { getModelConfig: async (owner: string) => {
        configOwners.push(owner);
        return options.getModelConfig ? options.getModelConfig(owner) : configFor(owner);
      } };
    },
    internal: { datasets: { listDueForRefreshInternal: "due", claimScheduledRefreshInternal: "claim", completeScheduledRefreshInternal: "complete", failScheduledRefreshInternal: "fail" } },
    convex: {
      query: async (reference: string) => {
        assert.equal(reference, "due");
        return datasets.filter((dataset) => dataset.nextRefreshAt <= 1000).map((dataset) => ({ ...dataset }));
      },
      mutation: async (reference: string, args: { id: string }) => {
        const dataset = datasets.find((item) => item._id === args.id)!;
        if (reference === "claim") {
          claims.push(args.id);
          const outcome = options.claimOutcome?.(dataset)
            ?? (dataset.status === "updating" ? "already_updating" : "started");
          if (outcome !== "started") return { outcome };
          dataset.status = "updating";
          dataset.lastRefreshStartedAt = 1000;
          return { outcome, dataset: {
            datasetId: dataset._id, datasetName: `Claimed ${dataset._id}`, ownerId: dataset.ownerId,
            description: dataset.description, columns: dataset.columns, maxRowCount: 37,
          } };
        }
        assert.ok(reference === "complete" || reference === "fail");
        dataset.status = reference === "complete" ? "live" : "failed";
        dataset.lastRefreshStartedAt = undefined;
        dataset.nextRefreshAt = 2000;
      },
    },
    updateWorkflow: { createRun: async () => {
      options.createRun?.(++runAttempts);
      return { runId: `run-${runAttempts}`, start: async (input: typeof starts[number]) => {
        assert.ok(getSignal(input.inputData.datasetId), "runner registers before workflow startup");
        starts.push(input);
        return { status: "success", steps: {} };
      } };
    } },
  }) as (logger: unknown) => unknown;
  const logger = { info() {}, debug() {}, error(...args: unknown[]) { errors.push(args); } };
  return {
    datasets, claims, starts, configOwners, errors,
    start: () => loaded(logger),
    tick: async () => { intervalTick(); await setImmediate(); },
  };
}

test("pending model settings do not claim a dataset or register an active run", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<ModelConfig>((_resolve, fail) => { reject = fail; });
  const harness = await scheduler({ getModelConfig: async (owner) => owner === "owner-first" ? pending : configFor(owner) });
  harness.start();
  await setImmediate();
  try {
    assert.deepEqual(harness.claims, []);
    assert.equal(harness.datasets[0].status, "live");
    assert.equal(getSignal("first"), undefined);
  } finally {
    reject(new Error("Synthetic configuration outage"));
    await setImmediate();
  }
});

for (const failure of ["configuration query", "module import"] as const) {
  test(`${failure} failure leaves the dataset unchanged and lets the next batch item run`, async () => {
    let imports = 0;
    const harness = await scheduler({
      importModels: () => { if (failure === "module import" && ++imports === 1) throw new Error("Synthetic import failure"); },
      getModelConfig: async (owner) => {
        if (failure === "configuration query" && owner === "owner-first") throw new Error("Synthetic query failure");
        return configFor(owner);
      },
    });
    const before = { ...harness.datasets[0] };
    harness.start();
    await setImmediate();
    assert.deepEqual(harness.datasets[0], before);
    assert.deepEqual(harness.claims, ["second"]);
    assert.deepEqual(harness.starts.map((start) => start.inputData.datasetId), ["second"]);
    assert.equal(harness.errors.length, 1);
    assert.equal(getSignal("first"), undefined);
    assert.equal(getSignal("second"), undefined);
  });
}

test("failed preparation can retry on the next poll without waiting for a stale claim", async () => {
  let failed = false;
  const harness = await scheduler({ getModelConfig: async (owner) => {
    if (owner === "owner-first" && !failed) { failed = true; throw new Error("Temporary outage"); }
    return configFor(owner);
  } });
  harness.start();
  await setImmediate();
  await harness.tick();
  assert.deepEqual(harness.claims, ["second", "first"]);
  assert.deepEqual(harness.starts.map((start) => start.inputData.datasetId), ["second", "first"]);
  assert.equal(harness.datasets[0].status, "live");
});

test("workflow creation failure remains isolated before the claim", async () => {
  const harness = await scheduler({ createRun: (attempt) => { if (attempt === 1) throw new Error("Synthetic createRun failure"); } });
  harness.start();
  await setImmediate();
  assert.deepEqual(harness.claims, ["second"]);
  assert.equal(harness.datasets[0].status, "live");
  assert.equal(harness.starts.length, 1);
});

test("preparation uses each owner's settings and successful starts use the fresh claim snapshot", async () => {
  const harness = await scheduler();
  harness.start();
  await setImmediate();
  assert.deepEqual(harness.configOwners, ["owner-first", "owner-second"]);
  for (const start of harness.starts) {
    const id = start.inputData.datasetId;
    assert.equal(start.inputData.datasetName, `Claimed ${id}`);
    assert.equal(start.inputData.maxRowCount, 37);
    assert.deepEqual(start.inputData.authContext.modelConfig, configFor(`owner-${id}`));
  }
  assert.equal(harness.starts.length, 2);
});

test("fresh atomic claim still rejects a dataset that became busy during preparation", async () => {
  const harness = await scheduler({ claimOutcome: (dataset) => dataset._id === "first" ? "already_updating" : "started" });
  harness.start();
  await setImmediate();
  assert.deepEqual(harness.claims, ["first", "second"]);
  assert.deepEqual(harness.starts.map((start) => start.inputData.datasetId), ["second"]);
  assert.equal(harness.errors.length, 0);
});
