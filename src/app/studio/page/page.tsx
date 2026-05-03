// Folio · /studio/page — index
// Three-pane writing surface (drafts · editor · assistant) when no draft is
// selected. The editor pane shows an inviting empty state that points the
// user toward "+ New draft" in the rail.

import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { DraftsRail } from './DraftsRail';
import { AssistantRail } from './AssistantRail';
import { createDraft } from './actions';

export const metadata: Metadata = {
  title: 'The Page · Folio',
};

export default async function PageIndex() {
  // Auth check at the top so any redirect happens before RSC streaming —
  // matches the pattern used in /studio/page.tsx and avoids the 500-mid-stream
  // class of bug called out in the gotchas.
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const user = await requireUser();

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)_300px] min-h-[calc(100vh-100px)]">
      <DraftsRail user={user} />

      <section className="flex items-center justify-center px-[7%] py-16">
        <div className="max-w-[48ch] text-center">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-5">
            ▸ The Page
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.05] tracking-tightest text-ink mb-5">
            A surface for{' '}
            <em className="italic font-light text-accent">thinking out loud.</em>
          </h1>
          <p className="font-serif font-light text-[18px] leading-[1.55] text-ink-soft mb-8">
            Drafts here are private and live — they auto-save as you type. The
            first H1 becomes the title. Markdown shortcuts work
            (<code className="font-mono text-[14px] text-tag">#&nbsp;</code>,
            {' '}<code className="font-mono text-[14px] text-tag">**bold**</code>,
            {' '}<code className="font-mono text-[14px] text-tag">*italic*</code>).
          </p>
          <form action={createDraft}>
            <button
              type="submit"
              className="inline-block px-5 py-3 bg-ink text-bg font-sans text-[11px] tracking-[0.22em] uppercase font-bold rounded-[3px] hover:bg-accent transition-colors"
            >
              ⏎ Start a new draft
            </button>
          </form>
        </div>
      </section>

      <AssistantRail />
    </div>
  );
}
