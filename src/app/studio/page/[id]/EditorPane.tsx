// Folio · EditorPane
// Client wrapper for the editor + meta + history modal. The Tiptap editor
// instance is held in a shared Context (EditorContextProvider) so siblings
// further out in the route tree — most importantly the Sprint 8 Assistant
// rail — can read it and act on it (insertContent for "pull into draft").
//
// Why context: prior to Sprint 8 the editor lived in local state here and
// was forwarded to direct children (DraftMeta, HistoryModal) via props.
// The Assistant rail is a sibling of EditorPane in the route grid, so it
// can't be reached by prop drilling. A tiny scoped context is the cleanest
// fix. EditorPane writes to the context (setEditor) and reads from it for
// its own children that need the live instance.

'use client';

import { useState } from 'react';
import { DraftEditor } from '../DraftEditor';
import { useEditorContext } from '../EditorContext';
import { DraftMeta } from './DraftMeta';
import { HistoryModal } from './HistoryModal';

export function EditorPane({
  draftId,
  initialContent,
  initialVersion,
  initialUpdatedAt,
  title,
  updatedAt,
}: {
  draftId: string;
  initialContent: unknown;
  initialVersion: number;
  initialUpdatedAt: string;
  title: string | null;
  updatedAt: Date | string | null;
}) {
  const { editor, setEditor } = useEditorContext();
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <>
      <DraftMeta
        title={title}
        updatedAt={updatedAt}
        draftId={draftId}
        editor={editor}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <div className="mt-10">
        <DraftEditor
          draftId={draftId}
          initialContent={initialContent}
          initialVersion={initialVersion}
          initialUpdatedAt={initialUpdatedAt}
          onEditorReady={setEditor}
        />
      </div>

      {historyOpen && editor && (
        <HistoryModal
          draftId={draftId}
          editor={editor}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}
