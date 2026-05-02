# Folio

A studio for your own thinking. From you, not for you.

> Other tools write _for_ you. Folio writes _from_ you.

This is the v0 codebase, Sprint 1.

---

## Stack

- Next.js 15 (App Router) · TypeScript · Tailwind
- Postgres on Neon + pgvector + Drizzle ORM
- Auth: Clerk (magic-link only)
- LLM: Anthropic Claude (Assistant) + OpenAI text-embedding-3-small (embeddings)
- Editor: Tiptap (added in Sprint 5)
- Webhooks: svix-verified Clerk webhook → mirrors users into our table

---

## Get it running locally

### 1. Install

```bash
npm install
```

### 2. Fill in your env

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with real values for: `DATABASE_URL`, both Clerk keys, `CLERK_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

### 3. Enable pgvector in Neon

In your Neon project → SQL Editor → run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

(Or paste the contents of `drizzle/0000_init.sql`.)

### 4. Push the schema

```bash
npm run db:push
```

Drizzle creates all tables — `users`, `ideas`, `captures`, `artifacts`, `threads`, `thread_entries`, `idea_edges`, `assistant_offers` — in your Neon database.

### 5. Set up the Clerk webhook (locally, optional for dev)

In Clerk Dashboard → Webhooks → Endpoints → **Create Endpoint**:
- **Endpoint URL** (production): `https://<your-domain>/api/webhooks/clerk`
- For local development, use [ngrok](https://ngrok.com) or [Vercel CLI's tunnel](https://vercel.com/docs/cli/dev) to forward webhooks
- **Subscribe to events**: `user.created`, `user.updated`, `user.deleted`
- Copy the **Signing Secret** → save as `CLERK_WEBHOOK_SECRET` in `.env.local`

### 6. Run

```bash
npm run dev
```

Visit http://localhost:3000.

---

## Deploy to Vercel (production)

### One-time setup

1. Push this repo to GitHub (already created at `github.com/<you>/folio`).

   ```bash
   git init
   git add .
   git commit -m "Sprint 1: scaffold + Clerk auth"
   git branch -M main
   git remote add origin https://github.com/<you>/folio.git
   git push -u origin main
   ```

2. In Vercel → **New Project** → import `folio` from GitHub.

3. **Environment variables** (Vercel UI → Settings → Environment Variables):
   - `DATABASE_URL`
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - `CLERK_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - (optionally) the four `NEXT_PUBLIC_CLERK_*_URL` variables

4. **Deploy.** Vercel runs `next build`; if it succeeds, you're live.

5. Update the Clerk webhook endpoint to your real Vercel URL once deployed.

6. (Optional) Add a custom domain in Vercel → Settings → Domains.

### After every push

Vercel auto-deploys on every push to `main`. Preview deploys on PRs.

---

## Routes

| Path | What it does | Auth |
|---|---|---|
| `/` | Public landing — opening-soon waitlist | public |
| `/sign-in` | Clerk sign-in (magic link) | public |
| `/sign-up` | Clerk sign-up | public |
| `/studio` | Authed home — Sprint 1 placeholder for The Page | required |
| `/api/webhooks/clerk` | User mirror on `user.created/updated/deleted` | public, signed |

---

## What's here in Sprint 1

- ✓ Project scaffold (Next.js 15, App Router, TypeScript, Tailwind)
- ✓ Editorial design language baked in (Fraunces + Inter + JetBrains Mono via `next/font`; warm-paper Tailwind palette)
- ✓ Database schema for the full Folio data model (Issue 02 + Issue 09)
- ✓ Clerk auth — sign-in, sign-up, protected `/studio`, signed webhook for user mirror
- ✓ Embedding helper stub (OpenAI text-embedding-3-small)
- ✓ Public landing page with waitlist form, lifecycle SVG, three rooms preview

## What's next

- **Sprint 2** — local Drizzle migrations workflow, error states, sign-out flow polish, env validation script
- **Sprint 3–4** — paste-based capture, Inbox view, idea attachment
- **Sprint 5–7** — The Page (writing surface, Tiptap editor, drafts as artifacts)
- **Sprint 8–10** — The Assistant (vector retrieval, rail UI)
- **Sprint 11–12** — polish, onboarding, beta launch to 5–10

See: `Folio · Field Notes · Issue 08` (build plan) and `Issue 09` (architecture).

---

Built with care.
