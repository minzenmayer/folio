# Environment & credentials

> **No secrets in this doc.** This is a list of what env vars exist,
> what each one does, and where the actual values live. Pull values
> from those locations (Vercel dashboard, Clerk dashboard, etc.) when
> setting up a fresh local dev environment.

---

## Service accounts (where to log in)

| Service     | Where to log in                            | What it's for                                   |
|-------------|--------------------------------------------|-------------------------------------------------|
| GitHub      | github.com (account: `minzenmayer`)        | Repo hosting, Obsidian vault repos, push hooks  |
| Vercel      | vercel.com (team: `payton-minzenmayers-projects`) | Production deploy, env vars, cron, function logs |
| Neon        | console.neon.tech (project: `folio`)       | Postgres + pgvector. Connection string lives here |
| Clerk       | dashboard.clerk.com                        | Auth. Publishable + secret keys, webhook signing key |
| Anthropic   | console.anthropic.com                      | API keys for Haiku (Reflect + extractIdeas)     |
| OpenAI      | platform.openai.com                        | API keys for `text-embedding-3-small`           |
| Beehiiv     | app.beehiiv.com → Settings → Integrations → API | API keys per publication. User pastes into BeehiivCard at runtime; we never store this in env vars. |

---

## Production env vars (Vercel project)

To view/edit: **Vercel Dashboard → folio project → Settings →
Environment Variables.**

All vars below should be present in **Production** scope. **Preview**
and **Development** scopes can mirror Production for now (single-user
project; we don't yet need staged credentials). When the project gets
a second user, split these.

### Database

| Var            | What                                                        | Where it comes from                                  |
|----------------|-------------------------------------------------------------|------------------------------------------------------|
| `DATABASE_URL` | Neon Postgres connection string. Pooled connection (faster). | Neon console → folio project → Connection Details → "Pooled connection" |

### Auth (Clerk)

| Var                                       | What                                                                       |
|-------------------------------------------|----------------------------------------------------------------------------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`       | Frontend Clerk key. `pk_test_…` or `pk_live_…`.                            |
| `CLERK_SECRET_KEY`                        | Backend Clerk key. `sk_test_…` or `sk_live_…`.                             |
| `CLERK_WEBHOOK_SECRET`                    | Signs the user-mirror webhook. From Clerk → Webhooks → endpoint signing secret. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`           | `/sign-in` (default OK)                                                    |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL`           | `/sign-up` (default OK)                                                    |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`  | `/studio` (default OK)                                            |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`  | `/studio` (default OK)                                            |

### LLMs

| Var                | What                                                       |
|--------------------|------------------------------------------------------------|
| `ANTHROPIC_API_KEY`| Anthropic key. Used by Reflect (`src/lib/llm.ts`) and `extractIdeas` (`src/lib/extract-ideas.ts`). |
| `OPENAI_API_KEY`   | OpenAI key. Used by `embedText()` (`src/lib/embed.ts`).    |
| `ANTHROPIC_MODEL` (optional)         | Override the default `claude-3-5-haiku-20241022`. |
| `ANTHROPIC_EXTRACT_MODEL` (optional) | Override `extractIdeas`-specific model.            |

### Connectors infrastructure (Sprint 15)

| Var                       | What                                                                |
|---------------------------|---------------------------------------------------------------------|
| `CONNECTOR_ENCRYPTION_KEY`| AES-256-GCM key wrapping `connector_accounts.encrypted_secret`. **base64-encoded 32 bytes.** Generate with `openssl rand -base64 32`. **Rotating this key requires re-encrypting all secrets** — coordinate carefully if you ever need to. |
| `CRON_SECRET`             | Bearer token for Vercel Cron + manual cron triggers. Generate with `openssl rand -hex 32`. Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically when the var is set. |
| `APP_URL`                 | **⚠️ NOT YET SET** in Vercel as of handoff. Should be `https://folio-payton-minzenmayers-projects.vercel.app`. Used by `resolveAppBaseUrl()` to build webhook callback URLs. Without it, code falls back to `VERCEL_PROJECT_PRODUCTION_URL` which is currently the same value but isn't guaranteed if the project ever gets a custom domain. |

---

## Vercel-managed env vars (do not set manually)

These are populated automatically by Vercel during deploy:

- `VERCEL`, `VERCEL_ENV`, `VERCEL_TARGET_ENV`
- `VERCEL_URL` (current deployment's unique URL)
- `VERCEL_PROJECT_PRODUCTION_URL` (e.g. `folio-payton-minzenmayers-projects.vercel.app`)
- `VERCEL_BRANCH_URL`
- `VERCEL_DEPLOYMENT_ID`, `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME`
- `VERCEL_GIT_*` (commit metadata)
- `VERCEL_OIDC_TOKEN` (used for some integrations)

`resolveAppBaseUrl()` in `src/lib/connectors/registry.ts` reads
`APP_URL` first, then falls back to `VERCEL_PROJECT_PRODUCTION_URL`,
then `VERCEL_URL`, then `localhost:3000`.

---

## Local development setup

```bash
git clone https://github.com/minzenmayer/folio.git
cd folio
cp .env.local.example .env.local
# Fill in real values — see service accounts table above for where to find them
npm install --legacy-peer-deps
npm run dev
```

For local webhook testing (Beehiiv push, GitHub push):

```bash
# Use ngrok or cloudflared to expose localhost
ngrok http 3000
# Then in .env.local, set:
APP_URL=https://<your-ngrok-subdomain>.ngrok.io
# Restart dev server. Now the connector registers webhook URLs that
# point at your ngrok tunnel instead of localhost.
```

For local DB inspection: `npm run db:studio` opens Drizzle Studio
against your `DATABASE_URL`. Recommend using a Neon **branch** for
development so you don't pollute production.

---

## Schema migrations

Migrations live in `drizzle/`. Files numbered chronologically:

- `0000_init.sql` — original schema (users, ideas, captures, artifacts, etc.)
- `0001_drafts.sql`, `0002_drafts_version.sql`, `0003_draft_versions.sql`
- `0004_embeddings.sql` — pgvector + HNSW
- `0005_beehiiv.sql` — connector_accounts + newsletter_issues (Sprint 13)
- **`0006_wave2.sql` — obsidian_notes + extracted_ideas (Sprint 15
  Wave 2). NOT YET APPLIED to production at handoff.**

To apply 0006:

```bash
# Either: push schema via Drizzle (preferred — keeps Drizzle's snapshot
# aware so future generate cycles know the state)
npm run db:push

# Or: paste drizzle/0006_wave2.sql into Neon's SQL editor and Run.
# Idempotent (CREATE TABLE/INDEX IF NOT EXISTS) so safe to re-run.
```

Verify after applying:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('obsidian_notes', 'extracted_ideas');
-- expect 2 rows
```

`drizzle/full-schema.sql` is the consolidated "paste this into a fresh
Neon DB" file. Update it when you add a new migration.

---

## Credential rotation guide

If a key leaks or you want to rotate periodically:

| Credential                  | Rotation cost                                                        |
|-----------------------------|----------------------------------------------------------------------|
| `OPENAI_API_KEY`            | Cheap. Generate new in OpenAI dashboard, update Vercel env, redeploy. |
| `ANTHROPIC_API_KEY`         | Cheap. Same shape as OpenAI.                                         |
| `CLERK_SECRET_KEY`          | Medium. Existing user sessions may be invalidated; re-login required.|
| `CLERK_WEBHOOK_SECRET`      | Medium. Update both Clerk's webhook config AND the Vercel env. Pending events between rotations may fail to verify. |
| `CRON_SECRET`               | Cheap. Generate new, update Vercel env, redeploy. Vercel Cron picks up the new value automatically. |
| `CONNECTOR_ENCRYPTION_KEY`  | **Expensive.** This wraps every stored Beehiiv API key + Obsidian PAT in `connector_accounts.encrypted_secret`. Rotating means: (1) generate new key, (2) write a one-time script to decrypt with old key + re-encrypt with new key + UPDATE the row, (3) update env var, (4) verify all connections still work. **Coordinate carefully.** Out of scope for solo-user current state but important if onboarding more users. |

---

## Security notes worth carrying forward

- API keys never leave the server. Every read of
  `connector_accounts.encrypted_secret` goes through
  `decryptSecret()`. Plaintext only exists in function closures during
  a sync run. No logs, no DB rows, no cookies.
- Webhook signatures verified with constant-time comparison
  (`crypto.timingSafeEqual`).
- Per-account webhook secrets — Beehiiv and GitHub each get their own
  HMAC key per connector account, so a leak of one user's secret can't
  forge deliveries against another user.
- Clerk middleware gates everything except the explicitly-public
  routes (`/`, `/sign-in/*`, `/sign-up/*`, `/api/webhooks/(.*)`,
  `/api/cron/(.*)`). Webhooks + cron auth themselves.
