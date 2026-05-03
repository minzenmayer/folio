// Thoughtbed · Studio home — writing-first
// Sprint 10: the authed homepage IS the writing surface. Greeting + a
// composer that branches into Draft / Idea / Plant by mode, and below
// it your recent ideas + drafts as a dense list — your bank of past
// issues, kept one click away.
//
// The legacy "dashboard with two CTAs" is gone. Most days the user
// has something to say; we honour that as the default.

import Link from 'next/link';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, captures, ideas, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Composer } from './Composer';
import { BackfillButton } from './BackfillButton';

function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export default async function StudioHome() {
  // Auth check at top so redirect() fires before any RSC streaming begins.
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    redirect('/sign-in');
  }

  const user = await requireUser();
  const clerk = await currentUser();
  const firstName = clerk?.firstName || user.name?.split(' ')[0] || 'friend';

  // Counts + freshest items so the page can adapt empty vs. populated
  // states without an extra round-trip.
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
      draftCount: sql<number>`(
        SELECT COUNT(*) FROM ${drafts}
        WHERE ${drafts.userId} = ${user.id}
      )`,
    })
    .from(captures)
    .limit(1);

  const recentDrafts = await db
    .select({
      id: drafts.id,
      title: drafts.title,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.userId, user.id))
    .orderBy(desc(drafts.updatedAt))
    .limit(5);

  const recentIdeas = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      maturity: ideas.maturity,
      lastVisitedAt: ideas.lastVisitedAt,
    })
    .from(ideas)
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt))
    .limit(5);

  const inboxCount = Number(counts?.inbox ?? 0);
  const ideaCount = Number(counts?.ideaCount ?? 0);
  const draftCount = Number(counts?.draftCount ?? 0);
  const isEmpty = inboxCount === 0 && ideaCount === 0 && draftCount === 0;

  return (
    <section>
      <div className="max-w-[800px] mx-auto px-[7%] py-12 md:py-16">
        {/* Greeting */}
        <div className="mb-8">
          <div className="font-mono text-[11px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
            ☘ {isEmpty ? 'Your bed is freshly turned' : 'Welcome back'}
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.0] tracking-tightest text-ink mb-3">
            Hello,{' '}
            <em className="italic font-light text-accent">{firstName}.</em>
          </h1>
          <p className="font-serif font-light text-[clamp(17px,1.8vw,21px)] leading-[1.5] text-ink-soft max-w-[56ch]">
            {isEmpty
              ? 'Drop in a thought to get started — anything you don\'t want to lose. The bed accepts seeds, drafts, and full ideas.'
              : 'What are you working on? Type below to start a new draft, idea, or plant a seed.'}
          </p>
        </div>

        {/* The composer — Sprint 10's writing-first heart */}
        <Composer initialMode="draft" />

        {/* Recent ideas + drafts — the bank of past issues */}
        {(recentDrafts.length > 0 || recentIdeas.length > 0) && (
          <div className="mt-12 grid sm:grid-cols-2 gap-8">
            {recentDrafts.length > 0 && (
              <div>
                <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-4 flex items-baseline gap-3">
                  <span>▸ Recent drafts</span>
                  <Link
                    href="/studio/page"
                    className="ml-auto text-tag/70 normal-case tracking-[0.04em] font-sans italic font-normal hover:text-accent transition-colors"
                  >
                    all →
                  </Link>
                </div>
                <ul className="border-t border-rule">
                  {recentDrafts.map((d) => (
                    <li key={d.id} className="border-b border-rule">
                      <Link
                        href={`/studio/page/${d.id}`}
                        className="flex items-baseline gap-3 py-3 px-1 hover:bg-paper/50 transition-colors group"
                      >
                        <span className="font-mono text-accent" aria-hidden>
                          ✎
                        </span>
                        <span className="font-serif text-[15px] text-ink leading-[1.4] flex-1 truncate group-hover:text-accent transition-colors">
                          {d.title || (
                            <em className="italic text-tag">Untitled</em>
                          )}
                        </span>
                        <span className="font-mono text-[10px] text-tag tracking-[0.04em]">
                          {timeAgo(d.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {recentIdeas.length > 0 && (
              <div>
                <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-4 flex items-baseline gap-3">
                  <span>▸ Recent ideas</span>
                  <Link
                    href="/studio/ideas"
                    className="ml-auto text-tag/70 normal-case tracking-[0.04em] font-sans italic font-normal hover:text-accent transition-colors"
                  >
                    garden →
                  </Link>
                </div>
                <ul className="border-t border-rule">
                  {recentIdeas.map((i) => (
                    <li key={i.id} className="border-b border-rule">
                      <Link
                        href={`/studio/ideas/${i.id}`}
                        className="flex items-baseline gap-3 py-3 px-1 hover:bg-paper/50 transition-colors group"
                      >
                        <span className="font-mono text-accent" aria-hidden>
                          ▸
                        </span>
                        <span className="font-serif text-[15px] text-ink leading-[1.4] flex-1 truncate group-hover:text-accent transition-colors">
                          {i.title}
                        </span>
                        <span className="font-mono text-[9px] text-tag uppercase tracking-[0.16em]">
                          {i.maturity}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Inbox callout — keep it discoverable when something's pending */}
        {inboxCount > 0 && (
          <div className="mt-10 border border-rule rounded-[3px] bg-paper px-5 py-4 flex items-center gap-3">
            <span className="font-mono text-accent" aria-hidden>
              "
            </span>
            <p className="font-serif text-[14px] text-ink-soft flex-1">
              <span className="font-mono text-[12px] text-accent font-bold">
                {inboxCount}
              </span>{' '}
              {inboxCount === 1 ? 'seed waiting' : 'seeds waiting'} in the
              Inbox.
            </p>
            <Link
              href="/studio/inbox"
              className="font-mono text-[11px] tracking-[0.22em] uppercase text-accent hover:text-ink transition-colors"
            >
              File →
            </Link>
          </div>
        )}

        {/* Maintenance — backfill embeddings (admin-style, kept here from Sprint 7) */}
        <BackfillButton />

        {/* Roadmap — only shown when bed is empty so newcomers see direction */}
        {isEmpty && (
          <div className="border-t border-rule pt-10 mt-12">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-6">
              ▸ How it works
            </div>
            <ul className="space-y-4">
              <li className="grid grid-cols-[80px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] text-accent font-bold">
                  Plant
                </span>
                <p className="font-serif text-[15px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">Inbox</span>
                  {' — '}paste a thought, a quote, anything you don't want to
                  lose.
                </p>
              </li>
              <li className="grid grid-cols-[80px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] text-accent font-bold">
                  Grow
                </span>
                <p className="font-serif text-[15px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">Garden</span>
                  {' — '}seeds connect to ideas, drafts, and each other while
                  you sleep.
                </p>
              </li>
              <li className="grid grid-cols-[80px_1fr] gap-6 items-baseline">
                <span className="font-mono text-[11px] text-accent font-bold">
                  Harvest
                </span>
                <p className="font-serif text-[15px] text-ink-soft leading-[1.5]">
                  <span className="text-ink font-medium">The Page</span>
                  {' — '}sit down to write, and ripe ideas surface as you
                  type.
                </p>
              </li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
