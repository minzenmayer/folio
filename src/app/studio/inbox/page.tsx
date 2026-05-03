// Thoughtbed · Inbox
// Sprint 14 brand pivot: monochrome restyle, drop garden vocabulary.

import { eq, and, desc } from 'drizzle-orm';
import { db, captures, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { CaptureForm } from './CaptureForm';
import { InboxRow } from './InboxRow';

export default async function InboxPage() {
  const user = await requireUser();

  const inboxCaptures = await db
    .select()
    .from(captures)
    .where(and(eq(captures.userId, user.id), eq(captures.status, 'inbox')))
    .orderBy(desc(captures.capturedAt))
    .limit(50);

  const userIdeas = await db
    .select({ id: ideas.id, title: ideas.title })
    .from(ideas)
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt));

  return (
    <section>
      <div className="max-w-[900px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Inbox
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[58ch]">
            {inboxCaptures.length === 0
              ? "Nothing yet. Capture something below — anything you don't want to lose."
              : `${inboxCaptures.length} unfiled ${inboxCaptures.length === 1 ? 'item' : 'items'}. File when you're ready, or leave them — Thoughtbed connects them on its own either way.`}
          </p>
        </div>

        <CaptureForm />

        <div className="mt-10">
          {inboxCaptures.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
                Empty
              </div>
              <p className="font-sans text-[14px] text-tag">
                The Inbox fills as you capture.
              </p>
            </div>
          ) : (
            <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
              {inboxCaptures.map((capture) => (
                <InboxRow
                  key={capture.id}
                  capture={capture}
                  ideas={userIdeas}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
