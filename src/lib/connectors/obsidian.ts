/**
 * src/lib/connectors/obsidian.ts
 *
 * ConnectorProvider implementation for the Obsidian-via-GitHub connector.
 *
 * Responsibilities
 * ────────────────
 * • Validate credentials (GitHub PAT + optional webhook secret).
 * • Expose a /api/webhooks/obsidian endpoint shape via handleWebhook().
 * • Verify X-Hub-Signature-256 on every incoming push event.
 * • Trigger diffPushPayload() for incremental syncs.
 * • Register in connectors/registry.ts so the UI and cron job pick it up.
 */

import type { ConnectorProvider, ConnectorCredentials, SyncResult } from './types';
import { parseRepoUrl, verifyWebhookSignature, normalizePushEvent } from '../obsidian';
import { syncVault, diffPushPayload }                               from '../obsidian-sync';

// ── Credential schema ─────────────────────────────────────────────────────────

/**
 * Shape stored in the DB's `connector_credentials` JSONB column.
 * All fields are strings; the PAT is stored encrypted at the DB layer.
 */
export interface ObsidianCredentials extends ConnectorCredentials {
  /** GitHub PAT with `contents:read` on the vault repository. */
  githubToken: string;
  /** Full vault repo URL or "owner/repo" bare form. */
  repoUrl: string;
  /** Branch to sync (optional, defaults to main). */
  branch?: string;
  /** HMAC secret registered in the GitHub webhook settings. */
  webhookSecret?: string;
}

// ── Provider implementation ───────────────────────────────────────────────────

export const obsidianConnector: ConnectorProvider = {
  id:          'obsidian',
  name:        'Obsidian (GitHub)',
  description: 'Sync your Obsidian vault backed by a GitHub repository.',

  // ── Credentials validation ──────────────────────────────────────────────
  async validateCredentials(raw: ConnectorCredentials): Promise<boolean> {
    const creds = raw as ObsidianCredentials;
    if (!creds.githubToken || !creds.repoUrl) return false;

    try {
      const repoFull = parseRepoUrl(creds.repoUrl);
      const res = await fetch(
        `https://api.github.com/repos/${repoFull}`,
        {
          headers: {
            Authorization: `Bearer ${creds.githubToken}`,
            Accept: 'application/vnd.github+json',
          },
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  },

  // ── Full sync (cron / manual trigger) ──────────────────────────────────
  async sync(credentials: ConnectorCredentials): Promise<SyncResult> {
    const creds     = credentials as ObsidianCredentials;
    const repoFull  = parseRepoUrl(creds.repoUrl);

    const result = await syncVault({
      repoFull,
      branch: creds.branch,
      token:  creds.githubToken,
    });

    return {
      success:   result.errors.length === 0,
      upserted:  result.upserted,
      deleted:   result.deleted,
      errors:    result.errors,
    };
  },

  // ── Webhook handler (push events) ──────────────────────────────────────
  async handleWebhook(
    credentials: ConnectorCredentials,
    request:     Request
  ): Promise<Response> {
    const creds     = credentials as ObsidianCredentials;
    const signature = request.headers.get('X-Hub-Signature-256');
    const event     = request.headers.get('X-GitHub-Event');
    const deliveryId = request.headers.get('X-GitHub-Delivery') ?? 'unknown';

    // Only process push events.
    if (event !== 'push') {
      return new Response(JSON.stringify({ skipped: true, reason: `event=${event}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read raw body for HMAC verification.
    const rawBody = await request.text();

    // Verify signature if a webhook secret is configured.
    if (creds.webhookSecret) {
      try {
        verifyWebhookSignature(rawBody, signature, creds.webhookSecret);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'signature error';
        return new Response(JSON.stringify({ error: msg }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Parse and normalise.
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const push = normalizePushEvent(body, deliveryId);

    // Run the incremental sync.
    const result = await diffPushPayload(push, creds.githubToken);

    return new Response(
      JSON.stringify({
        ok:       true,
        deliveryId,
        upserted: result.upserted,
        deleted:  result.deleted,
        errors:   result.errors,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
};
