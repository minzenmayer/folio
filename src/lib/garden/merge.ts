// Phase 14b — Garden redesign · "Add to existing" merge flow
//
// When an unclaimed extracted_idea matches an existing claimed idea above
// 0.85 cosine, we offer three paths (spec section 5):
//   · merge_body     — incoming claim becomes a body paragraph (with attribution)
//                      v1 ships literal-append; v2 will rewrite in voice (Voice ID dep)
//   · link_extends   — keep separate, idea_edges row of kind='extends'
//   · replace_essence — incoming claim becomes the new essence; old essence
//                      moves to body as the previous formulation

import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  ideas,
  extractedIdeas,
  ideaEdges,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  gmailMessages,
} from '@/db';

export type MergeMode = 'merge_body' | 'link_extends' | 'replace_essence';

// ── findMergeTarget — returns the highest-cosine ideas row above 0.85 ──
//
// Used when:
//   1. A new extracted_idea is inserted (sync time)
//   2. The user clicks "Claim it" on an unclaimed idea
//
// Returns null when no candidate above the threshold.

const MERGE_THRESHOLD = 0.85;

export async function findMergeTarget(
  userId: string,
  embedding: number[]
): Promise<{ ideaId: string; cosine: number } | null> {
  if (!embedding || embedding.length === 0) return null;
  const vecLiteral = `[${embedding.join(',')}]`;

  const rows = await db.execute<{ id: string; cos: number }>(sql`
    SELECT id, 1 - (embedding <=> ${vecLiteral}::vector) as cos
      FROM ideas
     WHERE user_id = ${userId}
       AND embedding IS NOT NULL
     ORDER BY embedding <=> ${vecLiteral}::vector
     LIMIT 1
  `);

  const row = (rows as unknown as { id: string; cos: number }[])[0];
  if (!row || Number(row.cos) < MERGE_THRESHOLD) return null;
  return { ideaId: row.id, cosine: Number(row.cos) };
}

// ── source-name helper for attribution ─────────────────────────────────

async function sourceLabel(extractedId: string): Promise<string> {
  const [row] = await db
    .select({
      sourceKind: extractedIdeas.sourceKind,
      newsletterIssueId: extractedIdeas.newsletterIssueId,
      obsidianNoteId: extractedIdeas.obsidianNoteId,
      linkedinPostId: extractedIdeas.linkedinPostId,
      gmailMessageId: extractedIdeas.gmailMessageId,
    })
    .from(extractedIdeas)
    .where(eq(extractedIdeas.id, extractedId))
    .limit(1);
  if (!row) return 'a source';

  if (row.sourceKind === 'newsletter_issue' && row.newsletterIssueId) {
    const [n] = await db
      .select({ title: newsletterIssues.title })
      .from(newsletterIssues)
      .where(eq(newsletterIssues.id, row.newsletterIssueId))
      .limit(1);
    return n ? `your newsletter — ${n.title}` : 'your newsletter';
  }
  if (row.sourceKind === 'obsidian_note' && row.obsidianNoteId) {
    const [n] = await db
      .select({ title: obsidianNotes.title })
      .from(obsidianNotes)
      .where(eq(obsidianNotes.id, row.obsidianNoteId))
      .limit(1);
    return n ? `vault — ${n.title}` : 'vault';
  }
  if (row.sourceKind === 'linkedin_post' && row.linkedinPostId) {
    return 'LinkedIn';
  }
  if (row.sourceKind === 'gmail_message' && row.gmailMessageId) {
    const [n] = await db
      .select({ subject: gmailMessages.subject })
      .from(gmailMessages)
      .where(eq(gmailMessages.id, row.gmailMessageId))
      .limit(1);
    return n ? `Gmail — ${n.subject ?? 'newsletter'}` : 'Gmail newsletter';
  }
  return 'a source';
}

// ── Main entry: mergeExtractedIntoIdea ─────────────────────────────────

export async function mergeExtractedIntoIdea(opts: {
  userId: string;
  extractedId: string;
  targetIdeaId: string;
  mode: MergeMode;
  claimText?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [ext] = await db
    .select({
      id: extractedIdeas.id,
      title: extractedIdeas.title,
      claim: extractedIdeas.claim,
      embedding: extractedIdeas.embedding,
      userId: extractedIdeas.userId,
    })
    .from(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.id, opts.extractedId),
        eq(extractedIdeas.userId, opts.userId)
      )
    )
    .limit(1);
  if (!ext) return { ok: false, reason: 'extracted idea not found' };

  const [target] = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      essence: ideas.essence,
      body: ideas.body,
    })
    .from(ideas)
    .where(and(eq(ideas.id, opts.targetIdeaId), eq(ideas.userId, opts.userId)))
    .limit(1);
  if (!target) return { ok: false, reason: 'target idea not found' };

  if (opts.mode === 'merge_body') {
    // v1 ships literal-append with divider; v2 will rewrite in voice (Voice ID).
    const label = await sourceLabel(ext.id);
    const newPara = `\n\n— from ${label}:\n\n${ext.claim}`;
    const newBody = (target.body ?? target.essence ?? '') + newPara;

    await db
      .update(ideas)
      .set({
        body: newBody,
        updatedAt: new Date(),
        // Bump temperature on merge — this is engagement.
        temperature: sql`CASE WHEN ${ideas.temperature} = 'cold' THEN 'cool'
                              WHEN ${ideas.temperature} = 'cool' THEN 'warm'
                              WHEN ${ideas.temperature} = 'warm' THEN 'hot'
                              ELSE ${ideas.temperature} END`,
        temperatureUpdatedAt: new Date(),
      })
      .where(eq(ideas.id, target.id));

    await db
      .update(extractedIdeas)
      .set({
        triageStatus: 'promoted',
        triagedAt: new Date(),
        claimText: opts.claimText ?? null,
      })
      .where(eq(extractedIdeas.id, ext.id));

    return { ok: true };
  }

  if (opts.mode === 'link_extends') {
    // Need a partner ideas row for the incoming claim. Reuse claim flow.
    if (!opts.claimText || opts.claimText.trim().length === 0) {
      return {
        ok: false,
        reason: 'link_extends requires a claim_text to seed the new idea body',
      };
    }
    const [newIdea] = await db
      .insert(ideas)
      .values({
        userId: opts.userId,
        title: ext.title,
        essence: ext.claim,
        body: opts.claimText,
        maturity: 'shaping',
        temperature: 'warm',
        claimKind: 'claimed',
        sourceExtractedIdeaId: ext.id,
      })
      .returning({ id: ideas.id });

    await db.insert(ideaEdges).values({
      fromIdea: target.id,
      toIdea: newIdea.id,
      kind: 'extends',
      strength: 0.9,
      userConfirmed: 1,
    });

    await db
      .update(extractedIdeas)
      .set({
        triageStatus: 'promoted',
        triagedAt: new Date(),
        claimText: opts.claimText,
      })
      .where(eq(extractedIdeas.id, ext.id));

    return { ok: true };
  }

  if (opts.mode === 'replace_essence') {
    const previousEssence = target.essence ?? '';
    const newBody = previousEssence
      ? `Previously framed as: ${previousEssence}\n\n${target.body ?? ''}`
      : target.body ?? '';

    await db
      .update(ideas)
      .set({
        essence: ext.claim,
        body: newBody,
        updatedAt: new Date(),
      })
      .where(eq(ideas.id, target.id));

    await db
      .update(extractedIdeas)
      .set({
        triageStatus: 'promoted',
        triagedAt: new Date(),
        claimText: opts.claimText ?? null,
      })
      .where(eq(extractedIdeas.id, ext.id));

    return { ok: true };
  }

  return { ok: false, reason: 'unknown merge mode' };
}
