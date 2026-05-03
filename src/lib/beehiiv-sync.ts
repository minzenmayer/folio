// Thoughtbed · Beehiiv sync engine (Sprint 13 Wave 2).
//
// Wave 1 lived inside src/app/studio/settings/connectors/actions.ts as
// private helpers. Wave 2 extracts them so non-server-action callers
// (specifically /api/cron/beehiiv-sync) can drive sync without going
// through the user-scoped server-action surface.
//
// Two exports:
//   · runSync(userId, accountId, apiKey, publicationId)
//     Walks the Beehiiv archive once, upserting into newsletter_issues
//     and updating the connector_accounts row's last_sync_* fields.
//     Throws on hard failures (auth, network) so callers can surface
//     them; soft per-row failures are logged + counted.
//
//   · upsertIssue(userId, accountId, publicationId, post)
//     Idempotent insert-or-update for one Beehiiv post. Returns true if
//     anything was written. Best-effort embedding so OpenAI flakiness
//     doesn't unwind the row insert.
//
// The functions don't authenticate; that's the caller's job. The user
// flow goes through requireUser() in actions.ts; the cron route auths
// via the CRON_SECRET bearer token before calling runSync per account.

import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts, newsletterIssues } from '@/db';
import { embedText } from '@/lib/embed';
import {
  listAllPosts,
  BeehiivError,
  type BeehiivPost,
} from '@/lib/beehiiv';
import { htmlToText, wordCount } from '@/lib/html-to-text';

export type SyncResult = { fetched: number; touched: number };

/**
 * Pull the Beehiiv archive for one connector account and reconcile into
 * newsletter_issues. Updates connector_accounts.last_sync_* on success
 * and on failure paths. Throws on hard upstream errors so callers can
 * map to typed responses (or, for the cron, log + continue).
 */
export async function runSync(
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
    // Hard failure — record + rethrow.
    const code =
      err instanceof BeehiivError && err.code === 'auth_failed'
        ? 'auth_failed'
        : err instanceof BeehiivError && err.code === 'rate_limited'
          ? 'rate_limited'
          : 'error';
    await db
      .update(connectorAccounts)
      .set({
        // auth_failed => mark connector errored so the BeehiivCard nudges
        // the user to reconnect. rate_limited / network errors stay
        // 'connected' so the next cron run retries automatically.
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
 * Insert one Beehiiv post into newsletter_issues, or update if a fresher
 * upstream change marker is present. Returns true if anything was written.
 */
export async function upsertIssue(
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

  // status_changed_at is documented but not consistently returned by the
  // posts list endpoint — see the spike notes in src/lib/beehiiv.ts. When
  // null we fall back to "always re-write", which is fine at archive
  // scale (tens of issues, ~$0.01 of embedding work per full sync).
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

  // Best-effort embedding. Source = title + body_text so search queries
  // about the topic match even when the body uses synonyms.
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

  // Skip if we're already fresher than the upstream marker (when we have it).
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
