// Thoughtbed · Idea detail page (the orbit feed for a single idea).
// Sprint 14 brand pivot: monochrome restyle, drop garden glyphs, drop
// italic editorial accents. Functionality unchanged.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, desc } from 'drizzle-orm';
import { db, ideas, captures } from '@/db';
import { requireUser } from '@/lib/auth';
import { visitIdea } from '../actions';
import { findSimilar } from '../../actions';
import type { SimilarHit } from '../../actions';

const MATURITY_DOTS: Record<string, string> = {
  // Maturity is functional state — the dots stay coloured to differentiate
  // at a glance. Sprint 14 keeps the colour palette here only.
  seed: 'bg-zinc-300',
  forming: 'bg-zinc-500',
  shaping: 'bg-zinc-700',
  ready: 'bg-zinc-900',
  circulated: 'bg-zinc-900 ring-2 ring-zinc-300',
  dormant: 'bg-zinc-200',
};

const KIND_LABEL: Record<SimilarHit['kind'], string> = {
  capture: 'Capture',
  idea: 'Idea',
  draft: 'Draft',
  newsletter_issue: 'Issue',
};

function relatedHref(hit: SimilarHit): string {
  switch (hit.kind) {
    case 'idea':
      return `/studio/ideas/${hit.id}`;
    case 'draft':
      return `/studio/page/${hit.id}`;
    case 'capture':
      return `/studio/inbox`;
    case 'newsletter_issue':
      return `/studio?settings=connectors`;
  }
}

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

  const queryText = [idea.title.trim(), idea.essence?.trim() ?? '']
    .filter(Boolean)
    .join('\n\n');

  let relatedItems: SimilarHit[] = [];
  try {
    if (queryText.length > 0) {
      relatedItems = await findSimilar({
        text: queryText,
        kinds: ['capture', 'idea', 'draft', 'newsletter_issue'],
        limit: 5,
        excludeIdeaId: idea.id,
      });
    }
  } catch (err) {
    console.warn('[idea-detail] findSimilar failed', err);
  }

  return (
    <section>
      <div className="max-w-[900px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <Link
          href="/studio/ideas"
          className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors"
        >
          ← Library
        </Link>

        <div className="mt-6 mb-10">
          <div className="flex items-center gap-3 mb-4 font-mono text-[10px] uppercase tracking-[0.18em]">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                MATURITY_DOTS[idea.maturity] || 'bg-zinc-300'
              }`}
              aria-label={idea.maturity}
            />
            <span className="text-ink font-medium">{idea.maturity}</span>
            <span className="text-tag">·</span>
            <span className="text-tag">{idea.energy}</span>
            <span className="text-tag">·</span>
            <span className="text-tag">
              {attachedCaptures.length}{' '}
              {attachedCaptures.length === 1 ? 'capture' : 'captures'}
            </span>
          </div>
          <h1 className="font-sans text-[clamp(28px,4.5vw,52px)] font-semibold leading-[1.1] tracking-tight text-ink mb-5">
            {idea.title}
          </h1>
          {idea.essence && (
            <p className="font-sans text-[clamp(15px,1.6vw,17px)] text-ink-soft leading-[1.6] max-w-[60ch] border-l-2 border-rule-strong pl-5">
              {idea.essence}
            </p>
          )}
        </div>

        {/* Captures section */}
        <div className="mb-12">
          <div className="flex items-baseline gap-3 mb-4">
            <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
              Captures
            </h2>
            <span className="font-sans text-[12px] text-tag">
              {attachedCaptures.length}
            </span>
          </div>

          {attachedCaptures.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-rule rounded-card bg-paper">
              <p className="font-sans text-[14px] text-tag mb-2">
                Nothing attached yet.
              </p>
              <Link
                href="/studio/inbox"
                className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink hover:text-ink-soft transition-colors"
              >
                Capture something →
              </Link>
            </div>
          ) : (
            <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
              {attachedCaptures.map((capture) => (
                <li
                  key={capture.id}
                  className="py-4 px-5 flex items-start gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-sans text-[14.5px] text-ink leading-[1.55]">
                      {capture.body}
                    </div>
                    <div className="font-mono text-[10px] text-tag mt-2 tracking-[0.04em]">
                      {capture.source && (
                        <>
                          <span>{capture.source}</span>
                          <span className="mx-2">·</span>
                        </>
                      )}
                      <span className="uppercase">{capture.capturedVia}</span>
                      <span className="mx-2">·</span>
                      <span>{timeAgo(capture.capturedAt)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Related */}
        <div className="mb-12">
          <div className="flex items-baseline gap-3 mb-4">
            <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
              Related
            </h2>
            {relatedItems.length > 0 && (
              <span className="font-sans text-[12px] text-tag">
                {relatedItems.length}
              </span>
            )}
          </div>

          {relatedItems.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-rule rounded-card bg-paper">
              <p className="font-sans text-[14px] text-tag mb-1">
                Nothing's resonating yet.
              </p>
              <p className="font-sans text-[12px] text-tag">
                Capture more, write more — sources surface as the archive
                grows.
              </p>
            </div>
          ) : (
            <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
              {relatedItems.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <Link
                    href={relatedHref(hit)}
                    className="flex items-start gap-4 py-4 px-5 hover:bg-paper-2 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag mb-1">
                        {KIND_LABEL[hit.kind]}
                        <span className="ml-2 normal-case tracking-[0.04em]">
                          {hit.similarity.toFixed(2)}
                        </span>
                      </div>
                      {hit.title && (
                        <div className="font-sans text-[14.5px] font-medium text-ink leading-[1.4] group-hover:underline underline-offset-4 decoration-rule-strong">
                          {hit.title}
                        </div>
                      )}
                      {hit.snippet && (
                        <div className="font-sans text-[13px] text-ink-soft leading-[1.55] mt-1 line-clamp-2">
                          {hit.snippet}
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Future placeholder sections */}
        <div className="space-y-4 opacity-60">
          {[
            { label: 'Threads', sub: 'where you think out loud — Sprint 5+' },
            { label: 'Artifacts', sub: 'things you build around this — Sprint 5+' },
            { label: 'Connected ideas', sub: 'supports · extends · echoes · contradicts — Sprint 8+' },
          ].map((row) => (
            <div key={row.label}>
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
                {row.label}
              </div>
              <div className="font-sans text-[12px] text-tag/80 mt-0.5">
                {row.sub}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
