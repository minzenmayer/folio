// Folio · Inbox
// Where unfiled captures land. The room you visit when you want to file —
// or, deliberately, never visit at all.

import { eq, and, desc } from 'drizzle-orm';
import { db, captures, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { CaptureForm } from './CaptureForm';
import { InboxRow } from './InboxRow';

export default async function InboxPage() {
  const user = await requireUser();

  // All inbox captures (unfiled), recent first.
  const inboxCaptures = await db
    .select()
    .from(captures)
    .where(and(eq(captures.userId, user.id), eq(captures.status, 'inbox')))
    .orderBy(desc(captures.capturedAt))
    .limit(50);

  // All ideas, for the attach-to-idea picker.
  const userIdeas = await db
    .select({ id: ideas.id, title: ideas.title })
    .from(ideas)
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt));

  return (
    <section>
      <div className="max-w-[900px] mx-auto px-[7%] py-12 md:py-16">
        {/* Header */}
        <div className="mb-10">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
            ▸ Inbox
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.05] tracking-tightest text-ink mb-3">
            What's <em className="italic font-light text-accent">come in</em>.
          </h1>
          <p className="font-serif font-light text-[18px] leading-[1.5] text-ink-soft max-w-[56ch]">
            {inboxCaptures.length === 0
              ? 'Nothing yet. Paste a thought below — anything you don\'t want to lose.'
              : `${inboxCaptures.length} unfiled ${inboxCaptures.length === 1 ? 'thing' : 'things'}. File when you're ready, or leave them — the assistant connects on the backend either way.`}
          </p>
        </div>

        {/* Capture form */}
        <CaptureForm />

        {/* Inbox list */}
        <div className="mt-12">
          {inboxCaptures.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-rule rounded-[3px] bg-paper/50">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-3">
                ▸ Empty
              </div>
              <p className="font-serif italic text-[16px] text-tag">
                No captures yet. The Inbox fills as you do.
              </p>
            </div>
          ) : (
            <div className="border-t border-rule">
              {inboxCaptures.map((capture) => (
                <InboxRow
                  key={capture.id}
                  capture={capture}
                  ideas={userIdeas}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
