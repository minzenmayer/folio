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

'use client';

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/react';

type EditorCtxValue = {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
};

const EditorCtx = createContext<EditorCtxValue | null>(null);

/**
 * Provider for the editor instance. Wrap the part of the route tree that
 * needs to read or write the live editor (typically the route's grid).
 *
 * Keep the provider as close to its consumers as possible — the lifetime
 * of the editor instance equals the lifetime of the wrapped subtree.
 */
export function EditorContextProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <EditorCtx.Provider value={{ editor, setEditor }}>
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
