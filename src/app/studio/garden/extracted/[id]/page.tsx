// Phase 14b — expand surface for an UNCLAIMED extracted_idea.
// Has the "Make it mine" textarea on top.

import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import {
  db,
  extractedIdeas,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  gmailMessages,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { ExpandSurfaceUnclaimed } from './ExpandSurfaceUnclaimed';

export const dynamic = 'force-dynamic';

export default async function ExtractedIdeaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [row] = await db
    .select()
    .from(extractedIdeas)
    .where(
      and(eq(extractedIdeas.id, id), eq(extractedIdeas.userId, user.id))
    )
    .limit(1);
  if (!row) notFound();

  // Resolve source title for provenance line.
  let sourceTitle = 'a source';
  if (row.sourceKind === 'newsletter_issue' && row.newsletterIssueId) {
    const [n] = await db.select({ title: newsletterIssues.title }).from(newsletterIssues).where(eq(newsletterIssues.id, row.newsletterIssueId)).limit(1);
    if (n) sourceTitle = `your newsletter — ${n.title}`;
  } else if (row.sourceKind === 'obsidian_note' && row.obsidianNoteId) {
    const [n] = await db.select({ title: obsidianNotes.title }).from(obsidianNotes).where(eq(obsidianNotes.id, row.obsidianNoteId)).limit(1);
    if (n) sourceTitle = `vault — ${n.title}`;
  } else if (row.sourceKind === 'linkedin_post' && row.linkedinPostId) {
    sourceTitle = 'LinkedIn';
  } else if (row.sourceKind === 'gmail_message' && row.gmailMessageId) {
    const [n] = await db.select({ subject: gmailMessages.subject }).from(gmailMessages).where(eq(gmailMessages.id, row.gmailMessageId)).limit(1);
    if (n) sourceTitle = `Gmail — ${n.subject ?? 'newsletter'}`;
  }

  return (
    <ExpandSurfaceUnclaimed
      ext={{
        id: row.id,
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        sourceKind: row.sourceKind,
        sourceTitle,
        temperature: row.temperature as any,
      }}
    />
  );
}
