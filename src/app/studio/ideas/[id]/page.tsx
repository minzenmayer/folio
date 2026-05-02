// Folio · Idea detail page
// The orbit feed — captures, threads (later), artifacts (later), marginalia (later).
// Sprint 3 v0: identity + captures only. Threads/artifacts/marginalia ship in
// later sprints, but the shell is here.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, desc } from 'drizzle-orm';
import { db, ideas, captures } from '@/db';
import { requireUser } from '@/lib/auth';
import { visitIdea } from '../actions';

const MATURITY_DOTS: Record<string, string> = {
  seed: 'bg-olive',
  forming: 'bg-gold',
  shaping: 'bg-accent',
  ready: 'bg-accent-2',
  circulated: 'bg-plum',
  dormant: 'bg-tag',
};

const TYPE_GLYPHS: Record<string, string> = {
  paste: '"',
  link: '↗',
  quote: '"',
  image: '▣',
  voice_memo: '◉',
  doc: '▭',
};

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

export default async function IdeaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const [idea] = await db
    .select()
    .from(ideas)
    .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)))
    .limit(1);

  if (!idea) notFound();

  // Touch the last_visited timestamp.
  await visitIdea(idea.id);

  const attachedCaptures = await db
    .select()
    .from(captures)
    .where(
      and(
        eq(captures.ideaId, idea.id),
        eq(captures.userId, user.id),
        eq(captures.status, 'attached')
      )
    )
    .orderBy(desc(captures.capturedAt));

  return (
    <section>
      <div className="max-w-[900px] mx-auto px-[7%] py-12 md:py-16">
        {/* Crumb back */}
        <Link
          href="/studio/ideas"
          className="font-sans text-[11px] tracking-[0.18em] uppercase text-tag hover:text-accent transition-colors"
        >
          ← Back to library
        </Link>

        {/* Header */}
        <div className="mt-6 mb-10">
          <div className="flex items-center gap-3 mb-4 font-mono text-[10px] uppercase tracking-[0.18em]">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                MATURITY_DOTS[idea.maturity] || 'bg-tag'
              }`}
              aria-label={idea.maturity}
            />
            <span className="text-accent font-bold">{idea.maturity}</span>
            <span className="text-tag">·</span>
            <span className="text-tag">{idea.energy}</span>
            <span className="text-tag">·</span>
            <span className="text-tag">
              {attachedCaptures.length}{' '}
              {attachedCaptures.length === 1 ? 'capture' : 'captures'}
            </span>
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5.5vw,72px)] leading-[1.0] tracking-tightest text-ink mb-6">
            {idea.title}
          </h1>
          {idea.essence && (
            <p className="font-serif italic font-light text-[clamp(18px,2vw,22px)] text-ink-soft leading-[1.5] max-w-[60ch] border-l-2 border-accent pl-5">
              "{idea.essence}"
            </p>
          )}
        </div>

        {/* Orbit — captures section */}
        <div className="mb-12">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-5 flex items-baseline gap-3">
            <span>▸ Captures</span>
            <span className="text-tag/70 text-[10px] normal-case tracking-[0.04em] font-sans italic font-normal">
              raw material orbiting this idea
            </span>
            <span className="ml-auto bg-paper-2 text-tag rounded-[99px] px-2 py-0.5 text-[10px] font-mono">
              {attachedCaptures.length}
            </span>
          </div>

          {attachedCaptures.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-rule rounded-[3px] bg-paper/50">
              <p className="font-serif italic text-[15px] text-tag mb-2">
                Nothing attached yet.
              </p>
              <Link
                href="/studio/inbox"
                className="font-sans text-[11px] tracking-[0.18em] uppercase text-accent hover:text-ink transition-colors"
              >
                Capture something →
              </Link>
            </div>
          ) : (
            <div className="border-t border-rule">
              {attachedCaptures.map((capture) => (
                <div
                  key={capture.id}
                  className="border-b border-rule py-5 px-2 flex items-start gap-4"
                >
                  <span className="flex-shrink-0 w-7 h-7 rounded-[3px] bg-paper-2 border border-rule flex items-center justify-center text-[12px] text-accent font-mono mt-0.5">
                    {TYPE_GLYPHS[capture.type] ?? '·'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-serif text-[16px] text-ink leading-[1.55]">
                      {capture.body}
                    </div>
                    <div className="font-sans text-[11px] text-tag mt-2 tracking-[0.04em]">
                      {capture.source && (
                        <>
                          <span className="italic">{capture.source}</span>
                          <span className="mx-2">·</span>
                        </>
                      )}
                      <span className="font-mono">{capture.capturedVia}</span>
                      <span className="mx-2">·</span>
                      <span>{timeAgo(capture.capturedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Future orbit sections — placeholders */}
        <div className="space-y-6 opacity-50">
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
              ▸ Threads
              <span className="ml-3 font-sans normal-case tracking-[0.04em] italic font-normal">
                where you'll think out loud — Sprint 5+
              </span>
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
              ▸ Artifacts
              <span className="ml-3 font-sans normal-case tracking-[0.04em] italic font-normal">
                things you build around this — Sprint 5+
              </span>
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
              ▸ Connected ideas
              <span className="ml-3 font-sans normal-case tracking-[0.04em] italic font-normal">
                supports · extends · echoes · contradicts — Sprint 8+
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
