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
  type ConnectorAccount,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import {
  listAllPosts,
  listPublications,
  BeehiivError,
  type BeehiivPost,
} from '@/lib/beehiiv';
import { htmlToText, wordCount } from '@/lib/html-to-text';

const PROVIDER = 'beehiiv';

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
  const encrypted = encryptSecret(apiKey);
  const metadata = {
    publicationId: pub.id,
    publication_name: pub.name,
    publication_url: pub.url ?? null,
    organization_name: pub.organization_name ?? null,
  };

  const existing = await loadAccount(user.id);
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

  // 3) Kick off the first sync immediately so the user sees a populated
  //    archive right after connecting. Errors here don't unwind the
  //    connection — the user can retry sync from the card.
  try {
    await runSync(user.id, accountId, apiKey, pub.id);
  } catch (err) {
    console.warn('[connectBeehiiv] initial sync failed', err);
    // Sync writes its own status to the row — nothing to do here.
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

  await db
    .update(connectorAccounts)
    .set({
      status: 'disconnected',
      encryptedSecret: null,
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

type SyncResult = { fetched: number; touched: number };

/**
 * Walk the Beehiiv archive and upsert into newsletter_issues. Embeds the
 * body text best-effort per row. Updates the connector_accounts row with
 * status + count once done. Throws on hard failures (auth, network) so the
 * caller can map to a user-facing error; soft per-row failures are logged.
 */
async function runSync(
  userId: string,
  accountId: string,
  apiKey: string,
  publicationId: string
): Promise<SyncResult> {
  let fetched = 0;
  let touched = 0;
  let errored = 0;

  try {
    const posts = await listAllPosts(apiKey, {
      publicationId,
      status: 'confirmed',
      platform: 'both',
      expand: ['free_web_content'],
      orderBy: 'publish_date',
      direction: 'desc',
    });
    fetched = posts.length;

    for (const post of posts) {
      try {
        const wrote = await upsertIssue(userId, accountId, publicationId, post);
        if (wrote) touched++;
      } catch (err) {
        errored++;
        console.warn('[runSync] upsert failed', post.id, err);
      }
    }

    const status =
      errored === 0 ? 'ok' : touched === 0 ? 'error' : 'partial';
    await db
      .update(connectorAccounts)
      .set({
        status: 'connected',
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        lastSyncError: errored > 0 ? `${errored} row(s) failed` : null,
        lastSyncCount: touched,
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, accountId));

    return { fetched, touched };
  } catch (err) {
    // Hard failure — record it and rethrow so caller can surface.
    const code =
      err instanceof BeehiivError && err.code === 'auth_failed'
        ? 'auth_failed'
        : err instanceof BeehiivError && err.code === 'rate_limited'
          ? 'rate_limited'
          : 'error';
    await db
      .update(connectorAccounts)
      .set({
        status: code === 'auth_failed' ? 'error' : 'connected',
        lastSyncAt: new Date(),
        lastSyncStatus: code,
        lastSyncError:
          err instanceof Error ? err.message : 'Unknown sync error',
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, accountId));
    throw err;
  }
}

/**
 * Idempotent upsert for a single Beehiiv post. Returns true if anything
 * was written (insert OR update with newer status_changed_at), false if
 * the row was already current.
 */
async function upsertIssue(
  userId: string,
  accountId: string,
  publicationId: string,
  post: BeehiivPost
): Promise<boolean> {
  const html = post.content?.free?.web ?? '';
  const text = htmlToText(html);
  const wc = wordCount(text);

  const publishDate = post.publish_date
    ? new Date(post.publish_date * 1000)
    : null;

  // Upstream change marker — if Beehiiv updates a post (typo fix, premium
  // tier change), status_changed_at moves forward. We compare against our
  // updated_at to decide whether to re-write.
  const upstreamChangedAt = post.status_changed_at
    ? new Date(post.status_changed_at * 1000)
    : null;

  const [existing] = await db
    .select({
      id: newsletterIssues.id,
      updatedAt: newsletterIssues.updatedAt,
    })
    .from(newsletterIssues)
    .where(
      and(
        eq(newsletterIssues.userId, userId),
        eq(newsletterIssues.externalId, post.id)
      )
    )
    .limit(1);

  // Best-effort embedding. Embedding source = title + body_text so search
  // queries about the topic match even when the body uses synonyms.
  const embedSource = [post.title.trim(), text.slice(0, 6000)]
    .filter(Boolean)
    .join('\n\n');
  let embedding: number[] | undefined;
  try {
    if (embedSource.trim().length > 0) {
      embedding = await embedText(embedSource);
    }
  } catch (err) {
    console.warn('[upsertIssue] embed failed', post.id, err);
  }

  const valuesShared = {
    title: post.title,
    subtitle: post.subtitle ?? null,
    slug: post.slug ?? null,
    webUrl: post.web_url ?? null,
    audience: post.audience ?? null,
    status: post.status ?? null,
    publishDate,
    bodyHtml: html || null,
    bodyText: text || null,
    contentTags: post.content_tags ?? [],
    wordCount: wc,
    embedding,
    raw: post as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };

  if (!existing) {
    await db.insert(newsletterIssues).values({
      userId,
      connectorAccountId: accountId,
      externalId: post.id,
      publicationId,
      ...valuesShared,
    });
    return true;
  }

  // Skip if our row is fresher than the upstream change marker.
  if (
    upstreamChangedAt &&
    existing.updatedAt &&
    existing.updatedAt.getTime() >= upstreamChangedAt.getTime()
  ) {
    return false;
  }

  await db
    .update(newsletterIssues)
    .set(valuesShared)
    .where(eq(newsletterIssues.id, existing.id));
  return true;
}
