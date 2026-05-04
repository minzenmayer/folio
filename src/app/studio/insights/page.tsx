// Thoughtbed · Insights — browse view for extracted_ideas
// (Sprint 15 Wave 4 / Phase 7).
//
// extractIdeas() runs on every newsletter post.sent + every Obsidian
// note upsert and writes 0..5 rows into extracted_ideas per source.
// Until now the only place those rows surfaced was the right-rail while
// writing. This page makes the curated layer browsable as its own thing
// — sorted by (depth_signal + breadth_signal) so the strongest claims
// rise to the top.
//
// Read-only. Editing extracted ideas isn't a use case (the LLM
// re-extracts when the source updates). For "I want to evolve this
// idea myself" the user copies the claim into a hand-authored Idea
// in Library, where the existing maturity + edit machinery applies.

import Link from 'next/link';
import { eq, sql, desc } from 'drizzle-orm';
import { db, extractedIdeas, newsletterIssues, obsidianNotes } from '@/db';
import { requireUser } from '@/lib/auth';

export default async function InsightsPage() {
  const user = await requireUser();

  // Single query, two left joins. The XOR-discriminated FK shape from
  // Wave 2's schema means at most one of newsletter_issue_id /
  // obsidian_note_id is set per row, so the joins never multiply rows.
  const rows = await db
    .select({
      id: extractedIdeas.id,
      title: extractedIdeas.title,
      claim: extractedIdeas.claim,
      evidence: extractedIdeas.evidence,
      depthSignal: extractedIdeas.depthSignal,
      breadthSignal: extractedIdeas.breadthSignal,
      sourceKind: extractedIdeas.sourceKind,
      sourceRef: extractedIdeas.sourceRef,
      createdAt: extractedIdeas.createdAt,
      newsletterTitle: newsletterIssues.title,
      newsletterUrl: newsletterIssues.webUrl,
      obsidianTitle: obsidianNotes.title,
      obsidianPath: obsidianNotes.path,
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
    .where(eq(extractedIdeas.userId, user.id))
    .orderBy(
      desc(sql`${extractedIdeas.depthSignal} + ${extractedIdeas.breadthSignal}`),
      desc(extractedIdeas.createdAt)
    )
    .limit(200);

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-10">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Insights
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[60ch]">
            {rows.length === 0
              ? 'Nothing yet. Connect Beehiiv or Obsidian and the system will start pulling claims out of every issue and note as they sync.'
              : `${rows.length} ${rows.length === 1 ? 'claim' : 'claims'} pulled from your newsletter and vault. Sorted by depth + breadth — the densest, most cross-cutting at the top.`}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
              Empty
            </div>
            <p className="font-sans text-[14px] text-tag">
              No extracted ideas yet.
            </p>
          </div>
        ) : (
          <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
            {rows.map((row) => {
              const sourceLabel =
                row.sourceKind === 'newsletter_issue'
                  ? row.newsletterTitle
                    ? `your newsletter · ${row.newsletterTitle}`
                    : 'your newsletter'
                  : row.sourceKind === 'obsidian_note'
                    ? row.obsidianTitle
                      ? `vault · ${row.obsidianTitle}`
                      : 'vault'
                    : 'source';

              const sourceHref =
                row.sourceKind === 'newsletter_issue' && row.newsletterUrl
                  ? row.newsletterUrl
                  : null;

              return (
                <li key={row.id} className="py-6 px-6">
                  <div className="flex items-baseline gap-3 mb-3 flex-wrap">
                    <h3 className="font-serif font-medium text-[20px] tracking-tight text-ink leading-tight">
                      {row.title}
                    </h3>
                    <SignalBars
                      depth={row.depthSignal}
                      breadth={row.breadthSignal}
                    />
                  </div>
                  <p className="font-sans text-[14.5px] leading-[1.6] text-ink-soft mb-3">
                    {row.claim}
                  </p>
                  {row.evidence ? (
                    <p className="font-sans text-[13px] leading-[1.55] text-tag italic mb-3">
                      {row.evidence.length > 240
                        ? row.evidence.slice(0, 240) + '…'
                        : row.evidence}
                    </p>
                  ) : null}
                  <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
                    from{' '}
                    {sourceHref ? (
                      <a
                        href={sourceHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2 hover:text-accent transition-colors"
                      >
                        {sourceLabel}
                      </a>
                    ) : (
                      <span>{sourceLabel}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// Two horizontal bars — depth, then breadth — sized 0..1. Keeps the
// numeric signals legible without leaking the raw float to the user.
function SignalBars({ depth, breadth }: { depth: number; breadth: number }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`depth ${depth.toFixed(2)} · breadth ${breadth.toFixed(2)}`}
    >
      <span className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.16em] uppercase text-tag">
        <span>D</span>
        <span className="relative inline-block w-12 h-[3px] bg-rule rounded-full overflow-hidden">
          <span
            className="absolute inset-y-0 left-0 bg-ink"
            style={{ width: `${Math.round(depth * 100)}%` }}
          />
        </span>
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.16em] uppercase text-tag">
        <span>B</span>
        <span className="relative inline-block w-12 h-[3px] bg-rule rounded-full overflow-hidden">
          <span
            className="absolute inset-y-0 left-0 bg-ink"
            style={{ width: `${Math.round(breadth * 100)}%` }}
          />
        </span>
      </span>
    </span>
  );
}
