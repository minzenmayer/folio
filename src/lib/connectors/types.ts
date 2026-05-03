/**
 * src/lib/connectors/types.ts
 *
 * Shared types for the connector framework.
 *
 * A ConnectorProvider describes one integration source (e.g. Beehiiv,
 * Obsidian).  The registry collects all providers; the cron job and
 * the webhook router use the registry to dispatch calls.
 *
 * Design goals
 * ────────────
 * • Minimal surface area — providers implement only what they need.
 * • No shared state — each method receives credentials explicitly.
 * • Async throughout — network calls are always async.
 */

// ── Credentials ───────────────────────────────────────────────────────────────

/**
 * Base shape for connector credentials stored in the DB.
 * Each provider extends this with its specific fields.
 */
export interface ConnectorCredentials {
  [key: string]: unknown;
}

// ── Sync result ───────────────────────────────────────────────────────────────

/**
 * Normalised result returned by every `sync()` and `handleWebhook()` call.
 * Callers can surface `errors` in the UI or logs without knowing the
 * internals of each provider.
 */
export interface SyncResult {
  success:   boolean;
  /** Number of records created or updated. */
  upserted?: number;
  /** Number of records removed. */
  deleted?:  number;
  /** Human-readable error messages (empty on full success). */
  errors?:   string[];
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ConnectorProvider {
  /** Stable machine-readable identifier, e.g. "beehiiv" or "obsidian". */
  id: string;

  /** Human-readable display name shown in the UI. */
  name: string;

  /** One-line description shown in the connectors panel. */
  description: string;

  /**
   * Validates a set of credentials without writing anything.
   * Returns true if the credentials are well-formed and accepted by
   * the upstream service.
   */
  validateCredentials(credentials: ConnectorCredentials): Promise<boolean>;

  /**
   * Performs a full sync (typically called by the daily cron job or a
   * manual "Sync now" button).
   */
  sync(credentials: ConnectorCredentials): Promise<SyncResult>;

  /**
   * Handles an inbound webhook from the upstream service.
   * Receives the original Request object so the provider can verify
   * signatures and read the raw body.
   *
   * Optional — providers that don't support webhooks can omit this.
   */
  handleWebhook?(
    credentials: ConnectorCredentials,
    request: Request
  ): Promise<Response>;
}
