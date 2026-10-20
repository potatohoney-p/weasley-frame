import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "../../fetch-timeout.js";
import { EvidenceCaptureRegistry, MAX_CAPTURE_CHARS } from "../../pipeline/evidence-capture.js";

export interface EvidenceWebDependencies {
  fetch?: typeof globalThis.fetch;
  credentials?: () => Promise<{ apiKey?: string; headers: Record<string, string> }>;
  abortSignal?: AbortSignal;
}

async function defaultCredentials() {
  const { getTinyFishApiKey, tinyFishHeaders } = await import("../../local-credentials.js");
  const apiKey = await getTinyFishApiKey();
  return { apiKey, headers: apiKey ? tinyFishHeaders(apiKey) : {} };
}

/** Keep cancellation effective through body consumption, even for stalled readers. */
function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      const error = new Error("Operation aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      operation().then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
  captureId: z.string().optional(),
});

function buildWebTools(registry?: EvidenceCaptureRegistry, dependencies: EvidenceWebDependencies = {}) {
const credentials = dependencies.credentials ?? defaultCredentials;
const request = dependencies.fetch ?? globalThis.fetch;
const searchWebTool = createTool({
  id: "search_web",
  description:
    'Search the web for information. Returns a list of results with titles, snippets, and URLs. Call with: {"query": "your search terms"}',
  inputSchema: z.object({
    query: z.string().describe("The search query string"),
  }),
  outputSchema: z.object({
    results: z.array(searchResultSchema).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }) => {
    if (!query?.trim())
      return { error: "query is required and cannot be empty." };

    if (dependencies.abortSignal?.aborted) return { error: "Web search cancelled." };
    if (registry?.remainingCaptures === 0) return { error: "Evidence capture limit reached (32)." };
    const { apiKey, headers } = await credentials();
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Web search is unavailable — use synthetic data instead." };

    const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
    console.log(`[search_web] Searching: "${query}"`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const signal = dependencies.abortSignal ? AbortSignal.any([controller.signal, dependencies.abortSignal]) : controller.signal;
    try {
      const res = await abortable(signal, () => request(url, {
        headers,
        signal,
      }));

      if (!res.ok) {
        const body = await abortable(signal, () => res.text());
        console.error(`[search_web] API error ${res.status}:`, body.slice(0, 200));
        if (res.status === 429)
          return { error: "Search rate limit hit. Wait a moment, or skip web search and use synthetic data." };
        if (res.status === 401)
          return { error: "Invalid TINYFISH_API_KEY. Web search unavailable — use synthetic data." };
        return { error: `Search API returned HTTP ${res.status}. Try a different query or use synthetic data.` };
      }

      const data = await abortable(signal, () => res.json());
      if (dependencies.abortSignal?.aborted) return { error: "Web search cancelled." };
      const candidates = Array.isArray(data.results) ? data.results.filter((r: Record<string, unknown>) =>
        r && typeof r.title === "string" && typeof r.snippet === "string" && typeof r.url === "string") : [];
      const selected = registry ? candidates.slice(0, Math.min(10, registry.remainingCaptures)) : candidates;
      const results = selected.map((r: Record<string, unknown>) => {
        const result = { title: String(r.title ?? ""), snippet: String(r.snippet ?? ""), url: String(r.url ?? "") };
        if (!registry || !result.snippet.trim()) return result;
        result.snippet = result.snippet.slice(0, MAX_CAPTURE_CHARS);
        const capture = registry.capture({ kind: "search_snippet", url: result.url, text: result.snippet });
        return { ...result, captureId: capture.captureId };
      });

      console.log(`[search_web] Got ${results.length} results`);
      if (results.length === 0)
        return { results: [], error: "No results found for this query. Try a broader search or use synthetic data." };
      return { results };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        return { error: dependencies.abortSignal?.aborted ? "Web search cancelled." : "Search timed out. Skip web search and use synthetic data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[search_web] Failed:`, msg);
      return { error: `Search failed: ${msg}. Skip web search and use synthetic data.` };
    } finally {
      clearTimeout(timeout);
    }
  },
});

const fetchPageTool = createTool({
  id: "fetch_page",
  description:
    'Fetch a web page and extract its content as clean markdown text. Call with: {"url": "https://example.com/page"}',
  inputSchema: z.object({
    url: z.string().describe("The full URL to fetch, starting with https://"),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    text: z.string().optional(),
    error: z.string().optional(),
    captureId: z.string().optional(),
  }),
  execute: async ({ url: targetUrl }) => {
    if (!targetUrl?.trim())
      return { error: "url is required and cannot be empty." };
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
      return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };

    if (dependencies.abortSignal?.aborted) return { error: "Page fetch cancelled." };
    if (registry?.remainingCaptures === 0) return { error: "Evidence capture limit reached (32)." };
    const { apiKey, headers } = await credentials();
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Page fetch is unavailable — use data from search snippets instead." };

    console.log(`[fetch_page] Fetching: ${targetUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const signal = dependencies.abortSignal ? AbortSignal.any([controller.signal, dependencies.abortSignal]) : controller.signal;
    try {
      const res = await abortable(signal, () => request("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ urls: [targetUrl], format: "markdown" }),
        signal,
      }));

      if (!res.ok) {
        const body = await abortable(signal, () => res.text());
        console.error(`[fetch_page] API error ${res.status}:`, body.slice(0, 200));
        if (res.status === 429)
          return { error: "Fetch rate limit hit. Use data from search snippets instead." };
        if (res.status === 401)
          return { error: "Invalid TINYFISH_API_KEY. Page fetch unavailable." };
        return { error: `Fetch API returned HTTP ${res.status}. Try a different URL or use search snippet data.` };
      }

      const data = await abortable(signal, () => res.json());

      if (data.errors?.length > 0) {
        const err = data.errors[0];
        console.log(`[fetch_page] Failed: ${err.error}`);
        const hints: Record<string, string> = {
          bot_blocked: "This site blocks automated access. Use the search snippet data instead.",
          timeout: "Page took too long to load. Try a different URL.",
          target_unreachable: "Could not connect to this site. Try a different URL.",
          page_not_found: "Page not found (404). The URL may be outdated. Try a different one.",
          target_http_error: `Site returned HTTP ${err.status ?? "error"}. Try a different URL.`,
        };
        return { error: hints[err.error] ?? `Fetch failed: ${err.error}. Try a different URL.` };
      }

      const page = data.results?.[0];
      if (typeof page?.text !== "string" || !page.text.trim())
        return { error: "Page loaded but had no extractable text content. Try a different URL." };

      if (dependencies.abortSignal?.aborted) return { error: "Page fetch cancelled." };
      const body = String(page.text);
      const captured = registry?.capture({ kind: "page", url: targetUrl, text: body });
      let text = body;
      const MAX_CHARS = MAX_CAPTURE_CHARS;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n\n[Truncated — showing first ${MAX_CHARS} of ${page.text.length} chars]`;
      }

      console.log(`[fetch_page] Got ${(page.text as string).length} chars from "${page.title}" (returning ${text.length})`);
      return {
        title: page.title as string | undefined,
        text,
        ...(captured ? { captureId: captured.captureId } : {}),
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        return { error: dependencies.abortSignal?.aborted ? "Page fetch cancelled." : "Page fetch timed out. Try a different URL or use search snippet data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fetch_page] Failed:`, msg);
      return { error: `Fetch failed: ${msg}. Use data from search snippets instead.` };
    } finally {
      clearTimeout(timeout);
    }
  },
});
return { search_web: searchWebTool, fetch_page: fetchPageTool };
}

/** Captures are scoped to the exact run/agent that receives these tool instances. */
export function buildEvidenceWebTools(registry: EvidenceCaptureRegistry, dependencies: EvidenceWebDependencies = {}) {
  return buildWebTools(registry, dependencies);
}

const untrackedTools = buildWebTools();
export const searchWebTool = untrackedTools.search_web;
export const fetchPageTool = untrackedTools.fetch_page;
