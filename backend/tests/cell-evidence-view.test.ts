import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { CellDetail } from "../../frontend/components/SideSheet.js";
import { getCellDetailView, type CellDetailView } from "../../frontend/lib/cell-evidence-view.js";
import { cellValueKey } from "../../frontend/convex/lib/cell-evidence.js";
import type { CapturedEvidence, DatasetRow } from "../../frontend/components/table/types.js";

const requireFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { createElement } = requireFrontend("react");
const { renderToStaticMarkup } = requireFrontend("react-dom/server");
const columns = [{ name: "Price", type: "number" as const }, { name: "Name", type: "text" as const }];
const selected = { rowId: "row-one", columnName: "Price" };
const capturedAt = Date.parse("2026-10-20T10:00:00Z");
const completedAt = Date.parse("2026-10-20T10:01:00Z");

function source(overrides: Partial<CapturedEvidence> = {}): CapturedEvidence {
  return {
    captureId: "capture-price", kind: "page", url: "https://example.com/price",
    excerpt: "The listed price is 12.", capturedAt, contentSha256: "a".repeat(64),
    runId: "run-latest", ...overrides,
  };
}

function row(): DatasetRow {
  return {
    _id: "row-one", _creationTime: 1, data: { Price: 12, Name: "Example" }, revision: 1,
    sources: ["https://example.com/row"],
    cellEvidence: {
      Price: { valueKey: cellValueKey(12)!, sources: [source()] },
      Name: { valueKey: cellValueKey("Example")!, sources: [source({ captureId: "capture-name", excerpt: "Other column evidence." })] },
    },
    lastEvidenceRefresh: { runId: "run-latest", completedAt, observedColumns: ["Price"] },
  };
}

function render(view: CellDetailView | null): string {
  assert.ok(view);
  return renderToStaticMarkup(createElement(CellDetail, view));
}

test("legacy row links are not presented as captured cell evidence", () => {
  const html = renderToStaticMarkup(createElement(CellDetail, {
    column: { name: "Price", type: "number" },
    value: 12,
    evidence: [],
    rowLinks: ["https://example.com/row"],
    latestRefresh: null,
  }));
  assert.match(html, /No captured evidence/);
  assert.match(html, /Row links/);
  assert.match(html, /https:\/\/example\.com\/row/);
  assert.doesNotMatch(html, /<blockquote/);
});

test("the drawer renders only the selected cell's current captured evidence", () => {
  const view = getCellDetailView(selected, columns, [row()]);
  const html = render(view);
  assert.equal(view?.value, 12);
  assert.equal(view?.evidence.length, 1);
  assert.match(html, /<blockquote[^>]*>The listed price is 12\.<\/blockquote>/);
  assert.match(html, /Page capture/);
  assert.match(html, /href="https:\/\/example\.com\/price"/);
  assert.match(html, /2026-10-20T10:00:00\.000Z/);
  assert.match(html, /SHA-256/);
  assert.match(html, new RegExp("a".repeat(64)));
  assert.match(html, /does not verify this value/);
  assert.match(html, /Captured for this value/);
  assert.doesNotMatch(html, /Other column evidence/);
});

test("a live value change cannot keep a snapshot of old value-bound evidence", () => {
  const original = row();
  assert.match(render(getCellDetailView(selected, columns, [original])), /The listed price is 12/);
  const changed = { ...original, data: { ...original.data, Price: 13 }, revision: 2 };
  const live = getCellDetailView(selected, columns, [changed]);
  assert.equal(live?.value, 13);
  assert.deepEqual(live?.evidence, []);
  const html = render(live);
  assert.match(html, /No captured evidence/);
  assert.match(html, /Not observed for this value/);
  assert.doesNotMatch(html, /The listed price is 12/);

  changed.cellEvidence = {
    Price: { valueKey: cellValueKey(13)!, sources: [source({ excerpt: "The new listed price is 13." })] },
  };
  const refreshed = render(getCellDetailView(selected, columns, [changed]));
  assert.match(refreshed, /The new listed price is 13/);
  assert.doesNotMatch(refreshed, /The listed price is 12/);
});

test("multiple excerpts from one capture are all rendered", () => {
  const multiple = row();
  multiple.cellEvidence!.Price!.sources.push(source({ excerpt: "The same page also lists the price in its summary." }));
  const html = render(getCellDetailView(selected, columns, [multiple]));
  assert.equal((html.match(/<blockquote/g) ?? []).length, 2);
  assert.match(html, /The listed price is 12/);
  assert.match(html, /The same page also lists the price in its summary/);
});

test("row deletion, column removal and query loading have no current drawer content", () => {
  assert.equal(getCellDetailView(selected, columns, []), null);
  assert.equal(getCellDetailView(selected, [], [row()]), null);
  assert.equal(getCellDetailView(selected, columns, undefined), null);
  assert.equal(getCellDetailView(selected, undefined, [row()]), null);
  assert.equal(getCellDetailView(null, columns, [row()]), null);
});

test("equal display text does not bind evidence across different value types", () => {
  const changed = row();
  changed.data.Price = "12";
  assert.deepEqual(getCellDetailView(selected, columns, [changed])?.evidence, []);
});

test("a missing or inherited cell cannot acquire captured evidence", () => {
  const missing = row();
  delete missing.data.Price;
  missing.cellEvidence!.Price!.valueKey = cellValueKey(undefined)!;
  assert.deepEqual(getCellDetailView(selected, columns, [missing])?.evidence, []);

  const inherited = row();
  inherited.data = Object.create({ Price: 12 });
  assert.deepEqual(getCellDetailView(selected, columns, [inherited])?.evidence, []);

  const inheritedEvidence = row();
  inheritedEvidence.cellEvidence = Object.create(inheritedEvidence.cellEvidence);
  assert.deepEqual(getCellDetailView(selected, columns, [inheritedEvidence])?.evidence, []);
});

test("unsupported values and evidence from another column do not become current", () => {
  const invalid = row();
  invalid.data.Price = NaN;
  assert.deepEqual(getCellDetailView(selected, columns, [invalid])?.evidence, []);
  delete invalid.cellEvidence!.Price;
  invalid.data.Price = 12;
  assert.deepEqual(getCellDetailView(selected, columns, [invalid])?.evidence, []);
});

test("a completed refresh may leave older current evidence explicitly not observed", () => {
  const older = row();
  older.lastEvidenceRefresh = { runId: "run-next", completedAt: completedAt + 60_000, observedColumns: [] };
  const view = getCellDetailView(selected, columns, [older]);
  assert.equal(view?.evidence.length, 1);
  assert.deepEqual(view?.latestRefresh, { completedAt: completedAt + 60_000, observed: false });
  const html = render(view);
  assert.match(html, /The listed price is 12/);
  assert.match(html, /Not observed for this value/);
});

test("an observation marker alone cannot claim evidence from its completed run", () => {
  const oldCapture = row();
  oldCapture.cellEvidence!.Price!.sources[0]!.runId = "run-earlier";
  assert.equal(getCellDetailView(selected, columns, [oldCapture])?.latestRefresh?.observed, false);
});

test("pending or cancelled refreshes do not invent a newer evidence timestamp", () => {
  const original = row();
  const before = getCellDetailView(selected, columns, [original])!;
  const pending = { ...original, updateStatus: "pending" as const, revision: 2 };
  assert.deepEqual(getCellDetailView(selected, columns, [pending])?.latestRefresh, before.latestRefresh);
  const cancelled: DatasetRow = { ...pending };
  delete cancelled.updateStatus;
  assert.deepEqual(getCellDetailView(selected, columns, [cancelled])?.latestRefresh, before.latestRefresh);
  delete cancelled.lastEvidenceRefresh;
  assert.match(render(getCellDetailView(selected, columns, [cancelled])), /No completed evidence refresh/);
});

test("captured snippets are escaped and unsafe URLs are displayed without executable links", () => {
  const snippets = row();
  snippets.cellEvidence!.Price!.sources = [source({
    kind: "search_snippet", url: "javascript:alert(1)",
    excerpt: '<script>alert("fixture")</script>',
  })];
  const html = render(getCellDetailView(selected, columns, [snippets]));
  assert.match(html, /Search snippet/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
});
