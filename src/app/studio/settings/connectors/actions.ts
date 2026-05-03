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

const PROVIDER = 'beehiiv';
const OBSIDIAN_PROVIDER = 'obsidian';

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
