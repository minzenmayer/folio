// Folio · Studio home
// Sprint 3 v0: smart entry that adapts to bank state.
// Empty bank? Onboard with capture. Got captures? Surface them. Got ideas?
// Show what's pulling.

import Link from 'next/link';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, captures, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function StudioHome() {
  // Auth check at top so redirect() fires before any RSC streaming begins.
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    redirect('/sign-in');
  }

  const user = await requireUser();
  const clerk = await currentUser();
  const firstName = clerk?.firstName || user.name?.split(' ')[0] || 'friend';

  // Fast counts + freshest items.
  const [counts] = await db
    .select({
      inbox: sql<number>`(
        SELECT COUNT(*) FROM ${captures}
        WHERE ${captures.userId} = ${user.id}
        AND ${captures.status} = 'inbox'
      )`,
      ideaCount: sql<number>`(
        SELECT COUNT(*) FROM ${ideas}
        WHERE ${ideas.userId} = ${user.id}
      )`,
    })
    .from(captures)
    .limit(1);

  const recentIdeas = await db
    .select({ id: ideas.id, title: ideas.title, maturity: ideas.maturity })
    .from(ideas)
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt))
    .limit(5);

  const inboxCount = Number(counts?.inbox ?? 0);
  const ideaCount = Number(counts?.ideaCount ?? 0);
  const isEmpty = inboxCount === 0 && ideaCount === 0;

  return (
    <section>
      <div className="max-w-[900px] mx-auto px-[7%] py-16 md:py-24">
        {/* Greeting */}
        <div className="mb-10">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-5">
            ▸ {isEmpty ? 'A new studio' : 'Welcome back'}
          </div>
          <h1 className="font-serif font-normal text-[clamp(40px,6vw,80px)] leading-[1.0] tracking-tightest text-ink mb-6">
            Hello,{' '}
            <em className="italic font-light text-accent">{firstName}.</em>
          </h1>

          {isEmpty ? (
            <p className="font-serif font-light text-[clamp(19px,2vw,24px)] leading-[1.5] text-ink-soft max-w-[56ch]">
              The studio is empty. The first move is{' '}
              <em className="italic">capture</em> — paste a thought, anything
              you don't want to lose. Then it accretes.
            </p>
          ) : (
            <p className="font-serif font-light text-[clamp(19px,2vw,24px)] leading-[1.5] text-ink-soft max-w-[56ch]">
              {ideaCount} {ideaCount === 1 ? 'idea' : 'ideas'} in your library.{' '}
              {inboxCount > 0 && (
                <>
                  {inboxCount} unfiled in the{' '}
                  <Link
                    href="/studio/inbox"
                    className="text-accent hover:underline underline-offset-4"
                  >
                    Inbox
                  </Link>
                  .{' '}
                </>
              )}
              <em className="italic">
                <Link
                  href="/studio/page"
                  className="text-accent hover:underline underline-offset-4 not-italic"
                >
                  The Page
                </Link>{' '}
                is open for writing now. The Assistant comes online in Sprint 8.
              </em>
            </p>
          )}
        </div>

        {/* Primary CTAs */}
        <div className="grid sm:grid-cols-2 gap-3 mb-12">
          <Link
            href="/studio/inbox"
            className="block bg-paper border-2 border-accent rounded-[3px] px-7 py-6 hover:bg-paper-2 transition-colors group"
          >
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-2">
              ▸ Capture
            </div>
            <h3 className="font-serif font-normal text-[26px] text-ink mb-1 group-hover:text-accent transition-colors">
              Open Inbox
            </h3>
            <p className="font-serif italic text-[14px] text-ink-soft">
              {inboxCount > 0
                ? `${inboxCount} unfiled · paste more`
                : 'Paste a thought, a quote, an excerpt'}
            </p>
          </Link>

          <Link
            href="/studio/ideas"
            className="block bg-paper border border-rule rounded-[3px] px-7 py-6 hover:bg-paper-2 hover:border-accent transition-colors group"
          >
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-2">
              ▸ Wander
            </div>
            <h3 className="font-serif font-normal text-[26px] text-ink mb-1 group-hover:text-accent transition-colors">
              The Library
            </h3>
            <p className="font-serif italic text-[14px] text-ink-soft">
              {ideaCount > 0
                ? `${ideaCount} ${ideaCount === 1 ? 'idea' : 'ideas'} · browse what's gathering`
                : 'Where your ideas will live'}
            </p>
          </Link>
        </div>

        {/* Recent ideas */}
        {recentIdeas.length > 0 && (
          <div className="mb-12">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-4">
              ▸ Recent ideas
            </div>
            <div className="border-t border-rule">
              {recentIdeas.map((idea) => (
                <Link
                  key={idea.id}
                  href={`/studio/ideas/${idea.id}`}
                  className="flex items-baseline gap-4 py-3 px-2 border-b border-rule hover:bg-paper/50 transition-colors group"
                >
                  <h3 className="font-serif font-normal text-[18px] text-ink group-hover:text-accent transition-colors flex-1">
                    {idea.title}
                  </h3>
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-tag">
                    {idea.maturity}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Roadmap (only shown when bank is empty) */}
        {isEmpty && (
          <div className="border-t border-rule pt-10">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-6">
              ▸ What's coming, in order
            </div>
            <ul className="space-y-4">
              <li className="grid grid-cols-[60px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] text-accent font-bold">
                  S 3
                </span>
                <p className="font-serif text-[16px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">Capture & Inbox</span>
                  {' — '}live now. Paste a thought, attach to an idea.
                </p>
              </li>
              <li className="grid grid-cols-[60px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] text-accent font-bold">
                  S 5
                </span>
                <p className="font-serif text-[16px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">The Page</span>
                  {' — '}live now. Three-pane writing surface, Tiptap editor.
                </p>
              </li>
              <li className="grid grid-cols-[60px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] text-tag">S 8–10</span>
                <p className="font-serif text-[16px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">The Assistant</span>
                  {' — '}vector retrieval, pulls your own thinking into your draft.
                </p>
              </li>
              <li className="grid grid-cols-[60px_1fr] gap-6 items-baseline">
                <span className="font-mono text-[11px] text-tag">S 11–12</span>
                <p className="font-serif text-[16px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">
                    Polish & beta launch
                  </span>
                  {' — '}invite-only beta to the first 5–10.
                </p>
              </li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
