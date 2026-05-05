// Thoughtbed · /studio/settings/connectors — server actions (Sprint 13)
//
// Wave 1 actions that drive the live Beehiiv card:
//
//   connectBeehiiv({ apiKey })
//     · validates the key by calling /v2/publications,
//     · upserts a connector_accounts row with the encrypted key + chosen
//       publicationId,
//     · runs an immediate full sync.
//
//   syncBeehiiv()
//     · re-runs the full archive pull for the user's connected Beehiiv
//       account. Idempotent — upserts by (user_id, external_id).
//     · updates last_sync_at / last_sync_status / last_sync_count.
//
//   disconnectBeehiiv()
//     · soft delete: zeroes encrypted_secret, sets status='disconnected',
//       keeps the row + the user's newsletter_issues archive.
//
// The "API key never leaves the server" promise: every read of the secret
// goes through decryptSecret(). The plaintext is held only in the function
// closure during a sync run; no logs, no DB rows, no cookies.

'use server';

import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  db,
  connectorAccounts,
  newsletterIssues,
  obsidianNotes,
  type ConnectorAccount,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import { listPublications, BeehiivError } from '@/lib/beehiiv';
// Sprint 13 Wave 2: runSync moved to src/lib/beehiiv-sync.ts so the cron
// handler at /api/cron/beehiiv-sync can drive sync without going through
// this 'use server' module's user-scoped surface.
import { runSync } from '@/lib/beehiiv-sync';
// Sprint 15 Wave 1: real-time push. After the initial sync we provision
// a Beehiiv webhook so future post.sent events land via the dispatcher
// at /api/webhooks/beehiiv. Disconnect revokes it. The cron stays as a
// backstop in case a delivery is missed.
import { beehiivConnector } from '@/lib/connectors/beehiiv';
import { buildWebhookUrl } from '@/lib/connectors/registry';
import type { WebhookMetadata } from '@/lib/connectors/types';
// Sprint 15 Wave 2: Obsidian via Git-backed vault. Same connector
// lifecycle pattern as Beehiiv — validate the PAT, provision the GitHub
// push webhook, store metadata, run an immediate sync so the user sees
// notes show up right away.
import { obsidianConnector, parseRepoUrl } from '@/lib/connectors/obsidian';
import { getRepo, GitHubError } from '@/lib/obsidian';
import { runSync as runObsidianSync } from '@/lib/obsidian-sync';
// Phase 12 (2026-05-04): LinkedIn inbound via Apify scraping. No webhook
// path — scraping is polled on a cron + a manual "Sync now" button. The
// connector_accounts row holds metadata.profileUrl; the platform-level
// APIFY_API_TOKEN env var authenticates the scrape.
import { sql } from 'drizzle-orm';
import { linkedinPosts } from '@/db';
import { getApifyToken, ApifyError } from '@/lib/apify';
import {
  startSync as startLinkedinSync,
  pollAndFinalize as pollAndFinalizeLinkedin,
} from '@/lib/linkedin-sync';
// Phase 13 (2026-05-04): Gmail OAuth connector. Read-only, polling, with
// a triage queue for individual newsletter messages. The OAuth dance
// happens via /api/connectors/gmail/initiate + /api/connectors/gmail/callback
// (see those routes); this module exposes status / sync / disconnect /
// triage actions for the GmailCard + Insights tab.
import { gmailMessages, gmailSenderRules } from '@/db';
import {
  kickFirstGmailSync,
  runIncrementalGmailSync,
  countGmailMessagesByStatus,
  type GmailAccountMetadata,
} from '@/lib/gmail/sync';
import { GMAIL_OAUTH_PROVIDER } from '@/lib/gmail/oauth';
// Idea extraction lives in @/lib/extract-ideas. We import the Gmail
// variant lazily (inside the action body) so the heavy LLM module isn't
// part of the actions.ts bundle when only triaging.

const PROVIDER = 'beehiiv';
const OBSIDIAN_PROVIDER = 'obsidian';
const GMAIL_PROVIDER = GMAIL_OAUTH_PROVIDER;

// ─── status types ──────────────────────────────────────

export type BeehiivStatus =
  | { connected: false }
  | {
      connected: true;
      account: {
        id: string;
        publicationId: string | null;
        publicationName: string | null;
        status: ConnectorAccount['status'];
        lastSyncAt: string | null;
        lastSyncStatus: string | null;
        lastSyncError: string | null;
        lastSyncCount: number | null;
        issueCount: number;
      };
    };

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; reason: string; message: string };

// Phase 14a (2026-05-04): triageGmailMessage extends the ok shape with
//   · extractedCount — for the post-promote toast ("3 ideas pulled").
//   · suggestion     — when the user has hit the streak threshold for
//                      this sender's domain (3+ same-action triages in
//                      30 days and no rule already exists).
export type TriageSuggestion = {
  type: 'block_domain' | 'allow_domain';
  target: string;
  count: number;
};

export type TriageGmailResult =
  | {
      ok: true;
      message?: string;
      extractedCount?: number;
      suggestion?: TriageSuggestion;
    }
  | { ok: false; reason: string; message: string };

// ─── connectBeehiiv ──────────────────────────────────────

const connectSchema = z.object({
  apiKey: z.string().trim().min(8, 'API key looks too short').max(2000),
});

export async function connectBeehiiv(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parse = connectSchema.safeParse(input);
  if (!parse.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: parse.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { apiKey } = parse.data;

  // 1) Validate against Beehiiv by listing publications. Anything other
  //    than a 200 with at least one publication means we won't connect.
  let publications;
  try {
    publications = await listPublications(apiKey);
  } catch (err) {
    if (err instanceof BeehiivError) {
      return {
        ok: false,
        reason: err.code,
        message:
          err.code === 'auth_failed'
            ? 'Beehiiv rejected this API key. Double-check it in Beehiiv → Settings → Integrations.'
            : err.message,
      };
    }
    return {
      ok: false,
      reason: 'network',
      message: 'Could not reach Beehiiv. Check your connection and try again.',
    };
  }
  if (publications.length === 0) {
    return {
      ok: false,
      reason: 'no_publications',
      message: 'This API key has no publications on it.',
    };
  }

  // Wave 1 picks the first publication. If the founder has multiple, the
  // plan is to add a picker in Wave 1.5 — for now we surface the chosen
  // name so they can spot a wrong pick at a glance.
  const pub = publications[0];

  // 2) Upsert the connector_accounts row. We always overwrite the
  //    encrypted secret on connect (re-connect with a fresh key works).
  //    We preserve any existing webhook metadata so we can revoke it
  //    cleanly below before provisioning a fresh webhook with the new key.
  const existing = await loadAccount(user.id);
  const previousMeta = (existing?.metadata ?? {}) as WebhookMetadata & {
    publicationId?: string;
  };

  const encrypted = encryptSecret(apiKey);
  const metadata: Record<string, unknown> = {
    publicationId: pub.id,
    publication_name: pub.name,
    publication_url: pub.url ?? null,
    organization_name: pub.organization_name ?? null,
    // Webhook fields are filled in below; null them now so a reconnect
    // doesn't leave a stale id pointing at a webhook we already deleted.
    webhookId: null,
    webhookSecret: null,
  };

  let accountId: string;
  if (existing) {
    await db
      .update(connectorAccounts)
      .set({
        status: 'connected',
        encryptedSecret: encrypted,
        metadata,
        lastSyncStatus: null,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, existing.id));
    accountId = existing.id;
  } else {
    const [row] = await db
      .insert(connectorAccounts)
      .values({
        userId: user.id,
        provider: PROVIDER,
        status: 'connected',
        encryptedSecret: encrypted,
        metadata,
      })
      .returning({ id: connectorAccounts.id });
    accountId = row.id;
  }

  // 3) If we're reconnecting and the old account had a webhook on file,
  //    revoke it before provisioning a fresh one. Best-effort — Beehiiv
  //    rejecting the old key is fine, the upstream webhook will start
  //    failing its own deliveries against the new secret and Beehiiv
  //    will eventually disable it.
  if (existing && previousMeta.webhookId && previousMeta.publicationId) {
    try {
      await beehiivConnector.revokeWebhook?.({
        account: { ...existing, metadata: previousMeta },
        apiKey,
        webhookId: previousMeta.webhookId,
      });
    } catch (err) {
      console.warn('[connectBeehiiv] revoke previous webhook failed', err);
    }
  }

  // 4) Kick off the first sync immediately so the user sees a populated
  //    archive right after connecting. Errors here don't unwind the
  //    connection — the user can retry sync from the card.
  try {
    await runSync(user.id, accountId, apiKey, pub.id);
  } catch (err) {
    console.warn('[connectBeehiiv] initial sync failed', err);
    // Sync writes its own status to the row — nothing to do here.
  }

  // 5) Provision the real-time webhook. Failures here are logged but
  //    don't unwind the connection — the daily cron is the backstop.
  try {
    const [refreshed] = await db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, accountId))
      .limit(1);
    if (refreshed) {
      const provisioned = await beehiivConnector.provisionWebhook?.({
        account: refreshed,
        apiKey,
        callbackUrl: buildWebhookUrl(PROVIDER, accountId),
      });
      if (provisioned) {
        await db
          .update(connectorAccounts)
          .set({
            metadata: {
              ...metadata,
              webhookId: provisioned.webhookId,
              webhookSecret: provisioned.webhookSecret,
            },
            updatedAt: new Date(),
          })
          .where(eq(connectorAccounts.id, accountId));
      }
    }
  } catch (err) {
    console.warn('[connectBeehiiv] webhook provision failed', err);
    // No status mutation — connector stays 'connected'. Cron picks up
    // the slack until the user reconnects (or we fix the upstream).
  }

  revalidatePath('/studio/settings/connectors');
  revalidatePath('/studio/knowledge');
  return { ok: true, message: `Connected to ${pub.name}.` };
}

// ─── syncBeehiiv ───────────────────────────────────────────

export async function syncBeehiiv(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await loadAccount(user.id);
  if (!account || account.status !== 'connected' || !account.encryptedSecret) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Beehiiv is not connected. Click Connect to set it up.',
    };
  }

  let apiKey: string;
  try {
    apiKey = decryptSecret(account.encryptedSecret);
  } catch (err) {
    console.error('[syncBeehiiv] decrypt failed', err);
    return {
      ok: false,
      reason: 'auth_failed',
      message: 'Stored credential is unreadable. Please reconnect.',
    };
  }

  const meta = (account.metadata ?? {}) as { publicationId?: string };
  if (!meta.publicationId) {
    return {
      ok: false,
      reason: 'missing_publication',
      message: 'No publication on file. Please reconnect.',
    };
  }

  try {
    const result = await runSync(user.id, account.id, apiKey, meta.publicationId);
    revalidatePath('/studio/settings/connectors');
    revalidatePath('/studio/knowledge');
    return {
      ok: true,
      message: `Synced ${result.touched} of ${result.fetched} issues.`,
    };
  } catch (err) {
    if (err instanceof BeehiivError) {
      return {
        ok: false,
        reason: err.code,
        message:
          err.code === 'auth_failed'
            ? 'Beehiiv rejected the stored API key. Please reconnect.'
            : err.message,
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Sync failed.',
    };
  }
}

// ─── disconnectBeehiiv ─────────────────────────────────────

export async function disconnectBeehiiv(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await loadAccount(user.id);
  if (!account) {
    // Already not connected — surface as success for idempotency.
    return { ok: true, message: 'Beehiiv was not connected.' };
  }

  // Revoke the upstream webhook BEFORE zeroing the encrypted secret —
  // we need the API key to make the DELETE call. Best-effort: a failure
  // here doesn't block the user from disconnecting locally. The next
  // delivery from Beehiiv will hit our dispatcher with a 410 ("Account
  // is no longer connected") and Beehiiv will eventually disable the
  // subscription on its own.
  const meta = (account.metadata ?? {}) as WebhookMetadata & {
    publicationId?: string;
  };
  if (account.encryptedSecret && meta.webhookId) {
    try {
      const apiKey = decryptSecret(account.encryptedSecret);
      await beehiivConnector.revokeWebhook?.({
        account,
        apiKey,
        webhookId: meta.webhookId,
      });
    } catch (err) {
      console.warn('[disconnectBeehiiv] revoke webhook failed', err);
    }
  }

  // Strip the webhook fields when we soft-delete the row so a future
  // reconnect doesn't think there's a live webhook to revoke.
  const cleanedMetadata: Record<string, unknown> = { ...meta };
  delete cleanedMetadata.webhookId;
  delete cleanedMetadata.webhookSecret;

  await db
    .update(connectorAccounts)
    .set({
      status: 'disconnected',
      encryptedSecret: null,
      metadata: cleanedMetadata,
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, account.id));

  revalidatePath('/studio/settings/connectors');
  revalidatePath('/studio/knowledge');
  return { ok: true, message: 'Disconnected.' };
}

// ─── getBeehiivStatus ──────────────────────────────────────
// Read-only fetcher used by the connectors page server component to
// render the live card. Never leaks the encrypted secret — only the
// metadata the user sees.

export async function getBeehiivStatus(): Promise<BeehiivStatus> {
  const user = await requireUser();
  const account = await loadAccount(user.id);
  if (!account || account.status === 'disconnected') {
    return { connected: false };
  }

  const meta = (account.metadata ?? {}) as {
    publicationId?: string;
    publication_name?: string;
  };

  const issueCount = await db
    .select({ count: newsletterIssues.id })
    .from(newsletterIssues)
    .where(
      and(
        eq(newsletterIssues.userId, user.id),
        eq(newsletterIssues.connectorAccountId, account.id)
      )
    )
    .then((rows) => rows.length);

  return {
    connected: true,
    account: {
      id: account.id,
      publicationId: meta.publicationId ?? null,
      publicationName: meta.publication_name ?? null,
      status: account.status,
      lastSyncAt: account.lastSyncAt
        ? account.lastSyncAt.toISOString()
        : null,
      lastSyncStatus: account.lastSyncStatus,
      lastSyncError: account.lastSyncError,
      lastSyncCount: account.lastSyncCount,
      issueCount,
    },
  };
}

// ─── helpers ─────────────────────────────────────────────

async function loadAccount(
  userId: string
): Promise<ConnectorAccount | undefined> {
  const [row] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, PROVIDER)
      )
    )
    .limit(1);
  return row;
}

// ════════════════════════════════════════════════════════════════════
// Sprint 15 Wave 2 — Obsidian (Git-backed vault) server actions
// ════════════════════════════════════════════════════════════════════
//
// Same shape as the Beehiiv actions above. Diff:
//   · The "secret" we store is a GitHub PAT (read-only, repo:read scope)
//     instead of a Beehiiv API key.
//   · Connect takes (repoUrl, pat, branch?) and infers owner/repo via
//     parseRepoUrl. Branch defaults to the repo's default_branch.
//   · The provisioned webhook is a GitHub push hook on the vault repo,
//     not a Beehiiv post.sent subscription.
//   · The cron + push delta both call into runObsidianSync /
//     upsertNoteByPath in src/lib/obsidian-sync.ts.

export type ObsidianStatus =
  | { connected: false }
  | {
      connected: true;
      account: {
        id: string;
        repoUrl: string | null;
        owner: string | null;
        repo: string | null;
        branch: string | null;
        status: ConnectorAccount['status'];
        lastSyncAt: string | null;
        lastSyncStatus: string | null;
        lastSyncError: string | null;
        lastSyncCount: number | null;
        noteCount: number;
      };
    };

const obsidianConnectSchema = z.object({
  repoUrl: z.string().trim().min(4).max(400),
  pat: z
    .string()
    .trim()
    .min(20, 'GitHub token looks too short')
    .max(2000),
  branch: z.string().trim().min(1).max(120).optional(),
});

type ObsidianMetadata = WebhookMetadata & {
  owner?: string;
  repo?: string;
  branch?: string;
  repoUrl?: string;
  fullName?: string;
};

export async function connectObsidian(
  input: unknown
): Promise<ActionResult> {
  const user = await requireUser();
  const parse = obsidianConnectSchema.safeParse(input);
  if (!parse.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: parse.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { repoUrl, pat, branch } = parse.data;

  // 1) Parse the repo URL into owner/repo. Reject early if it doesn't
  //    look like a GitHub URL — saves a network round-trip on bad input.
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    return {
      ok: false,
      reason: 'invalid_repo',
      message:
        'That doesn\'t look like a GitHub repo URL. Try https://github.com/{owner}/{repo} or {owner}/{repo}.',
    };
  }

  // 2) Validate the PAT by fetching the repo metadata. Anything other
  //    than a 200 with pull permission means we won't connect.
  let repoMeta;
  try {
    repoMeta = await getRepo(pat, parsed.owner, parsed.repo);
  } catch (err) {
    if (err instanceof GitHubError) {
      const msg =
        err.code === 'auth_failed'
          ? 'GitHub rejected this token. Check Settings → Developer settings → Personal access tokens.'
          : err.code === 'not_found'
            ? `Couldn't find ${parsed.owner}/${parsed.repo}. Confirm the repo exists and the token can see it.`
            : err.message;
      return { ok: false, reason: err.code, message: msg };
    }
    return {
      ok: false,
      reason: 'network',
      message: 'Could not reach GitHub. Check your connection and try again.',
    };
  }

  if (!repoMeta.permissions?.pull) {
    return {
      ok: false,
      reason: 'no_permission',
      message:
        'This token can\'t read that repo. Re-issue with at least repo:read scope.',
    };
  }

  const effectiveBranch = (branch ?? repoMeta.default_branch).trim();

  // 3) Upsert connector_accounts row.
  const existing = await loadObsidianAccount(user.id);
  const previousMeta = (existing?.metadata ?? {}) as ObsidianMetadata;

  const encrypted = encryptSecret(pat);
  const metadata: Record<string, unknown> = {
    owner: parsed.owner,
    repo: parsed.repo,
    branch: effectiveBranch,
    repoUrl,
    fullName: repoMeta.full_name,
    webhookId: null,
    webhookSecret: null,
  };

  let accountId: string;
  if (existing) {
    await db
      .update(connectorAccounts)
      .set({
        status: 'connected',
        encryptedSecret: encrypted,
        metadata,
        lastSyncStatus: null,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, existing.id));
    accountId = existing.id;
  } else {
    const [row] = await db
      .insert(connectorAccounts)
      .values({
        userId: user.id,
        provider: OBSIDIAN_PROVIDER,
        status: 'connected',
        encryptedSecret: encrypted,
        metadata,
      })
      .returning({ id: connectorAccounts.id });
    accountId = row.id;
  }

  // 4) Reconnect: revoke the previous webhook before provisioning a new
  //    one. Best-effort — see Beehiiv connect for the same reasoning.
  if (existing && previousMeta.webhookId && previousMeta.owner && previousMeta.repo) {
    try {
      await obsidianConnector.revokeWebhook?.({
        account: { ...existing, metadata: previousMeta },
        apiKey: pat,
        webhookId: previousMeta.webhookId,
      });
    } catch (err) {
      console.warn('[connectObsidian] revoke previous webhook failed', err);
    }
  }

  // 5) Run the initial vault sync. Errors here don't unwind the
  //    connection; the user can retry from the card.
  try {
    await runObsidianSync(user.id, accountId, {
      pat,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: effectiveBranch,
    });
  } catch (err) {
    console.warn('[connectObsidian] initial sync failed', err);
  }

  // 6) Provision the GitHub push webhook so future commits push notes
  //    to us in real time. Cron is the backstop for missed deliveries.
  try {
    const [refreshed] = await db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, accountId))
      .limit(1);
    if (refreshed) {
      const provisioned = await obsidianConnector.provisionWebhook?.({
        account: refreshed,
        apiKey: pat,
        callbackUrl: buildWebhookUrl(OBSIDIAN_PROVIDER, accountId),
      });
      if (provisioned) {
        await db
          .update(connectorAccounts)
          .set({
            metadata: {
              ...metadata,
              webhookId: provisioned.webhookId,
              webhookSecret: provisioned.webhookSecret,
            },
            updatedAt: new Date(),
          })
          .where(eq(connectorAccounts.id, accountId));
      }
    }
  } catch (err) {
    console.warn('[connectObsidian] webhook provision failed', err);
  }

  revalidatePath('/studio/settings/connectors');
  revalidatePath('/studio/knowledge');
  return { ok: true, message: `Connected to ${repoMeta.full_name}.` };
}

export async function syncObsidian(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await loadObsidianAccount(user.id);
  if (!account || account.status !== 'connected' || !account.encryptedSecret) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Obsidian is not connected. Click Connect to set it up.',
    };
  }

  let pat: string;
  try {
    pat = decryptSecret(account.encryptedSecret);
  } catch (err) {
    console.error('[syncObsidian] decrypt failed', err);
    return {
      ok: false,
      reason: 'auth_failed',
      message: 'Stored credential is unreadable. Please reconnect.',
    };
  }

  const meta = (account.metadata ?? {}) as ObsidianMetadata;
  if (!meta.owner || !meta.repo) {
    return {
      ok: false,
      reason: 'missing_repo',
      message: 'No repo on file. Please reconnect.',
    };
  }

  try {
    const result = await runObsidianSync(user.id, account.id, {
      pat,
      owner: meta.owner,
      repo: meta.repo,
      branch: meta.branch ?? 'main',
    });
    revalidatePath('/studio/settings/connectors');
    revalidatePath('/studio/knowledge');
    return {
      ok: true,
      message: `Synced ${result.touched} of ${result.fetched} notes${result.removed > 0 ? `, removed ${result.removed}` : ''}.`,
    };
  } catch (err) {
    if (err instanceof GitHubError) {
      return {
        ok: false,
        reason: err.code,
        message:
          err.code === 'auth_failed'
            ? 'GitHub rejected the stored token. Please reconnect.'
            : err.message,
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Sync failed.',
    };
  }
}

export async function disconnectObsidian(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await loadObsidianAccount(user.id);
  if (!account) {
    return { ok: true, message: 'Obsidian was not connected.' };
  }

  const meta = (account.metadata ?? {}) as ObsidianMetadata;
  if (account.encryptedSecret && meta.webhookId) {
    try {
      const pat = decryptSecret(account.encryptedSecret);
      await obsidianConnector.revokeWebhook?.({
        account,
        apiKey: pat,
        webhookId: meta.webhookId,
      });
    } catch (err) {
      console.warn('[disconnectObsidian] revoke webhook failed', err);
    }
  }

  const cleanedMetadata: Record<string, unknown> = { ...meta };
  delete cleanedMetadata.webhookId;
  delete cleanedMetadata.webhookSecret;

  await db
    .update(connectorAccounts)
    .set({
      status: 'disconnected',
      encryptedSecret: null,
      metadata: cleanedMetadata,
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, account.id));

  revalidatePath('/studio/settings/connectors');
  revalidatePath('/studio/knowledge');
  return { ok: true, message: 'Disconnected.' };
}

export async function getObsidianStatus(): Promise<ObsidianStatus> {
  const user = await requireUser();
  const account = await loadObsidianAccount(user.id);
  if (!account || account.status === 'disconnected') {
    return { connected: false };
  }

  const meta = (account.metadata ?? {}) as ObsidianMetadata;

  const noteCount = await db
    .select({ count: obsidianNotes.id })
    .from(obsidianNotes)
    .where(
      and(
        eq(obsidianNotes.userId, user.id),
        eq(obsidianNotes.connectorAccountId, account.id)
      )
    )
    .then((rows) => rows.length);

  return {
    connected: true,
    account: {
      id: account.id,
      repoUrl: meta.repoUrl ?? null,
      owner: meta.owner ?? null,
      repo: meta.repo ?? null,
      branch: meta.branch ?? null,
      status: account.status,
      lastSyncAt: account.lastSyncAt
        ? account.lastSyncAt.toISOString()
        : null,
      lastSyncStatus: account.lastSyncStatus,
      lastSyncError: account.lastSyncError,
      lastSyncCount: account.lastSyncCount,
      noteCount,
    },
  };
}

async function loadObsidianAccount(
  userId: string
): Promise<ConnectorAccount | undefined> {
  const [row] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, OBSIDIAN_PROVIDER)
      )
    )
    .limit(1);
  return row;
}

// ─── LinkedIn (Phase 12, 2026-05-04) ──────────────────────────────────
//
// Inbound-only via Apify scraping. The user gives us their public
// LinkedIn profile URL; we store it on connector_accounts.metadata and
// kick off Apify runs. The platform-level APIFY_API_TOKEN env var
// authenticates every call (single-tenant for now; per-user later).
//
// Server-action surface mirrors the Beehiiv shape:
//
//   · connectLinkedin({ profileUrl })  → upsert + start first scrape
//   · syncLinkedin()                   → kick a fresh run
//   · pollLinkedin()                   → drain pending run if SUCCEEDED
//   · disconnectLinkedin()             → soft delete
//   · getLinkedinStatus()              → for the UI card to render
//
// The full ingest is async — connectLinkedin returns within seconds
// (just kicked the run); the LinkedinCard polls pollLinkedin every 30s
// to see when results land.

const LINKEDIN_PROVIDER = 'linkedin';

const linkedinConnectSchema = z.object({
  profileUrl: z
    .string()
    .url()
    .refine((u) => /linkedin\.com\/in\//i.test(u), {
      message:
        'Profile URL must be a personal LinkedIn URL like https://www.linkedin.com/in/yourhandle/',
    }),
});

export type LinkedinStatus =
  | { kind: 'disconnected' }
  | {
      kind: 'connected';
      profileUrl: string;
      lastSyncAt: string | null;
      lastSyncStatus: string | null;
      lastSyncError: string | null;
      lastSyncCount: number | null;
      // Set when a poll-and-finalize is still pending — the UI card
      // shows "Sync in progress (Xs)".
      pendingRunId: string | null;
      pendingStartedAt: string | null;
      lastRunItemCount: number | null;
      postsSynced: number;
    };

async function getLinkedinAccount(userId: string) {
  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, LINKEDIN_PROVIDER)
      )
    )
    .limit(1);
  return account ?? null;
}

export async function connectLinkedin(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = linkedinConnectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message:
        parsed.error.errors[0]?.message ?? 'Profile URL looks invalid.',
    };
  }
  const { profileUrl } = parsed.data;

  // Validate the platform Apify token early so the user gets a clean
  // error instead of a generic 500 when the env var is missing.
  try {
    getApifyToken();
  } catch (err) {
    return {
      ok: false,
      reason: 'config_missing',
      message:
        err instanceof ApifyError
          ? err.message
          : 'Server is missing APIFY_API_TOKEN.',
    };
  }

  // Upsert the connector_accounts row.
  const existing = await getLinkedinAccount(user.id);

  let accountId: string;
  if (existing) {
    accountId = existing.id;
    await db
      .update(connectorAccounts)
      .set({
        status: 'connected',
        metadata: {
          ...(existing.metadata as Record<string, unknown>),
          profileUrl,
        },
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, accountId));
  } else {
    const [created] = await db
      .insert(connectorAccounts)
      .values({
        userId: user.id,
        provider: LINKEDIN_PROVIDER,
        status: 'connected',
        metadata: { profileUrl },
      })
      .returning({ id: connectorAccounts.id });
    accountId = created.id;
  }

  // Kick the first scrape. Run is async; the UI polls.
  try {
    await startLinkedinSync(user.id, accountId, profileUrl);
  } catch (err) {
    // Connection itself succeeded; only the run kickoff failed. Surface
    // the error but leave the account row in place so the user can
    // retry via the Sync button.
    return {
      ok: false,
      reason: 'sync_kickoff_failed',
      message: (err as Error).message?.slice(0, 300) ?? 'Apify start failed.',
    };
  }

  revalidatePath('/studio/knowledge');
  revalidatePath('/studio');

  return { ok: true };
}

export async function syncLinkedin(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getLinkedinAccount(user.id);
  if (!account || account.status !== 'connected') {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'LinkedIn is not connected yet.',
    };
  }

  const meta = (account.metadata ?? {}) as { profileUrl?: string };
  if (!meta.profileUrl) {
    return {
      ok: false,
      reason: 'missing_profile_url',
      message:
        'No LinkedIn profile URL on file. Reconnect to set it.',
    };
  }

  try {
    await startLinkedinSync(user.id, account.id, meta.profileUrl);
  } catch (err) {
    return {
      ok: false,
      reason: 'sync_kickoff_failed',
      message: (err as Error).message?.slice(0, 300),
    };
  }

  revalidatePath('/studio/knowledge');
  return { ok: true };
}

/**
 * Poll the in-flight Apify run and finalize if it's done. The UI card
 * calls this every 30s while there's a pendingRunId on the status.
 */
export async function pollLinkedin(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getLinkedinAccount(user.id);
  if (!account) {
    return { ok: false, reason: 'not_connected', message: 'No LinkedIn account.' };
  }

  try {
    await pollAndFinalizeLinkedin(user.id, account.id);
  } catch (err) {
    return {
      ok: false,
      reason: 'poll_failed',
      message: (err as Error).message?.slice(0, 300),
    };
  }

  revalidatePath('/studio/knowledge');
  return { ok: true };
}

export async function disconnectLinkedin(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getLinkedinAccount(user.id);
  if (!account) return { ok: true }; // already gone

  // Soft delete: status='disconnected', clear the in-flight run id so
  // a future reconnect gets a clean slate. We deliberately keep
  // linkedin_posts rows so a reconnect doesn't re-pay for the same
  // archive — same pattern as Beehiiv.
  await db
    .update(connectorAccounts)
    .set({
      status: 'disconnected',
      metadata: {
        ...(account.metadata as Record<string, unknown>),
        apifyRunId: undefined,
        apifyDatasetId: undefined,
        apifyRunStartedAt: undefined,
      },
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, account.id));

  revalidatePath('/studio/knowledge');
  return { ok: true };
}

export async function getLinkedinStatus(): Promise<LinkedinStatus> {
  const user = await requireUser();
  const account = await getLinkedinAccount(user.id);
  if (!account || account.status !== 'connected') {
    return { kind: 'disconnected' };
  }

  const meta = (account.metadata ?? {}) as {
    profileUrl?: string;
    apifyRunId?: string;
    apifyRunStartedAt?: string;
    lastRunItemCount?: number;
  };

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(linkedinPosts)
    .where(eq(linkedinPosts.userId, user.id));

  return {
    kind: 'connected',
    profileUrl: meta.profileUrl ?? '',
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: account.lastSyncStatus ?? null,
    lastSyncError: account.lastSyncError ?? null,
    lastSyncCount: account.lastSyncCount ?? null,
    pendingRunId: meta.apifyRunId ?? null,
    pendingStartedAt: meta.apifyRunStartedAt ?? null,
    lastRunItemCount: meta.lastRunItemCount ?? null,
    postsSynced: Number(count ?? 0),
  };
}


// ─────────────────────────────────────────────────────────
// GMAIL — Phase 13 (2026-05-04)
//
//   · getGmailStatus()       → for the GmailCard to render.
//   · syncGmail()            → manual "Sync now" — runs incremental sync,
//                              or finishes the chunked first-sync.
//   · disconnectGmail()      → clear encryptedSecret + status='disconnected'.
//                              Keeps gmail_messages rows for audit + reconnect.
//   · triageGmailMessage()   → promote / dismiss / snooze a pending row.
//                              Promote fires embed + extractIdeasFromGmail.
//
// The OAuth round-trip is NOT a server action — the Connect button is a
// plain link to /api/connectors/gmail/initiate so the browser does the
// 302s itself.
// ─────────────────────────────────────────────────────────

export type GmailStatus =
  | { kind: 'disconnected' }
  | {
      kind: 'connected';
      googleEmail: string | null;
      lastSyncAt: string | null;
      lastSyncStatus: string | null;
      lastSyncError: string | null;
      lastSyncCount: number | null;
      syncCompletedAt: string | null;
      firstSyncInProgress: boolean;
      counts: {
        pending: number;
        promoted: number;
        dismissed: number;
        snoozed: number;
        total: number;
      };
    };

async function getGmailAccount(userId: string): Promise<ConnectorAccount | null> {
  const [row] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, GMAIL_PROVIDER)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getGmailStatus(): Promise<GmailStatus> {
  const user = await requireUser();
  const account = await getGmailAccount(user.id);
  if (!account || account.status !== 'connected') {
    return { kind: 'disconnected' };
  }

  const meta = (account.metadata ?? {}) as GmailAccountMetadata;
  const counts = await countGmailMessagesByStatus({ userId: user.id });

  return {
    kind: 'connected',
    googleEmail: meta.googleEmail ?? null,
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: account.lastSyncStatus ?? null,
    lastSyncError: account.lastSyncError ?? null,
    lastSyncCount: account.lastSyncCount ?? null,
    syncCompletedAt: meta.syncCompletedAt ?? null,
    // Chunked first-sync still has a pageToken parked → not yet done.
    firstSyncInProgress:
      !meta.syncCompletedAt && Boolean(meta.pendingPageToken ?? false),
    counts,
  };
}

export async function syncGmail(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getGmailAccount(user.id);
  if (!account || account.status !== 'connected') {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Gmail is not connected yet.',
    };
  }

  const meta = (account.metadata ?? {}) as GmailAccountMetadata;
  try {
    if (!meta.syncCompletedAt) {
      await kickFirstGmailSync({ userId: user.id, accountId: account.id });
    } else {
      await runIncrementalGmailSync({ userId: user.id, accountId: account.id });
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'sync_failed',
      message: (err as Error).message?.slice(0, 300),
    };
  }

  revalidatePath('/studio/knowledge');
  revalidatePath('/studio/insights');
  return { ok: true };
}

export async function disconnectGmail(): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getGmailAccount(user.id);
  if (!account) return { ok: true };

  // Soft delete: clear encryptedSecret (so we can never accidentally hit
  // Google with a stale token) and set status='disconnected'. Keep
  // gmail_messages rows + metadata.googleEmail so reconnect rehydrates.
  await db
    .update(connectorAccounts)
    .set({
      encryptedSecret: null,
      status: 'disconnected',
      metadata: {
        ...((account.metadata as Record<string, unknown>) ?? {}),
        // Reset the cursor and pagination state so reconnect starts clean.
        lastHistoryId: null,
        pendingPageToken: null,
        pendingExamined: 0,
      },
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, account.id));

  revalidatePath('/studio/knowledge');
  revalidatePath('/studio/insights');
  return { ok: true };
}

// ─── triage actions ─────────────────────────────────────

const triageSchema = z.object({
  messageId: z.string().uuid(),
  action: z.enum(['promote', 'dismiss', 'snooze']),
  snoozeDays: z.number().int().min(1).max(365).optional(),
});

export async function triageGmailMessage(input: unknown): Promise<TriageGmailResult> {
  const parsed = triageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'bad_input',
      message: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const user = await requireUser();
  const { messageId, action, snoozeDays } = parsed.data;

  const [row] = await db
    .select()
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.id, messageId),
        eq(gmailMessages.userId, user.id)
      )
    )
    .limit(1);

  if (!row) {
    return { ok: false, reason: 'not_found', message: 'Message not found.' };
  }

  const now = new Date();

  if (action === 'dismiss') {
    await db
      .update(gmailMessages)
      .set({
        status: 'dismissed',
        dismissedAt: now,
        updatedAt: now,
      })
      .where(eq(gmailMessages.id, messageId));
    revalidatePath('/studio/insights');
    // Phase 14a: after a dismiss, check for streak to surface a
    // 'block this domain' suggestion in the row's response.
    const { getDomainTriageStreakIfNoRule } = await import(
      '@/lib/gmail/sender-rules'
    );
    const streak = await getDomainTriageStreakIfNoRule({
      userId: user.id,
      fromAddress: row.fromAddress,
      triagedStatus: 'dismissed',
    });
    if (streak) {
      return {
        ok: true,
        suggestion: {
          type: 'block_domain',
          target: streak.domain,
          count: streak.count,
        },
      };
    }
    return { ok: true };
  }

  if (action === 'snooze') {
    const days = snoozeDays ?? 30;
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    await db
      .update(gmailMessages)
      .set({
        status: 'snoozed',
        snoozeUntil: until,
        updatedAt: now,
      })
      .where(eq(gmailMessages.id, messageId));
    revalidatePath('/studio/insights');
    return { ok: true };
  }

  // action === 'promote'
  // Lazy-import the heavy extract-ideas module so triaging dismiss/snooze
  // doesn't pay the LLM bundle cost.
  const [{ extractIdeasFromGmailMessage }, { embedText }] = await Promise.all([
    import('@/lib/extract-ideas'),
    import('@/lib/embed'),
  ]);

  // Compute embedding from body_clean (or body_text) so the message is
  // retrievable in Reflect immediately on promote.
  const text = row.bodyClean ?? row.bodyText ?? '';
  let embedding: number[] | undefined;
  if (text.trim().length >= 200) {
    try {
      embedding = await embedText(text);
    } catch (err) {
      console.warn('[gmail:promote] embed failed', messageId, err);
    }
  }

  await db
    .update(gmailMessages)
    .set({
      status: 'promoted',
      promotedAt: now,
      embedding,
      updatedAt: now,
    })
    .where(eq(gmailMessages.id, messageId));

  // Idea extraction. Best-effort — promote succeeds even if extraction fails.
  let extractedCount = 0;
  try {
    extractedCount = await extractIdeasFromGmailMessage({
      userId: user.id,
      messageId: row.id,
      title: row.subject ?? '(no subject)',
      bodyText: text,
      webUrl: null,
      postedAt: row.postedAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.warn('[gmail:promote] extractIdeas failed', messageId, err);
  }

  revalidatePath('/studio/insights');
  revalidatePath('/studio/knowledge');

  // Phase 14a: post-promote, check for an allowlist suggestion.
  const { getDomainTriageStreakIfNoRule } = await import(
    '@/lib/gmail/sender-rules'
  );
  const streak = await getDomainTriageStreakIfNoRule({
    userId: user.id,
    fromAddress: row.fromAddress,
    triagedStatus: 'promoted',
  });
  if (streak) {
    return {
      ok: true,
      extractedCount,
      suggestion: {
        type: 'allow_domain',
        target: streak.domain,
        count: streak.count,
      },
    };
  }
  return { ok: true, extractedCount };
}

// ─── GMAIL sender rules (Phase 14a, 2026-05-04) ──────────────────────
//
// Triage burden reduction. The user can pre-decide what to ingest from
// a given sender or domain. See drizzle/0010_gmail_sender_rules.sql.
//
//   · listGmailRules()       → for the management UI on GmailCard.
//   · addGmailRule({...})    → create a rule for an address OR a domain.
//   · removeGmailRule({ id }) → delete by id (idempotent).

export type GmailSenderRuleRow = {
  id: string;
  senderAddress: string | null;
  senderDomain: string | null;
  action: 'allow' | 'block';
  reason: string | null;
  createdAt: string;
};

const addGmailRuleSchema = z
  .object({
    senderAddress: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(320)
      .refine((v) => v.includes('@'), {
        message: 'Sender address must contain @',
      })
      .optional(),
    senderDomain: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(253)
      .refine((v) => !v.includes('@'), {
        message: 'Sender domain must not contain @',
      })
      .optional(),
    action: z.enum(['allow', 'block']),
    reason: z.enum(['manual', 'auto_suggested']).optional().default('manual'),
  })
  .refine(
    (v) =>
      (v.senderAddress ? 1 : 0) + (v.senderDomain ? 1 : 0) === 1,
    { message: 'Provide exactly one of senderAddress or senderDomain.' }
  );

export async function addGmailRule(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = addGmailRuleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { senderAddress, senderDomain, action, reason } = parsed.data;

  try {
    await db
      .insert(gmailSenderRules)
      .values({
        userId: user.id,
        senderAddress: senderAddress ?? null,
        senderDomain: senderDomain ?? null,
        action,
        reason,
      })
      .onConflictDoNothing({
        target: [
          gmailSenderRules.userId,
          gmailSenderRules.senderAddress,
          gmailSenderRules.senderDomain,
          gmailSenderRules.action,
        ],
      });
  } catch (err) {
    return {
      ok: false,
      reason: 'db_error',
      message: (err as Error).message?.slice(0, 300) ?? 'Insert failed.',
    };
  }

  revalidatePath('/studio/insights');
  revalidatePath('/studio/settings/connectors');
  return {
    ok: true,
    message:
      action === 'allow'
        ? `Always keeping from ${senderAddress ?? senderDomain}.`
        : `Never showing from ${senderAddress ?? senderDomain}.`,
  };
}

const removeGmailRuleSchema = z.object({ id: z.string().uuid() });

export async function removeGmailRule(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = removeGmailRuleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  await db
    .delete(gmailSenderRules)
    .where(
      and(
        eq(gmailSenderRules.id, parsed.data.id),
        eq(gmailSenderRules.userId, user.id)
      )
    );
  revalidatePath('/studio/insights');
  revalidatePath('/studio/settings/connectors');
  return { ok: true };
}

export async function listGmailRules(): Promise<GmailSenderRuleRow[]> {
  const user = await requireUser();
  const rows = await db
    .select({
      id: gmailSenderRules.id,
      senderAddress: gmailSenderRules.senderAddress,
      senderDomain: gmailSenderRules.senderDomain,
      action: gmailSenderRules.action,
      reason: gmailSenderRules.reason,
      createdAt: gmailSenderRules.createdAt,
    })
    .from(gmailSenderRules)
    .where(eq(gmailSenderRules.userId, user.id))
    .orderBy(sql`${gmailSenderRules.action}, lower(coalesce(${gmailSenderRules.senderAddress}, ${gmailSenderRules.senderDomain}))`);

  return rows.map((r) => ({
    id: r.id,
    senderAddress: r.senderAddress,
    senderDomain: r.senderDomain,
    action: r.action as 'allow' | 'block',
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}


// ─── ignoreGmailSender — Phase 14a refresh (2026-05-04) ───────────────
//
// Triage row primary action #2. Combines three things into one click so
// "ignore from this sender" actually clears the queue:
//   1. Adds a block rule for the message's sender_domain (forward-only —
//      future newsletters from this domain never re-enter triage).
//   2. Cascade-dismisses ALL pending + snoozed messages from the same
//      sender_domain so the queue drops them immediately. Without this
//      step, the user reasonably expects 'ignore from sender' to clear
//      the feed but only future ingest actually changes.
//   3. Returns dismissedCount + domain so the row can show a single
//      toast: 'Ignored. Removed N messages from <domain>. Future
//      newsletters from <domain> will be skipped.'
//
// We block by domain (not sender_address) on this primary path because
// most newsletters rotate the local-part (weekly+xyz@..., daily+abc@...)
// while keeping the domain stable. Domain blocking is what the user
// actually means by 'ignore this sender' for newsletters. The narrower
// 'never show from <full-address>' rule is still available in the '...'
// menu when they want to be surgical.

const ignoreSenderSchema = z.object({
  messageId: z.string().uuid(),
});

export type IgnoreGmailSenderResult =
  | {
      ok: true;
      domain: string;
      dismissedCount: number;
      ruleAdded: boolean;
    }
  | { ok: false; reason: string; message: string };

export async function ignoreGmailSender(
  input: unknown
): Promise<IgnoreGmailSenderResult> {
  const user = await requireUser();
  const parsed = ignoreSenderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }

  const [row] = await db
    .select({
      id: gmailMessages.id,
      fromAddress: gmailMessages.fromAddress,
    })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.id, parsed.data.messageId),
        eq(gmailMessages.userId, user.id)
      )
    )
    .limit(1);

  if (!row) {
    return { ok: false, reason: 'not_found', message: 'Message not found.' };
  }

  const fromAddr = (row.fromAddress ?? '').trim().toLowerCase();
  const domain = fromAddr.includes('@') ? fromAddr.split('@')[1] : '';
  if (!domain) {
    return {
      ok: false,
      reason: 'no_domain',
      message: "Can't determine sender domain — try 'Skip This One' instead.",
    };
  }

  // 1) Add block rule. ON CONFLICT DO NOTHING so re-clicks are idempotent.
  let ruleAdded = false;
  try {
    const ins = await db
      .insert(gmailSenderRules)
      .values({
        userId: user.id,
        senderDomain: domain,
        senderAddress: null,
        action: 'block',
        reason: 'manual',
      })
      .onConflictDoNothing({
        target: [
          gmailSenderRules.userId,
          gmailSenderRules.senderAddress,
          gmailSenderRules.senderDomain,
          gmailSenderRules.action,
        ],
      })
      .returning({ id: gmailSenderRules.id });
    ruleAdded = ins.length > 0;
  } catch (err) {
    console.warn('[ignoreGmailSender] rule insert failed', err);
  }

  // 2) Cascade-dismiss every pending or snoozed message from the same
  //    domain. Promoted messages stay where they are — we don't unwind
  //    a deliberate promote.
  const now = new Date();
  const dismissed = await db
    .update(gmailMessages)
    .set({
      status: 'dismissed',
      dismissedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(gmailMessages.userId, user.id),
        // status in pending | snoozed
        sql`${gmailMessages.status} IN ('pending', 'snoozed')`,
        // domain match — case-insensitive on the stored from_address
        sql`lower(${gmailMessages.fromAddress}) LIKE ${'%@' + domain}`
      )
    )
    .returning({ id: gmailMessages.id });

  revalidatePath('/studio/insights');
  revalidatePath('/studio/knowledge');

  return {
    ok: true,
    domain,
    dismissedCount: dismissed.length,
    ruleAdded,
  };
}
