// Folio · EditorPane
// Client wrapper for the editor + meta + history modal. Owns the Tiptap
// editor instance via state so DraftMeta (exports, history toggle) and
// HistoryModal (restore action) can act on it without prop drilling.
//
// Why it exists: DraftMeta needs `editor.getJSON()` / `getHTML()` for
// exports, and HistoryModal needs `editor.commands.setContent` after a
// restore. Both are siblings of DraftEditor in the route, so the editor
// instance has to be lifted up. We use a local state slot rather than
// React Context — same effect, less ceremony.

'use client';

import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { DraftEditor } from '../DraftEditor';
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
  const [editor, setEditor] = useState<Editor | null>(null);
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
