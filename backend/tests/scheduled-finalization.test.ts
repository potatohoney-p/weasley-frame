import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as datasets from "../../frontend/convex/datasets.js";
import { deregisterDataset, getSignal, registerDataset } from "../src/abort-registry.js";

type RecordDoc = Record<string, any>;
type Terminal = "completeScheduledRefreshInternal" | "failScheduledRefreshInternal";
const terminals: Terminal[] = ["completeScheduledRefreshInternal", "failScheduledRefreshInternal"];
const interval = 30 * 60 * 1000;

// Exercise the real Convex handlers with synthetic storage. This records writes
// and models field removal, but does not simulate Convex dispatch or transactions.
function fixture(overrides: RecordDoc = {}) {
  let document: RecordDoc | null = {
    _id: "dataset", ownerId: "owner", name: "Synthetic dataset", description: "", columns: [],
    status: "live", refreshEnabled: true, refreshCadence: "30m", nextRefreshAt: 1,
    lastRefreshAt: 0, ...overrides,
  };
  const writes: RecordDoc[] = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    db: {
      get: async (id: string) => { assert.equal(id, "dataset"); return structuredClone(document); },
      patch: async (id: string, fields: RecordDoc) => {
        assert.equal(id, "dataset");
        assert.ok(document);
        writes.push(structuredClone(fields));
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) delete document[key];
          else document[key] = structuredClone(value);
        }
      },
    },
  };
  async function invoke(name: keyof typeof datasets, args: RecordDoc = {}) {
    const mutation = datasets[name] as unknown as {
      _handler: (ctx: unknown, args: RecordDoc) => Promise<any>;
    };
    return mutation._handler(ctx, { id: "dataset", ...args });
  }
  return {
    invoke, writes, snapshot: () => structuredClone(document), remove: () => { document = null; },
    claim: (runId: string, now = 100) => invoke("claimScheduledRefreshInternal", { runId, now, staleAfterMs: 10 }),
    finish: (name: Terminal, runId: string, now = 112) => invoke(name, { runId, now, ...(name === "failScheduledRefreshInternal" ? { lastStatusError: "Synthetic failure" } : {}) }),
  };
}

for (const terminal of terminals) {
  test(`${terminal}: a reclaimed worker cannot finalize its successor`, async () => {
    const state = fixture();
    assert.equal((await state.claim("A")).outcome, "started");
    assert.equal((await state.claim("B", 111)).outcome, "started");
    const successor = state.snapshot();
    const writes = state.writes.length;
    assert.equal((await state.finish(terminal, "A")).outcome, "stale_run");
    assert.deepEqual(state.snapshot(), successor);
    assert.equal(state.writes.length, writes);

    const success = terminal === "completeScheduledRefreshInternal";
    assert.equal((await state.finish(terminal, "B", 113)).outcome, success ? "completed" : "failed");
    assert.equal(state.snapshot()!.status, success ? "live" : "failed");
    assert.equal(state.snapshot()!.lastRefreshAt, success ? 113 : 0);
    assert.equal(state.snapshot()!.lastStatusError, success ? undefined : "Synthetic failure");
    assert.equal(state.snapshot()!.nextRefreshAt, 113 + interval);
    assert.equal(state.snapshot()!.lastRefreshStartedAt, undefined);
    assert.equal(state.snapshot()!.lastRefreshRunId, "B", "retain the last run for correlation");
  });

  for (const repeated of terminals) {
    test(`${terminal} followed by ${repeated} preserves the first terminal result`, async () => {
      const state = fixture();
      await state.claim("A");
      await state.finish(terminal, "A");
      const completed = state.snapshot();
      const writes = state.writes.length;
      assert.equal((await state.finish(repeated, "A", 900)).outcome, "stale_run");
      assert.deepEqual(state.snapshot(), completed);
      assert.equal(state.writes.length, writes);
    });
  }

  test(`${terminal}: incomplete or inactive ownership is a no-op`, async () => {
    const cases: RecordDoc[] = [
      { lastRefreshRunId: undefined }, { lastRefreshStartedAt: undefined }, { lastRefreshRunId: "other" },
      ...["live", "paused", "building", "failed"].map((status) => ({ status })),
    ];
    for (const overrides of cases) {
      const state = fixture({ status: "updating", lastRefreshRunId: "A", lastRefreshStartedAt: 100, ...overrides });
      const before = state.snapshot();
      assert.equal((await state.finish(terminal, "A")).outcome, "stale_run", JSON.stringify(overrides));
      assert.deepEqual(state.snapshot(), before);
      assert.equal(state.writes.length, 0);
    }
    const missing = fixture();
    missing.remove();
    assert.equal((await missing.finish(terminal, "A")).outcome, "not_found");
    assert.equal(missing.writes.length, 0);
  });
}

test("terminal validators require the workflow run ID", () => {
  for (const name of terminals) {
    const registered = datasets[name] as unknown as { exportArgs: () => string };
    const validator = JSON.parse(registered.exportArgs());
    assert.deepEqual(validator.value.runId, { fieldType: { type: "string" }, optional: false });
  }
});

for (const manual of ["beginPopulateInternal", "beginUpdateInternal"] as const) {
  test(`Stop then ${manual} cannot inherit an orphaned scheduled claim`, async () => {
    const state = fixture();
    await state.claim("orphan");
    await state.invoke("setStatusInternal", { status: "failed", lastStatusError: "Stopped orphan" });
    assert.equal((await state.invoke(manual, { ownerId: "owner" })).outcome, "started");
    const active = state.snapshot();
    assert.equal(active!.lastRefreshStartedAt, undefined);
    assert.equal((await state.claim("replacement", 1000)).outcome, manual === "beginPopulateInternal" ? "already_building" : "already_updating");
    for (const terminal of terminals) assert.equal((await state.finish(terminal, "orphan", 1001)).outcome, "stale_run");
    assert.deepEqual(state.snapshot(), active);
  });

  test(`${manual} also clears timestamps left by an older backend`, async () => {
    const state = fixture({ status: "failed", lastRefreshRunId: "legacy", lastRefreshStartedAt: 100 });
    assert.equal((await state.invoke(manual, { ownerId: "owner" })).outcome, "started");
    assert.equal(state.snapshot()!.lastRefreshStartedAt, undefined);
    assert.equal(state.snapshot()!.lastRefreshRunId, "legacy");
  });

  test(`${manual} rejects a busy or unauthorized claim without revoking the scheduled owner`, async () => {
    const state = fixture();
    await state.claim("A");
    const before = state.snapshot();
    const writes = state.writes.length;
    assert.equal((await state.invoke(manual, { ownerId: "other" })).outcome, "forbidden");
    assert.equal((await state.invoke(manual, { ownerId: "owner" })).outcome, "already_updating");
    assert.deepEqual(state.snapshot(), before);
    assert.equal(state.writes.length, writes);
  });
}

test("non-scheduled status transitions revoke the active scheduled marker", async () => {
  for (const [name, statuses] of [
    ["setStatusInternal", ["live", "paused", "building", "updating", "failed"]],
    ["updateStatus", ["live", "paused", "building"]],
  ] as const) {
    for (const status of statuses) {
      const state = fixture();
      await state.claim("A");
      await state.invoke(name, { status });
      assert.equal(state.snapshot()!.lastRefreshStartedAt, undefined, `${name}: ${status}`);
      const transitioned = state.snapshot();
      for (const terminal of terminals) assert.equal((await state.finish(terminal, "A")).outcome, "stale_run");
      assert.deepEqual(state.snapshot(), transitioned);
    }
  }
});

test("current finalization uses the latest cadence, including disabled refresh", async () => {
  for (const terminal of terminals) {
    for (const cadence of ["6h", "manual"] as const) {
      const state = fixture({ status: "updating", lastRefreshStartedAt: 0, lastRefreshRunId: "A", refreshCadence: cadence, refreshEnabled: cadence !== "manual" });
      assert.notEqual((await state.finish(terminal, "A")).outcome, "stale_run");
      assert.equal(state.snapshot()!.nextRefreshAt, cadence === "manual" ? undefined : 112 + 6 * 60 * 60 * 1000);
    }
  }
});

// Compile the actual runner, without the entrypoint's server/credentials/providers.
// Its mutation calls go through the real handlers above, including failure fallback.
async function runner(state: ReturnType<typeof fixture>, afterMutation?: (name: Terminal) => Promise<void>) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "runScheduledUpdateWorkflowInBackground");
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls: Array<{ name: Terminal; args: RecordDoc }> = [];
  const loaded = runInNewContext(`${compiled}\nrunScheduledUpdateWorkflowInBackground`, {
    registerDataset, deregisterDataset, Error, Date: { now: () => 112 },
    statusErrorMessage: (error: Error) => error.message,
    internal: { datasets: Object.fromEntries(terminals.map((name) => [name, name])) },
    convex: { mutation: async (name: Terminal, args: RecordDoc) => {
      calls.push({ name, args });
      const result = await state.invoke(name, args);
      await afterMutation?.(name);
      return result;
    } },
  }) as (args: RecordDoc) => Promise<void>;
  return {
    calls,
    start: (start: () => Promise<unknown>) => loaded({
      input: { datasetId: "dataset", datasetName: "Synthetic dataset", description: "", columns: [] },
      run: { runId: "A", start }, authorizedUserId: "owner", modelConfig: {},
      logger: { info() {}, error() {} },
    }),
  };
}

for (const success of [true, false]) {
  test(`runner passes its run ID for ${success ? "success" : "failure"} after another worker reclaims`, async () => {
    const state = fixture();
    await state.claim("A");
    const background = await runner(state);
    let successor: RecordDoc | null;
    await background.start(async () => {
      assert.ok(getSignal("dataset"));
      assert.equal((await state.claim("B", 111)).outcome, "started");
      successor = state.snapshot();
      return { status: success ? "success" : "failed", steps: {} };
    });
    assert.equal(background.calls.length, 1);
    assert.equal(background.calls[0].name, terminals[success ? 0 : 1]);
    assert.equal(background.calls[0].args.runId, "A");
    assert.deepEqual(state.snapshot(), successor!);
    assert.equal(getSignal("dataset"), undefined);
  });
}

for (const reclaim of [false, true]) {
  test(`committed success with a lost response preserves ${reclaim ? "a subsequent claim" : "the terminal result"}`, async () => {
    const state = fixture();
    await state.claim("A");
    let committed: RecordDoc | null;
    const background = await runner(state, async (name) => {
      if (name !== "completeScheduledRefreshInternal") return;
      if (reclaim) assert.equal((await state.claim("B", 112 + interval)).outcome, "started");
      committed = state.snapshot();
      throw new Error("Synthetic response lost after commit");
    });
    await background.start(async () => ({ status: "success", steps: {} }));
    assert.deepEqual(background.calls.map((call) => call.name), terminals);
    assert.deepEqual(background.calls.map((call) => call.args.runId), ["A", "A"]);
    assert.deepEqual(state.snapshot(), committed!);
    assert.equal(getSignal("dataset"), undefined);
  });
}
