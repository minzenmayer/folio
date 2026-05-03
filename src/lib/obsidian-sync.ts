/**
 * src/lib/obsidian-sync.ts
 *
 * Pure sync engine for the Obsidian-via-GitHub connector.
 *
 * This module contains no I/O beyond what callers pass in — all
 * network and DB calls are injected so the logic stays unit-testable.
 *
 * Terminology
 * ───────────
 * • "vault"   — the GitHub repository that backs an Obsidian vault.
 * • "note"    — a single markdown file inside the vault.
 * • "blob"    — a Git blob (file at a specific SHA).
 * • "diff"    — the set of notes to upsert or delete in this sync run.
 *
 * Exports
 * ───────
 * syncVault(config)            full vault sync (cron / manual trigger)
 * diffPushPayload(push, ...)   incremental sync from a push webhook
 * upsertParsedNote(note, ...)  write one note to the DB
 */

import { fetchVaultTree, fetchBlob, type PushPayload } from './obsidian';
import { parseMarkdownNote }                           from './markdown';
import { extractIdeas }                                from './extract-ideas';
import { db }                                          from '@/db';
import { obsidianNotes, extractedIdeas }               from '@/db/schema';
import { eq, and, inArray, notInArray }                from 'drizzle-orm';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultConfig {
  /** "owner/repo" of the GitHub vault. */
  repoFull: string;
  /** Branch to sync (default: main). */
  branch?: string;
  /** GitHub PAT with contents:read. */
  token: string;
  /** Only sync files matching this glob prefix (default: sync all .md). */
  pathPrefix?: string;
}

export interface SyncResult {
  upserted: number;
  deleted:  number;
  skipped:  number;  // blob-SHA match — no change
  errors:   string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isMarkdown(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.markdown');
}

/**
 * Converts a vault-relative path to the stable `id` we store in
 * `obsidian_notes`.  We use the path directly — it is unique within
 * a repo and human-readable.
 */
function noteId(repoFull: string, path: string): string {
  return `${repoFull}::${path}`;
}

// ── upsertParsedNote ─────────────────────────────────────────────────────────

/**
 * Parses a raw markdown blob and writes (or updates) one row in
 * `obsidian_notes`, then runs `extractIdeas` so the ideas table
 * stays in sync without a separate backfill pass.
 *
 * @returns The db row id of the upserted note.
 */
export async function upsertParsedNote(
  repoFull: string,
  path:     string,
  raw:      string,
  blobSha:  string
): Promise<string> {
  const id      = noteId(repoFull, path);
  const parsed  = parseMarkdownNote(raw, path);

  await db
    .insert(obsidianNotes)
    .values({
      id,
      repoFull,
      title:       parsed.title ?? null,
      content:     parsed.body,
      frontmatter: parsed.frontmatter,
      tags:        parsed.tags,
      wikilinks:   parsed.wikilinks,
      blobSha,
      syncedAt:    new Date(),
      updatedAt:   new Date(),
    })
    .onConflictDoUpdate({
      target: obsidianNotes.id,
      set: {
        title:       parsed.title ?? null,
        content:     parsed.body,
        frontmatter: parsed.frontmatter,
        tags:        parsed.tags,
        wikilinks:   parsed.wikilinks,
        blobSha,
        syncedAt:    new Date(),
        updatedAt:   new Date(),
      },
    });

  // Extract ideas inline so cron, push, and manual UI calls all align.
  try {
    const ideas = await extractIdeas(parsed.body, {
      sourceRef: path,
      tags:      parsed.tags,
      frontmatter: parsed.frontmatter,
    });

    if (ideas.length > 0) {
      // Delete any stale ideas for this note before inserting fresh ones.
      await db
        .delete(extractedIdeas)
        .where(eq(extractedIdeas.noteId, id));

      await db.insert(extractedIdeas).values(
        ideas.map((idea) => ({
          noteId:        id,
          title:         idea.title,
          claim:         idea.claim,
          evidence:      idea.evidence ?? null,
          depthScore:    idea.depthScore ?? null,
          breadthScore:  idea.breadthScore ?? null,
          outboundLinks: idea.links ?? [],
          sourceRef:     idea.sourceRef ?? null,
        }))
      );
    }
  } catch (err) {
    // Non-fatal: ideas extraction is best-effort.
    console.error(`[obsidian-sync] extractIdeas failed for ${path}:`, err);
  }

  return id;
}

// ── syncVault ────────────────────────────────────────────────────────────────

/**
 * Full vault sync — compares the live GitHub tree against what we
 * have in `obsidian_notes` and performs the minimum set of writes.
 *
 * Algorithm
 * ─────────
 * 1. Fetch the full recursive tree from GitHub.
 * 2. Filter to markdown files (optionally scoped to pathPrefix).
 * 3. Load existing blob SHAs from DB for this repo.
 * 4. Skip files whose blob SHA hasn't changed.
 * 5. Fetch + upsert changed/new files.
 * 6. Delete DB rows whose paths have vanished from the tree.
 */
export async function syncVault(config: VaultConfig): Promise<SyncResult> {
  const { repoFull, branch = 'HEAD', token, pathPrefix } = config;
  const result: SyncResult = { upserted: 0, deleted: 0, skipped: 0, errors: [] };
  const signal = AbortSignal.timeout(120_000); // 2-minute hard cap

  // ── 1. Fetch tree ──────────────────────────────────────────────────────────
  let tree;
  try {
    tree = await fetchVaultTree(repoFull, branch, token, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...result, errors: [`fetchVaultTree failed: ${msg}`] };
  }

  // ── 2. Filter ──────────────────────────────────────────────────────────────
  const candidates = tree.filter(
    (e) =>
      isMarkdown(e.path) &&
      (!pathPrefix || e.path.startsWith(pathPrefix))
  );

  // ── 3. Load existing SHAs ──────────────────────────────────────────────────
  const existingRows = await db
    .select({ id: obsidianNotes.id, blobSha: obsidianNotes.blobSha })
    .from(obsidianNotes)
    .where(eq(obsidianNotes.repoFull, repoFull));

  const shaByPath = new Map(
    existingRows.map((r) => [r.id, r.blobSha])
  );

  // ── 4–5. Upsert changed / new notes ──────────────────────────────────────
  for (const entry of candidates) {
    const id = noteId(repoFull, entry.path);
    if (shaByPath.get(id) === entry.sha) {
      result.skipped++;
      continue;
    }

    try {
      const raw = await fetchBlob(repoFull, entry.sha, token, signal);
      await upsertParsedNote(repoFull, entry.path, raw, entry.sha);
      result.upserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`upsert ${entry.path}: ${msg}`);
    }
  }

  // ── 6. Delete vanished paths ───────────────────────────────────────────────
  const liveIds = candidates.map((e) => noteId(repoFull, e.path));
  const staleIds = existingRows
    .map((r) => r.id)
    .filter((id) => !liveIds.includes(id));

  if (staleIds.length > 0) {
    await db
      .delete(obsidianNotes)
      .where(
        and(
          eq(obsidianNotes.repoFull, repoFull),
          inArray(obsidianNotes.id, staleIds)
        )
      );
    result.deleted += staleIds.length;
  }

  return result;
}

// ── diffPushPayload ───────────────────────────────────────────────────────────

/**
 * Incremental sync driven by a GitHub push webhook.
 *
 * Only processes the paths mentioned in the push event commits —
 * much cheaper than a full vault sync for frequent edits.
 */
export async function diffPushPayload(
  push:  PushPayload,
  token: string
): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, deleted: 0, skipped: 0, errors: [] };
  const signal = AbortSignal.timeout(60_000);

  const added    = push.commits.flatMap((c) => c.added);
  const modified = push.commits.flatMap((c) => c.modified);
  const removed  = push.commits.flatMap((c) => c.removed);

  // Upsert added + modified markdown files
  const toUpsert = [...new Set([...added, ...modified])].filter(isMarkdown);
  for (const path of toUpsert) {
    try {
      // We don't have the blob SHA from the push event, so fetch via path.
      const res = await fetch(
        `https://api.github.com/repos/${push.repoFull}/contents/${encodeURIComponent(path)}?ref=${push.ref}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
          signal,
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json() as { sha: string; content: string; encoding: string };
      const raw  =
        meta.encoding === 'base64'
          ? Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf-8')
          : meta.content;

      await upsertParsedNote(push.repoFull, path, raw, meta.sha);
      result.upserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`upsert ${path}: ${msg}`);
    }
  }

  // Delete removed markdown files
  const toDelete = [...new Set(removed)].filter(isMarkdown);
  if (toDelete.length > 0) {
    const ids = toDelete.map((p) => noteId(push.repoFull, p));
    await db
      .delete(obsidianNotes)
      .where(inArray(obsidianNotes.id, ids));
    result.deleted += toDelete.length;
  }

  return result;
}
