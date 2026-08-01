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
npm run build            # backend + frontend production builds
```

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

- Per-cell provenance views
- Incremental refreshes
- SQL query support
- Browser automation for interaction-heavy sources
- More deterministic schema and source-quality evaluation

## License

Copyright 2026 Weasley Contributors. Released under the
[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.
