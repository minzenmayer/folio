'use server';

/**
 * src/app/studio/actions.ts — Sprint 15 Wave 2
 *
 * Studio-level server actions.
 *
 * Wave 2 additions:
 * ─────────────────
 * • backfillExtractedIdeas() — sweeps newsletter_issues + obsidian_notes
 *   and runs extractIdeas() where no ideas exist yet.  Surfaced as a
 *   second BackfillButton on /studio.  Idempotent per source.
 *
 * Pre-existing:
 * • backfillEmbeddings()  — unchanged.
 * • Other studio helpers  — unchanged.
 */

import { auth }              from '@clerk/nextjs/server';
import { db }                from '@/db';
import {
  newsletterIssues,
  obsidianNotes,
  extractedIdeas,
  newsletterEmbeddings,
} from '@/db/schema';
import { eq, notInArray, sql } from 'drizzle-orm';
import { revalidatePath }    from 'next/cache';
import { extractIdeas }      from '@/lib/extract-ideas';

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// backfillExtractedIdeas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sweeps every newsletter_issue and obsidian_note that has no
 * extracted_ideas rows yet and runs extractIdeas() on each.
 *
 * Idempotent: sources that already have ideas are skipped.
 * Safe to call multiple times — only processes the gap.
 *
 * @returns Summary of what was processed.
 */
export async function backfillExtractedIdeas(): Promise<{
  ok: boolean;
  processed: number;
  skipped:   number;
  errors:    string[];
}> {
  await requireUserId();

  let processed = 0;
  let skipped   = 0;
  const errors: string[] = [];

  // ── 1. Newsletter issues without ideas ───────────────────────────────────
  const issuesWithIdeas = await db
    .selectDistinct({ issueId: extractedIdeas.issueId })
    .from(extractedIdeas)
    .where(sql`${extractedIdeas.issueId} IS NOT NULL`);

  const coveredIssueIds = issuesWithIdeas
    .map((r) => r.issueId)
    .filter((id): id is string => id !== null);

  const issueRows = await (coveredIssueIds.length > 0
    ? db
        .select({ id: newsletterIssues.id, content: newsletterIssues.content, tags: newsletterIssues.tags })
        .from(newsletterIssues)
        .where(notInArray(newsletterIssues.id, coveredIssueIds))
    : db
        .select({ id: newsletterIssues.id, content: newsletterIssues.content, tags: newsletterIssues.tags })
        .from(newsletterIssues)
  );

  for (const issue of issueRows) {
    try {
      const ideas = await extractIdeas(issue.content, {
        sourceRef: issue.id,
        tags:      issue.tags,
      });

      if (ideas.length === 0) { skipped++; continue; }

      await db.insert(extractedIdeas).values(
        ideas.map((idea) => ({
          issueId:       issue.id,
          title:         idea.title,
          claim:         idea.claim,
          evidence:      idea.evidence ?? null,
          depthScore:    idea.depthScore ?? null,
          breadthScore:  idea.breadthScore ?? null,
          outboundLinks: idea.links ?? [],
          sourceRef:     idea.sourceRef ?? null,
        }))
      );
      processed++;
    } catch (err) {
      errors.push(`issue ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. Obsidian notes without ideas ──────────────────────────────────────
  const notesWithIdeas = await db
    .selectDistinct({ noteId: extractedIdeas.noteId })
    .from(extractedIdeas)
    .where(sql`${extractedIdeas.noteId} IS NOT NULL`);

  const coveredNoteIds = notesWithIdeas
    .map((r) => r.noteId)
    .filter((id): id is string => id !== null);

  const noteRows = await (coveredNoteIds.length > 0
    ? db
        .select({ id: obsidianNotes.id, content: obsidianNotes.content, tags: obsidianNotes.tags, frontmatter: obsidianNotes.frontmatter })
        .from(obsidianNotes)
        .where(notInArray(obsidianNotes.id, coveredNoteIds))
    : db
        .select({ id: obsidianNotes.id, content: obsidianNotes.content, tags: obsidianNotes.tags, frontmatter: obsidianNotes.frontmatter })
        .from(obsidianNotes)
  );

  for (const note of noteRows) {
    try {
      const ideas = await extractIdeas(note.content, {
        sourceRef:   note.id,
        tags:        note.tags,
        frontmatter: note.frontmatter as Record<string, unknown>,
      });

      if (ideas.length === 0) { skipped++; continue; }

      await db.insert(extractedIdeas).values(
        ideas.map((idea) => ({
          noteId:        note.id,
          title:         idea.title,
          claim:         idea.claim,
          evidence:      idea.evidence ?? null,
          depthScore:    idea.depthScore ?? null,
          breadthScore:  idea.breadthScore ?? null,
          outboundLinks: idea.links ?? [],
          sourceRef:     idea.sourceRef ?? null,
        }))
      );
      processed++;
    } catch (err) {
      errors.push(`note ${note.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  revalidatePath('/studio');
  return { ok: errors.length === 0, processed, skipped, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// backfillEmbeddings  (unchanged from Wave 1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates embeddings for every newsletter issue that doesn't have
 * any yet.  Uses OpenAI text-embedding-3-small.
 */
export async function backfillEmbeddings(): Promise<{
  ok: boolean;
  processed: number;
  skipped:   number;
  errors:    string[];
}> {
  await requireUserId();

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  let processed = 0;
  let skipped   = 0;
  const errors: string[] = [];

  // Issues that already have at least one embedding chunk
  const covered = await db
    .selectDistinct({ issueId: newsletterEmbeddings.issueId })
    .from(newsletterEmbeddings);

  const coveredIds = covered.map((r) => r.issueId);

  const issues = await (coveredIds.length > 0
    ? db
        .select({ id: newsletterIssues.id, content: newsletterIssues.content })
        .from(newsletterIssues)
        .where(notInArray(newsletterIssues.id, coveredIds))
    : db
        .select({ id: newsletterIssues.id, content: newsletterIssues.content })
        .from(newsletterIssues)
  );

  for (const issue of issues) {
    const text = issue.content.trim();
    if (!text) { skipped++; continue; }

    // Naive 800-word chunking — good enough for Sprint 15.
    const words  = text.split(/\s+/);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 800) {
      chunks.push(words.slice(i, i + 800).join(' '));
    }

    let chunkFailed = false;
    for (let idx = 0; idx < chunks.length; idx++) {
      try {
        const embRes = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: chunks[idx],
          }),
        });
        if (!embRes.ok) throw new Error(`OpenAI ${embRes.status}`);
        const embJson = await embRes.json() as { data: Array<{ embedding: number[] }> };
        const vector  = embJson.data[0].embedding;

        await db
          .insert(newsletterEmbeddings)
          .values({
            issueId:   issue.id,
            chunkIdx:  idx,
            content:   chunks[idx],
            embedding: JSON.stringify(vector),
          })
          .onConflictDoNothing();
      } catch (err) {
        errors.push(
          `${issue.id} chunk ${idx}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        chunkFailed = true;
        break;
      }
    }

    if (!chunkFailed) processed++;
    else skipped++;
  }

  return { ok: errors.length === 0, processed, skipped, errors };
}
