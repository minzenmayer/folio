// Phase 14b — expand surface for a CLAIMED idea.

import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db, ideas, ideaEdges, drafts, extractedIdeas, newsletterIssues, obsidianNotes, linkedinPosts, gmailMessages } from '@/db';
import { requireUser } from '@/lib/auth';
import { markVisited } from '../actions';
import { ExpandSurfaceClaimed } from './ExpandSurfaceClaimed';

export const dynamic = 'force-dynamic';

export default async function IdeaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [row] = await db
    .select()
    .from(ideas)
    .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)))
    .limit(1);
  if (!row) notFound();

  // Mark visited (fire-and-forget; don't block render).
  markVisited(id).catch(() => {});

  // Load linked ideas via idea_edges (out-edges from this idea).
  const edges = await db
    .select({
      kind: ideaEdges.kind,
      strength: ideaEdges.strength,
      userConfirmed: ideaEdges.userConfirmed,
      otherId: ideaEdges.toIdea,
    })
    .from(ideaEdges)
    .where(eq(ideaEdges.fromIdea, id));

  const otherIds = edges.map((e) => e.otherId);
  const linkedTitles = otherIds.length > 0
    ? await db
        .select({ id: ideas.id, title: ideas.title })
        .from(ideas)
        .where(eq(ideas.userId, user.id))
    : [];
  const titleMap = new Map(linkedTitles.map((r) => [r.id, r.title]));
  const links = edges
    .map((e) => ({
      kind: e.kind,
      strength: e.strength ?? 1,
      manual: (e.userConfirmed ?? 0) === 1,
      otherId: e.otherId,
      otherTitle: titleMap.get(e.otherId) ?? '(unknown)',
    }))
    .filter((l) => l.otherId !== id);

  // Provenance — lookup extracted_ideas + source title.
  let provenance: { kind: string; title: string } | null = null;
  if (row.sourceExtractedIdeaId) {
    const [ext] = await db
      .select({
        sourceKind: extractedIdeas.sourceKind,
        newsletterIssueId: extractedIdeas.newsletterIssueId,
        obsidianNoteId: extractedIdeas.obsidianNoteId,
        linkedinPostId: extractedIdeas.linkedinPostId,
        gmailMessageId: extractedIdeas.gmailMessageId,
      })
      .from(extractedIdeas)
      .where(eq(extractedIdeas.id, row.sourceExtractedIdeaId))
      .limit(1);
    if (ext) {
      let sourceTitle: string | null = null;
      if (ext.sourceKind === 'newsletter_issue' && ext.newsletterIssueId) {
        const [n] = await db.select({ title: newsletterIssues.title }).from(newsletterIssues).where(eq(newsletterIssues.id, ext.newsletterIssueId)).limit(1);
        sourceTitle = n?.title ?? null;
      } else if (ext.sourceKind === 'obsidian_note' && ext.obsidianNoteId) {
        const [n] = await db.select({ title: obsidianNotes.title }).from(obsidianNotes).where(eq(obsidianNotes.id, ext.obsidianNoteId)).limit(1);
        sourceTitle = n?.title ?? null;
      } else if (ext.sourceKind === 'linkedin_post' && ext.linkedinPostId) {
        sourceTitle = 'LinkedIn post';
      } else if (ext.sourceKind === 'gmail_message' && ext.gmailMessageId) {
        const [n] = await db.select({ subject: gmailMessages.subject }).from(gmailMessages).where(eq(gmailMessages.id, ext.gmailMessageId)).limit(1);
        sourceTitle = n?.subject ?? null;
      }
      provenance = {
        kind: ext.sourceKind,
        title: sourceTitle ?? 'a source',
      };
    }
  }

  return (
    <ExpandSurfaceClaimed
      idea={{
        id: row.id,
        title: row.title,
        essence: row.essence,
        body: row.body,
        themes: row.themes ?? [],
        maturity: row.maturity,
        temperature: row.temperature as any,
        lastVisitedAt: row.lastVisitedAt ? new Date(row.lastVisitedAt).toISOString() : null,
        claimKind: row.claimKind,
      }}
      links={links}
      provenance={provenance}
    />
  );
}
