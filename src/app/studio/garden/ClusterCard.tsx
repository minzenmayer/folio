// Thoughtbed · ClusterCard — Phase 17 (2026-05-05)
//
// One card per cluster. Shows the representative title + claim
// preview, source-mix dots (one dot per source kind contributing),
// sibling count badge, and an inline expand for siblings.
//
// Click the body of the card → navigates to the rep's expand
// surface (claimed or extracted, same routing rules as the flat
// feed). Click '+ N related' to expand inline; the expand shows
// each sibling as a smaller row with its own click-to-expand link.

'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { GardenItem } from '@/lib/garden/types';
import { TempPill, MaturityDots } from './pills';
import { WriteFromIdeaButton } from './WriteFromIdeaButton';

const SOURCE_LABEL: Record<string, string> = {
  newsletter_issue: 'CSL',
  obsidian_note: 'vault',
  linkedin_post: 'LinkedIn',
  gmail_message: 'newsletter',
};

const SOURCE_DOT_CLASS: Record<string, string> = {
  newsletter_issue: 'bg-ink',
  obsidian_note: 'bg-ink-soft',
  linkedin_post: 'bg-tag',
  gmail_message: 'bg-rule-strong',
  // 'authored' / claimed ideas (no source kind) get a muted dot.
  authored: 'bg-paper-3',
};

export interface ClusterRender {
  id: string;
  rep: GardenItem;
  theme: string | null;
  members: GardenItem[];
}

export function ClusterCard({ cluster }: { cluster: ClusterRender }) {
  const [expanded, setExpanded] = useState(false);
  const others = cluster.members.filter(
    (m) => !(m.kind === cluster.rep.kind && m.id === cluster.rep.id)
  );

  // Source-mix: count contributions per source kind (rep + members).
  const counts: Record<string, number> = {};
  for (const m of cluster.members) {
    const k = m.sourceKind ?? 'authored';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const sourceKeys = Object.keys(counts);

  const repHref = cluster.rep.isClaimed
    ? `/studio/garden/${cluster.rep.id}`
    : `/studio/garden/extracted/${cluster.rep.id}`;

  return (
    <article className="rounded-card border border-rule bg-paper overflow-hidden">
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-baseline gap-3 mb-1">
          <Link
            href={repHref}
            className="font-sans font-medium text-[15px] leading-[1.35] tracking-tight text-ink hover:underline underline-offset-4 decoration-rule-strong flex-1"
          >
            {cluster.rep.title}
          </Link>
          {cluster.rep.claimKind === 'auto_claimed' && (
            <span
              className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag border border-rule rounded px-1.5 py-[1px]"
              title="Auto-claimed from your own writing. Refine or demote any time."
            >
              Auto
            </span>
          )}
          <WriteFromIdeaButton
            kind={cluster.rep.kind}
            id={cluster.rep.id}
          />
          {others.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="font-mono text-[10px] tracking-[0.12em] uppercase text-tag hover:text-ink transition-colors whitespace-nowrap"
              aria-expanded={expanded}
            >
              {expanded ? '— hide' : `+ ${others.length} related`}
            </button>
          )}
        </div>

        {cluster.rep.preview && (
          <p className="font-sans text-[13px] text-ink-soft leading-[1.55] mb-2 line-clamp-2">
            {cluster.rep.preview}
          </p>
        )}

        <div className="flex gap-2 flex-wrap items-center">
          <TempPill t={cluster.rep.temperature} />
          {cluster.rep.isClaimed && <MaturityDots m={cluster.rep.maturity} />}
          {cluster.theme && (
            <span className="font-mono text-[10px] px-2 py-[2px] rounded bg-paper-2 text-tag">
              {cluster.theme}
            </span>
          )}
          {sourceKeys.length > 0 && (
            <span
              className="ml-auto flex items-center gap-1"
              title={sourceKeys
                .map(
                  (k) =>
                    `${counts[k]} ${SOURCE_LABEL[k] ?? k}${counts[k] === 1 ? '' : 's'}`
                )
                .join(' · ')}
            >
              {sourceKeys.map((k) => (
                <span
                  key={k}
                  className={`inline-block w-1.5 h-1.5 rounded-full ${SOURCE_DOT_CLASS[k] ?? 'bg-rule-strong'}`}
                  aria-label={`${counts[k]} ${SOURCE_LABEL[k] ?? k}`}
                />
              ))}
            </span>
          )}
        </div>
      </div>

      {expanded && others.length > 0 && (
        <ul className="border-t border-rule divide-y divide-rule bg-paper-2">
          {others.map((m) => {
            const href = m.isClaimed
              ? `/studio/garden/${m.id}`
              : `/studio/garden/extracted/${m.id}`;
            return (
              <li key={`${m.kind}-${m.id}`}>
                <Link
                  href={href}
                  className="block py-2 px-5 hover:bg-paper transition-colors group"
                >
                  <div className="flex items-baseline gap-3 mb-1">
                    <span className="font-sans text-[13.5px] leading-[1.4] text-ink flex-1 group-hover:underline underline-offset-4 decoration-rule-strong">
                      {m.title}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-tag whitespace-nowrap">
                      {m.sourceKind
                        ? SOURCE_LABEL[m.sourceKind] ?? 'source'
                        : m.isClaimed
                          ? 'idea'
                          : 'unclaimed'}
                    </span>
                    <WriteFromIdeaButton kind={m.kind} id={m.id} />
                  </div>
                  {m.preview && (
                    <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] line-clamp-1">
                      {m.preview}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
