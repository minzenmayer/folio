// Thoughtbed · The Garden — ideas list
// Chronological list of all the user's ideas with attachment counts.
// The garden is where seeds grow into ideas; the orbit view (/studio/ideas/[id])
// is where each one matures alongside its captures and Related neighbours.

import Link from 'next/link';
import { eq, sql, desc } from 'drizzle-orm';
import { db, ideas, captures } from '@/db';
import { requireUser } from '@/lib/auth';
import { NewIdeaForm } from './NewIdeaForm';

const MATURITY_DOTS: Record<string, string> = {
  seed: 'bg-olive',
  forming: 'bg-gold',
  shaping: 'bg-accent',
  ready: 'bg-accent-2',
  circulated: 'bg-plum',
  dormant: 'bg-tag',
};

export default async function IdeasPage() {
  const user = await requireUser();

  // Ideas with attachment counts.
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
    })
    .from(ideas)
    .where(eq(ideas.userId, user.id))
    .orderBy(desc(ideas.lastVisitedAt));

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-[7%] py-12 md:py-16">
        <div className="mb-10">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
            ☘ The Garden
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.05] tracking-tightest text-ink mb-3">
            Your{' '}
            <em className="italic font-light text-accent">ideas.</em>
          </h1>
          <p className="font-serif font-light text-[18px] leading-[1.5] text-ink-soft max-w-[56ch]">
            {rows.length === 0
              ? 'Nothing yet. Plant a seed in the Inbox first, or start an idea below.'
              : `${rows.length} ${rows.length === 1 ? 'idea' : 'ideas'} in the garden. Tap one to walk its orbit — captures attached, related items, the bed humming around it.`}
          </p>
        </div>

        <NewIdeaForm />

        <div className="mt-12">
          {rows.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper/50">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-3">
                ▸ Empty
              </div>
              <p className="font-serif italic text-[16px] text-tag">
                No ideas yet. The bed fills as you plant.
              </p>
            </div>
          ) : (
            <div className="border-t border-rule">
              {rows.map((idea) => (
                <Link
                  key={idea.id}
                  href={`/studio/ideas/${idea.id}`}
                  className="block border-b border-rule py-6 px-2 hover:bg-paper/50 transition-colors group"
                >
                  <div className="flex items-baseline gap-3 mb-1.5">
                    <span
                      className={`flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full ${
                        MATURITY_DOTS[idea.maturity] || 'bg-tag'
                      } translate-y-[-2px]`}
                      aria-label={idea.maturity}
                    />
                    <h2 className="font-serif font-normal text-[24px] leading-[1.2] tracking-editorial text-ink group-hover:text-accent transition-colors">
                      {idea.title}
                    </h2>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-tag whitespace-nowrap">
                      {idea.maturity}
                    </span>
                  </div>
                  {idea.essence && (
                    <p className="font-serif italic text-[15px] text-ink-soft leading-[1.5] mb-2 max-w-[60ch]">
                      "{idea.essence}"
                    </p>
                  )}
                  <div className="font-sans text-[11px] text-tag tracking-[0.04em]">
                    <span>
                      {idea.attached} {idea.attached === 1 ? 'capture' : 'captures'} attached
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
