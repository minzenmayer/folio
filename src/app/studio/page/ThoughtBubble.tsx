// Thoughtbed · ThoughtBubble
//
// Phase 20.5 (2026-05-06). React render component for the unified
// `thoughtBubble` Tiptap node. Same shape used for two surfaces:
//
//   source = 'idea'  — pulled from the resonance rail. Reads as
//                       "From your Garden / [memory] / capture this in
//                       your own words below". Open-in-Garden link
//                       routes by kind.
//   source = 'plan'  — written by commitProposal in the spar handoff.
//                       Reads as "From your plan / [beat] / write this
//                       beat below". No Open link; the PlanRibbon on
//                       the side handles plan navigation.
//
// Visual: paper-hot rounded card, larger than the slice-4 reference
// pill. Small mono uppercase tag at the top, idea/beat title big
// enough to scan, preview clamped to 2 lines, an italic "capture
// this in your own words below" / "write this beat below" line at
// the bottom, dismiss × in the corner.
//
// The user writes their prose under the bubble. Dismiss with the ×
// when the writing is done; the bubble removes itself via deleteNode().

'use client';

import Link from 'next/link';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

export function ThoughtBubble({ node, deleteNode }: NodeViewProps) {
  const source = (node.attrs.source as 'idea' | 'plan') || 'idea';
  const title = ((node.attrs.title as string) || '').trim();
  const preview = ((node.attrs.preview as string) || '').trim();

  // Idea-only fields
  const ideaId = (node.attrs.ideaId as string | null) ?? '';
  const kind =
    (node.attrs.kind as 'idea' | 'extracted_idea' | null) ?? 'idea';

  const sourceLabel = source === 'plan' ? 'From your plan' : 'From your Garden';
  const captureLine =
    source === 'plan'
      ? 'Write this beat below.'
      : 'Capture this in your own words below.';

  const showOpenInGarden = source === 'idea' && ideaId.length > 0;
  const openHref =
    kind === 'extracted_idea'
      ? `/studio/garden/extracted/${ideaId}`
      : `/studio/garden/${ideaId}`;

  return (
    <NodeViewWrapper
      data-tb-thought-bubble="true"
      data-source={source}
      data-idea-id={ideaId || undefined}
      className="my-4 not-prose"
    >
      <div
        contentEditable={false}
        className="relative rounded-card border border-rule bg-paper-hot pl-5 pr-4 py-4 flex flex-col gap-2.5"
      >
        {/* Left accent line */}
        <div
          aria-hidden="true"
          className="absolute left-0 top-3 bottom-3 w-[3px] bg-glyph-hot rounded-full"
        />

        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
            {sourceLabel}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteNode();
            }}
            aria-label="Dismiss bubble"
            title="Dismiss"
            className="font-mono text-[16px] leading-none text-tag hover:text-ink transition-colors px-1.5 py-0.5 rounded-soft focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            ×
          </button>
        </div>

        {title.length > 0 && (
          <div className="font-sans text-[16px] font-medium text-ink leading-[1.4]">
            {title}
          </div>
        )}

        {preview.length > 0 && (
          <p className="font-sans text-[13.5px] text-ink-soft leading-[1.55] line-clamp-2">
            {preview}
          </p>
        )}

        <div className="pt-1 border-t border-rule-strong/40 mt-0.5 flex items-baseline justify-between gap-3 flex-wrap">
          <span className="font-serif italic text-[13px] text-ink-soft leading-[1.5]">
            {captureLine}
          </span>
          {showOpenInGarden && (
            <Link
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors inline-flex items-center gap-1 rounded-soft px-1 -mr-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
            >
              Open in Garden →
            </Link>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
