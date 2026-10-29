<p align="center">
  <img src="assets/weasley-frame-mark.png" alt="Weasley Frame mark" width="112" />
</p>

<h1 align="center">Weasley Frame</h1>

<p align="center">
  Turn a plain-language research question into a sourced, refreshable dataset.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-f2ad32" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%3E%3D22-5fa04e" />
  <img alt="Open source" src="https://img.shields.io/badge/Weasley-open%20source-0b1736" />
</p>

![Weasley Frame turns live web sources into verified tables](assets/weasley-frame-hero.png)

Weasley Frame coordinates search, extraction, schema inference, source verification,
deduplication, and scheduled refreshes in one local-first workspace. Describe the
table you need; the agents discover entities, investigate them in parallel, and
produce rows you can inspect or export as CSV/XLSX.

## Why Weasley Frame

- **Prompt to schema:** infer useful columns and primary keys from a sentence.
- **Source-aware research:** retain the URLs used to support collected data.
- **Parallel population:** investigate independent entities concurrently.
- **Refresh schedules:** run manually or every 30 minutes, 6 hours, 12 hours,
  day, or week.
- **Local credentials:** keep provider keys in the operating-system keychain.
- **Portable data:** browse in the UI and export CSV or XLSX.
- **Open development:** Apache-2.0 source, contribution guide, and reproducible
  local stack.

## Architecture

```text
browser
  │
  ▼
Next.js 16 ─────── Convex functions + data
  │                         │
  └──────── Fastify API ────┘
                 │
            Mastra agents
                 │
       TinyFish + OpenRouter
```

The frontend never owns server-side authentication logic. Browser requests are
proxied to the Fastify backend, while Convex owns the application data and
functions. See `AGENTS.md` for repository-specific development constraints.

## Quick start

Prerequisites:

- Node.js 22 or newer
- Git
- Docker with Docker Compose
- GNU Make

Install the launcher and verify the machine:

```bash
npm install --global weasley-frame
weasley-frame doctor
```

Install the managed source checkout and start the local stack:

```bash
weasley-frame install
weasley-frame start
```

The app opens at [http://localhost:3500](http://localhost:3500). The launcher
stores its checkout under `~/.weasley/frame` by default. Override it with
`WEASLEY_FRAME_HOME`.

For a one-off installation:

```bash
npx weasley-frame doctor
npx weasley-frame install
```

### Launcher commands

| Command | Purpose |
| --- | --- |
| `weasley-frame doctor` | Check Node, Git, Docker, Compose, and Make |
| `weasley-frame install` | Clone a shallow managed checkout |
| `weasley-frame update` | Fast-forward a clean managed checkout |
| `weasley-frame start` | Start or recover the complete local stack |
| `weasley-frame stop` | Stop containers while preserving data |
| `weasley-frame path` | Print the managed checkout path |

The updater refuses to touch a modified checkout, so local work is never silently
overwritten.

## Develop from source

```bash
git clone https://github.com/potatohoney-p/weasley-frame.git
cd weasley-frame
make dev
```

`make dev` installs frontend and backend dependencies, starts PostgreSQL and
self-hosted Convex, deploys the Convex functions, starts the local keychain
bridge, then starts the frontend, backend, and Mastra Studio.

| Service | Local URL |
| --- | --- |
| Weasley Frame | <http://localhost:3500> |
| Fastify backend | <http://localhost:3501> |
| Convex | <http://localhost:3210> |
| Convex dashboard | <http://localhost:6791> |
| Mastra Studio | <http://localhost:4111> |

Common commands:

```bash
make dev                 # start or repair the stack
make convex-push         # deploy changes under frontend/convex
make seed-public-datasets
make down                # stop without deleting data
npm test                 # launcher regression tests
npm run test:backend     # offline lifecycle, refresh, capture and cell-view regressions
npm run build            # backend + frontend production builds
```

## Offline dataset quality gate

Evaluate a saved snapshot before comparing research runs or accepting a dataset:

```bash
npm ci --prefix backend --ignore-scripts
npm run test:quality --prefix backend
npm run eval:quality --prefix backend -- tests/fixtures/quality/valid.json
```

The command prints a deterministic JSON report for schema validity, cell types,
null and key completeness, duplicate identities, and row-level source-URL
coverage. The synthetic fixtures use reserved `.invalid` domains and require no
provider keys, running services, or network access during evaluation.

URL syntax and coverage do **not** establish source truth, credibility, live
availability, or support for a particular cell. See the [backend evaluation
contract](backend/README.md#offline-dataset-quality-evaluation) for input format,
exit codes, metric definitions, and limitations.

## Provider configuration

The local setup screen stores credentials in your OS keychain.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TINYFISH_API_KEY` | Yes | Web search and page retrieval |
| `OPENROUTER_API_KEY` | Yes | Model routing for schema and research agents |
| `RESEND_API_KEY` | No | Dataset-ready email notifications |
| `NEXT_PUBLIC_POSTHOG_KEY` | No | Opt-in product analytics |

Create keys at [TinyFish](https://agent.tinyfish.ai/api-keys) and
[OpenRouter](https://openrouter.ai/settings/keys). Weasley Frame is independent
open-source software; provider names and marks remain the property of their
respective owners.

Do not commit `.env` files or credentials. Local API keys are never written into
the repository.

## Project layout

```text
weasley-frame/
├── bin/                 npm launcher
├── frontend/            Next.js UI + Convex functions
├── backend/             Fastify API + Mastra workflows
├── db/                  local PostgreSQL bootstrap
├── scripts/             release and authorization checks
├── tests/               launcher regression tests
└── docker-compose.dev.yml
```

## Security and privacy

- The local keychain bridge binds to `127.0.0.1` and requires a generated token.
- Production auth remains in the backend; do not add frontend auth API routes.
- Web research should target public information and respect source terms,
  robots policies, privacy, and applicable law.
- Report vulnerabilities privately using the process in `SECURITY.md`.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
npm test
npm run build
bash scripts/verify-authz.sh  # requires the local stack
```

Please read `CONTRIBUTING.md`, keep credentials out of commits, and update docs
when a command, environment variable, or architecture boundary changes.

## Roadmap

- Extended provenance history and derived-value lineage
- Incremental refreshes
- SQL query support
- Browser automation for interaction-heavy sources
- Deterministic schema and source-quality evaluation: [offline structural and
  source-URL coverage gate](backend/README.md#offline-dataset-quality-evaluation)
  available; semantic evidence support, source credibility and live availability
  evaluation remain future work

### Refresh correctness

Refresh workers stop dispatching queued rows after cancellation and wait for
in-flight work to finish cleanup. The updated-row count comes from successful
`update_row` tool results for that row, rather than the model's final summary.
Rejected writes count as errors; successful retries count the row once. A mixed
run with errors and unchanged rows remains a partial success, while a stopped
run is recorded as an error in run metrics.

Run `npm run test:backend` after installing backend dependencies to verify these
dispatch and outcome decisions offline, without credentials or model calls.
Live workflow and Convex persistence checks require the supported local stack.

Run cleanup is controller-owned, so a completed runner cannot remove the Stop
signal for a newer run while waiting for its final notification or status
response. See [the repeated-run cancellation contract](docs/run-cancellation.md).

Populate also rejects resolved stream errors and records stopped agent attempts
as errors, while retaining observed usage and the existing partial-results
lifecycle. See [populate completion integrity](docs/populate-completion.md).

### Captured cell evidence

The cell drawer shows column-specific excerpts captured by the research tools,
with source URL, page/snippet kind and capture time. Changed values invalidate
old evidence; unchanged values can record fresh observations without increasing
the changed-row count. Legacy row links remain separate and do not imply that a
particular cell has captured support.

This records observed source text, not factual correctness. See
[the capture, retry and compatibility contract](docs/cell-evidence.md) for
storage bounds, mutation behavior and offline verification limits. Backend
regressions now require both frontend and backend dependencies because they
exercise the actual Convex handlers and render the cell drawer.

## License

Copyright 2026 Weasley Contributors. Released under the
[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.

Manual populate/update requests prepare read-only context and model settings
before claiming a dataset, so a settings outage does not strand it as active.
See [manual startup guarantees and limits](docs/manual-startup.md).
