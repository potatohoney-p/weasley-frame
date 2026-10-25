import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildPopulateTools } from "../tools/dataset-tools.js";
import { buildEvidenceWebTools } from "../tools/web-tools.js";
import { EvidenceCaptureRegistry } from "../../pipeline/evidence-capture.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

function buildInvestigateInstructions(columns: PopulateColumn[]): string {
  const columnNames = columns.map((c) => c.name);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You research one entity and insert one row. Be fast — you have very few steps.

Columns:
${columnsDesc}

RULES:
- Do NOT fetch the same URL twice. If a fetch worked, use the data you got.
- You have at most 6 tool calls total. Budget them: 1 fetch + 1 search + 1 fetch + 1 insert = done.
- ALWAYS insert a row, even if some fields are incomplete. Use "" for unknown fields. Partial real data is better than no row.
- Never fabricate values. Use "" for anything you cannot verify.
- For each supported cell, include cell_evidence with the captureId returned by your own search_web or fetch_page call and an exact, short excerpt from its source text. Do not cite context prose or a generated truncation notice. A captured excerpt records what you saw; it does not prove the value is true.
- insert_row rejects duplicates based on primary key columns. If you get a "Duplicate" error, do NOT retry — report INSERTED: false and move on.

TOOL CALL FORMAT — every tool call argument must be a JSON object wrapped in curly braces:
  search_web: {"query": "your search terms"}
  fetch_page: {"url": "https://example.com"}
  insert_row: {"data": {${columnNames.map((n) => `"${n}": "value"`).join(", ")}}, "sources": ["https://url-you-fetched.com"], "row_summary": "one line about this entity", "how_found": "step by step guide on how to extract the data so an agent in the future can do it too"}

WORKFLOW:
1. Fetch 1-2 of the provided URLs to get real data (if URLs were given).
2. If you need more, run ONE search and fetch the best result.
3. Call insert_row with whatever real data you have. Use "" for missing fields.
   Include "sources" (URLs you fetched), "row_summary" (one line about this entity), and "how_found" (a step by step guide on how you found this data. eg, 1. fetch the contents of this url "<insert url>", 2. Look for the pricing field, and title name field, 3. etc...)
   Add "cell_evidence": {"Column Name": [{"captureId": "<returned captureId>", "excerpt": "<exact source text>"}]} for columns with captured support. Omit unsupported columns.
4. Write your final response:
   INSERTED: true/false
   SUMMARY: one line
   CLUES: hints for finding more entities
   REASON: why you succeeded or what was missing
`;
}

/**
 * Build an investigate Agent that researches one entity and inserts a single row.
 *
 * Scoped to the same authorized dataset as the orchestrator via the same
 * closure-based security model (buildPopulateTools). A fresh instance is
 * constructed per investigate_row tool call; do not cache or share.
 */
export function buildInvestigateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  openRouterApiKey: string,
  abortSignal?: AbortSignal,
  confirmedInsertIds?: Set<string>,
): Agent {
  const modelSlug = authContext.modelConfig!.investigateSubagent;
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    baseURL: process.env.OPENROUTER_BASE_URL,
  });

  const evidenceRegistry = new EvidenceCaptureRegistry(authContext.workflowRunId);
  const { insert_row } = buildPopulateTools(
    authorizedDatasetId,
    authContext,
    { evidenceRegistry, abortSignal, confirmedInsertIds },
  );
  return new Agent({
    id: "investigate-agent",
    name: "Dataset Investigate Agent",
    instructions: buildInvestigateInstructions(columns),
    model: openrouter(modelSlug),

    tools: {
      insert_row,
      ...buildEvidenceWebTools(evidenceRegistry, { abortSignal }),
    },
  });
}
