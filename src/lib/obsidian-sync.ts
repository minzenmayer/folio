// Thoughtbed · Obsidian sync engine (Sprint 15 Wave 2).
//
// Mirrors src/lib/beehiiv-sync.ts for the Obsidian-via-GitHub connector.
// Same shape: pure functions that the user-scoped server actions, the
// daily cron, and the webhook dispatcher all share — so cron + push + UI
// drive a single source of truth.
//
// Two exports:
//
//   · runSync(userId, accountId, ctx)
//     Pulls the full vault tree, diffs against what's already in
//     obsidian_notes, upserts changed/new files, removes vanished ones.
//     Best-effort embeddings + extracted ideas — soft per-row failures
//     are logged + counted; hard failures (auth, 5xx) bubble.
//
//   · upsertNote(userId, accountId, ctx, treeEntry)
//     Idempotent insert-or-update for one Markdown file. Returns true if
//     anything was written. Skips when the blob sha matches what's
//     already on the row (cheap diff). Re-runs extractIdeas on every
//     write so the extracted_ideas table never drifts from the source.

import { eq, and, inArray, notInArray } from 'drizzle-orm';
import {
  db,
  connectorAccounts,
  obsidianNotes,
  extractedIdeas,
  type ObsidianNote,
} from '@/db';
import { embedText } from '@/lib/embed';
import {
  parseMarkdown,
  resolveTitle,
  extractLinks,
  resolveTags,
  markdownToPlainText,
  countWords,
} from '@/lib/markdown';
import {
  GitHubError,
  decodeBlobUtf8,
  getBlob,
  getBranchTree,
  getFileAtRef,
  isVaultMarkdown,
  type GitTreeEntry,
} from '@/lib/obsidian';
import { extractIdeasFromObsidian } from '@/lib/extract-ideas';

export type ObsidianSyncCtx = {
  pat: string;
  owner: string;
  repo: string;
  branch: string;
};

export type ObsidianSyncResult = {
  fetched: number;
  touched: number;
  removed: number;
};

/**
 * Pull the entire vault and reconcile into obsidian_notes. Updates
 * connector_accounts.last_sync_* on both success and failure paths.
 *
 * Strategy:
 *   1. Get the recursive tree at the branch tip.
 *   2. Build a Set of vault-relative paths we expect to see post-sync.
 *   3. For each .md entry: if our row's blob_sha matches, skip; else
 *      fetch the blob, parse, upsert, re-extract ideas.
 *   4. Delete any rows whose path is no longer in the tree (the user
 *      removed the file from the vault).
 */
export async function runSync(
  userId: string,
  accountId: string,
  ctx: ObsidianSyncCtx
): Promise<ObsidianSyncResult> {
  let fetched = 0;
  let touched = 0;
  let removed = 0;
  let errored = 0;

  try {
    const tree = await getBranchTree(ctx.pat, ctx.owner, ctx.repo, ctx.branch);
    const mdEntries = tree.tree.filter((e) => isVaultMarkdown(e));
    fetched = mdEntries.length;

    // Existing rows for this account (so we can skip unchanged + delete
    // disappeared paths in one pass). At founder scale this fits in
    // memory comfortably; if a future user has 50k+ notes we'd page.
    const existing = await db
      .select({
        id: obsidianNotes.id,
        externalId: obsidianNotes.externalId,
        blobSha: obsidianNotes.blobSha,
      })
      .from(obsidianNotes)
      .where(
        and(
          eq(obsidianNotes.userId, userId),
          eq(obsidianNotes.connectorAccountId, accountId)
        )
      );
    const existingByPath = new Map(existing.map((r) => [r.externalId, r]));

    const seenPaths = new Set<string>();

    for (const entry of mdEntries) {
      seenPaths.add(entry.path);
      try {
        const wrote = await upsertNote(userId, accountId, ctx, entry, {
          // Optimization: pass through the cached blob sha so upsertNote
          // can short-circuit without fetching the blob if nothing changed.
          existingBlobSha: existingByPath.get(entry.path)?.blobSha ?? null,
        });
        if (wrote) touched++;
      } catch (err) {
        errored++;
        console.warn('[obsidian:runSync] upsert failed', entry.path, err);
      }
    }

    // Delete rows for paths no longer present. extracted_ideas rows cascade
    // via the FK, so a removed note's ideas vanish with it.
    const survivingPaths = Array.from(seenPaths);
    if (existing.length > 0) {
      const toRemove = existing.filter((r) => !seenPaths.has(r.externalId));
      if (toRemove.length > 0) {
        await db
          .delete(obsidianNotes)
          .where(
            and(
              eq(obsidianNotes.userId, userId),
              eq(obsidianNotes.connectorAccountId, accountId),
              survivingPaths.length > 0
                ? notInArray(obsidianNotes.externalId, survivingPaths)
                : // edge case: vault is empty post-sync
                  inArray(
                    obsidianNotes.externalId,
                    toRemove.map((r) => r.externalId)
                  )
            )
          );
        removed = toRemove.length;
      }
    }

    const status =
      errored === 0 ? 'ok' : touched === 0 && removed === 0 ? 'error' : 'partial';
    await db
      .update(connectorAccounts)
      .set({
        status: 'connected',
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        lastSyncError: errored > 0 ? `${errored} file(s) failed` : null,
        lastSyncCount: touched,
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, accountId));

    return { fetched, touched, removed };
  } catch (err) {
    const code =
      err instanceof GitHubError && err.code === 'auth_failed'
        ? 'auth_failed'
        : err instanceof GitHubError && err.code === 'rate_limited'
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
 * Apply one note. Three code paths:
 *
 *   · Same blob sha as DB → skip (no fetch, no embed, no LLM).
 *   · New path or different sha → fetch blob, parse, embed, upsert,
 *     re-run extractIdeas to refresh extracted_ideas.
 *   · Sha unknown (called from webhook handler with a path-only delta) →
 *     same as "different sha" path; we always fetch.
 */
export async function upsertNote(
  userId: string,
  accountId: string,
  ctx: ObsidianSyncCtx,
  entry: GitTreeEntry,
  opts: { existingBlobSha?: string | null } = {}
): Promise<boolean> {
  if (
    opts.existingBlobSha &&
    entry.sha &&
    opts.existingBlobSha === entry.sha
  ) {
    return false;
  }

  const blob = await getBlob(ctx.pat, ctx.owner, ctx.repo, entry.sha);
  const content = decodeBlobUtf8(blob);
  if (content === null) return false;

  return upsertParsedNote(userId, accountId, entry.path, entry.sha, content);
}

/**
 * Webhook entry point: we have a path (and optionally a ref), fetch the
 * file fresh from GitHub, parse + upsert. Used by the Obsidian connector's
 * handle() when a push event fires.
 */
export async function upsertNoteByPath(
  userId: string,
  accountId: string,
  ctx: ObsidianSyncCtx,
  path: string,
  ref: string
): Promise<boolean> {
  const file = await getFileAtRef(ctx.pat, ctx.owner, ctx.repo, path, ref);
  return upsertParsedNote(userId, accountId, path, file.sha, file.content);
}

/**
 * Delete a note by vault-relative path. extracted_ideas cascade through
 * the FK. Used by the webhook handler when a push removes a file.
 */
export async function deleteNoteByPath(
  userId: string,
  accountId: string,
  path: string
): Promise<boolean> {
  const result = await db
    .delete(obsidianNotes)
    .where(
      and(
        eq(obsidianNotes.userId, userId),
        eq(obsidianNotes.connectorAccountId, accountId),
        eq(obsidianNotes.externalId, path)
      )
    )
    .returning({ id: obsidianNotes.id });
  return result.length > 0;
}

// ─── internals ─────────────────────────────────────────

async function upsertParsedNote(
  userId: string,
  accountId: string,
  path: string,
  blobSha: string,
  content: string
): Promise<boolean> {
  const parsed = parseMarkdown(content);
  const title = resolveTitle(parsed.frontmatter, parsed.body, path);
  const plain = markdownToPlainText(parsed.body);
  const wc = countWords(plain);
  const links = extractLinks(parsed.body);
  const tags = resolveTags(parsed.frontmatter, parsed.body);

  const embedSource = [title, plain.slice(0, 6000)].filter(Boolean).join('\n\n');
  let embedding: number[] | undefined;
  try {
    if (embedSource.trim().length > 0) {
      embedding = await embedText(embedSource);
    }
  } catch (err) {
    console.warn('[obsidian:upsert] embed failed', path, err);
  }

  const valuesShared = {
    path,
    blobSha,
    title,
    frontmatter: parsed.frontmatter as Record<string, unknown>,
    bodyText: plain,
    bodyMarkdown: content,
    links,
    tags,
    wordCount: wc,
    embedding,
    raw: { blobSha, contentLength: content.length } as Record<string, unknown>,
    updatedAt: new Date(),
  };

  // Check for existing row keyed on (userId, externalId=path).
  const [existing] = await db
    .select({ id: obsidianNotes.id })
    .from(obsidianNotes)
    .where(
      and(
        eq(obsidianNotes.userId, userId),
        eq(obsidianNotes.externalId, path)
      )
    )
    .limit(1);

  let noteId: string;
  if (!existing) {
    const [row] = await db
      .insert(obsidianNotes)
      .values({
        userId,
        connectorAccountId: accountId,
        externalId: path,
        ...valuesShared,
      })
      .returning({ id: obsidianNotes.id });
    noteId = row.id;
  } else {
    await db
      .update(obsidianNotes)
      .set(valuesShared)
      .where(eq(obsidianNotes.id, existing.id));
    noteId = existing.id;
  }

  // Refresh extracted_ideas for this note. Best-effort — extraction is an
  // LLM call and we'd rather have a synced note without ideas than fail
  // the whole sync. The extract-ideas helper handles delete-then-insert.
  try {
    await extractIdeasFromObsidian({
      userId,
      noteId,
      title,
      bodyText: plain,
      frontmatter: parsed.frontmatter,
      links,
      tags,
      path,
    });
  } catch (err) {
    console.warn('[obsidian:upsert] extractIdeas failed', path, err);
  }

  return true;
}

// ─── helper for the webhook payload ─────────────────────

/**
 * Pull the unique set of changed vault paths from a GitHub push payload.
 * Aggregates `added`, `modified`, and `removed` arrays across every commit
 * in the push. Returns:
 *   · upserts: paths we should re-fetch
 *   · removes: paths we should delete
 *
 * If a path appears in both lists across commits (rapid edit-then-rename),
 * the latest "removed" wins (more recent commit). The webhook handler
 * applies them in order.
 */
export type PushDelta = {
  upserts: string[];
  removes: string[];
};

export function diffPushPayload(payload: unknown): PushDelta {
  const upserts = new Set<string>();
  const removes = new Set<string>();
  if (!payload || typeof payload !== 'object') {
    return { upserts: [], removes: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commits = (payload as any).commits;
  if (!Array.isArray(commits)) return { upserts: [], removes: [] };

  for (const c of commits) {
    if (!c || typeof c !== 'object') continue;
    const added = Array.isArray(c.added) ? c.added : [];
    const modified = Array.isArray(c.modified) ? c.modified : [];
    const removed = Array.isArray(c.removed) ? c.removed : [];
    for (const p of [...added, ...modified]) {
      if (typeof p !== 'string') continue;
      if (!/\.md$/i.test(p)) continue;
      if (p.split('/').some((s) => s.startsWith('.'))) continue;
      upserts.add(p);
      removes.delete(p);
    }
    for (const p of removed) {
      if (typeof p !== 'string') continue;
      if (!/\.md$/i.test(p)) continue;
      removes.add(p);
      upserts.delete(p);
    }
  }
  return { upserts: Array.from(upserts), removes: Array.from(removes) };
}

// Re-export so the connector's handle() can hand me a row without
// re-doing the type narrowing.
export type { ObsidianNote };
