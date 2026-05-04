// Thoughtbed · Garden — ideas list.
// The route stays /studio/ideas (matches DB tables + server actions);
// the sidebar + header label is "Garden" — Phase 11 brand alignment.

import Link from 'next/link';
import { eq, sql, desc } from 'drizzle-orm';
import { db, ideas, captures, extractedIdeas } from '@/db';
import { requireUser } from '@/lib/auth';
import { NewIdeaForm } from './NewIdeaForm';

const MATURITY_DOTS: Record<string, string> = {
  seed: 'bg-zinc-300',
  forming: 'bg-zinc-500',
  shaping: 'bg-zinc-700',
  ready: 'bg-zinc-900',
  circulated: 'bg-zinc-900 ring-2 ring-zinc-300',
  dormant: 'bg-zinc-200',
};

export default async function IdeasPage() {
  const user = await requireUser();

  const rows = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      essence: ideas.essence,
      maturity: ideas.maturity,
      energy: ideas.energy,
      lastVisitedAt: ideas.lastVisitedAt,
      lastEvolvedAt: ideas.lastEvolvedAt,
      attached: sql<number>`(
        SELECT COUNT(*) FROM ${captures}
        WHERE ${captures.ideaId} = ${ideas.id}
        AND ${captures.status} = 'attached'
      )`,
      // Direction B (2026-05-04): if this idea was promoted from an
      // extracted_ideas row, surface the source kind so the card can
      // render a "from your newsletter / vault / LinkedIn" line.
      sourceExtractedIdeaId: ideas.sourceExtractedIdeaId,
      sourceKind: extractedIdeas.sourceKind,
    })
    .from(ideas)
    .leftJoin(
      extractedIdeas,
      eq(ideas.sourceExtractedIdeaId, extractedIdeas.id)
    )
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt));

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Garden
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[58ch]">
            {rows.length === 0
              ? 'Nothing yet. Capture something in the Inbox, or start an idea below.'
              : `${rows.length} ${rows.length === 1 ? 'idea' : 'ideas'}. Tap one to see captures attached, related items, and what else of yours sounds like it.`}
          </p>
        </div>

        <NewIdeaForm />

        <div className="mt-10">
          {rows.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
                Empty
              </div>
              <p className="font-sans text-[14px] text-tag">
                No ideas yet.
              </p>
            </div>
          ) : (
            <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
              {rows.map((idea) => (
                <li key={idea.id}>
                  <Link
                    href={`/studio/ideas/${idea.id}`}
                    className="block py-5 px-5 hover:bg-paper-2 transition-colors group"
                  >
                    <div className="flex items-baseline gap-3 mb-1">
                      <span
                        className={`flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full ${
                          MATURITY_DOTS[idea.maturity] || 'bg-zinc-300'
                        } translate-y-[-1px]`}
                        aria-label={idea.maturity}
                      />
                      <h2 className="font-sans font-semibold text-[18px] leading-[1.3] tracking-tight text-ink group-hover:underline underline-offset-4 decoration-rule-strong">
                        {idea.title}
                      </h2>
                      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-tag whitespace-nowrap">
                        {idea.maturity}
                      </span>
                    </div>
                    {idea.essence && (
                      <p className="font-sans text-[14px] text-ink-soft leading-[1.55] mb-2 max-w-[64ch]">
                        {idea.essence}
                      </p>
                    )}
                    <div className="font-mono text-[10px] text-tag tracking-[0.04em] flex items-center gap-3 flex-wrap">
                      <span>
                        {idea.attached}{' '}
                        {idea.attached === 1 ? 'capture' : 'captures'} attached
                      </span>
                      {idea.sourceExtractedIdeaId && idea.sourceKind && (
                        <span className="text-tag/70">
                          · promoted from{' '}
                          {idea.sourceKind === 'newsletter_issue'
                            ? 'your newsletter'
                            : idea.sourceKind === 'obsidian_note'
                              ? 'vault'
                              : idea.sourceKind === 'linkedin_post'
                                ? 'LinkedIn'
                                : 'a source'}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
