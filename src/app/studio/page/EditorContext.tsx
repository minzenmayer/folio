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

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/react';
import type { IdeaBubbleAttrs } from './IdeaBubbleExtension';

export type InsertIdeaBubbleResult =
  | { ok: true; inserted: true }
  // Fallback when there's no editor yet — the rail can still update its
  // own client-side 'pulled' set so the pill flips visually.
  | { ok: false; reason: 'no_editor' };

type EditorCtxValue = {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  /**
   * Phase 20 slice 5: insert an ideaBubble node ABOVE the current block,
   * OR scroll an existing bubble for the same ideaId into view if one
   * already lives in the doc. Returns ok:true once the editor has done
   * either of those.
   */
  insertIdeaBubble: (attrs: IdeaBubbleAttrs) => InsertIdeaBubbleResult;
};

const EditorCtx = createContext<EditorCtxValue | null>(null);

/**
 * Walk the doc looking for an ideaBubble node whose ideaId matches.
 * Returns the position of the FIRST match (rare edge case: two bubbles
 * for the same idea — shouldn't happen, but if it does we land on the
 * earlier one). Null when no match.
 */
function findExistingBubblePos(editor: Editor, ideaId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'ideaBubble' && node.attrs.ideaId === ideaId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Provider for the editor instance. Wrap the part of the route tree that
 * needs to read or write the live editor (typically the route's grid).
 *
 * Keep the provider as close to its consumers as possible — the lifetime
 * of the editor instance equals the lifetime of the wrapped subtree.
 */
export function EditorContextProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  const insertIdeaBubble = useCallback(
    (attrs: IdeaBubbleAttrs): InsertIdeaBubbleResult => {
      if (!editor) return { ok: false, reason: 'no_editor' };

      const existing = findExistingBubblePos(editor, attrs.ideaId);
      if (existing !== null) {
        // Already in the doc — focus + scroll into view, don't duplicate.
        const dom = editor.view.nodeDOM(existing) as HTMLElement | null;
        if (dom && typeof dom.scrollIntoView === 'function') {
          dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return { ok: true, inserted: true };
      }

      editor.chain().focus().insertIdeaBubble(attrs).run();
      return { ok: true, inserted: true };
    },
    [editor]
  );

  return (
    <EditorCtx.Provider value={{ editor, setEditor, insertIdeaBubble }}>
      {children}
    </EditorCtx.Provider>
  );
}

/**
 * Hook to read the shared editor. Throws if used outside the provider —
 * we want the misuse to be loud rather than silently producing dead refs.
 */
export function useEditorContext(): EditorCtxValue {
  const ctx = useContext(EditorCtx);
  if (!ctx) {
    throw new Error(
      'useEditorContext must be used inside <EditorContextProvider>'
    );
  }
  return ctx;
}
