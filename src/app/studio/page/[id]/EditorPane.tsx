// Folio · EditorPane
//
// Client wrapper for the editor + meta + history modal. The Tiptap editor
// instance is held in a shared Context (EditorContextProvider) so siblings
// further out in the route tree — most importantly the Sprint 8 Assistant
// rail — can read it and act on it (insertContent for "pull into draft").
//
// Phase 14a (2026-05-04): the static "first H1 IS the title" affordance
// got replaced with a dedicated <TitleInput> above <DraftEditor>. EditorPane
// now lifts the title state up so:
//   · TitleInput edits push to updateDraftTitle (debounced).
//   · DraftEditor body autosaves can REPORT an H1 auto-promote — when the
//     title slot was empty and the body started with an H1, the server
//     lifts the H1 text into the title and strips it from the body. We
//     update the local title state + show an inline notice so the user
//     understands what just happened.
//
// The version cursor (drafts.version, the optimistic-concurrency token)
// is a single ref shared between TitleInput and DraftEditor so a
// title-side save and a body-side save don't blow each other up.

'use client';

import { useEffect, useRef, useState } from 'react';
import { DraftEditor } from '../DraftEditor';
import { useEditorContext } from '../EditorContext';
import { DraftMeta } from './DraftMeta';
import { HistoryModal } from './HistoryModal';
import { TitleInput } from './TitleInput';

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

  // Lifted title state. TitleInput is controlled; H1 auto-promote from
  // DraftEditor pushes here.
  const [currentTitle, setCurrentTitle] = useState<string | null>(title);
  const [titlePromotionNotice, setTitlePromotionNotice] = useState(false);

  // Shared optimistic-concurrency cursor. Both TitleInput and DraftEditor
  // read+write this. DraftEditor's internal versionRef stays as the
  // canonical state; this ref forwards the same number so TitleInput sees
  // the same value without prop-drilling on every save.
  const versionRef = useRef<number>(initialVersion);
  const bodyInFlightRef = useRef(false);

  function handleH1Promoted(newTitle: string) {
    setCurrentTitle(newTitle);
    setTitlePromotionNotice(true);
    // Auto-fade the notice after 5s.
    setTimeout(() => setTitlePromotionNotice(false), 5000);
  }

  // Sync down if the server prop changes (e.g. after a router.refresh).
  // Only adopt the new title when our local state is null/empty so we
  // don't clobber a title the user is actively typing.
  useEffect(() => {
    if (!currentTitle && title && title.trim().length > 0) {
      setCurrentTitle(title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  return (
    <>
      <DraftMeta
        title={currentTitle}
        updatedAt={updatedAt}
        draftId={draftId}
        editor={editor}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <div className="mt-8">
        <TitleInput
          draftId={draftId}
          value={currentTitle}
          onChange={setCurrentTitle}
          versionRef={versionRef}
          bodyInFlightRef={bodyInFlightRef}
        />

        {titlePromotionNotice && (
          <p
            role="status"
            className="mt-1 font-mono text-[10px] tracking-[0.18em] uppercase text-tag"
          >
            · Title set from H1
          </p>
        )}
      </div>

      <div className="mt-6">
        <DraftEditor
          draftId={draftId}
          initialContent={initialContent}
          initialVersion={initialVersion}
          initialUpdatedAt={initialUpdatedAt}
          onEditorReady={setEditor}
          versionRef={versionRef}
          bodyInFlightRef={bodyInFlightRef}
          onTitleAutoPromoted={handleH1Promoted}
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
