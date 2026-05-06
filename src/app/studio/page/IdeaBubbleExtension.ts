// Thoughtbed · IdeaBubbleExtension
//
// Phase 20 slice 4 (2026-05-06). Custom Tiptap node that renders a
// "thought bubble" referencing one of the user's Garden ideas above the
// paragraph they're writing. The bubble is the new shape of the rail's
// "Pull as bubble" action — the user's prose sits below it, the bubble
// stays as a visual reference, and the dismiss × removes it cleanly
// (slice 8 wires the dismiss command).
//
// Node spec:
//   name      'ideaBubble'
//   group     'block'                    — sits at the same level as paragraphs
//   atom      true                       — no editable inner content; attrs carry data
//   draggable false                      — Phase 20 has no drag-to-rearrange
//   attrs     { ideaId, kind, title, preview }
//
// The Garden idea's ideaId is the canonical pointer back to the source.
// kind discriminates 'idea' (claimed) vs 'extracted_idea' (unclaimed)
// so the Open-in-Garden link in slice 8 can route to the right surface.
// title + preview are denormalized into the doc so the bubble keeps
// reading correctly even if the source row's title later changes.
//
// addCommands('insertIdeaBubble') wraps the standard insertContentAt
// pattern. Slice 5 calls it from the rail.

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { IdeaBubble } from './IdeaBubble';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ideaBubble: {
      /**
       * Insert an ideaBubble node at the position immediately above the
       * current block. If `pos` is omitted we resolve a position for the
       * caller — useful from outside the editor where computing it is
       * awkward.
       */
      insertIdeaBubble: (attrs: IdeaBubbleAttrs) => ReturnType;
    };
  }
}

export type IdeaBubbleKind = 'idea' | 'extracted_idea';

export type IdeaBubbleAttrs = {
  ideaId: string;
  kind: IdeaBubbleKind;
  title: string;
  preview: string;
};

export const IdeaBubbleExtension = Node.create({
  name: 'ideaBubble',

  group: 'block',
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      ideaId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-idea-id') ?? '',
        renderHTML: (attrs) => ({ 'data-idea-id': attrs.ideaId }),
      },
      kind: {
        default: 'idea',
        parseHTML: (el) =>
          (el.getAttribute('data-kind') as IdeaBubbleKind) ?? 'idea',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
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
    return [{ tag: 'div[data-tb-idea-bubble]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Plain HTML render path (used by exports + non-editor surfaces).
    // The editor itself uses the React node view below.
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-tb-idea-bubble': 'true' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(IdeaBubble);
  },

  addCommands() {
    return {
      insertIdeaBubble:
        (attrs) =>
        ({ chain, state }) => {
          // Insert the bubble immediately above the current block. We
          // resolve $from.before(1) to find the start of the block the
          // selection sits in, then drop the node at that position so it
          // lands ABOVE the user's current paragraph. If we fail to
          // resolve a position (selection at doc edge), fall back to
          // insertContent which puts it at the cursor.
          let insertPos: number | null = null;
          try {
            const $from = state.selection.$from;
            insertPos = $from.before(1);
          } catch {
            insertPos = null;
          }

          const node = {
            type: 'ideaBubble',
            attrs: {
              ideaId: attrs.ideaId,
              kind: attrs.kind,
              title: attrs.title,
              preview: attrs.preview,
            },
          };

          if (insertPos === null) {
            return chain().insertContent(node).run();
          }
          return chain().insertContentAt(insertPos, node).run();
        },
    };
  },
});
