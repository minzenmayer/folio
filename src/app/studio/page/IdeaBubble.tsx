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
// The dismiss button calls deleteNode from the node-view props (slice
// 8 verifies the Tiptap idiom). Open-in-Garden is wired to '#' for
// this slice — slice 8 swaps in the right Next.js Link with the kind-
// keyed href.

'use client';

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

export function IdeaBubble({ node, deleteNode }: NodeViewProps) {
  const ideaId = (node.attrs.ideaId as string) || '';
  const kind = (node.attrs.kind as 'idea' | 'extracted_idea') || 'idea';
  const title = ((node.attrs.title as string) || '').trim();
  const preview = ((node.attrs.preview as string) || '').trim();

  // Slice 8 wires this to the actual Garden surface. Routing here so
  // the slice 4 -> 8 diff is just an href swap.
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
      <div className="relative rounded-card border border-rule bg-paper-hot pl-4 pr-3 py-3 flex flex-col gap-1.5">
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
            className="font-mono text-[14px] leading-none text-tag hover:text-ink transition-colors -mr-1"
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
          <a
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors inline-flex items-center gap-1"
          >
            Open in Garden →
          </a>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
