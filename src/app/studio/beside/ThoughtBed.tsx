// Thoughtbed · Beside ThoughtBed (right pane)
//
// Phase 24 slice 1 (2026-05-07). Three-zone panel:
//   • search box at the top (input only, no behavior in slice 1)
//   • cluster cards (placeholders for slice 1)
//   • edge-prompt placeholder at the bottom
//
// Three-state collapse is wired via useThoughtBedCollapse:
// expanded (~360px) → strip (56px, glyphs only) → hidden (gone).
// Cycle button at the top-left of the panel.
//
// Real retrieval, real cluster data, and real claim semantics
// land in slice 2.

'use client';

import { useThoughtBedCollapse } from './useThoughtBedCollapse';
import {
  ClusterCardPlaceholder,
  type ClusterPlaceholder,
} from './ClusterCardPlaceholder';

const SAMPLE_CLUSTERS: ReadonlyArray<ClusterPlaceholder> = [
  {
    id: 'c1',
    title: 'Cluster · prayer & exhaustion',
    fragments: [
      {
        id: 'f1',
        text: "We sat at her table for six hours. She didn't say a word until I asked her — quietly — what she had been praying for that month.",
      },
      {
        id: 'f2',
        text: 'Most pastors confuse fatigue with unfaithfulness. The body is telling the truth before the soul does.',
      },
      {
        id: 'f3',
        text: 'Silence is not the absence of prayer. Silence is the most common prayer in scripture.',
      },
    ],
  },
  {
    id: 'c2',
    title: 'Cluster · pace of ministry',
    fragments: [
      {
        id: 'f4',
        text: 'The week the church grew was the week I learned to do less.',
      },
      {
        id: 'f5',
        text: 'A sustainable rhythm is not slower work. It is honest work.',
      },
    ],
  },
  {
    id: 'c3',
    title: 'Cluster · rest as resistance',
    fragments: [
      {
        id: 'f6',
        text: 'Sabbath in a productivity culture is a public refusal.',
      },
      {
        id: 'f7',
        text: "Rest is not what you do when the work is done. Rest is part of the work.",
      },
    ],
  },
];

export function ThoughtBed() {
  const { state, cycle } = useThoughtBedCollapse();

  if (state === 'hidden') {
    return null;
  }

  if (state === 'strip') {
    return (
      <aside
        aria-label="Thought bed (collapsed)"
        className="hidden lg:flex flex-col w-[56px] border-l border-rule bg-paper sticky top-0 self-start h-screen"
      >
        <button
          type="button"
          onClick={cycle}
          className="px-2 py-3 text-tag hover:text-ink transition-colors"
          aria-label="Expand thought bed"
          title="Expand thought bed"
        >
          <span className="font-mono text-[10px] tracking-[0.16em]">‹</span>
        </button>
        <div className="px-2 mt-1 space-y-3 text-tag">
          {SAMPLE_CLUSTERS.map((c) => (
            <div
              key={c.id}
              aria-hidden="true"
              className="w-8 h-8 rounded-full bg-paper-2 border border-rule flex items-center justify-center font-mono text-[10px]"
              title={c.title}
            >
              {c.title.split('·')[1]?.trim()?.charAt(0)?.toUpperCase() ?? '·'}
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Thought bed"
      className="hidden lg:flex flex-col w-[360px] border-l border-rule bg-bg sticky top-0 self-start h-screen overflow-y-auto"
    >
      <header className="flex items-center justify-between px-3 py-2 border-b border-rule bg-paper">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
          Thought bed
        </span>
        <button
          type="button"
          onClick={cycle}
          className="text-tag hover:text-ink transition-colors p-1"
          aria-label="Collapse thought bed"
          title="Collapse"
        >
          <span className="font-mono text-[12px] leading-none">›</span>
        </button>
      </header>

      <div className="px-3 py-2 border-b border-rule bg-paper">
        <input
          type="search"
          disabled
          placeholder="Search your Garden…"
          aria-label="Search your Garden"
          className="w-full bg-paper-2 border border-rule rounded-soft px-2.5 py-1.5 font-sans text-[13px] text-ink-soft placeholder:text-tag outline-none focus:border-rule-strong"
        />
        <p className="mt-1 font-mono text-[9px] tracking-[0.14em] uppercase text-tag">
          slice 2 wires retrieval
        </p>
      </div>

      <div className="px-3 py-3 space-y-2">
        {SAMPLE_CLUSTERS.map((c) => (
          <ClusterCardPlaceholder key={c.id} cluster={c} />
        ))}
      </div>

      <div className="mt-auto border-t border-rule bg-paper px-3 py-3">
        <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag mb-1">
          Edge prompts
        </p>
        <p className="font-sans text-[12px] text-ink-soft leading-[1.4]">
          Two clusters in your space might combine here. (Slice 2 wires the
          real surface.)
        </p>
      </div>
    </aside>
  );
}
