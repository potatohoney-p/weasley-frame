import assert from "node:assert/strict";
import test from "node:test";
import { buildInvestigateAgent } from "../src/mastra/agents/investigate.js";
import { buildRefreshAgent } from "../src/mastra/agents/refresh.js";

const context = {
  authorizedUserId: "synthetic-user",
  workflowRunId: "synthetic-run",
  modelConfig: {
    schemaInference: "synthetic/model",
    populateOrchestrator: "synthetic/model",
    investigateSubagent: "synthetic/model",
  },
};
const columns = [{ name: "Price", type: "number" as const }];

test("research agent factories expose capture-aware inputs and separate tool instances", async () => {
  const first = await buildInvestigateAgent("dataset", context, columns, "unused-synthetic-key").listTools();
  const second = await buildInvestigateAgent("dataset", context, columns, "unused-synthetic-key").listTools();
  assert.notEqual(first.fetch_page, second.fetch_page);
  assert.notEqual(first.search_web, second.search_web);
  const parsed = first.insert_row.inputSchema.parse({
    data: { Price: 12 },
    cell_evidence: { Price: [{ captureId: "synthetic-id", excerpt: "Price: 12" }] },
  });
  assert.equal(parsed.cell_evidence?.Price?.[0]?.captureId, "synthetic-id");
});

test("production agent wiring propagates cancellation to both capture and persistence tools", async () => {
  const signal = AbortSignal.abort();
  const investigate = await buildInvestigateAgent(
    "dataset", context, columns, "unused-synthetic-key", signal,
  ).listTools();
  const refresh = await buildRefreshAgent(
    "dataset", context, columns, "unused-synthetic-key",
    { abortSignal: signal, refreshRow: { id: "row", revision: 0 } },
  ).listTools();
  // Already cancelled tools return before loading credentials or a Convex client.
  for (const tools of [investigate, refresh]) {
    assert.match((await tools.fetch_page.execute({ url: "https://example.test" }))?.error ?? "", /cancel/i);
    assert.match((await tools.search_web.execute({ query: "synthetic" }))?.error ?? "", /cancel/i);
  }
  const inserted = await investigate.insert_row.execute({ data: { Price: 12 } });
  assert.equal(inserted?.success, false);
  assert.match(inserted?.error ?? "", /cancel/i);
  const updated = await refresh.update_row.execute({ rowId: "row", data: { Price: 12 } });
  assert.equal(updated?.success, false);
  assert.match(updated?.error ?? "", /cancel/i);
});
