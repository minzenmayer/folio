// Thoughtbed · Studio home — writing-first
//
// Sprint 14 brand pivot: Ghostbase shape — system sans, monochrome
// palette, no decorative glyphs, no italic accents. The composer + recent
// items pattern stays; only the visual language changes.

import Link from 'next/link';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, captures, ideas, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Spar } from './Spar';
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
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const user = await requireUser();
  const clerk = await currentUser();
  const firstName = clerk?.firstName || user.name?.split(' ')[0] || 'there';

  // Each query in its own try/catch with a safe fallback. If any
  // single load fails (transient DB hiccup, schema drift, anything),
  // the page still renders with that section degraded instead of
  // taking down the whole composer.
  let counts:
    | { inbox: number; ideaCount: number; draftCount: number }
    | undefined;
  try {
    const rows = await db
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
    counts = rows[0];
  } catch (err) {
    console.warn('[studio/page] counts query failed', err);
  }

  let recentDrafts: Array<{
    id: string;
    title: string | null;
    updatedAt: Date | null;
  }> = [];
  try {
    recentDrafts = await db
      .select({
        id: drafts.id,
        title: drafts.title,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(eq(drafts.userId, user.id))
      .orderBy(desc(drafts.updatedAt))
      .limit(5);
  } catch (err) {
    console.warn('[studio/page] recentDrafts query failed', err);
  }

  let recentIdeas: Array<{
    id: string;
    title: string;
    maturity: string;
    lastVisitedAt: Date | null;
  }> = [];
  try {
    recentIdeas = await db
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
  } catch (err) {
    console.warn('[studio/page] recentIdeas query failed', err);
  }

  const inboxCount = Number(counts?.inbox ?? 0);
  const ideaCount = Number(counts?.ideaCount ?? 0);
  const draftCount = Number(counts?.draftCount ?? 0);
  const isEmpty = inboxCount === 0 && ideaCount === 0 && draftCount === 0;

  return (
    <section>
      <div className="max-w-[800px] mx-auto px-6 md:px-8 py-12 md:py-16">
        {/* Greeting */}
        <div className="mb-8">
          <p className="font-sans text-[16px] text-ink-soft mb-1">
            Hello, {firstName}
          </p>
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink">
            What can I help you with?
          </h1>
        </div>

        {/* Composer (Phase 15b — sparring partner) */}
        <Spar />

        {/* Recent drafts + recent ideas */}
        {(recentDrafts.length > 0 || recentIdeas.length > 0) && (
          <div className="mt-10 grid sm:grid-cols-2 gap-6">
            {recentDrafts.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
                    Recent drafts
                  </h2>
                  <Link
                    href="/studio/page"
                    className="font-sans text-[12px] text-tag hover:text-ink transition-colors"
                  >
                    All →
                  </Link>
                </div>
                <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
                  {recentDrafts.map((d) => (
                    <li key={d.id}>
                      <Link
                        href={`/studio/page/${d.id}`}
                        className="flex items-baseline gap-3 py-2.5 px-4 hover:bg-paper-2 transition-colors"
                      >
                        <span className="font-sans text-[14px] text-ink leading-[1.4] flex-1 truncate">
                          {d.title || (
                            <span className="text-tag">Untitled</span>
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
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
                    Recent ideas
                  </h2>
                  <Link
                    href="/studio/ideas"
                    className="font-sans text-[12px] text-tag hover:text-ink transition-colors"
                  >
                    Library →
                  </Link>
                </div>
                <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
                  {recentIdeas.map((i) => (
                    <li key={i.id}>
                      <Link
                        href={`/studio/ideas/${i.id}`}
                        className="flex items-baseline gap-3 py-2.5 px-4 hover:bg-paper-2 transition-colors"
                      >
                        <span className="font-sans text-[14px] text-ink leading-[1.4] flex-1 truncate">
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

        {/* Inbox callout */}
        {inboxCount > 0 && (
          <div className="mt-8 rounded-card bg-paper border border-rule px-5 py-4 flex items-center gap-3">
            <p className="font-sans text-[13.5px] text-ink-soft flex-1">
              <span className="font-medium text-ink">
                {inboxCount}
              </span>{' '}
              {inboxCount === 1 ? 'item' : 'items'} waiting in the Inbox.
            </p>
            <Link
              href="/studio/inbox"
              className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink hover:text-tag transition-colors"
            >
              File →
            </Link>
          </div>
        )}

        {/* Maintenance — backfill embeddings (admin) */}
        <BackfillButton />

        {/* First-run guide */}
        {isEmpty && (
          <div className="border-t border-rule pt-8 mt-12">
            <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-5">
              How it works
            </h2>
            <ul className="space-y-4">
              <li className="grid grid-cols-[100px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink font-medium">
                  Capture
                </span>
                <p className="font-sans text-[14px] text-ink-soft leading-[1.55]">
                  <span className="text-ink font-medium">Inbox.</span> Paste
                  a thought, a quote, anything you don't want to lose.
                </p>
              </li>
              <li className="grid grid-cols-[100px_1fr] gap-6 items-baseline border-b border-rule pb-4">
                <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink font-medium">
                  Connect
                </span>
                <p className="font-sans text-[14px] text-ink-soft leading-[1.55]">
                  <span className="text-ink font-medium">Library.</span>{' '}
                  Captures connect to ideas, drafts, and each other while
                  you sleep.
                </p>
              </li>
              <li className="grid grid-cols-[100px_1fr] gap-6 items-baseline">
                <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink font-medium">
                  Write
                </span>
                <p className="font-sans text-[14px] text-ink-soft leading-[1.55]">
                  <span className="text-ink font-medium">The partner.</span>{' '}
                  Drop in a topic, spar through angles, then open a page
                  with the outline already in place.
                </p>
              </li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
