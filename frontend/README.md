# Weasley Frame Frontend

Next.js 16 app — the UI for Weasley Frame.

## Running

```bash
npm install
npm run dev
```

Opens on [localhost:3500](http://localhost:3500). Package scripts load root
`.env` before starting Next.js. The supported full-stack dev path is still
`make dev` from the repo root.

## Key Paths

- `app/page.tsx` — Landing page
- `app/sign-in/` and `app/sign-up/` — Clerk sign in + sign up
- `app/dashboard/` — Main dashboard (protected)
- `lib/backend.ts` — Backend API client
- `proxy.ts` — Clerk route protection

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
