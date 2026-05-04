// Thoughtbed · Insights — triage queue (Direction B, 2026-05-04)
//
// Pre-Direction-B this was a read-only browse view sorted by depth +
// breadth. The change: Insights is now a queue. extractIdeas() drops
// rows in 'pending'; you triage with promote / dismiss / snooze;
// promoted rows leave the queue and show up in the Garden as
// maturity='seed' Ideas (with a back-link to the source). Dismissed
// rows never resurface. Snoozed rows resurface automatically once
// snooze_until <= now() (no cron — the default query handles it).
//
// View states are URL-driven via ?view=:
//   · pending (default) — pending + ripe-snoozed.
//   · promoted          — already promoted into Garden.
//   · dismissed         — explicitly hidden.
//   · all               — everything.
//
// Sort stays depth+breadth desc. Future: source-grouping toggle +
// keyword search. Out of scope for the v1 ship.

import Link from 'next/link';
import { eq, and, sql, desc, or, lte, isNull } from 'drizzle-orm';
import {
  db,
  extractedIdeas,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  gmailMessages,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { InsightRow } from './InsightRow';
import { GmailMessageRow } from './GmailMessageRow';

type Tab = 'ideas' | 'gmail';

function parseTab(raw: string | string[] | undefined): Tab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'gmail' ? 'gmail' : 'ideas';
}

function gmailHrefFor(view: View): string {
  return view === 'pending'
    ? '/studio/insights?tab=gmail'
    : `/studio/insights?tab=gmail&view=${view}`;
}

function ideasHrefFor(view: View): string {
  return view === 'pending'
    ? '/studio/insights'
    : `/studio/insights?view=${view}`;
}

type View = 'pending' | 'promoted' | 'dismissed' | 'all';

const VIEW_LABEL: Record<View, string> = {
  pending: 'Pending',
  promoted: 'Promoted',
  dismissed: 'Dismissed',
  all: 'All',
};

function parseView(raw: string | string[] | undefined): View {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'promoted' || v === 'dismissed' || v === 'all') return v;
  return 'pending';
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[]; tab?: string | string[] }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const tab = parseTab(params.tab);
  const view = parseView(params.view);

  // Cheap counts for the tab nav badges. The full per-status chip
  // counts for the active tab live inside the body components.
  const [{ ideasPending = 0 } = {}] = (await db
    .select({
      ideasPending: sql<number>`SUM(CASE WHEN ${extractedIdeas.triageStatus} = 'pending' THEN 1 ELSE 0 END)::int`,
    })
    .from(extractedIdeas)
    .where(eq(extractedIdeas.userId, user.id))) as Array<{ ideasPending: number | null }>;

  const [{ gmailPending = 0 } = {}] = (await db
    .select({
      gmailPending: sql<number>`SUM(CASE WHEN ${gmailMessages.status} = 'pending' THEN 1 ELSE 0 END)::int`,
    })
    .from(gmailMessages)
    .where(eq(gmailMessages.userId, user.id))) as Array<{ gmailPending: number | null }>;

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Insights
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[60ch]">
            Claims the system pulled out of your sources. Triage the
            queue: <strong className="text-ink">promote</strong> the ones that hit (they grow into Ideas
            in the Garden), <strong className="text-ink">dismiss</strong> the ones that don&rsquo;t, <strong className="text-ink">snooze</strong> the
            maybes for 30 days. The system learns your taste over time.
          </p>
        </div>

        {/* Phase 13: tab switcher between auto-extracted ideas (default)
            and Gmail-detected newsletter messages awaiting triage. */}
        <nav
          className="flex items-center gap-2 mb-6 border-b border-rule"
          aria-label="Insights tabs"
        >
          <Link
            href={ideasHrefFor(view)}
            className={`font-mono text-[11px] tracking-[0.18em] uppercase px-3 py-2 border-b-2 -mb-px transition-colors ${
              tab === 'ideas'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            Ideas
            <span className="ml-1.5 opacity-60 normal-case tracking-normal text-[10px]">
              {Number(ideasPending ?? 0)}
            </span>
          </Link>
          <Link
            href={gmailHrefFor(view)}
            className={`font-mono text-[11px] tracking-[0.18em] uppercase px-3 py-2 border-b-2 -mb-px transition-colors ${
              tab === 'gmail'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            Gmail
            <span className="ml-1.5 opacity-60 normal-case tracking-normal text-[10px]">
              {Number(gmailPending ?? 0)}
            </span>
          </Link>
        </nav>

        {tab === 'gmail' ? (
          <GmailTabBody userId={user.id} view={view} />
        ) : (
          <IdeasTabBody userId={user.id} view={view} />
        )}
      </div>
    </section>
  );
}

// ─── IdeasTabBody — original triage flow over extracted_ideas ───
async function IdeasTabBody({
  userId,
  view,
}: {
  userId: string;
  view: View;
}) {
  const userScope = eq(extractedIdeas.userId, userId);
  const whereByView =
    view === 'pending'
      ? and(
          userScope,
          or(
            eq(extractedIdeas.triageStatus, 'pending'),
            and(
              eq(extractedIdeas.triageStatus, 'snoozed'),
              or(
                isNull(extractedIdeas.snoozeUntil),
                lte(extractedIdeas.snoozeUntil, sql`now()`)
              )
            )
          )
        )
      : view === 'all'
        ? userScope
        : and(userScope, eq(extractedIdeas.triageStatus, view));

  const rows = await db
    .select({
      id: extractedIdeas.id,
      title: extractedIdeas.title,
      claim: extractedIdeas.claim,
      evidence: extractedIdeas.evidence,
      depthSignal: extractedIdeas.depthSignal,
      breadthSignal: extractedIdeas.breadthSignal,
      sourceKind: extractedIdeas.sourceKind,
      triageStatus: extractedIdeas.triageStatus,
      snoozeUntil: extractedIdeas.snoozeUntil,
      newsletterTitle: newsletterIssues.title,
      newsletterUrl: newsletterIssues.webUrl,
      obsidianTitle: obsidianNotes.title,
      obsidianPath: obsidianNotes.path,
      linkedinUrl: linkedinPosts.linkedinUrl,
      linkedinAuthor: linkedinPosts.authorName,
    })
    .from(extractedIdeas)
    .leftJoin(
      newsletterIssues,
      eq(extractedIdeas.newsletterIssueId, newsletterIssues.id)
    )
    .leftJoin(
      obsidianNotes,
      eq(extractedIdeas.obsidianNoteId, obsidianNotes.id)
    )
    .leftJoin(
      linkedinPosts,
      eq(extractedIdeas.linkedinPostId, linkedinPosts.id)
    )
    .where(whereByView)
    .orderBy(
      desc(sql`${extractedIdeas.depthSignal} + ${extractedIdeas.breadthSignal}`),
      desc(extractedIdeas.createdAt)
    )
    .limit(200);

  const counts = await db
    .select({
      status: extractedIdeas.triageStatus,
      n: sql<number>`count(*)::int`,
    })
    .from(extractedIdeas)
    .where(eq(extractedIdeas.userId, userId))
    .groupBy(extractedIdeas.triageStatus);
  const countMap: Record<string, number> = Object.fromEntries(
    counts.map((c) => [c.status, Number(c.n)])
  );
  const total = Object.values(countMap).reduce((a, b) => a + Number(b), 0);
  const chipCounts: Record<View, number> = {
    pending: countMap['pending'] ?? 0,
    promoted: countMap['promoted'] ?? 0,
    dismissed: countMap['dismissed'] ?? 0,
    all: total,
  };

  return (
    <>
      <nav
        className="flex items-center gap-2 mb-8 flex-wrap"
        aria-label="Filter insights by triage state"
      >
        {(['pending', 'promoted', 'dismissed', 'all'] as View[]).map((v) => {
          const active = view === v;
          const href = ideasHrefFor(v);
          return (
            <Link
              key={v}
              href={href}
              className={`font-mono text-[10px] tracking-[0.18em] uppercase rounded-full px-3 py-1.5 border transition-colors ${
                active
                  ? 'bg-ink text-bg border-ink'
                  : 'bg-paper text-ink-soft border-rule hover:text-ink hover:border-ink'
              }`}
            >
              {VIEW_LABEL[v]}
              <span className="ml-1.5 opacity-70">{chipCounts[v]}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
            {view === 'pending' ? 'Inbox zero' : 'Empty'}
          </div>
          <p className="font-sans text-[14px] text-tag">
            {view === 'pending'
              ? 'No insights waiting. New claims arrive as your sources sync.'
              : `Nothing in ${VIEW_LABEL[view].toLowerCase()}.`}
          </p>
        </div>
      ) : (
        <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
          {rows.map((row) => (
            <InsightRow key={row.id} row={row} view={view} />
          ))}
        </ul>
      )}
    </>
  );
}

// ─── GmailTabBody — Phase 13 triage queue for gmail_messages ───
async function GmailTabBody({
  userId,
  view,
}: {
  userId: string;
  view: View;
}) {
  // Per-status counts for the chips. Same shape as IdeasTabBody.
  const counts = await db
    .select({
      status: gmailMessages.status,
      n: sql<number>`count(*)::int`,
    })
    .from(gmailMessages)
    .where(eq(gmailMessages.userId, userId))
    .groupBy(gmailMessages.status);
  const countMap: Record<string, number> = Object.fromEntries(
    counts.map((c) => [c.status, Number(c.n)])
  );
  const total = Object.values(countMap).reduce((a, b) => a + Number(b), 0);
  const chipCounts: Record<View, number> = {
    pending: countMap['pending'] ?? 0,
    promoted: countMap['promoted'] ?? 0,
    dismissed: countMap['dismissed'] ?? 0,
    all: total,
  };
  const userScope = eq(gmailMessages.userId, userId);
  const whereByView =
    view === 'pending'
      ? and(
          userScope,
          or(
            eq(gmailMessages.status, 'pending'),
            and(
              eq(gmailMessages.status, 'snoozed'),
              or(
                isNull(gmailMessages.snoozeUntil),
                lte(gmailMessages.snoozeUntil, sql`now()`)
              )
            )
          )
        )
      : view === 'all'
        ? userScope
        : and(userScope, eq(gmailMessages.status, view));

  const rows = await db
    .select({
      id: gmailMessages.id,
      subject: gmailMessages.subject,
      fromAddress: gmailMessages.fromAddress,
      fromName: gmailMessages.fromName,
      snippet: gmailMessages.snippet,
      bodyText: gmailMessages.bodyText,
      newsletterKind: gmailMessages.newsletterKind,
      status: gmailMessages.status,
      postedAt: gmailMessages.postedAt,
    })
    .from(gmailMessages)
    .where(whereByView)
    .orderBy(desc(gmailMessages.postedAt))
    .limit(200);

  return (
    <>
      <nav
        className="flex items-center gap-2 mb-8 flex-wrap"
        aria-label="Filter Gmail messages by triage state"
      >
        {(['pending', 'promoted', 'dismissed', 'all'] as View[]).map((v) => {
          const active = view === v;
          const href = gmailHrefFor(v);
          return (
            <Link
              key={v}
              href={href}
              className={`font-mono text-[10px] tracking-[0.18em] uppercase rounded-full px-3 py-1.5 border transition-colors ${
                active
                  ? 'bg-ink text-bg border-ink'
                  : 'bg-paper text-ink-soft border-rule hover:text-ink hover:border-ink'
              }`}
            >
              {VIEW_LABEL[v]}
              <span className="ml-1.5 opacity-70">{chipCounts[v]}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
            {view === 'pending' ? 'No newsletters waiting' : 'Empty'}
          </div>
          <p className="font-sans text-[14px] text-tag">
            {view === 'pending'
              ? 'Connect Gmail in Settings → Connectors and your subscribed newsletters will land here for triage.'
              : `Nothing in ${VIEW_LABEL[view].toLowerCase()}.`}
          </p>
        </div>
      ) : (
        <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
          {rows.map((row) => (
            <GmailMessageRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}
