// Thoughtbed · Connector registry (Sprint 15 Wave 1)
//
// Single source of truth for which providers the dispatcher knows about.
// The dispatcher at /api/webhooks/[provider]/route.ts looks up by name;
// the connect/disconnect server actions look up the same way to find the
// webhook lifecycle hooks.
//
// Adding a provider is two lines: import its ConnectorProvider impl and
// drop it into REGISTRY. Wave 2 (Obsidian) will add itself this way.

import { decryptSecret } from '@/lib/crypto';
import type { ConnectorAccount } from '@/db';
import { beehiivConnector } from './beehiiv';
import type { ConnectorProvider } from './types';

const REGISTRY: Record<string, ConnectorProvider> = {
  [beehiivConnector.name]: beehiivConnector,
  // obsidianConnector  ← Sprint 15 Wave 2
  // substackConnector  ← future
  // ghostConnector     ← future
};

/** Returns the provider impl for a name, or null if unknown. */
export function getConnector(name: string): ConnectorProvider | null {
  return REGISTRY[name] ?? null;
}

/** Whole registry — handy for debugging / status pages. */
export function listConnectors(): ConnectorProvider[] {
  return Object.values(REGISTRY);
}

// ─── webhook URL helper ──────────────────────────────────

/**
 * Resolve the absolute base URL for webhook callback URLs we hand to
 * upstream services. Webhooks need a stable, public hostname — Vercel's
 * ephemeral preview URLs change every deploy, which would break already-
 * registered webhooks.
 *
 * Priority:
 *   1. APP_URL          — explicit override (set in Vercel env). Use this
 *                         as the production custom domain or canonical
 *                         alias. Wins if set, no questions asked.
 *   2. VERCEL_PROJECT_PRODUCTION_URL — the stable production alias Vercel
 *                         exposes to runtime, e.g.
 *                         folio-payton-minzenmayers-projects.vercel.app.
 *   3. VERCEL_URL       — current deployment URL (preview-stable, not
 *                         prod-stable). OK for connector smoke tests on
 *                         preview branches.
 *   4. http://localhost:3000 — dev fallback. Outside-world senders can't
 *                         reach this; use ngrok / cloudflared and set
 *                         APP_URL when testing locally.
 */
export function resolveAppBaseUrl(): string {
  const explicit = process.env.APP_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;

  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;

  return 'http://localhost:3000';
}

/**
 * Build the absolute webhook URL we register with the upstream provider.
 * Embeds ?account=<id> so verify() can locate the connector_accounts row
 * without needing per-account routes.
 */
export function buildWebhookUrl(provider: string, accountId: string): string {
  const base = resolveAppBaseUrl();
  return `${base}/api/webhooks/${provider}?account=${encodeURIComponent(accountId)}`;
}

// ─── shared helper ───────────────────────────────────────

/**
 * Decrypt an account's API key for use by handle() callbacks. Returns
 * null when the account has been disconnected (encryptedSecret cleared)
 * or when the ciphertext is unreadable — callers should treat null as
 * "skip this delivery".
 *
 * Lives here (not on a per-provider module) because every connector that
 * stores an API key uses the same crypto module.
 */
export function decryptAccountKey(account: ConnectorAccount): string | null {
  if (!account.encryptedSecret) return null;
  try {
    return decryptSecret(account.encryptedSecret);
  } catch {
    return null;
  }
}
