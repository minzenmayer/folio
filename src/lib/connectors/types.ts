// Thoughtbed · Connector provider abstraction (Sprint 15 Wave 1)
//
// Each upstream integration (beehiiv today; obsidian / substack / ghost
// next) implements this contract so the single webhook dispatcher at
// /api/webhooks/[provider]/route.ts can route real-time push without
// growing a switch statement per provider.
//
// Lifecycle in concept:
//
//   connect  → provisionWebhook() → store {webhookId, webhookSecret}
//                                   on connector_accounts.metadata
//   push     → dispatcher(req) → provider.verify(req)
//                              → provider.normalize(payload) → ConnectorEvent
//                              → provider.handle(ctx, event) → existing upsert
//   disconnect → revokeWebhook() before zeroing the secret
//
// Idempotency lives in the existing per-provider upsert (e.g. upsertIssue
// for beehiiv) — the dispatcher is intentionally dumb so cron + push
// share one truth.

import type { ConnectorAccount } from '@/db';

// ─── normalized event shape ──────────────────────────────────

/**
 * Kinds of events the dispatcher knows about. Add a literal here when a
 * new provider needs a new shape — the union is the canonical contract
 * between providers and downstream handlers.
 *
 * Wave 1: 'post.sent' (Beehiiv).
 * Wave 2: 'vault.push' (Obsidian via GitHub). One push event covers a
 *         set of added/modified/removed notes; the provider's handle()
 *         applies the full delta against obsidian_notes. Going coarse
 *         instead of per-note keeps the dispatcher simple — the GitHub
 *         payload is one logical unit.
 */
export type ConnectorEventKind = 'post.sent' | 'vault.push';

export type ConnectorEvent = {
  /** Discriminator. */
  kind: ConnectorEventKind;
  /** Provider's stable id for the entity (e.g. Beehiiv post id). */
  externalId: string;
  /** Verified raw payload — provider-shaped, handler-aware. */
  payload: unknown;
};

// ─── verify result ────────────────────────────────────────

/**
 * Outcome of provider.verify(). On success the dispatcher has everything
 * it needs to load+decrypt the account and dispatch. On failure the
 * dispatcher returns the supplied status verbatim — this lets providers
 * use 401 (bad signature), 404 (unknown account), 410 (account
 * disconnected), etc. without the dispatcher needing to know.
 */
export type VerifyResult =
  | {
      ok: true;
      /** The connector_accounts row this webhook belongs to. */
      account: ConnectorAccount;
      /** Verified, parsed payload. Pass through to normalize(). */
      payload: unknown;
    }
  | {
      ok: false;
      /** HTTP status the dispatcher should return. */
      status: number;
      /** Short human-readable reason (logged + sent in body). */
      message: string;
    };

// ─── handle context ───────────────────────────────────────

/**
 * Everything a provider's handle() needs to do its work. The dispatcher
 * decrypts the API key once and passes it in so handle() can re-fetch
 * upstream content without each provider re-implementing decrypt logic.
 *
 * apiKey is null when the connector has been disconnected (encrypted
 * secret cleared) — handlers should treat that as "ignore", since the
 * disconnect path also revokes the upstream webhook.
 */
export type ConnectorHandleCtx = {
  account: ConnectorAccount;
  apiKey: string | null;
};

// ─── provider contract ───────────────────────────────────

export interface ConnectorProvider {
  /** Matches connector_accounts.provider — used by the registry lookup. */
  name: string;

  /**
   * Authenticate the inbound webhook request.
   *
   * Responsibilities:
   *   1. Locate the connector_accounts row this delivery belongs to
   *      (typically via a route or query-string hint we set when
   *      provisioning the webhook URL).
   *   2. Verify the upstream signature against the per-account secret
   *      stored in metadata.webhookSecret.
   *   3. Parse the raw body into the provider's native payload shape.
   *
   * Must NOT touch the database beyond the read needed to find the
   * account; the dispatcher handles routing the verified event.
   */
  verify(req: Request): Promise<VerifyResult>;

  /**
   * Map a verified provider payload to a normalized ConnectorEvent.
   *
   * Returning null means "not an event we care about" — the dispatcher
   * 200's so the upstream stops retrying. Throwing means "the payload
   * was unexpected" — the dispatcher 400's.
   */
  normalize(payload: unknown): ConnectorEvent | null;

  /**
   * Apply the event. Idempotent. Typically delegates to the same
   * upsert path the cron uses (e.g. upsertIssue for beehiiv).
   */
  handle(ctx: ConnectorHandleCtx, event: ConnectorEvent): Promise<void>;

  // ─── webhook lifecycle (optional — providers without API-managed ─
  // hooks like Obsidian-via-GitHub can omit these and the connect
  // path skips provisioning) ──────────────────────────────────

  /**
   * Provision a webhook on the upstream service. Returns the upstream
   * webhook id + the signing secret to use for HMAC verification.
   *
   * Called from the connect server action AFTER the initial sync
   * succeeds, so a flaky webhook provision doesn't unwind a working
   * connection.
   */
  provisionWebhook?(opts: ProvisionWebhookOpts): Promise<ProvisionedWebhook>;

  /**
   * Revoke a webhook on the upstream service. Called from the disconnect
   * server action BEFORE zeroing the encrypted secret. Failures are
   * logged but don't block disconnect — leaving an orphaned webhook
   * that 401's on every delivery is preferable to a stuck disconnect.
   */
  revokeWebhook?(opts: RevokeWebhookOpts): Promise<void>;
}

export type ProvisionWebhookOpts = {
  account: ConnectorAccount;
  apiKey: string;
  /** Absolute URL the provider should POST events to. */
  callbackUrl: string;
};

export type ProvisionedWebhook = {
  /** Upstream webhook id — we store this so we can revoke later. */
  webhookId: string;
  /** Per-account HMAC secret used by verify(). */
  webhookSecret: string;
};

export type RevokeWebhookOpts = {
  account: ConnectorAccount;
  apiKey: string;
  /** Upstream webhook id (loaded from metadata.webhookId). */
  webhookId: string;
};

// ─── narrow metadata shape (shared with actions.ts) ──────────────────

/**
 * The slice of connector_accounts.metadata that the webhook plumbing
 * cares about. Each provider may add its own keys (publicationId,
 * publication_name, etc.); this type just nails down the webhook
 * lifecycle keys so refactors don't drift.
 */
export type WebhookMetadata = {
  webhookId?: string;
  webhookSecret?: string;
};
