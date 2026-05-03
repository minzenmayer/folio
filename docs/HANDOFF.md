# Folio · Claude Code handoff

> **Last touched:** Sprint 15 Wave 2.1 (commit `76ee5874`, deployed to
> production at `folio-payton-minzenmayers-projects.vercel.app`).

This document is the **single source of truth** a new Claude Code session needs
to pick up Folio and keep moving without re-reading the full codebase.

---

## 1 — Project in one paragraph

Folio is a **multi-connector data-normalisation + conversation layer** built on
Next.js 14 (App Router, TypeScript). It pulls financial data from several third-
party APIs, normalises everything to a shared schema, stores it in Supabase
(Postgres + pgvector), and exposes a chat interface powered by Anthropic Claude.
The product is deployed on Vercel (production) and developed locally with `pnpm`.

---

## 2 — Repository map (only the non-obvious parts)

```
folio/
├── app/
│   ├── api/          # Next.js route handlers
│   │   ├── chat/     # POST /api/chat  → Claude streaming
│   │   ├── sync/     # POST /api/sync  → runs connector pipeline
│   │   └── health/   # GET  /api/health
│   ├── (dashboard)/  # Authenticated dashboard pages
│   └── layout.tsx
├── components/       # React components (shadcn/ui base)
├── connectors/       # One file per data-source (see §4)
├── lib/
│   ├── db.ts         # Supabase client (anon key, browser-safe)
│   ├── db-server.ts  # Supabase client (service role, server-only)
│   ├── schema.ts     # Zod schemas shared across connectors
│   └── openai.ts     # Re-export of Anthropic client (historical name)
├── docs/             # This file lives here
├── supabase/
│   └── migrations/   # SQL migration files (apply in order)
└── types/            # Global TypeScript types
```

---

## 3 — Active sprint: Sprint 15 Wave 3

See **`docs/WAVE-3-BRIEF.md`** for the full brief.

**TL;DR for Wave 3:**
- Improve assistant synthesis quality (reduce hallucination, improve citation)
- Add a confidence-score field to the normalised schema
- Surface confidence in the chat UI (colour-coded badge)
- All work should be covered by Vitest unit tests

Wave 2 shipped: connector health dashboard, bulk-sync endpoint, Plaid OAuth
flow. Those are done — don't revisit unless a Wave 3 task depends on them.

---

## 4 — Connector architecture

See **`docs/CONNECTORS.md`** for the full spec.

**Quick ref:**

| Connector | File | Status |
|-----------|------|--------|
| Plaid (banking) | `connectors/plaid.ts` | ✅ live |
| Polygon.io (stocks) | `connectors/polygon.ts` | ✅ live |
| CoinGecko (crypto) | `connectors/coingecko.ts` | ✅ live |
| Zillow (real-estate) | `connectors/zillow.ts` | 🚧 stubbed |
| Manual CSV | `connectors/csv.ts` | ✅ live |

All connectors export:
```ts
export interface Connector {
  id: string
  displayName: string
  sync(userId: string, options?: SyncOptions): Promise<SyncResult>
  healthCheck(): Promise<HealthStatus>
}
```

---

## 5 — Environment & credentials

See **`docs/ENVIRONMENT.md`** for the full list.

**Never commit secrets.** `.env.local` is gitignored. Vercel env vars are
configured in the Vercel dashboard; the CI pipeline reads from GitHub Actions
secrets.

Minimum local `.env.local` to run the dev server:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=...
```

---

## 6 — How to run locally

```bash
# 1. Install deps
pnpm install

# 2. Start Supabase local stack (Docker required)
npx supabase start

# 3. Apply any pending migrations
npx supabase db push

# 4. Copy env template and fill in values
cp .env.example .env.local

# 5. Start the dev server
pnpm dev
```

App available at `http://localhost:3000`.

---

## 7 — Key conventions

| Convention | Rule |
|------------|------|
| Imports | Path alias `@/` maps to repo root |
| Server vs client | Files in `app/api/` and `lib/*-server.ts` are server-only |
| Env vars | Public vars prefixed `NEXT_PUBLIC_`; server-only vars unprefixed |
| DB access | Always use `db-server.ts` in route handlers; `db.ts` in client components |
| Error handling | Throw typed errors from `lib/errors.ts`; catch at route-handler boundary |
| Tests | Vitest; test files co-located as `*.test.ts` |
| Formatting | Prettier default config; `pnpm format` before committing |

---

## 8 — Known issues / tech debt

- `connectors/zillow.ts` is a stub — returns mock data. Real Zillow API
  integration is scheduled for Sprint 16.
- The `lib/openai.ts` name is a historical artefact; it actually exports the
  Anthropic client. Rename tracked in issue #47.
- Supabase RLS policies for the `assets` table are overly permissive (issue #52).
  Tighten before any multi-tenant work.
- `app/(dashboard)/portfolio/page.tsx` has a known hydration mismatch on first
  load (issue #61). Workaround: `suppressHydrationWarning` is in place.

---

## 9 — Useful one-liners

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test --watch

# Type-check without building
pnpm tsc --noEmit

# Lint
pnpm lint

# Build for production
pnpm build

# Trigger a full sync (all connectors) via API
curl -X POST http://localhost:3000/api/sync \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <service_token>' \
  -d '{"connectors": "all"}'
```

---

## 10 — Who to ask / context sources

- **Sprint brief:** `docs/WAVE-3-BRIEF.md`
- **Connector contracts:** `docs/CONNECTORS.md`
- **Environment / secrets layout:** `docs/ENVIRONMENT.md`
- **Kickoff prompt template:** `docs/CLAUDE-CODE-KICKOFF.md`
- **GitHub issues:** `https://github.com/minzenmayer/folio/issues`
- **Vercel deployments:** `https://vercel.com/minzenmayers-projects/folio`
