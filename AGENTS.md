# Weasley Frame — Agent Guidelines

## Architecture

- **Frontend** (`frontend/`): Next.js 16, React 19, Tailwind 4. Pure UI — no server-side auth logic.
- **Backend** (`backend/`): Fastify, TypeScript, ESM. Owns auth, provider calls, and scheduled refreshes.
- Clerk protects production routes and Convex owns application data/functions. Do not add custom auth API routes to the frontend.

## What not to do

- Do not add API routes to the frontend. All API logic belongs in the backend.
- Do not hardcode ports. Read from env vars such as `PORT`, `CLIENT_ORIGIN`, and `CONVEX_URL`.
- Do not commit `.env` files or secrets.

## Dev setup

`make dev` starts everything via Docker (Postgres, backend, frontend). That's the only supported dev workflow.
