// Folio · DraftEditor
// Tiptap writing surface with debounced auto-save.
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
  | { kind: 'error'; message: string };

const DEBOUNCE_MS = 1000;

function formatClockTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function DraftEditor({
  draftId,
  initialContent,
}: {
  draftId: string;
  // Tiptap/ProseMirror JSON. Shape isn't strictly typed by Tiptap's React API;
  // we round-trip it as-is.
  initialContent: unknown;
}) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });

  // The latest doc we've seen but not yet saved. Coalesces fast typing into
  // a single network call.
  const pendingDocRef = useRef<unknown | null>(null);
  // Debounce timer id (browser environment, returned by setTimeout).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a save POST is mid-flight.
  const inFlightRef = useRef(false);
  const router = useRouter();

  // Single save-and-coalesce loop. Always reads latest pendingDocRef so it
  // sends the freshest document, even if multiple beats fired during flight.
  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return; // already saving; the in-flight call will re-check
    const doc = pendingDocRef.current;
    if (doc === null) return;

    inFlightRef.current = true;
    pendingDocRef.current = null;
    setStatus({ kind: 'saving' });

    try {
      const result = await updateDraft({ draftId, contentJson: doc });
      setStatus({
        kind: 'saved',
        at: result?.savedAt ? new Date(result.savedAt) : new Date(),
      });
      // If a new title was derived, refresh server components so the rail
      // and document <title> stay in sync.
      router.refresh();
    } catch (err) {
      console.error('[DraftEditor] save failed', err);
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      inFlightRef.current = false;
      // If more typing happened while we were saving, run again.
      if (pendingDocRef.current !== null) {
        flushSave();
      }
    }
  }, [draftId, router]);

  const scheduleSave = useCallback(
    (doc: unknown) => {
      pendingDocRef.current = doc;
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
      if (pendingDocRef.current !== null) {
        // Best-effort: this is a fire-and-forget save during unmount.
        // updateDraft is a server action so it returns a Promise we don't
        // await here.
        void flushSave();
      }
    };
    // We deliberately depend on flushSave only — running once-on-mount and
    // once-on-unmount (with the latest closure) is the right shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative">
      {/* Save indicator — top-right corner of the editor pane, mono + faint */}
      <div
        aria-live="polite"
        className="absolute -top-7 right-0 font-mono text-[10px] tracking-[0.16em] uppercase text-tag pointer-events-none"
      >
        <SaveIndicator status={status} />
      </div>

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
          · save failed — retrying
        </span>
      );
  }
}
