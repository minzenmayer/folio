// Thoughtbed · RailIdeaPill
//
// Phase 20 slice 2 (2026-05-06). Replaces the verbose HitRow card layout
// with a small pill: glyph + one-line truncated title. On hover (desktop)
// the pill expands inline to reveal a two-line preview plus action
// buttons — "Pull as bubble" and "Open in Garden". Other pills stay in
// their default shape; only the hovered one expands.
//
// Slice 2 ships the pill shape + hover state. The action buttons wire
// into existing onPull (which still inserts text) and a placeholder
// onOpen handler. Slice 5 swaps onPull to insert an ideaBubble node
// instead of raw text. Slice 8 routes onOpen to the Garden surface.
//
// Heat color (paper-hot bg + filled lightbulb) lands in slice 3 — for
// now every pill renders in the 'cool' visual band so the diff for slice
// 3 is purely about ranking, not pill shape.

'use client';

import { useState } from 'react';
import type { SimilarHit } from '../actions';

// Source-type label used in the small mono caption inside the expand.
// Mirrors the KIND_LABEL map in AssistantRailLive — kept local so the
// pill component is self-contained and can be unit-tested in isolation
// later if we add tests.
const KIND_LABEL: Record<SimilarHit['kind'], string> = {
  capture: 'Capture',
  idea: 'Idea',
  draft: 'Draft',
  newsletter_issue: 'Issue',
  obsidian_note: 'Note',
  extracted_idea: 'Lesson',
  linkedin_post: 'LinkedIn',
  gmail_message: 'Newsletter',
};

export type RailIdeaPillProps = {
  hit: SimilarHit;
  onPull: (hit: SimilarHit) => void;
  onOpen?: (hit: SimilarHit) => void;
  // Slice 3 will pass a 'rank' here ('hot' | 'ready' | 'cool') derived
  // from similarity score so the pill knows which glyph + bg to render.
  // Slice 2 only declares the prop so the surrounding component can
  // start passing it without a follow-up touch; default 'cool'.
  rank?: 'hot' | 'ready' | 'cool';
  // Slice 5: marks the pill as already pulled (the user's draft already
  // contains a bubble for this idea). Default false.
  pulled?: boolean;
};

export function RailIdeaPill({
  hit,
  onPull,
  onOpen,
  rank = 'cool',
  pulled = false,
}: RailIdeaPillProps) {
  const [expanded, setExpanded] = useState(false);

  const title = hit.title?.trim() || hit.snippet?.slice(0, 60) || '(untitled)';
  const claimFull = (hit.claimFull ?? '').trim();
  const snippet = (hit.snippet ?? '').trim();
  const preview =
    hit.kind === 'extracted_idea' && claimFull.length > 0 ? claimFull : snippet;

  // Slice 2: visual band stays neutral. Slice 3 swaps these to heat-color
  // bg + filled glyph for hot, dot for ready, outline for cool.
  const bgClass =
    rank === 'hot'
      ? 'bg-paper-hot hover:bg-paper-hot'
      : 'bg-paper hover:bg-paper-2';

  return (
    <div
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        // Only collapse if focus is leaving the whole pill.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setExpanded(false);
        }
      }}
      className={`group rounded-soft border border-rule ${bgClass} transition-colors`}
    >
      <button
        type="button"
        onClick={() => (expanded ? onPull(hit) : setExpanded(true))}
        className="w-full text-left px-2.5 py-2 flex items-center gap-2 focus:outline-none focus:ring-1 focus:ring-rule-strong rounded-soft"
        aria-expanded={expanded}
      >
        <span className="shrink-0">
          <PillGlyph rank={rank} />
        </span>
        <span className="flex-1 truncate font-sans text-[13px] text-ink leading-[1.4]">
          {title}
        </span>
        {pulled && (
          <span
            className="shrink-0 font-mono text-[9px] tracking-[0.18em] uppercase text-tag"
            aria-label="Already pulled into the draft"
            title="Already in your draft"
          >
            ✓ pulled
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 -mt-1 flex flex-col gap-2">
          {preview.length > 0 && (
            <p className="font-sans text-[12px] text-ink-soft leading-[1.5] line-clamp-2">
              {preview}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onPull(hit)}
              className="font-mono text-[9px] tracking-[0.18em] uppercase text-ink border border-rule-strong rounded-full px-2.5 py-1 hover:border-ink hover:bg-paper-2 transition-colors"
            >
              {pulled ? 'Jump to bubble' : 'Pull as bubble'}
            </button>
            {onOpen && (
              <button
                type="button"
                onClick={() => onOpen(hit)}
                className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag border border-rule rounded-full px-2.5 py-1 hover:border-ink hover:text-ink transition-colors"
              >
                Open in Garden
              </button>
            )}
            <span className="ml-auto font-mono text-[9px] tracking-[0.16em] uppercase text-tag/70">
              {KIND_LABEL[hit.kind]}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Phase 20 slice 3: three real glyph shapes, keyed off rank.
//   hot   — filled lightbulb in glyph-hot (#EF9F27).
//   ready — small dot in text-tag.
//   cool  — outline lightbulb in border-rule.
// Kept inline; the pill is the only consumer.
function PillGlyph({ rank }: { rank: 'hot' | 'ready' | 'cool' }) {
  if (rank === 'ready') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="2.4" className="fill-tag" />
      </svg>
    );
  }

  // Lightbulb path — bulb body on top, two filament lines, base ticks
  // at the bottom. Reads at 12px.
  if (rank === 'hot') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="text-glyph-hot"
      >
        <path
          d="M6 1.4 C 4 1.4 2.6 2.7 2.6 4.5 C 2.6 5.6 3.1 6.4 3.7 7 V 8.2 H 8.3 V 7 C 8.9 6.4 9.4 5.6 9.4 4.5 C 9.4 2.7 8 1.4 6 1.4 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <line x1="4.2" y1="9.2" x2="7.8" y2="9.2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        <line x1="4.7" y1="10.4" x2="7.3" y2="10.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }

  // cool — outline bulb in border-rule.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="text-rule"
    >
      <path
        d="M6 1.4 C 4 1.4 2.6 2.7 2.6 4.5 C 2.6 5.6 3.1 6.4 3.7 7 V 8.2 H 8.3 V 7 C 8.9 6.4 9.4 5.6 9.4 4.5 C 9.4 2.7 8 1.4 6 1.4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <line x1="4.2" y1="9.2" x2="7.8" y2="9.2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="4.7" y1="10.4" x2="7.3" y2="10.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
