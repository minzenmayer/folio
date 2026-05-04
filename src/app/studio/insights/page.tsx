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
} from '@/db';
import { requireUser } from '@/lib/auth';
import { InsightRow } from './InsightRow';

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
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const user = await requireUser();
  const { view: viewParam } = await searchParams;
  const view = parseView(viewParam);

  // Build the WHERE clause per view.
  //   · pending: triage_status = 'pending'
  //              OR (triage_status = 'snoozed' AND snooze_until <= now())
  //   · promoted: triage_status = 'promoted'
  //   · dismissed: triage_status = 'dismissed'
  //   · all: every row owned by user
  const userScope = eq(extractedIdeas.userId, user.id);
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

  // Counts for the filter chips. Cheap because we already have the
  // index on (user_id, triage_status).
  const counts = await db
    .select({
      status: extractedIdeas.triageStatus,
      n: sql<number>`count(*)::int`,
    })
    .from(extractedIdeas)
    .where(eq(extractedIdeas.userId, user.id))
    .groupBy(extractedIdeas.triageStatus);

  const countMap: Record<string, number> = Object.fromEntries(
    counts.map((c) => [c.status, Number(c.n)])
  );
  const total = Object.values(countMap).reduce((a, b) => a + b, 0);
  // The "pending" chip surfaces both pending + ripe-snoozed; we approximate
  // with raw 'pending' count because counting the snoozed-but-ripe
  // subset would need a second query for almost no UX value.
  const chipCounts: Record<View, number> = {
    pending: countMap['pending'] ?? 0,
    promoted: countMap['promoted'] ?? 0,
    dismissed: countMap['dismissed'] ?? 0,
    all: total,
  };

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

        {/* Filter chips */}
        <nav
          className="flex items-center gap-2 mb-8 flex-wrap"
          aria-label="Filter insights by triage state"
        >
          {(['pending', 'promoted', 'dismissed', 'all'] as View[]).map((v) => {
            const active = view === v;
            const href = v === 'pending' ? '/studio/insights' : `/studio/insights?view=${v}`;
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
      </div>
    </section>
  );
}
