// Thoughtbed · ThoughtBubbleExtension
//
// Phase 20.5 (2026-05-06). Unified Tiptap node that backs both
// "borrowed material" surfaces in the editor:
//
//   source = 'idea'  — pulled from the resonance rail (a Garden idea
//                       or extracted_idea). Title + preview are the
//                       memory; the user writes their own prose under.
//   source = 'plan'  — written by commitProposal when the spar lands a
//                       proposal in the editor. One bubble per beat, in
//                       insertion order. PlanRibbon reads beatId from
//                       attrs to compute pill state.
//
// Prior shape: separate IdeaBubble extension. The plan beats lived as
// H2 headings stamped with data-tb-beat-id. Both lands in the doc
// looked like content rather than scaffolding — Payton's gripe on
// 2026-05-06. Phase 20.5 unifies the surfaces so anything that isn't
// the user's prose reads as a dismissable reference card.
//
// Wire shape:
//   name      'thoughtBubble'
//   group     'block'
//   atom      true   (no editable inner content)
//   attrs     { source, ideaId?, kind?, title, preview?, beatId?, beatStatus? }
//
// Backward compatibility: existing drafts may persist contentJson
// containing `type: 'ideaBubble'` from the brief Phase 20 window. The
// migration helper in DraftEditor renames those to `type:
// 'thoughtBubble'` with source: 'idea' on load.
//
// Command idiom: insertThoughtBubble uses `commands.insertContentAt`
// (not a nested chain().run()) so it composes cleanly with any
// surrounding chain(). The Phase 20 nested-chain pattern was Payton's
// suspected cause of bubbles rendering as quotes — the inner chain
// dispatched its own transaction which raced with the outer focus().

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ThoughtBubble } from './ThoughtBubble';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    thoughtBubble: {
      insertThoughtBubble: (attrs: ThoughtBubbleAttrs) => ReturnType;
    };
  }
}

export type ThoughtBubbleSource = 'idea' | 'plan';
export type ThoughtBubbleIdeaKind = 'idea' | 'extracted_idea';
export type ThoughtBubbleBeatStatus = 'anchored' | 'drafted' | 'floating';

export type ThoughtBubbleAttrs = {
  source: ThoughtBubbleSource;
  // Idea variant
  ideaId?: string;
  kind?: ThoughtBubbleIdeaKind;
  // Plan variant
  beatId?: string;
  beatStatus?: ThoughtBubbleBeatStatus;
  // Both
  title: string;
  preview?: string;
};

export const ThoughtBubbleExtension = Node.create({
  name: 'thoughtBubble',

  group: 'block',
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: 'idea',
        parseHTML: (el) =>
          (el.getAttribute('data-source') as ThoughtBubbleSource) || 'idea',
        renderHTML: (attrs) => ({ 'data-source': attrs.source }),
      },
      ideaId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-idea-id'),
        renderHTML: (attrs) =>
          attrs.ideaId ? { 'data-idea-id': attrs.ideaId } : {},
      },
      kind: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-kind'),
        renderHTML: (attrs) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
      },
      beatId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-beat-id'),
        renderHTML: (attrs) =>
          attrs.beatId ? { 'data-beat-id': attrs.beatId } : {},
      },
      beatStatus: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-beat-status'),
        renderHTML: (attrs) =>
          attrs.beatStatus ? { 'data-beat-status': attrs.beatStatus } : {},
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title }),
      },
      preview: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-preview') ?? '',
        renderHTML: (attrs) => ({ 'data-preview': attrs.preview }),
      },
    };
  },

  parseHTML() {
    // Recognize both the new tag and the brief Phase 20 ideaBubble tag
    // so any HTML round-trips of older drafts still parse.
    return [
      { tag: 'div[data-tb-thought-bubble]' },
      { tag: 'div[data-tb-idea-bubble]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-tb-thought-bubble': 'true' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ThoughtBubble);
  },

  addCommands() {
    return {
      insertThoughtBubble:
        (attrs) =>
        ({ commands, state }) => {
          // Phase 21 slice 1 (2026-05-06): defensive rewrite.
          // String() coerces title/preview so a hit row with a
          // numeric or null field can't sneak past as undefined and
          // render the bubble with empty content. Earlier on, Payton
          // saw bubbles render with no title/preview even though the
          // hit had both — the safest read is one of the attrs was
          // arriving as something other than a plain string.
          let insertPos: number | null = null;
          try {
            const $from = state.selection.$from;
            insertPos = $from.before(1);
          } catch {
            insertPos = null;
          }

          const safeTitle = String(attrs.title ?? '').trim();
          const safePreview = String(attrs.preview ?? '').trim();

          const node = {
            type: 'thoughtBubble',
            attrs: {
              source: attrs.source ?? 'idea',
              ideaId: attrs.ideaId ?? null,
              kind: attrs.kind ?? null,
              beatId: attrs.beatId ?? null,
              beatStatus: attrs.beatStatus ?? null,
              title: safeTitle,
              preview: safePreview,
            },
          };

          if (insertPos === null) {
            return commands.insertContent(node);
          }
          return commands.insertContentAt(insertPos, node);
        },
    };
  },
});

/**
 * Migrate a saved contentJson tree in place: any node with
 * type === 'ideaBubble' is renamed to 'thoughtBubble' with
 * source: 'idea'. Used by DraftEditor on initial content so the brief
 * Phase 20 window of saved bubbles renders correctly under the
 * unified node name.
 */
export function migrateIdeaBubbleToThoughtBubble(content: unknown): unknown {
  if (!content || typeof content !== 'object') return content;
  if (Array.isArray(content)) {
    return content.map((c) => migrateIdeaBubbleToThoughtBubble(c));
  }
  const obj = content as Record<string, unknown>;
  let next: Record<string, unknown> = obj;
  if (obj.type === 'ideaBubble') {
    const attrs = (obj.attrs ?? {}) as Record<string, unknown>;
    next = {
      ...obj,
      type: 'thoughtBubble',
      attrs: {
        source: 'idea',
        ideaId: attrs.ideaId ?? null,
        kind: attrs.kind ?? null,
        beatId: null,
        beatStatus: null,
        title: attrs.title ?? '',
        preview: attrs.preview ?? '',
      },
    };
  }
  if (Array.isArray(next.content)) {
    next = { ...next, content: next.content.map((c) => migrateIdeaBubbleToThoughtBubble(c)) };
  }
  return next;
}
