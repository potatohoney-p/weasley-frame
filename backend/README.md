# Weasley Frame Backend

Fastify server that handles auth, database, and talks to TinyFish APIs.

## Running

```bash
# From the repo root:
cp .env.example .env
# Fill in the root .env file.
cd backend
npm install
npm run dev
```

Starts on [localhost:3501](http://localhost:3501).

## Key Paths

- `src/index.ts` — Fastify server + route setup
- `src/clerk-auth.ts` — Clerk JWT verification
- `src/convex.ts` — Convex HTTP client
- `src/env.ts` — root env loader

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript |
| `npm run build:quality` | Compile the evaluator, reused schema and quality tests |
| `npm run test:quality` | Test the offline dataset evaluator and CLI |
| `npm run eval:quality -- <snapshot.json>` | Print a deterministic quality report |

Server scripts load the repo-root `.env` through `../scripts/with-root-env.mjs`.
The offline quality commands do not load environment files or start the server.

## Offline dataset quality evaluation

From the repository root, using Node.js 22 or newer:

```bash
npm ci --prefix backend --ignore-scripts
npm run build:quality --prefix backend
npm run test:quality --prefix backend
npm run eval:quality --prefix backend -- tests/fixtures/quality/valid.json
npm run eval:quality --prefix backend -- tests/fixtures/quality/mixed.json
```

The first fixture passes (exit 0). The second intentionally fails (exit 1), with
one missing cell, one unknown column, one null violation, five type violations,
one incomplete composite key and a duplicate identity affecting two rows. One
of its three rows has syntactically valid source evidence. Both reports are
checked against reviewed `*.expected.json` files in `tests/fixtures/quality/`.
All fixture values are synthetic; `.invalid` URLs are deliberately not real sources.

Input paths are relative to the backend directory when using `--prefix backend`.
To evaluate your own snapshot, provide an absolute path or a path relative to that
directory. The input is a JSON object:

```json
{
  "schema": { "...": "a full DatasetSchema from src/pipeline/types.ts" },
  "rows": [
    {
      "data": { "id": "synthetic-1", "...": "all declared columns" },
      "sources": ["https://example.invalid/evidence"]
    }
  ]
}
```

The `data` and optional `sources` fields match the row payload used by dataset
tools. Extra row metadata is ignored. Schema validation uses the existing
`datasetSchemaSchema`; primitive row validation uses `datasetRowSchema`.
The standalone library entry point is
`evaluateDatasetQuality(input: unknown)` in `src/evaluation/dataset-quality.ts`.
It does not mutate input, read the environment, access storage, call a model,
fetch URLs, or include timestamps in the report.

### Gate policy and report meaning

- A passing dataset has a valid schema, at least one row and no issues. Invalid
  schemas return `schema_valid: false` and `summary: null`; row checks were not run.
- Every declared column must be present. A nullable column may explicitly contain
  `null`; omission remains a `missing_cell`. Unknown columns are reported.
- Numbers must be finite numbers; booleans must be booleans. No string coercion
  occurs, so `0` and `false` are valid values. String and enum columns require
  strings. Enum membership is **unmeasured**, because the schema has no list of
  allowed enum values.
- URL cells and evidence entries require absolute HTTP(S) URLs accepted by the
  WHATWG URL parser, with an explicit `http://` or `https://` prefix and no
  whitespace/control characters. Dates require a real `YYYY-MM-DD` calendar date
  or an ISO timestamp with seconds and `Z` or a `+/-HH:MM` offset. Ambiguous dates,
  missing timezones, rollover dates and leap seconds are rejected.
- Each primary-key component must be present, non-null, non-blank and type-valid.
  Invalid row-data shapes also count as incomplete keys. Duplicate identities use
  exact typed tuples in the declared key order, without case folding, trimming,
  URL normalization or separator concatenation. Invalid keys never enter duplicate
  groups. A bad non-key cell does not hide an otherwise complete identity.
- `duplicate_rows` counts **all** rows in duplicate groups, including the first
  occurrence. `valid_rows` counts rows with no issues, excluding every duplicate
  participant. Indices in issue paths and `row_indexes` are zero-based.
- `evidence_rows` counts rows with at least one syntactically valid source URL;
  `evidence_coverage` divides that count by **all input rows**, including invalid
  rows. Repeating URLs does not increase coverage. Empty datasets have `null`
  coverage and fail. `source_hint` never counts as row evidence. Missing evidence
  fails the gate; each malformed source entry also fails even if another is valid.

Evidence coverage is a syntactic, row-level check. It does **not** measure whether
a URL is reachable, truthful, credible, fresh, independent, relevant, or supports
any particular cell. There is no per-cell evidence model in this input. A pass is
an offline structural gate, not a verification of research claims.

The CLI writes the report to stdout and returns 0 for pass, 1 for quality issues
(including an invalid schema), or 2 for malformed JSON/input, unreadable files or
invalid invocation. Exit-2 errors are JSON on stderr. No snapshot row values are
included in quality diagnostics; malformed JSON is not echoed. Run with `--silent`
to suppress npm's own banner when redirecting a report:

```bash
npm run --silent eval:quality --prefix backend -- tests/fixtures/quality/valid.json > quality-report.json
```

Reports follow schema-column order, input row order and sorted unknown-column
names. The format has `version: 1`; fixture expectations protect its reproducible
output. The `Dataset quality` CI workflow runs the same corpus and scoped build
without provider credentials or services. The scoped build compiles the evaluator,
its existing schema dependency and tests; it does not need frontend dependencies
or the full application's Convex type graph.
