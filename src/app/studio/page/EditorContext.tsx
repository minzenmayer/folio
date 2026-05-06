// Folio · EditorContext
//
// Sprint 8: shares the live Tiptap editor instance between EditorPane (where
// it's instantiated) and AssistantRailLive (where the user pulls retrieval
// results into the editor). Until now, EditorPane owned editor state locally
// and forwarded the instance to its direct children (DraftMeta, HistoryModal)
// via props. The Assistant rail is a sibling of EditorPane in the route's
// grid, so prop drilling is no longer enough.
//
// We deliberately use a tiny React Context rather than a global store: the
// scope of "things that need the editor" is one route's tree, the editor
// lifecycle is bounded by that tree, and nothing else needs it.
//
// Phase 20 slice 5 (2026-05-06): exposes an `insertIdeaBubble` helper on
// the context. The rail calls it instead of building the Tiptap chain
// itself; that keeps the bubble-insert call shape (and the
// scroll-to-existing-bubble fallback) in one place.
//
// Phase 20.5 (2026-05-06): renamed to `insertThoughtBubble`. Same
// behavior, but the unified node spec carries a `source` attr so plan
// beats can use the same shape. The duplicate-check walks
// thoughtBubble nodes whose ideaId matches.

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/react';
import type { ThoughtBubbleAttrs } from './ThoughtBubbleExtension';

export type InsertThoughtBubbleResult =
  | { ok: true; inserted: true }
  | { ok: false; reason: 'no_editor' };

type EditorCtxValue = {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  /**
   * Insert a thoughtBubble node ABOVE the current block. For
   * source='idea', if a bubble for the same ideaId already lives in
   * the doc, we scroll to it instead of inserting a duplicate. For
   * source='plan' (one bubble per beat) we always insert; the caller
   * (commitProposal) is responsible for not double-writing.
   */
  insertThoughtBubble: (attrs: ThoughtBubbleAttrs) => InsertThoughtBubbleResult;
};

const EditorCtx = createContext<EditorCtxValue | null>(null);

/**
 * Walk the doc looking for a thoughtBubble with source='idea' whose
 * ideaId matches. Returns the position of the first match, null
 * otherwise. Plan bubbles are not deduped here — beat IDs are unique
 * per draft and commitProposal owns the write.
 */
function findExistingIdeaBubblePos(editor: Editor, ideaId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (
      node.type.name === 'thoughtBubble' &&
      node.attrs.source === 'idea' &&
      node.attrs.ideaId === ideaId
    ) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

export function EditorContextProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  const insertThoughtBubble = useCallback(
    (attrs: ThoughtBubbleAttrs): InsertThoughtBubbleResult => {
      if (!editor) return { ok: false, reason: 'no_editor' };

      if (attrs.source === 'idea' && attrs.ideaId) {
        const existing = findExistingIdeaBubblePos(editor, attrs.ideaId);
        if (existing !== null) {
          const dom = editor.view.nodeDOM(existing) as HTMLElement | null;
          if (dom && typeof dom.scrollIntoView === 'function') {
            dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          return { ok: true, inserted: true };
        }
      }

      editor.chain().focus().insertThoughtBubble(attrs).run();
      return { ok: true, inserted: true };
    },
    [editor]
  );

  return (
    <EditorCtx.Provider value={{ editor, setEditor, insertThoughtBubble }}>
      {children}
    </EditorCtx.Provider>
  );
}

export function useEditorContext(): EditorCtxValue {
  const ctx = useContext(EditorCtx);
  if (!ctx) {
    throw new Error(
      'useEditorContext must be used inside <EditorContextProvider>'
    );
  }
  return ctx;
}
