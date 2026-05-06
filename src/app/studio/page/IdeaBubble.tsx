// Thoughtbed · IdeaBubble
//
// Phase 20 slice 4 (2026-05-06). React render component for the
// `ideaBubble` Tiptap node (see IdeaBubbleExtension.ts). The bubble
// lands above the paragraph the user is writing when they click "Pull
// as bubble" in the rail. Its job is to keep the borrowed material
// visible while the user writes their own prose underneath, then
// dismiss when they're done.
//
// Visual shape (locked in spec):
//   · Rounded paper-hot bg
//   · Left accent line in border-rule-strong (stronger than the box border)
//   · Small mono-uppercase "From your Garden" label
//   · Idea title in font-medium
//   · One-line preview clamp
//   · Dismiss × in the top-right
//   · "Open in Garden →" link
//
// Phase 20 slice 8 (2026-05-06): polish.
//   · Open-in-Garden becomes a Next.js <Link> so internal route
//     transitions get the prefetch + soft-nav behavior.
//   · contentEditable={false} on the inner box so Tiptap leaves the
//     interactive bits alone (atom node, but the inner buttons need
//     to be reachable by Tab without the editor swallowing focus).
//   · Explicit focus rings on the dismiss × and the Open-in-Garden
//     link so keyboard navigation has a visible focus target.
//   · Dismiss uses deleteNode() from the node-view props — that's
//     the Tiptap idiom for "remove this exact node instance"; it's
//     scoped to the right node without us needing to compute its
//     position.

'use client';

import Link from 'next/link';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

export function IdeaBubble({ node, deleteNode }: NodeViewProps) {
  const ideaId = (node.attrs.ideaId as string) || '';
  const kind = (node.attrs.kind as 'idea' | 'extracted_idea') || 'idea';
  const title = ((node.attrs.title as string) || '').trim();
  const preview = ((node.attrs.preview as string) || '').trim();

  const openHref =
    kind === 'extracted_idea'
      ? `/studio/garden/extracted/${ideaId}`
      : `/studio/garden/${ideaId}`;

  return (
    <NodeViewWrapper
      data-tb-idea-bubble="true"
      data-idea-id={ideaId}
      data-kind={kind}
      className="my-3 not-prose"
    >
      <div
        contentEditable={false}
        className="relative rounded-card border border-rule bg-paper-hot pl-4 pr-3 py-3 flex flex-col gap-1.5"
      >
        {/* Left accent line */}
        <div
          aria-hidden="true"
          className="absolute left-0 top-2 bottom-2 w-[2px] bg-rule-strong rounded-full"
        />

        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag font-medium">
            From your Garden
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
            className="font-mono text-[14px] leading-none text-tag hover:text-ink transition-colors -mr-1 px-1 rounded-soft focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            ×
          </button>
        </div>

        {title.length > 0 && (
          <div className="font-sans text-[14px] font-medium text-ink leading-[1.4]">
            {title}
          </div>
        )}

        {preview.length > 0 && (
          <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] line-clamp-1">
            {preview}
          </p>
        )}

        <div>
          <Link
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors inline-flex items-center gap-1 rounded-soft px-1 -ml-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            Open in Garden →
          </Link>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
