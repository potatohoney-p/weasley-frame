import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EvidenceCaptureRegistry } from "../src/pipeline/evidence-capture.js";

test("captured references retain server metadata and require an exact observed excerpt", () => {
  const registry = new EvidenceCaptureRegistry("run-one", { now: () => 123, id: () => "capture-one" });
  const capture = registry.capture({ kind: "page", url: "https://example.test/page", text: "Observed: thirty seats." });
  const evidence = registry.resolve(capture.captureId, "thirty seats");
  assert.deepEqual(evidence, {
    captureId: "capture-one", kind: "page", url: "https://example.test/page",
    excerpt: "thirty seats", capturedAt: 123, runId: "run-one",
    contentSha256: createHash("sha256").update("Observed: thirty seats.").digest("hex"),
  });
  assert.throws(() => registry.resolve(capture.captureId, "sixty seats"), /not present/);
  assert.throws(() => new EvidenceCaptureRegistry("other-run").resolve(capture.captureId, "thirty seats"), /Unknown capture/);
});

test("capture limits do not turn omitted text or presentation notices into evidence", () => {
  let next = 0;
  const registry = new EvidenceCaptureRegistry("run", { id: () => `capture-${++next}` });
  const capture = registry.capture({ kind: "page", url: "https://example.test", text: "a".repeat(15000) + "omitted tail" });
  assert.throws(() => registry.resolve(capture.captureId, "omitted tail"), /not present/);
  assert.throws(() => registry.resolve(capture.captureId, "[Truncated"), /not present/);
  assert.throws(() => registry.resolve(capture.captureId, "a".repeat(1025)), /1024/);
  assert.throws(() => registry.resolve(capture.captureId, " "), /empty/);
  for (let i = 1; i < 32; i++) registry.capture({ kind: "search_snippet", url: "https://example.test", text: "snippet" });
  assert.throws(() => registry.capture({ kind: "page", url: "https://example.test", text: "extra" }), /32/);
  assert.equal(registry.resolve(capture.captureId, "aaa").captureId, capture.captureId);
});

test("generated metadata respects persistence identifier and timestamp bounds", () => {
  assert.throws(() => new EvidenceCaptureRegistry("r".repeat(129)), /128/);
  const input = { kind: "page" as const, url: "https://example.test", text: "Observed evidence" };
  assert.throws(() => new EvidenceCaptureRegistry("run", { id: () => "c".repeat(129) }).capture(input), /128/);
  for (const time of [-1, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.throws(() => new EvidenceCaptureRegistry("run", { now: () => time }).capture(input), /capture time/);
  }
  const collision = new EvidenceCaptureRegistry("run", { id: () => "same" });
  collision.capture(input);
  assert.throws(() => collision.capture(input), /unique/);
});
