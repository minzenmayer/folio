# Connectors · how each integration is wired

> One contract, one dispatcher, multiple providers. This doc is the
> map for when you need to add a third provider, debug a webhook
> delivery, or refactor the lifecycle.

---

## The contract

`src/lib/connectors/types.ts` — one interface every provider implements:

```ts
interface ConnectorProvider {
  name: string;                                          // 'beehiiv' | 'obsidian' | …
  verify(req: Request): Promise<VerifyResult>;           // auth + locate account + parse body
  normalize(payload): ConnectorEvent | null;             // provider shape → unified shape
  handle(ctx, event): Promise<void>;                     // do the work (typically delegates to upsert)
  provisionWebhook?(opts): Promise<ProvisionedWebhook>;  // create webhook, store secret
  revokeWebhook?(opts): Promise<void>;                   // tear it down
}
```

The dispatcher at `src/app/api/webhooks/[provider]/route.ts` is the
single entry point. Reads `?account=<id>` from the URL, looks up the
provider in the registry (`src/lib/connectors/registry.ts`), runs
`verify → normalize → handle` in sequence. Errors are logged with the
provider name; 4xx / 5xx propagates upward.

Middleware (`src/middleware.ts`) marks `/api/webhooks/(.*)` public so
Clerk's session check stays out of the webhook path.

---

## Beehiiv connector (Wave 1)

**Provider impl:** `src/lib/connectors/beehiiv.ts`
**Sync engine:** `src/lib/beehiiv-sync.ts`
**API client:** `src/lib/beehiiv.ts`

### How it connects

1. User pastes API key into BeehiivCard → `connectBeehiiv()` server action
2. We call `listPublications()` to validate the key
3. Encrypt the key (AES-256-GCM via `src/lib/crypto.ts`)
4. Insert a `connector_accounts` row (provider='beehiiv', status='connected')
5. Run an immediate full sync (`runSync` walks the archive, upserts every
   issue into `newsletter_issues`)
6. Provision a Beehiiv webhook subscribed to `post.sent` with a per-account
   secret; store `webhookId` + `webhookSecret` on
   `connector_accounts.metadata`

### How real-time push works

1. Beehiiv POSTs to `/api/webhooks/beehiiv?account=<id>` when a post is sent
2. Dispatcher calls `beehiivConnector.verify(req)`:
   - Reads `?account=<id>`, loads the connector_accounts row
   - HMAC-SHA256 over raw body using `metadata.webhookSecret`
   - Accepts three signature header layouts (raw hex, GitHub-style
     `sha256=…`, Stripe-style `t=…,v1=…`) since Beehiiv's exact format
     wasn't pinned in our codebase yet — see comment in
     `verifyHmac()` for tightening when we know
   - Parses JSON body
3. `normalize(payload)` → `ConnectorEvent { kind: 'post.sent', externalId,
   payload }`
4. `handle(ctx, event)` re-fetches the post (`getPost()`) to get full
   HTML, then calls `upsertIssue()` which idempotently writes to
   `newsletter_issues`
5. `upsertIssue` triggers `extractIdeasFromNewsletter()` on real writes
   so `extracted_ideas` stays current

### How disconnect works

1. User clicks Disconnect on BeehiivCard → `disconnectBeehiiv()` action
2. Decrypt API key, call `deleteWebhook()` on Beehiiv's API to revoke the
   webhook before zeroing local state
3. Set `status='disconnected'`, clear `encryptedSecret`, strip
   `webhookId` + `webhookSecret` from metadata
4. Past `newsletter_issues` rows stay (cascade is preserved via
   `connector_accounts.id` FK on the issue rows)

### Cron backstop

`src/app/api/cron/beehiiv-sync/route.ts` runs daily at 08:00 UTC
(see `vercel.json`). For every `provider='beehiiv'` connector row that
is `status='connected'`, decrypts the key and calls `runSync`. Catches
posts that webhooks missed (5xx outage on our side, etc.).

Auth: `Authorization: Bearer ${CRON_SECRET}`. CRON_SECRET is set in
Vercel project env.

### Beehiiv API endpoints we hit

```
GET    /v2/publications                            — list publications
GET    /v2/publications/{pubId}/posts              — paginated archive
GET    /v2/publications/{pubId}/posts/{postId}     — single post (used by webhook handler)
POST   /v2/publications/{pubId}/webhooks           — subscribe to post.sent
DELETE /v2/publications/{pubId}/webhooks/{whId}    — unsubscribe
```

Rate limit: 180 req/min per organization. We honour `RateLimit-Remaining`
by sleeping when it dips below 10, and retry once on 429 with exponential
backoff.

---

## Obsidian connector (Wave 2)

**Provider impl:** `src/lib/connectors/obsidian.ts`
**Sync engine:** `src/lib/obsidian-sync.ts`
**Vault client:** `src/lib/obsidian.ts`
**Markdown helpers:** `src/lib/markdown.ts` (frontmatter, wikilinks, tags)

### Why "Obsidian via Git"

Obsidian has no hosted API. The user pushes their vault to a Git repo;
we pull on a daily cron + GitHub push webhook. Other models considered
and rejected: local REST API plugin (localhost only), one-shot upload
(loses live property), iCloud/Dropbox bridge (operationally heavy).

### How it connects

1. User pastes repo URL + read-only PAT into ObsidianCard
2. `connectObsidian()` parses the URL (HTTPS / SSH / `owner/repo` shapes
   all accepted via `parseRepoUrl()`)
3. `getRepo()` validates the PAT by fetching repo metadata (must have
   `pull` permission)
4. Encrypt PAT, insert `connector_accounts` row, run immediate
   `runObsidianSync`
5. Provision a GitHub push webhook on the vault repo with a generated
   per-account 32-byte secret. Webhook id + secret stored on metadata.

### How sync works

`runObsidianSync(userId, accountId, ctx)`:

1. `getBranchTree()` — full recursive tree at branch tip
2. Filter to `.md` blobs under 1MB, skip hidden/`.obsidian/` paths
3. For each note: if our row's `blob_sha` matches the tree entry's
   `sha`, skip (no fetch, no embed, no LLM call)
4. Otherwise: `getBlob()` → decode → `parseMarkdown()` → embed → upsert
   to `obsidian_notes` → `extractIdeasFromObsidian()`
5. Delete rows for paths no longer in the tree

### How push events work

1. GitHub POSTs to `/api/webhooks/obsidian?account=<id>` on every push
2. `verify` checks `X-Hub-Signature-256` against `metadata.webhookSecret`
3. `normalize` filters to push events (returns null for ping events, so
   GitHub marks the test delivery as OK)
4. `handle` filters to the configured branch (default: `main`), runs
   `diffPushPayload()` to extract added/modified/removed paths,
   then for each:
   - Added/modified → `upsertNoteByPath()` (fetches via
     `getFileAtRef`, parses, upserts)
   - Removed → `deleteNoteByPath()`
5. Cascading FK deletes any `extracted_ideas` rows for removed notes

### Cron backstop

`src/app/api/cron/obsidian-sync/route.ts` runs at 08:30 UTC daily
(30 min after Beehiiv to spread load). Same Bearer-token auth.

### What `parseMarkdown` extracts

- Frontmatter (YAML between `---` fences) — primitive types only,
  inline arrays, multi-line lists. Nested mappings flatten to
  JSON-stringified strings.
- Title resolution: `frontmatter.title` → first H1 in body → filename
  basename
- Wikilinks: `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]` —
  aliases stripped, anchors stripped, deduped first-seen-order
- Inline `#tags`, merged with `frontmatter.tags` array
- Plain text + word count — strips fenced code, inline code, image
  embeds, markdown link URLs (keeps labels)

---

## Clerk webhook (pre-Sprint-15, in place)

**Route:** `src/app/api/webhooks/clerk/route.ts`

Mirrors Clerk users into our local `users` table on `user.created`,
`user.updated`, `user.deleted`. svix signature verification.
Subscribed in Clerk Dashboard → Webhooks → endpoint
`https://<your-domain>/api/webhooks/clerk` with signing secret stored as
`CLERK_WEBHOOK_SECRET`.

Doesn't go through the Wave-1 dispatcher (Clerk pre-dates it). Could be
refactored to extend `ConnectorProvider` if there's a reason — but the
shape is different (no per-account secret, just a global signing secret),
so the refactor would water down the contract. Leave it where it is.

---

## Provider lifecycle on `connector_accounts`

| status         | encryptedSecret | metadata.webhookId | meaning                                          |
|----------------|-----------------|--------------------|--------------------------------------------------|
| `pending`      | maybe           | maybe              | brief window between insert and first validation |
| `connected`    | yes             | yes                | live, syncing, receiving webhooks                |
| `error`        | yes (or null)   | maybe              | upstream rejected our credential; user re-connects |
| `disconnected` | null            | null (cleaned)     | soft delete; rows preserved for archive value    |

Disconnect zeroes the secret + strips webhook id/secret. Past sources
(`newsletter_issues`, `obsidian_notes`) stay reachable. Reconnect with a
fresh credential reuses the same `connector_accounts.id` so existing
sources stay attached.

---

## Adding a third provider

1. Create `src/lib/connectors/<name>.ts` implementing
   `ConnectorProvider` (verify, normalize, handle, optionally
   provisionWebhook + revokeWebhook).
2. Register in `src/lib/connectors/registry.ts`:
   ```ts
   import { newConnector } from './newprovider';
   const REGISTRY = {
     [beehiivConnector.name]: beehiivConnector,
     [obsidianConnector.name]: obsidianConnector,
     [newConnector.name]: newConnector,
   };
   ```
3. Add a sync engine if needed (mirror `beehiiv-sync.ts` /
   `obsidian-sync.ts` shape: `runSync()` for full pulls, `upsertX()`
   for single-row idempotent writes).
4. Add a cron route (`src/app/api/cron/<name>-sync/route.ts`) for the
   missed-delivery backstop. Add the cron path to `vercel.json`.
5. Add a Card UI (`src/app/studio/settings/connectors/<Name>Card.tsx`)
   modeled on BeehiivCard / ObsidianCard.
6. Add server actions (connect/sync/disconnect/getStatus) to
   `src/app/studio/settings/connectors/actions.ts`.
7. Add the card to `ConnectorsPanel.tsx` and remove from the
   `SOON_CONNECTORS` list.
8. Flip the entry on `/studio/knowledge` from `state: 'soon'` to
   `state: 'live'`.

A clean third-provider add is roughly 400-700 lines of new code
including the UI card, depending on how complex the provider's API is.
The contract abstraction is what makes the connector layer cheap.
