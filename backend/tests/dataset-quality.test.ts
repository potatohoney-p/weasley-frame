import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateDatasetQuality, QualityInputError } from "../src/evaluation/dataset-quality.js";
import { datasetRowSchema, datasetSchemaSchema, type DatasetSchema } from "../src/pipeline/types.js";

interface Snapshot {
  schema: DatasetSchema;
  rows: { data: Record<string, unknown>; sources?: unknown }[];
}

const fixtureUrl = (name: string) => new URL(`./fixtures/quality/${name}`, import.meta.url);
const readJson = async (name: string) => JSON.parse(await readFile(fixtureUrl(name), "utf8"));
const snapshot = async (): Promise<Snapshot> => readJson("valid.json");

for (const name of ["valid", "mixed"]) {
  test(`${name} synthetic snapshot matches its reviewed expected report`, async () => {
    const input = await readJson(`${name}.json`);
    const original = structuredClone(input);
    const expected = await readJson(`${name}.expected.json`);
    assert.deepEqual(evaluateDatasetQuality(input), expected);
    assert.equal(JSON.stringify(evaluateDatasetQuality(input)), JSON.stringify(expected));
    assert.deepEqual(input, original, "evaluation must not mutate the snapshot");
  });
}

test("the existing primitive validators alone accept the failing corpus", async () => {
  const input: Snapshot = await readJson("mixed.json");
  assert.equal(datasetSchemaSchema.safeParse(input.schema).success, true);
  assert.ok(input.rows.every((row) => datasetRowSchema.safeParse(row.data).success));
  assert.equal(evaluateDatasetQuality(input).passed, false);
});

test("reuses schema validation and does not report unmeasured row checks as zero", async () => {
  const input = await snapshot();
  input.schema.primary_key = "id";
  const report = evaluateDatasetQuality(input);
  assert.equal(report.passed, false);
  assert.equal(report.schema_valid, false);
  assert.equal(report.summary, null);
  assert.deepEqual(report.issues.map((issue) => [issue.code, issue.path]), [["invalid_schema", ["schema", "primary_key"]]]);
});

test("rejects malformed envelopes and fails empty datasets without perfect coverage", async () => {
  for (const input of [null, [], {}, { schema: {}, rows: {} }, { rows: [] }]) {
    assert.throws(() => evaluateDatasetQuality(input), QualityInputError);
  }
  const input = await snapshot();
  input.rows = [];
  const report = evaluateDatasetQuality(input);
  assert.equal(report.passed, false);
  assert.equal(report.summary?.evidence_coverage, null);
  assert.equal(report.issues[0].code, "empty_dataset");
});

test("non-primitive row values and malformed rows are reported without crashing", async () => {
  const input = await snapshot();
  input.rows[0].data.note = { nested: "unsupported" };
  const report = evaluateDatasetQuality({ ...input, rows: [...input.rows, null, { data: [] }] });
  assert.equal(report.passed, false);
  assert.equal(report.summary?.incomplete_key_rows, 2, "a bad non-key cell must not invalidate an otherwise complete key");
  assert.ok(report.issues.some((issue) => issue.code === "invalid_row_data" && issue.path.join(".") === "rows.0.data.note"));
  assert.ok(report.issues.some((issue) => issue.code === "invalid_row"));
});

test("false and zero form a complete composite identity and every duplicate row is invalid", async () => {
  const input = await snapshot();
  input.schema.columns[0].type = "boolean";
  input.rows.forEach((row) => { row.data.id = false; row.data.revision = 0; });
  const report = evaluateDatasetQuality(input);
  assert.equal(report.summary?.incomplete_key_rows, 0);
  assert.equal(report.summary?.duplicate_identity_groups, 1);
  assert.equal(report.summary?.duplicate_rows, 2);
  assert.equal(report.summary?.valid_rows, 0);
  assert.deepEqual(report.issues.at(-1)?.row_indexes, [0, 1]);
});

test("tuple identity encoding avoids delimiter collisions and does not normalize values", async () => {
  const input = await snapshot();
  input.schema.columns[1].type = "string";
  input.rows[0].data.id = "a|b";
  input.rows[0].data.revision = "c";
  input.rows[1].data.id = "a";
  input.rows[1].data.revision = "b|c";
  assert.equal(evaluateDatasetQuality(input).passed, true);
  input.rows[1].data.id = " a|b";
  input.rows[1].data.revision = "c";
  assert.equal(evaluateDatasetQuality(input).passed, true);
});

test("missing, null, blank and type-invalid primary keys never form duplicate groups", async () => {
  const input = await snapshot();
  const row = input.rows[0];
  input.rows = [undefined, null, "\t ", 42].map((id) => {
    const copy = structuredClone(row);
    if (id === undefined) delete copy.data.id;
    else copy.data.id = id;
    return copy;
  });
  const report = evaluateDatasetQuality(input);
  assert.equal(report.summary?.incomplete_key_rows, 4);
  assert.equal(report.summary?.duplicate_identity_groups, 0);
});

test("date policy rejects rollover, ambiguous dates and timestamps without a zone", async () => {
  const input = await snapshot();
  for (const date of ["2026-02-29", "1900-02-29", "2024-04-31", "10/20/2026", "2026-10-20T12:00:00", "2026-10-20T24:00:00Z", "2026-10-20T12:00:00+24:00"]) {
    input.rows[0].data.seen_at = date;
    assert.equal(evaluateDatasetQuality(input).summary?.type_violations, 1, date);
  }
  for (const date of ["2000-02-29", "2026-10-20T12:00:00.123Z", "2026-10-20T12:00:00-07:00"]) {
    input.rows[0].data.seen_at = date;
    assert.equal(evaluateDatasetQuality(input).passed, true, date);
  }
});

test("evidence coverage is row-level, independent of validity and never inferred from source_hint", async () => {
  const input = await snapshot();
  input.rows[0].sources = ["https://example.invalid/a", "https://example.invalid/b"];
  delete input.rows[1].sources;
  let report = evaluateDatasetQuality(input);
  assert.equal(report.summary?.evidence_rows, 1);
  assert.equal(report.summary?.evidence_coverage, 0.5);
  assert.equal(report.summary?.valid_rows, 1);
  input.rows[0].sources = "https://example.invalid/a";
  report = evaluateDatasetQuality(input);
  assert.equal(report.summary?.evidence_rows, 0);
  assert.ok(report.issues.some((issue) => issue.code === "invalid_sources"));
});

test("URL checks reject relative, non-HTTP and whitespace inputs without consulting the network", async () => {
  const input = await snapshot();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Offline evaluation must not fetch"); };
  try {
    for (const url of ["example.invalid", "/relative", "https:example.invalid", "ftp://example.invalid", "https://", "https://example.invalid/a b", "https://example.invalid/\n", null]) {
      input.rows[0].sources = [url];
      assert.equal(evaluateDatasetQuality(input).summary?.evidence_rows, 1, String(url));
    }
    input.rows[0].sources = ["https://does-not-exist.invalid/evidence"];
    assert.equal(evaluateDatasetQuality(input).passed, true, "syntax alone does not establish availability");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("non-finite numbers are invalid even for direct library callers", async () => {
  const input = await snapshot();
  for (const value of [NaN, Infinity, -Infinity]) {
    input.rows[0].data.revision = value;
    const report = evaluateDatasetQuality(input);
    assert.equal(report.passed, false);
    assert.equal(report.summary?.incomplete_key_rows, 1);
  }
});

test("sparse arrays from library callers do not silently pass unchecked rows or sources", async () => {
  const input = await snapshot();
  const report = evaluateDatasetQuality({ ...input, rows: new Array(2) });
  assert.equal(report.passed, false);
  assert.equal(report.summary?.valid_rows, 0);
  const sources = new Array(2);
  sources[1] = "https://example.invalid/evidence";
  input.rows[0].sources = sources;
  assert.ok(evaluateDatasetQuality(input).issues.some((issue) => issue.code === "invalid_source_url"));
});

test("diagnostics do not echo cell values and sort unknown column names", async () => {
  const input = await snapshot();
  input.rows[0].data.z_extra = "private synthetic value";
  input.rows[0].data.a_extra = "private synthetic value";
  input.rows[0].data.active = "private synthetic value";
  const report = evaluateDatasetQuality(input);
  assert.deepEqual(report.issues.filter((issue) => issue.code === "unknown_column").map((issue) => issue.path.at(-1)), ["a_extra", "z_extra"]);
  assert.equal(JSON.stringify(report).includes("private synthetic value"), false);
});

test("CLI emits stable reports and distinguishes quality failures from invocation errors", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const cli = fileURLToPath(new URL("../src/evaluation/cli.ts", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd, encoding: "utf8" });
  for (const [name, status] of [["valid", 0], ["mixed", 1]] as const) {
    const result = run([fileURLToPath(fixtureUrl(`${name}.json`))]);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), await readJson(`${name}.expected.json`));
  }
  for (const args of [[], ["missing-quality-snapshot.json"], ["package.json"], ["README.md"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(typeof JSON.parse(result.stderr).error, "string");
  }
  assert.deepEqual(JSON.parse(run(["README.md"]).stderr), { error: "Input is not valid JSON." });
});
