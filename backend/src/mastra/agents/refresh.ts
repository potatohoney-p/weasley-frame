import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildPopulateTools, type PopulateToolOptions } from "../tools/dataset-tools.js";
import { buildEvidenceWebTools } from "../tools/web-tools.js";
import { EvidenceCaptureRegistry } from "../../pipeline/evidence-capture.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

function buildRefreshInstructions(columns: PopulateColumn[]): string {
  const columnNames = columns.map((c) => c.name);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You are refreshing data for one existing row. Be fast — you have very few steps.

Columns:
${columnsDesc}

RULES:
- You have at most 6 tool calls total.
- Start by following the steps in the "Previously found via" section — it describes exactly how the data was originally extracted (which URLs to fetch, which fields to look for). Reproduce those steps to get fresh data.
- If no "Previously found via" steps are provided, fall back to fetching the source URLs directly.
- If a source returns a 404, timeout, or is blocked, note it and move to the next.
- Compare the fetched data with the existing row data carefully.
- If data has MEANINGFULLY changed (not just formatting differences), call update_row with the FULL updated data object (all columns, not just changed ones), plus updated sources, row_summary, and how_found.
- If NO sources work (all 404/blocked), try ONE web search using the primary key values to find a current source.
- If the data is unchanged but you captured fresh support, call update_row with unchanged values and cell_evidence for the observed columns. This records an observation without counting a data change.
- Never fabricate values. If you can't verify a field, keep the existing value.
- Evidence must reference captureId values from your own search_web or fetch_page results with exact, short excerpts from source text. Do not cite old context prose or a generated truncation notice. Omit evidence for fields you could not observe. Captures do not prove factual correctness.

TOOL CALL FORMAT — every tool call argument must be a JSON object wrapped in curly braces:
  fetch_page: {"url": "https://example.com"}
  search_web: {"query": "your search terms"}
  update_row: {"rowId": "<id>", "data": {${columnNames.map((n) => `"${n}": "value"`).join(", ")}}, "sources": ["https://..."], "row_summary": "one line about this entity", "how_found": "how you verified this data"}

WORKFLOW:
1. Fetch the provided source URLs (1-2 calls).
2. Compare fetched data with existing row data.
3. If changed: call update_row with the full updated data.
   For observed columns add "cell_evidence": {"Column Name": [{"captureId": "<returned captureId>", "excerpt": "<exact source text>"}]}. Do this also for unchanged values that you observed again.
   If sources broken: try ONE search using primary key values, then fetch the best result.
4. Write your final response:
   UPDATED: true/false
   CHANGES: what changed (or "no changes")
   REASON: why you updated or didn't
`;
}

export function buildRefreshAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  openRouterApiKey: string,
  options: Pick<PopulateToolOptions, "refreshRow" | "abortSignal"> = {},
): Agent {
  const modelSlug = authContext.modelConfig!.investigateSubagent;
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    baseURL: process.env.OPENROUTER_BASE_URL,
  });
  const evidenceRegistry = new EvidenceCaptureRegistry(authContext.workflowRunId);
  const { update_row } = buildPopulateTools(
    authorizedDatasetId,
    authContext,
    { ...options, evidenceRegistry },
  );
  return new Agent({
    id: "refresh-agent",
    name: "Dataset Refresh Agent",
    instructions: buildRefreshInstructions(columns),
    model: openrouter(modelSlug),
    tools: {
      update_row,
      ...buildEvidenceWebTools(evidenceRegistry, { abortSignal: options.abortSignal }),
    },
  });
}
