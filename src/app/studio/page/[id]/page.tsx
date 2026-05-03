// Folio · /studio/page/[id] — editor for a single draft
// Three-pane layout. Loads the draft server-side, hydrates the Tiptap
// component on the client.

import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { db, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { DraftsRail } from '../DraftsRail';
import { AssistantRail } from '../AssistantRail';
import { DraftEditor } from '../DraftEditor';
import { DraftMeta } from './DraftMeta';

type Params = Promise<{ id: string }>;

// Static metadata. Per-draft titles surfaced via the in-page <DraftMeta>
// header; we deliberately skip auth-in-metadata to avoid the Clerk 6 + Next
// 15.5 edge case where `auth()` outside the page render path can throw.
export const metadata: Metadata = {
  title: 'The Page · Folio',
};

export default async function DraftEditorPage({ params }: { params: Params }) {
  // Auth check first — synchronous redirect before any heavy await, per the
  // gotchas doc.
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const { id } = await params;
  const user = await requireUser();

  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
    .limit(1);

  if (!draft) notFound();

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)_300px] min-h-[calc(100vh-100px)]">
      <DraftsRail user={user} activeId={draft.id} />

      <section className="px-[7%] py-12 md:py-14 overflow-y-auto">
        <div className="max-w-[68ch] mx-auto">
          <DraftMeta
            title={draft.title}
            updatedAt={draft.updatedAt}
            draftId={draft.id}
          />

          <div className="mt-10">
            <DraftEditor
              draftId={draft.id}
              initialContent={draft.contentJson}
              initialVersion={draft.version}
              initialUpdatedAt={draft.updatedAt.toISOString()}
            />
          </div>
        </div>
      </section>

      <AssistantRail />
    </div>
  );
}
