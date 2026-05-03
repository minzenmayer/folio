// Folio · DraftEditor
// Tiptap writing surface with debounced auto-save and optimistic-concurrency
// conflict handling.
//
// Design principles:
//   · Editorial — Fraunces for body, generous line-height, no chrome.
//   · Calm — the only state we surface is "saving" / "saved at HH:MM".
//     Everything else (toolbars, counts, "format" buttons) is omitted by design.
//   · Trustworthy — never lose a keystroke. Force-save on blur and Cmd/Ctrl+S.
//
// Save model: 1s debounce after last keystroke. If a save is in flight when a
// new beat fires, we coalesce — only the latest doc gets sent. We also force
// a flush on blur and on the Cmd/Ctrl+S keybind.
//
// Concurrency (Sprint 6 wave 1): we send `expectedVersion` with every save.
// The server gates its UPDATE on it and returns `{conflict: true, currentDoc,
// currentVersion, ...}` if another tab/device bumped first. On conflict we
// suspend the save loop and surface a calm banner — the user picks Reload
// (replace editor with the server's version) or Keep mine (overwrite, using
// the freshest server version as the new expectedVersion).

'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateDraft } from './actions';

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string }
  | { kind: 'conflict' };

type ConflictState = {
  currentDoc: unknown;
  currentVersion: number;
  currentTitle: string | null;
  currentUpdatedAt: string;
};

const DEBOUNCE_MS = 1000;

function formatClockTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function DraftEditor({
  draftId,
  initialContent,
  initialVersion,
}: {
  draftId: string;
  // Tiptap/ProseMirror JSON. Shape isn't strictly typed by Tiptap's React API;
  // we round-trip it as-is.
  initialContent: unknown;
  // Optimistic-concurrency token for this draft. Bumped after every save.
  initialVersion: number;
}) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  // The latest doc we've seen but not yet saved. Coalesces fast typing into
  // a single network call.
  const pendingDocRef = useRef<unknown | null>(null);
  // Debounce timer id (browser environment, returned by setTimeout).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a save POST is mid-flight.
  const inFlightRef = useRef(false);
  // Latest version we know the server has accepted. Bumped after each
  // successful save; reset on conflict resolution.
  const versionRef = useRef<number>(initialVersion);
  // Mirror of conflict state so closures inside flushSave see latest value
  // without re-binding on every render.
  const conflictRef = useRef<ConflictState | null>(null);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  const router = useRouter();

  // Single save-and-coalesce loop. Always reads latest pendingDocRef so it
  // sends the freshest document, even if multiple beats fired during flight.
  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return; // already saving; the in-flight call will re-check
    if (conflictRef.current) return; // suspended until user resolves
    const doc = pendingDocRef.current;
    if (doc === null) return;

    inFlightRef.current = true;
    pendingDocRef.current = null;
    setStatus({ kind: 'saving' });

    try {
      const result = await updateDraft({
        draftId,
        expectedVersion: versionRef.current,
        contentJson: doc,
      });

      if (!result.ok) {
        // Concurrent edit detected (the only failure variant). Don't bump
        // versionRef; surface the banner and stash the user's local doc back
        // into pendingDocRef so "Keep mine" can flush it after they resolve.
        // Narrowing note: a single `!result.ok` is necessary AND sufficient
        // for TS to narrow `result` to the conflict variant in this branch
        // and to the success variant after the return. Adding a redundant
        // `&& result.conflict` collapses the post-return narrowing back to
        // the union (TS doesn't simplify "ok || !conflict") and breaks the
        // success path's `result.version` access. Keep it as the single test.
        pendingDocRef.current = doc;
        setConflict({
          currentDoc: result.currentDoc,
          currentVersion: result.currentVersion,
          currentTitle: result.currentTitle,
          currentUpdatedAt: result.currentUpdatedAt,
        });
        setStatus({ kind: 'conflict' });
        return;
      }

      // Success — bump our token, surface the timestamp, refresh server
      // components so the rail title and <title> stay in sync.
      versionRef.current = result.version;
      setStatus({
        kind: 'saved',
        at: result.savedAt ? new Date(result.savedAt) : new Date(),
      });
      router.refresh();
    } catch (err) {
      console.error('[DraftEditor] save failed', err);
      // Restore the doc so the next typing beat (or a future retry) tries
      // again. Without this, a failed save would silently drop the user's
      // most recent paragraph.
      if (pendingDocRef.current === null) {
        pendingDocRef.current = doc;
      }
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      inFlightRef.current = false;
      // If more typing happened while we were saving, run again — but only
      // if we're not in a conflict.
      if (pendingDocRef.current !== null && !conflictRef.current) {
        flushSave();
      }
    }
  }, [draftId, router]);

  const scheduleSave = useCallback(
    (doc: unknown) => {
      pendingDocRef.current = doc;
      if (conflictRef.current) {
        // Autosave is suspended until the user resolves the banner. We still
        // capture their typing into pendingDocRef so "Keep mine" picks up
        // the latest, but skip the debounce timer.
        return;
      }
      setStatus({ kind: 'dirty' });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushSave();
      }, DEBOUNCE_MS);
    },
    [flushSave]
  );

  const forceSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingDocRef.current !== null) {
      flushSave();
    }
  }, [flushSave]);

  const editor = useEditor({
    extensions: [StarterKit],
    // Avoid the SSR/CSR mismatch warning Tiptap emits in Next 15 — render only
    // after mount.
    immediatelyRender: false,
    content: initialContent ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: ({ editor: ed }) => {
      scheduleSave(ed.getJSON());
    },
    onBlur: () => {
      forceSave();
    },
    editorProps: {
      attributes: {
        class:
          'folio-prose focus:outline-none min-h-[60vh] font-serif text-[19px] leading-[1.65] text-ink',
        spellcheck: 'true',
      },
    },
  });

  // Cmd/Ctrl+S — force-save.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isSave =
        (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
      if (isSave) {
        e.preventDefault();
        forceSave();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [forceSave]);

  // On unmount: flush whatever's pending so navigating away doesn't lose work.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingDocRef.current !== null && !conflictRef.current) {
        // Best-effort: this is a fire-and-forget save during unmount.
        // updateDraft is a server action so it returns a Promise we don't
        // await here. Skip if a conflict is still unresolved — saving with
        // a known-stale version would just produce the same conflict.
        void flushSave();
      }
    };
    // We deliberately depend on flushSave only — running once-on-mount and
    // once-on-unmount (with the latest closure) is the right shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Conflict resolution ───────────────────────
  // Reload: take the server's version, replace editor content, drop pending.
  const handleReload = useCallback(() => {
    if (!conflict || !editor) return;
    editor.commands.setContent(conflict.currentDoc as any, false);
    versionRef.current = conflict.currentVersion;
    pendingDocRef.current = null;
    setConflict(null);
    setStatus({ kind: 'saved', at: new Date(conflict.currentUpdatedAt) });
    // Refresh server components so the rail picks up whatever the other
    // session changed (title, ordering).
    router.refresh();
  }, [conflict, editor, router]);

  // Keep mine: rebase onto the server's latest version, then push our doc.
  // This overwrites the other session's changes — by design, since the user
  // explicitly chose to. The rebase prevents an infinite conflict loop.
  const handleKeepMine = useCallback(() => {
    if (!conflict || !editor) return;
    versionRef.current = conflict.currentVersion;
    pendingDocRef.current = editor.getJSON();
    setConflict(null);
    setStatus({ kind: 'dirty' });
    // Trigger a save immediately rather than waiting for the next debounce.
    flushSave();
  }, [conflict, editor, flushSave]);

  return (
    <div className="relative">
      {/* Save indicator — top-right corner of the editor pane, mono + faint */}
      <div
        aria-live="polite"
        className="absolute -top-7 right-0 font-mono text-[10px] tracking-[0.16em] uppercase text-tag pointer-events-none"
      >
        <SaveIndicator status={status} />
      </div>

      {conflict && (
        <ConflictBanner
          conflict={conflict}
          onReload={handleReload}
          onKeepMine={handleKeepMine}
        />
      )}

      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div className="min-h-[60vh] font-serif italic text-tag">
          Loading editor…
        </div>
      )}
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  switch (status.kind) {
    case 'idle':
      return <span className="opacity-50">· ready</span>;
    case 'dirty':
      return <span className="opacity-70">· unsaved</span>;
    case 'saving':
      return <span className="text-accent">· saving</span>;
    case 'saved':
      return (
        <span className="opacity-80">
          · saved {formatClockTime(status.at)}
        </span>
      );
    case 'error':
      return (
        <span className="text-accent" title={status.message}>
          · save failed — will retry
        </span>
      );
    case 'conflict':
      return <span className="text-accent">· edited elsewhere</span>;
  }
}

function ConflictBanner({
  conflict,
  onReload,
  onKeepMine,
}: {
  conflict: ConflictState;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-8 border-2 border-accent rounded-[3px] bg-paper px-5 py-4"
    >
      <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-2">
        ▸ Edited elsewhere
      </div>
      <p className="font-serif text-[15px] leading-[1.55] text-ink-soft mb-3 max-w-[60ch]">
        This draft was changed in another tab or device at{' '}
        <span className="font-mono text-[12px] text-tag">
          {formatStamp(conflict.currentUpdatedAt)}
        </span>
        . Autosave is paused so you don't overwrite it by accident.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onReload}
          className="px-4 py-2 bg-ink text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:bg-accent transition-colors"
        >
          ⟳ Reload other version
        </button>
        <button
          type="button"
          onClick={onKeepMine}
          className="px-4 py-2 border border-rule text-ink font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:border-accent hover:text-accent transition-colors"
        >
          Overwrite with mine
        </button>
        <span className="font-serif italic text-[12px] text-tag ml-1">
          — overwriting replaces the other session's changes.
        </span>
      </div>
    </div>
  );
}
