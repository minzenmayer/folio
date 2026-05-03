# Environment & credentials

> **No secrets in this doc.** This is a list of what env vars are needed and
> where to get them — not the values themselves.

---

## Local development (`.env.local`)

`.env.local` is gitignored. Copy `.env.example` to get started:

```bash
cp .env.example .env.local
```

Then fill in each value. The sections below describe each variable.

---

## Supabase

| Variable | Where to get it |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → `anon` `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → `service_role` key |

**Warning:** `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. It must
never be used in client-side code. Only import `lib/db-server.ts` from server
components, route handlers, and server actions.

---

## Anthropic

| Variable | Where to get it |
|----------|-----------------|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API keys |

The model used is configurable via:

```
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022   # default
```

If `ANTHROPIC_MODEL` is not set, `lib/openai.ts` falls back to
`claude-3-5-sonnet-20241022`.

---

## Plaid

| Variable | Where to get it |
|----------|-----------------|
| `PLAID_CLIENT_ID` | https://dashboard.plaid.com → Team Settings → Keys |
| `PLAID_SECRET` | Same page — use the **Sandbox** secret for local dev |
| `PLAID_ENV` | `sandbox` for local/staging; `production` for prod |

For local development you almost always want `PLAID_ENV=sandbox`. The sandbox
provides deterministic test data and does not require a real bank connection.

**Production Plaid access** requires submitting a production access request
through the Plaid dashboard. This has been done for the `folio` application;
the production secret is in the Vercel environment (do not re-request).

---

## Polygon.io

| Variable | Where to get it |
|----------|-----------------|
| `POLYGON_API_KEY` | https://polygon.io/dashboard → API Keys |

The free tier is sufficient for development (5 calls/min). The production
deployment uses a paid Starter plan key stored in Vercel.

---

## CoinGecko

No API key required for the public tier. If you hit rate limits during
development, you can get a free Demo API key:

| Variable | Where to get it |
|----------|-----------------|
| `COINGECKO_API_KEY` | https://www.coingecko.com/en/api → Get Demo API Key (optional) |

If `COINGECKO_API_KEY` is set, it is passed as a query param; otherwise the
public (no-key) endpoint is used.

---

## Vercel (deployment)

All production and preview env vars are set in the Vercel dashboard:

> Vercel → folio project → Settings → Environment Variables

Do not use the Vercel CLI to set secrets; use the dashboard so that the whole
team has visibility.

**Preview vs Production:** Vercel automatically injects `VERCEL_ENV` as
`preview` or `production`. The app reads this to decide whether to use sandbox
or production Plaid credentials (see `lib/plaid-client.ts`).

---

## GitHub Actions (CI)

CI secrets are stored in:

> GitHub → folio repo → Settings → Secrets and variables → Actions

| Secret name | Purpose |
|-------------|---------|
| `SUPABASE_ACCESS_TOKEN` | Used by `supabase/migrations` CI step to apply migrations to staging |
| `SUPABASE_DB_PASSWORD` | Staging DB password for migration runner |
| `VERCEL_TOKEN` | Used by deployment workflow |
| `VERCEL_ORG_ID` | Vercel org ID |
| `VERCEL_PROJECT_ID` | Vercel project ID |

These secrets are already configured. Do not rotate them without updating CI.

---

## `.env.example`

The repo contains `.env.example` with all variable names and placeholder values.
Keep it in sync when adding new env vars: add the new var with a descriptive
placeholder (not a real value), commit it, and document it in this file.
