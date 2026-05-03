# Connectors · how each integration is wired

> One contract, one dispatcher, multiple sources. This document describes the
> connector abstraction, each live connector, and how to add a new one.

---

## The `Connector` interface

Defined in `types/connector.ts`:

```ts
export interface SyncOptions {
  since?: Date        // only fetch records updated after this date
  limit?: number      // max records to upsert in one run
}

export interface SyncResult {
  upserted: number
  errors: SyncError[]
  durationMs: number
}

export interface HealthStatus {
  ok: boolean
  latencyMs: number
  message?: string
}

export interface Connector {
  id: string                    // stable slug, e.g. "plaid"
  displayName: string
  sync(userId: string, options?: SyncOptions): Promise<SyncResult>
  healthCheck(): Promise<HealthStatus>
}
```

Every connector **must** export a default object that satisfies this interface.
The dispatcher in `lib/dispatcher.ts` imports all connectors and calls `sync`
or `healthCheck` by connector `id`.

---

## Normalised asset schema

Defined in `lib/schema.ts` (Zod):

```ts
export const NormalisedAssetSchema = z.object({
  id:               z.string().uuid(),
  userId:           z.string().uuid(),
  connectorId:      z.string(),          // matches Connector.id
  externalId:       z.string(),          // connector-native ID
  assetType:        z.enum(['cash', 'stock', 'crypto', 'real_estate', 'other']),
  displayName:      z.string(),
  valueCents:       z.number().int(),     // current value in USD cents
  currency:         z.string().length(3), // ISO 4217
  lastSyncedAt:     z.string().datetime(),
  confidenceScore:  z.number().min(0).max(1),  // added Wave 3
  metadata:         z.record(z.unknown()).optional(),
})

export type NormalisedAsset = z.infer<typeof NormalisedAssetSchema>
```

---

## Connector: Plaid (banking)

**File:** `connectors/plaid.ts`
**Status:** ✅ live
**API docs:** https://plaid.com/docs/

### Auth flow
Plaid uses a Link token → public token → access token OAuth-ish flow. The
access token is stored (encrypted) in the `plaid_connections` table. The
connector reads it from there; it never touches `.env.local` directly.

### What it syncs
- Depository accounts (checking, savings) → `assetType: 'cash'`
- Each account balance is treated as one `NormalisedAsset`

### Env vars needed
```
PLAID_CLIENT_ID
PLAID_SECRET          # sandbox or production
PLAID_ENV             # 'sandbox' | 'production'
```

### Known quirks
- Plaid sandbox returns deterministic fake data. Switching to production
  requires a separate Plaid application approval.
- Balance refresh can lag up to 60 s in sandbox.

---

## Connector: Polygon.io (stocks)

**File:** `connectors/polygon.ts`
**Status:** ✅ live
**API docs:** https://polygon.io/docs/stocks

### Auth
API key in `POLYGON_API_KEY` env var. No OAuth.

### What it syncs
- User's stock holdings stored in the `stock_holdings` table (manually entered
  or imported via CSV)
- For each holding, fetches latest closing price from Polygon and computes
  `valueCents`

### Rate limits
Free tier: 5 calls / minute. The connector batches requests and sleeps between
batches. Do not remove the sleep.

---

## Connector: CoinGecko (crypto)

**File:** `connectors/coingecko.ts`
**Status:** ✅ live
**API docs:** https://www.coingecko.com/api/documentation

### Auth
No API key required for the public tier (used here). Rate limit: 10–50
calls / minute depending on server load. The connector respects `Retry-After`
headers.

### What it syncs
- User's crypto holdings from the `crypto_holdings` table
- Fetches current USD price from `/simple/price` endpoint

---

## Connector: Zillow (real estate) — STUB

**File:** `connectors/zillow.ts`
**Status:** 🚧 stubbed (returns mock data)

Zillow's public API was deprecated. The plan (Sprint 16) is to use the
BridgeInteractive MLS API instead. For now the connector returns a hardcoded
`NormalisedAsset` with `confidenceScore: 0.40`.

**Do not build on top of the Zillow connector** until the real integration lands.

---

## Connector: Manual CSV

**File:** `connectors/csv.ts`
**Status:** ✅ live

### What it syncs
User-uploaded CSV files parsed and upserted into the `assets` table. Expected
columns:

```
name, type, value_usd, currency, as_of_date
```

`type` must match one of the `assetType` enum values (case-insensitive).

---

## Adding a new connector

1. Create `connectors/<name>.ts` implementing the `Connector` interface.
2. Add it to the connector registry in `lib/dispatcher.ts`:
   ```ts
   import myConnector from '@/connectors/<name>'
   export const connectors: Connector[] = [
     // ... existing
     myConnector,
   ]
   ```
3. Add required env vars to `docs/ENVIRONMENT.md` and `.env.example`.
4. Write a Vitest unit test in `connectors/<name>.test.ts`.
5. If the connector needs a new table, add a migration in `supabase/migrations/`.
6. Update this file with the new connector's section.
7. Update the connector table in `docs/HANDOFF.md`.
