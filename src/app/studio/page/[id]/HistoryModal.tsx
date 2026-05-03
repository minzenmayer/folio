// Folio · HistoryModal
// Sprint 6 wave 3: time-travel for The Page. Lists the most recent 50
// draft_versions snapshots; each row offers a click-to-confirm Restore
// button. Restoring is non-destructive — it spawns a new linear
// `source='restore'` row and updates the draft to that content.
//
// UI shape: full-screen overlay (modal). Click outside or press Escape
// to close. Versions are listed chronologically (newest first) with a
// glyph + timestamp + first-line preview.
//
// Restore flow:
//   1. User clicks Restore → button flips to "Click to confirm".
//   2. Second click fires the server action.
//   3. Server creates a new version row (source='restore'), updates the
//      draft, returns the new version + content.
//   4. Client calls editor.commands.setContent(content) and closes the
//      modal. router.refresh() picks up the new draft.version on next
//      render so DraftEditor's initialVersion catches up.
//
// Known caveat: between the restore and the refresh landing, DraftEditor's
// versionRef is one behind. Typing immediately after restore may produce
// a conflict, which is recoverable via the conflict banner (Keep mine).
// Future polish: pass key={draft.version} to DraftEditor for clean remount.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Editor } from '@tiptap/react';
import {
  listDraftVersions,
  restoreDraftVersion,
  type DraftVersionRow,
} from '../actions';

const SOURCE_GLYPHS: Record<string, string> = {
  autosave: '·',
  manual: '⏵',
  restore: '↻',
};

const SOURCE_LABELS: Record<string, string> = {
  autosave: 'autosave',
  manual: 'manual',
  restore: 'restore',
};

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Walk a Tiptap JSON doc and pull the first ~140 chars of plain text for
// the preview snippet. Cheap enough for a 50-row list.
function previewText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const stack: any[] = [doc];
  let out = '';
  while (stack.length && out.length < 200) {
    const node = stack.shift();
    if (!node) continue;
    if (node.type === 'text' && typeof node.text === 'string') {
      out += node.text + ' ';
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) stack.push(child);
    }
  }
  return out.trim().slice(0, 140);
}

export function HistoryModal({
  draftId,
  editor,
  onClose,
}: {
  draftId: string;
  editor: Editor;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<DraftVersionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listDraftVersions({ draftId });
        if (!cancelled) setVersions(rows);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load history');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleRestoreClick = useCallback(
    async (versionId: string) => {
      if (confirmingId !== versionId) {
        setConfirmingId(versionId);
        setTimeout(() => {
          setConfirmingId((prev) => (prev === versionId ? null : prev));
        }, 4000);
        return;
      }

      setRestoring(versionId);
      try {
        const result = await restoreDraftVersion({ draftId, versionId });
        editor.commands.setContent(result.content as any, false);
        router.refresh();
        onClose();
      } catch (err) {
        console.error('[HistoryModal] restore failed', err);
        setRestoring(null);
        setConfirmingId(null);
        setLoadError(err instanceof Error ? err.message : 'Restore failed');
      }
    },
    [confirmingId, draftId, editor, onClose, router]
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Draft history"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-10"
      onClick={onClose}
    >
      <div
        className="bg-paper border border-rule rounded-[3px] max-w-[640px] w-full max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 pt-5 pb-4 border-b border-rule flex items-baseline justify-between">
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-1">
              ▸ History
            </div>
            <p className="font-serif italic text-[13px] text-tag">
              The recent trail of this draft. Restore is non-destructive — it
              spawns a new entry on top.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-sans text-[11px] tracking-[0.18em] uppercase text-tag hover:text-accent transition-colors"
            aria-label="Close history"
          >
            close ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loadError && (
            <div className="px-6 py-5 font-serif italic text-[14px] text-accent">
              {loadError}
            </div>
          )}

          {!loadError && versions === null && (
            <div className="px-6 py-8 font-serif italic text-[14px] text-tag">
              Loading history…
            </div>
          )}

          {!loadError && versions !== null && versions.length === 0 && (
            <div className="px-6 py-8 font-serif italic text-[14px] text-tag">
              No saved versions yet. As you write, snapshots appear here.
            </div>
          )}

          {!loadError && versions !== null && versions.length > 0 && (
            <ul>
              {versions.map((v) => {
                const isConfirming = confirmingId === v.id;
                const isRestoring = restoring === v.id;
                const preview = previewText(v.contentJson);
                return (
                  <li
                    key={v.id}
                    className="px-6 py-4 border-b border-rule last:border-b-0"
                  >
                    <div className="flex items-baseline justify-between gap-4 mb-1">
                      <div className="flex items-baseline gap-3 min-w-0">
                        <span
                          className="font-mono text-[12px] text-accent flex-shrink-0"
                          aria-label={SOURCE_LABELS[v.source] ?? v.source}
                          title={SOURCE_LABELS[v.source] ?? v.source}
                        >
                          {SOURCE_GLYPHS[v.source] ?? '·'}
                        </span>
                        <span className="font-mono text-[11px] tracking-[0.04em] text-ink-soft whitespace-nowrap">
                          {formatStamp(v.createdAt)}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-tag">
                          {SOURCE_LABELS[v.source] ?? v.source}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRestoreClick(v.id)}
                        disabled={isRestoring}
                        className={`font-sans text-[10px] tracking-[0.18em] uppercase transition-colors disabled:opacity-40 flex-shrink-0 ${
                          isConfirming
                            ? 'text-accent hover:text-ink'
                            : 'text-tag hover:text-accent'
                        }`}
                      >
                        {isRestoring
                          ? 'Restoring…'
                          : isConfirming
                            ? 'Click to confirm'
                            : 'Restore'}
                      </button>
                    </div>
                    {preview && (
                      <p className="font-serif italic text-[14px] text-ink-soft leading-[1.5] mt-1.5">
                        {preview}
                        {preview.length >= 140 ? '…' : ''}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
