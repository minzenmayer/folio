// Thoughtbed · LinkedIn sync engine (Phase 12, 2026-05-04)
//
// The thing that bridges Apify's async run model to our existing
// connector pattern. Two exports:
//
//   · startSync(userId, accountId, profileUrl, opts)
//     Kicks off an Apify run for the user's LinkedIn profile and
//     stashes the runId on connector_accounts.metadata. Returns
//     immediately so the server action stays under the Vercel Hobby
//     10s cap.
//
//   · pollAndFinalize(userId, accountId)
//     Checks the in-flight run. If still RUNNING, returns 'pending'.
//     If SUCCEEDED, drains the dataset, upserts every post into
//     linkedin_posts, runs idea extraction on each, and clears the
//     runId from metadata. Returns 'ok' or 'error' with details.
//
// Why split: Apify scrapes can take minutes for a full backfill of
// hundreds of posts. Server actions can't block that long on Vercel
// Hobby. Same chunked pattern as the Wave 2 backfill button — kick the
// work, poll separately, surface progress in the UI.
//
// The cron route at /api/cron/linkedin-sync runs both steps every day:
// kick a fresh run, then immediately try to finalize any pending run
// (the previous one will usually be done by now).

import { eq, and } from 'drizzle-orm';
import {
  db,
  connectorAccounts,
  linkedinPosts,
  type NewLinkedinPost,
} from '@/db';
import { embedText } from '@/lib/embed';
import {
  startProfilePostsScrape,
  getActorRun,
  listDatasetItems,
  isRunPending,
  isRunSucceeded,
  ApifyError,
  type HarvestLinkedinPost,
} from '@/lib/apify';
import { extractIdeasFromLinkedinPost } from '@/lib/extract-ideas';

// ─── types ─────────────────────────────────────────────

export type LinkedinAccountMetadata = {
  profileUrl?: string;
  apifyRunId?: string;
  apifyDatasetId?: string;
  apifyRunStartedAt?: string;
  // Last completed run's stats — surfaced on the UI card.
  lastRunItemCount?: number;
  lastRunUsageUsd?: number;
};

export type StartSyncResult = {
  runId: string;
  datasetId: string;
  startedAt: string;
};

export type PollResult =
  | {
      kind: 'idle';
      message: string;
    }
  | {
      kind: 'pending';
      runId: string;
      startedAt: string;
    }
  | {
      kind: 'ok';
      fetched: number;
      touched: number;
      runId: string;
    }
  | {
      kind: 'error';
      reason: string;
      runId?: string;
    };

// ─── start ─────────────────────────────────────────────

/**
 * Kick a fresh Apify run for one connector account and persist the runId.
 *
 * If a run is already in flight we don't start another one — the
 * existing runId stays put and the next pollAndFinalize call will
 * drain it. Returns the active runId so the caller can render
 * "Sync in progress" without re-checking metadata.
 */
export async function startSync(
  userId: string,
  accountId: string,
  profileUrl: string,
  options: { maxItems?: number } = {}
): Promise<StartSyncResult> {
  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.id, accountId),
        eq(connectorAccounts.userId, userId)
      )
    )
    .limit(1);
  if (!account) throw new Error('Connector account not found');

  const meta = (account.metadata ?? {}) as LinkedinAccountMetadata;

  if (meta.apifyRunId) {
    // Surface the in-flight run, don't burn budget on a duplicate.
    return {
      runId: meta.apifyRunId,
      datasetId: meta.apifyDatasetId ?? '',
      startedAt: meta.apifyRunStartedAt ?? new Date().toISOString(),
    };
  }

  const run = await startProfilePostsScrape(profileUrl, {
    maxItems: options.maxItems,
  });

  const startedAt = new Date().toISOString();
  await db
    .update(connectorAccounts)
    .set({
      metadata: {
        ...meta,
        profileUrl,
        apifyRunId: run.id,
        apifyDatasetId: run.defaultDatasetId,
        apifyRunStartedAt: startedAt,
      },
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, accountId));

  return {
    runId: run.id,
    datasetId: run.defaultDatasetId,
    startedAt,
  };
}

// ─── poll + finalize ───────────────────────────────────

/**
 * Inspect the in-flight Apify run for one account.
 *
 *   - 'idle'    : no run on file. Caller should kick one with startSync.
 *   - 'pending' : run still scraping. UI shows "Sync in progress".
 *   - 'ok'      : run finished + we ingested the dataset. UI flips to
 *                 "Last sync: X items, just now."
 *   - 'error'   : Apify reported FAILED/ABORTED, or the dataset fetch
 *                 blew up. Run is cleared from metadata so the user can
 *                 retry without an "in progress" lock.
 */
export async function pollAndFinalize(
  userId: string,
  accountId: string
): Promise<PollResult> {
  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.id, accountId),
        eq(connectorAccounts.userId, userId)
      )
    )
    .limit(1);
  if (!account) throw new Error('Connector account not found');

  const meta = (account.metadata ?? {}) as LinkedinAccountMetadata;
  if (!meta.apifyRunId) {
    return { kind: 'idle', message: 'No run in flight.' };
  }

  let run;
  try {
    run = await getActorRun(meta.apifyRunId);
  } catch (err) {
    const message =
      err instanceof ApifyError ? err.message : (err as Error).message;
    // Run id is unrecoverable (404). Clear it so the user isn't stuck.
    if (err instanceof ApifyError && err.status === 404) {
      await clearRun(accountId, meta);
    }
    return { kind: 'error', reason: message, runId: meta.apifyRunId };
  }

  if (isRunPending(run.status)) {
    return {
      kind: 'pending',
      runId: run.id,
      startedAt: meta.apifyRunStartedAt ?? run.startedAt,
    };
  }

  if (!isRunSucceeded(run.status)) {
    await clearRun(accountId, meta, {
      lastSyncStatus: 'error',
      lastSyncError: `Apify run ${run.status.toLowerCase()}`,
    });
    return {
      kind: 'error',
      reason: `Apify run ${run.status}`,
      runId: run.id,
    };
  }

  // Run succeeded — drain the dataset and upsert.
  let posts: HarvestLinkedinPost[];
  try {
    posts = await listDatasetItems<HarvestLinkedinPost>(run.defaultDatasetId);
  } catch (err) {
    const message = (err as Error).message;
    await clearRun(accountId, meta, {
      lastSyncStatus: 'error',
      lastSyncError: `Dataset fetch failed: ${message}`.slice(0, 500),
    });
    return { kind: 'error', reason: message, runId: run.id };
  }

  let touched = 0;
  let errored = 0;
  for (const post of posts) {
    try {
      const wrote = await upsertPost(userId, accountId, post);
      if (wrote) touched++;
    } catch (err) {
      errored++;
      console.warn('[linkedin-sync] upsert failed', post.id, err);
    }
  }

  const status =
    errored === 0 ? 'ok' : touched === 0 ? 'error' : 'partial';

  await db
    .update(connectorAccounts)
    .set({
      metadata: {
        ...meta,
        profileUrl: meta.profileUrl,
        apifyRunId: undefined,
        apifyDatasetId: undefined,
        apifyRunStartedAt: undefined,
        lastRunItemCount: posts.length,
        lastRunUsageUsd: run.usageUsd,
      } as LinkedinAccountMetadata,
      lastSyncAt: new Date(),
      lastSyncStatus: status,
      lastSyncError:
        errored === 0 ? null : `${errored}/${posts.length} posts failed`,
      lastSyncCount: touched,
      status: 'connected',
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, accountId));

  return {
    kind: 'ok',
    fetched: posts.length,
    touched,
    runId: run.id,
  };
}

async function clearRun(
  accountId: string,
  meta: LinkedinAccountMetadata,
  patch: {
    lastSyncStatus?: string;
    lastSyncError?: string | null;
  } = {}
) {
  await db
    .update(connectorAccounts)
    .set({
      metadata: {
        ...meta,
        apifyRunId: undefined,
        apifyDatasetId: undefined,
        apifyRunStartedAt: undefined,
      } as LinkedinAccountMetadata,
      lastSyncAt: new Date(),
      lastSyncStatus: patch.lastSyncStatus ?? null,
      lastSyncError: patch.lastSyncError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, accountId));
}

// ─── upsert one post ───────────────────────────────────

/**
 * Idempotent insert-or-update for one Apify-returned LinkedIn post.
 * Returns true when the row was written (insert or content change).
 *
 * Best-effort embedding + idea extraction — same pattern as Beehiiv's
 * upsertIssue: don't unwind the row on OpenAI flake.
 */
export async function upsertPost(
  userId: string,
  accountId: string,
  post: HarvestLinkedinPost
): Promise<boolean> {
  if (!post.id) return false;
  if (post.type && post.type !== 'post') {
    // Skip reposts/comments for now — the existing schema can hold them
    // (post_type column) but the v1 connector intentionally narrows to
    // top-level posts so the extractIdeas signal stays clean.
    return false;
  }

  const externalId = post.id;
  const linkedinUrl =
    post.linkedinUrl ||
    `https://www.linkedin.com/feed/update/urn:li:activity:${externalId}/`;

  const content = (post.content ?? '').trim();
  const bodyClean = cleanLinkedinPostText(content);

  const postedAtIso =
    post.postedAt?.date ??
    (post.postedAt?.timestamp
      ? new Date(post.postedAt.timestamp).toISOString()
      : null);

  if (!postedAtIso) {
    console.warn('[linkedin-sync] post missing postedAt', externalId);
    return false;
  }

  const author = post.author ?? {};
  const imageUrls = (post.postImages ?? [])
    .map((img) => img.url)
    .filter((u): u is string => !!u);

  const reactionCount =
    post.reactionCount ?? post.reactions?.count ?? null;
  const commentCount = post.commentCount ?? post.comments?.count ?? null;
  const shareCount = post.shareCount ?? post.shares?.count ?? null;

  // Embed body_clean — fall back silently on flake. Extracted ideas use
  // their own embedding inside extractIdeasFromLinkedinPost.
  let embedding: number[] | undefined;
  if (bodyClean.length >= 16) {
    try {
      embedding = await embedText(bodyClean);
    } catch (err) {
      console.warn('[linkedin-sync] embed failed', externalId, err);
    }
  }

  const row: NewLinkedinPost = {
    userId,
    connectorAccountId: accountId,
    externalId,
    linkedinUrl,
    content: content || null,
    bodyClean: bodyClean || null,
    postedAt: new Date(postedAtIso),
    postType: post.type ?? 'post',
    authorId: author.id ?? null,
    authorHandle: author.publicIdentifier ?? null,
    authorName: author.name ?? null,
    imageUrls: imageUrls.length ? imageUrls : [],
    reactionCount,
    commentCount,
    shareCount,
    embedding,
    raw: post as unknown as Record<string, unknown>,
  };

  const [returned] = await db
    .insert(linkedinPosts)
    .values(row)
    .onConflictDoUpdate({
      target: [linkedinPosts.userId, linkedinPosts.externalId],
      set: {
        connectorAccountId: row.connectorAccountId,
        linkedinUrl: row.linkedinUrl,
        content: row.content,
        bodyClean: row.bodyClean,
        postedAt: row.postedAt,
        postType: row.postType,
        authorId: row.authorId,
        authorHandle: row.authorHandle,
        authorName: row.authorName,
        imageUrls: row.imageUrls,
        reactionCount: row.reactionCount,
        commentCount: row.commentCount,
        shareCount: row.shareCount,
        embedding: row.embedding,
        raw: row.raw,
        updatedAt: new Date(),
      },
    })
    .returning({ id: linkedinPosts.id });

  if (!returned) return false;

  // Best-effort idea extraction. Don't unwind the row on extract flake.
  try {
    if (bodyClean.length >= 40) {
      await extractIdeasFromLinkedinPost({
        userId,
        postId: returned.id,
        title: deriveTitleFromBody(bodyClean),
        bodyText: bodyClean,
        webUrl: linkedinUrl,
        postedAt: postedAtIso,
      });
    }
  } catch (err) {
    console.warn('[linkedin-sync] extractIdeas failed', externalId, err);
  }

  return true;
}

// ─── small helpers ─────────────────────────────────────

/**
 * LinkedIn posts don't have titles — they're prose. Use the first
 * 80 chars (or until first newline) as the title for extractIdeas
 * routing. Trimmed and ellipsis-padded so `[1] from your LinkedIn`
 * citations have something to reference.
 */
export function deriveTitleFromBody(body: string): string {
  const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (firstLine.length <= 80) return firstLine || '(LinkedIn post)';
  return firstLine.slice(0, 77).trimEnd() + '…';
}

/**
 * Light cleanup of LinkedIn-flavored boilerplate: collapse runs of
 * blank lines, drop the "...see more" cutoff that LinkedIn injects on
 * very long posts, normalize unicode spaces. We deliberately keep
 * URLs and hashtags inline — they're useful retrieval signal.
 */
export function cleanLinkedinPostText(content: string): string {
  if (!content) return '';
  return content
    // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) — used
    // as raw chars in a regex literal they're treated as line
    // terminators by the parser and break the build (SWC). Encode them.
    .replace(/[\u2028\u2029]/g, '\n')
    // U+00A0 (NON-BREAKING SPACE) — LinkedIn loves these in pasted copy.
    .replace(/\u00a0/g, ' ')
    // U+2026 (HORIZONTAL ELLIPSIS) plus the ASCII-dotted variant.
    .replace(/\s*\u2026see more$/i, '')
    .replace(/\s*\.\.\.see more$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
