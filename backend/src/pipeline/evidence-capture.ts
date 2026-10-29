import { createHash, randomUUID } from "node:crypto";

/** Serialized contract shared with Convex, with no frontend runtime dependency. */
export interface CapturedEvidence {
  captureId: string;
  kind: "page" | "search_snippet";
  url: string;
  excerpt: string;
  capturedAt: number;
  contentSha256: string;
  runId: string;
}

export const MAX_CAPTURE_CHARS = 15000;
export const MAX_CAPTURES = 32;
export const MAX_EVIDENCE_COLUMNS = 64;
export const MAX_SOURCES_PER_CELL = 4;
export const MAX_EXCERPT_LENGTH = 1024;

type StoredCapture = Omit<CapturedEvidence, "excerpt"> & { text: string };

/** One registry per run/agent. IDs, time and hashes never come from tool inputs. */
export class EvidenceCaptureRegistry {
  private readonly captures = new Map<string, StoredCapture>();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    readonly runId: string,
    dependencies: { now?: () => number; id?: () => string } = {},
  ) {
    if (!runId?.trim() || runId.length > 128) throw new Error("Evidence capture runId must contain 1 to 128 characters");
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
  }

  get remainingCaptures(): number { return MAX_CAPTURES - this.captures.size; }

  capture(input: { kind: CapturedEvidence["kind"]; url: string; text: string }): Omit<StoredCapture, "text"> {
    if (this.captures.size >= MAX_CAPTURES) throw new Error("Evidence capture limit reached (32)");
    if (input.kind !== "page" && input.kind !== "search_snippet") throw new Error("Invalid capture kind");
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || input.url.length > 2048) throw new Error("Invalid capture URL");
    if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Capture text cannot be empty");
    const text = input.text.slice(0, MAX_CAPTURE_CHARS);
    const captureId = this.id();
    if (!captureId?.trim() || captureId.length > 128 || this.captures.has(captureId)) throw new Error("Capture ID must be unique and contain 1 to 128 characters");
    const capturedAt = this.now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0 || Number.isNaN(new Date(capturedAt).getTime())) throw new Error("Invalid capture time");
    const metadata = {
      captureId, kind: input.kind, url: input.url, capturedAt,
      contentSha256: createHash("sha256").update(text).digest("hex"), runId: this.runId,
    };
    this.captures.set(captureId, { ...metadata, text });
    return { ...metadata };
  }

  resolve(captureId: string, excerpt: string): CapturedEvidence {
    const capture = this.captures.get(captureId);
    if (!capture) throw new Error("Unknown capture in this run/agent registry");
    if (typeof excerpt !== "string" || !excerpt.trim()) throw new Error("Evidence excerpt cannot be empty");
    if (excerpt.length > MAX_EXCERPT_LENGTH) throw new Error("Evidence excerpt exceeds 1024 characters");
    if (!capture.text.includes(excerpt)) throw new Error("Evidence excerpt is not present in the captured content");
    const { text: _text, ...metadata } = capture;
    return { ...metadata, excerpt };
  }
}
