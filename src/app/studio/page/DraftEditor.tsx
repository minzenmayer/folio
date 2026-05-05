// Folio · DraftEditor
// Tiptap writing surface with debounced auto-save, optimistic-concurrency
// conflict handling, retry/backoff, offline queue, and localStorage shadow
// recovery.
//
// Design principles:
//   · Editorial — Fraunces for body, generous line-height, no chrome.
//   · Calm — surface only what the user needs to know about.
//   · Trustworthy — never lose a keystroke. Force-save on blur and Cmd/Ctrl+S.
//
// Save model: 1s debounce after the last keystroke. Saves coalesce — if a
// save is in flight when a new beat fires, only the latest doc gets sent.
// Force-flush on blur and Cmd/Ctrl+S.
//
// Concurrency (S6 wave 1): expectedVersion sent with each save. Server gates
// WHERE on it; conflict response triggers a Reload / Keep-mine banner.
//
// Hardening (S6 wave 2):
//   · Retry with exponential backoff (1s → 2s → 4s, max 3 attempts) on
//     save failures. Fresh save attempts (typing, Keep-mine, reconnect)
//     reset the retry counter.
//   · Offline awareness via `navigator.onLine` + 'online'/'offline' events.
//     While offline, status shows "offline · queued" and saves are skipped
//     entirely; on reconnect we flush whatever's pending.
//   · localStorage shadow at key `folio:draft:{id}`. Every keystroke writes
//     `{doc, savedAt, version}` so a hard refresh during typing doesn't lose
//     work. On mount, if the shadow's savedAt beats the server's updatedAt
//     by more than SHADOW_TOLERANCE_MS, surface a "Recover unsaved changes"
//     banner with Recover / Discard buttons. Cleared on every successful
//     save and on Reload-other-version.
//
// S6 wave 3+4 hook:
//   · Optional `onEditorReady` callback exposes the live Tiptap editor
//     instance to the parent (EditorPane), which forwards it to DraftMeta
//     for exports and HistoryModal for restore-set-content.

'use client';

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Heading from '@tiptap/extension-heading';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateDraft } from './actions';

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'retrying'; attempt: number }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict' }
  | { kind: 'offline' };

type ConflictState = {
  currentDoc: unknown;
  currentVersion: number;
  currentTitle: string | null;
  currentUpdatedAt: string;
};

type RecoveryState = {
  doc: unknown;
  savedAt: number;
};

type ShadowEntry = {
  doc: unknown;
  savedAt: number;
  version: number;
};

const DEBOUNCE_MS = 1000;
const MAX_RETRIES = 3;
const SHADOW_TOLERANCE_MS = 1000;

function shadowKey(draftId: string): string {
  return `folio:draft:${draftId}`;
}

function readShadow(draftId: string): ShadowEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(shadowKey(draftId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'doc' in parsed &&
      'savedAt' in parsed &&
      'version' in parsed &&
      typeof (parsed as { savedAt: unknown }).savedAt === 'number' &&
      typeof (parsed as { version: unknown }).version === 'number'
    ) {
      return parsed as ShadowEntry;
    }
  } catch (err) {
    console.warn('[DraftEditor] shadow read failed', err);
  }
  return null;
}

function writeShadow(draftId: string, doc: unknown, version: number) {
  if (typeof window === 'undefined') return;
  try {
    const entry: ShadowEntry = { doc, savedAt: Date.now(), version };
    window.localStorage.setItem(shadowKey(draftId), JSON.stringify(entry));
  } catch (err) {
    console.warn('[DraftEditor] shadow write failed', err);
  }
}

function clearShadow(draftId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(shadowKey(draftId));
  } catch {
    // Ignore.
  }
}

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
  initialUpdatedAt,
  onEditorReady,
  versionRef: externalVersionRef,
  bodyInFlightRef,
  onTitleAutoPromoted,
}: {
  draftId: string;
  initialContent: unknown;
  initialVersion: number;
  initialUpdatedAt: string;
  // Optional callback the parent (EditorPane) uses to acquire the Tiptap
  // editor instance. Lets siblings (DraftMeta, HistoryModal) act on the
  // editor — exports, history-restore — without prop drilling or context.
  onEditorReady?: (editor: Editor | null) => void;
  // Phase 14a (2026-05-04): the version cursor (drafts.version, the
  // optimistic-concurrency token) is shared with TitleInput so a
  // title-side save and a body-side save stay in sync. When supplied
  // we mirror updates into both refs.
  versionRef?: React.MutableRefObject<number>;
  // Phase 14a: lets TitleInput back off while a body save is mid-flight.
  bodyInFlightRef?: React.MutableRefObject<boolean>;
  // Phase 14a: when the server reports titleSetFromH1, surface the
  // promoted title to the parent (EditorPane) so its TitleInput updates
  // and the inline notice can render.
  onTitleAutoPromoted?: (title: string) => void;
}) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);

  const pendingDocRef = useRef<unknown | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  // Phase 14a: prefer the parent's versionRef when supplied so the title
  // input and body editor share the same OCC cursor.
  const localVersionRef = useRef<number>(initialVersion);
  const versionRef = externalVersionRef ?? localVersionRef;
  const conflictRef = useRef<ConflictState | null>(null);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  const onlineRef = useRef(true);
  const retryCountRef = useRef(0);

  const router = useRouter();

  // Phase 14a: keep the parent-shared bodyInFlightRef in sync with our
  // own inFlightRef so TitleInput knows when to back off.
  const setInFlight = useCallback(
    (v: boolean) => {
      inFlightRef.current = v;
      if (bodyInFlightRef) bodyInFlightRef.current = v;
    },
    [bodyInFlightRef]
  );

  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return;
    if (conflictRef.current) return;
    if (!onlineRef.current) return;
    const doc = pendingDocRef.current;
    if (doc === null) return;

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    setInFlight(true);
    pendingDocRef.current = null;
    setStatus({ kind: 'saving' });

    try {
      const result = await updateDraft({
        draftId,
        expectedVersion: versionRef.current,
        contentJson: doc,
      });

      if (!result.ok) {
        // Single-test narrowing for the discriminated union; see S6 wave 1
        // bug fix commit. `&& result.conflict` would break the success-path
        // narrowing after the early return.
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

      versionRef.current = result.version;
      retryCountRef.current = 0;
      clearShadow(draftId);
      setStatus({
        kind: 'saved',
        at: result.savedAt ? new Date(result.savedAt) : new Date(),
      });
      // Phase 14a: H1 → title auto-promote. Server stripped the H1 from
      // the body and lifted its text into the title slot. Swap our
      // editor content to match (silent setContent so we don't loop on
      // onUpdate) and tell the parent to update its title state.
      if (result.titleSetFromH1 && result.contentJson) {
        if (editorRef.current) {
          editorRef.current.commands.setContent(
            result.contentJson as any,
            false
          );
        }
        if (onTitleAutoPromoted && result.title) {
          onTitleAutoPromoted(result.title);
        }
      }
      router.refresh();
    } catch (err) {
      console.error('[DraftEditor] save failed', err);
      if (pendingDocRef.current === null) {
        pendingDocRef.current = doc;
      }

      const message = err instanceof Error ? err.message : 'Save failed';

      if (!onlineRef.current) {
        setStatus({ kind: 'offline' });
        return;
      }

      const attempt = retryCountRef.current + 1;
      if (attempt > MAX_RETRIES) {
        retryCountRef.current = 0;
        setStatus({ kind: 'failed', message });
        return;
      }

      retryCountRef.current = attempt;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      setStatus({ kind: 'retrying', attempt });
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        flushSave();
      }, delay);
    } finally {
      setInFlight(false);
      if (
        pendingDocRef.current !== null &&
        !conflictRef.current &&
        onlineRef.current &&
        !retryTimerRef.current
      ) {
        flushSave();
      }
    }
  }, [draftId, router]);

  const scheduleSave = useCallback(
    (doc: unknown) => {
      pendingDocRef.current = doc;
      writeShadow(draftId, doc, versionRef.current);

      if (conflictRef.current) {
        return;
      }
      if (!onlineRef.current) {
        setStatus({ kind: 'offline' });
        return;
      }
      setStatus({ kind: 'dirty' });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushSave();
      }, DEBOUNCE_MS);
    },
    [draftId, flushSave]
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

  const editorRef = useRef<Editor | null>(null);
  // Phase 16 (2026-05-05): extend Heading to preserve data-tb-beat-id
  // and data-tb-beat-status attributes through save / load. The Plan
  // ribbon (slice 6) reads these attrs to compute pill fill states.
  // Without this extension, Tiptap drops unknown HTML attributes when
  // serializing to JSON. We override StarterKit's built-in Heading by
  // listing both — order matters; the explicit one takes precedence.
  const ThoughtbedHeading = Heading.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        'data-tb-beat-id': {
          default: null,
          parseHTML: (el) => el.getAttribute('data-tb-beat-id'),
          renderHTML: (attrs) => {
            if (!attrs['data-tb-beat-id']) return {};
            return { 'data-tb-beat-id': attrs['data-tb-beat-id'] };
          },
        },
        'data-tb-beat-status': {
          default: null,
          parseHTML: (el) => el.getAttribute('data-tb-beat-status'),
          renderHTML: (attrs) => {
            if (!attrs['data-tb-beat-status']) return {};
            return { 'data-tb-beat-status': attrs['data-tb-beat-status'] };
          },
        },
      };
    },
  });
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      ThoughtbedHeading,
    ],
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

  // Lock the editor while the recovery banner is up. See S6 wave 2 commit
  // for the full rationale.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!recovery);
  }, [editor, recovery]);

  // Expose the editor instance to the parent so siblings (DraftMeta,
  // HistoryModal) can call getJSON / getHTML / setContent without prop
  // drilling. Cleaned up on unmount so the parent doesn't hold a dead ref.
  useEffect(() => {
    editorRef.current = editor ?? null;
    if (!onEditorReady) return;
    onEditorReady(editor ?? null);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  // Online/offline detection.
  useEffect(() => {
    function onOnline() {
      onlineRef.current = true;
      retryCountRef.current = 0;
      if (
        pendingDocRef.current !== null &&
        !conflictRef.current &&
        !inFlightRef.current
      ) {
        flushSave();
      } else {
        setStatus((prev) => (prev.kind === 'offline' ? { kind: 'idle' } : prev));
      }
    }
    function onOffline() {
      onlineRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setStatus({ kind: 'offline' });
    }
    onlineRef.current = navigator.onLine;
    if (!navigator.onLine) {
      setStatus({ kind: 'offline' });
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shadow recovery on mount.
  useEffect(() => {
    const shadow = readShadow(draftId);
    if (!shadow) return;
    const serverTime = new Date(initialUpdatedAt).getTime();
    if (Number.isNaN(serverTime)) {
      clearShadow(draftId);
      return;
    }
    if (shadow.savedAt > serverTime + SHADOW_TOLERANCE_MS) {
      setRecovery({ doc: shadow.doc, savedAt: shadow.savedAt });
    } else {
      clearShadow(draftId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (
        pendingDocRef.current !== null &&
        !conflictRef.current &&
        onlineRef.current
      ) {
        void flushSave();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReload = useCallback(() => {
    if (!conflict || !editor) return;
    editor.commands.setContent(conflict.currentDoc as any, false);
    versionRef.current = conflict.currentVersion;
    pendingDocRef.current = null;
    retryCountRef.current = 0;
    clearShadow(draftId);
    setConflict(null);
    setStatus({ kind: 'saved', at: new Date(conflict.currentUpdatedAt) });
    router.refresh();
  }, [conflict, editor, router, draftId]);

  const handleKeepMine = useCallback(() => {
    if (!conflict || !editor) return;
    versionRef.current = conflict.currentVersion;
    pendingDocRef.current = editor.getJSON();
    retryCountRef.current = 0;
    setConflict(null);
    setStatus({ kind: 'dirty' });
    flushSave();
  }, [conflict, editor, flushSave]);

  const handleRecover = useCallback(() => {
    if (!recovery || !editor) return;
    editor.commands.setContent(recovery.doc as any, false);
    pendingDocRef.current = recovery.doc;
    setRecovery(null);
    setStatus({ kind: 'dirty' });
    flushSave();
  }, [recovery, editor, flushSave]);

  const handleDiscard = useCallback(() => {
    clearShadow(draftId);
    setRecovery(null);
  }, [draftId]);

  return (
    <div className="relative">
      <div
        aria-live="polite"
        className="absolute -top-7 right-0 font-mono text-[10px] tracking-[0.16em] uppercase text-tag pointer-events-none"
      >
        <SaveIndicator status={status} />
      </div>

      {recovery && !conflict && (
        <RecoveryBanner
          recovery={recovery}
          onRecover={handleRecover}
          onDiscard={handleDiscard}
        />
      )}

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
    case 'retrying':
      return (
        <span className="text-accent">
          · retrying ({status.attempt}/{MAX_RETRIES})
        </span>
      );
    case 'failed':
      return (
        <span className="text-accent" title={status.message}>
          · save failed — type to retry
        </span>
      );
    case 'conflict':
      return <span className="text-accent">· edited elsewhere</span>;
    case 'offline':
      return <span className="text-accent">· offline · queued</span>;
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

function RecoveryBanner({
  recovery,
  onRecover,
  onDiscard,
}: {
  recovery: RecoveryState;
  onRecover: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-8 border-2 border-accent rounded-[3px] bg-paper px-5 py-4"
    >
      <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-2">
        ▸ Unsaved changes
      </div>
      <p className="font-serif text-[15px] leading-[1.55] text-ink-soft mb-3 max-w-[60ch]">
        We found unsaved work on this device from{' '}
        <span className="font-mono text-[12px] text-tag">
          {formatStamp(new Date(recovery.savedAt).toISOString())}
        </span>
        . The server has an older version. Recover the unsaved work, or stick
        with what's saved?
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRecover}
          className="px-4 py-2 bg-ink text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:bg-accent transition-colors"
        >
          ⤴ Recover unsaved
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="px-4 py-2 border border-rule text-ink font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:border-accent hover:text-accent transition-colors"
        >
          Discard
        </button>
        <span className="font-serif italic text-[12px] text-tag ml-1">
          — discard drops the local copy permanently.
        </span>
      </div>
    </div>
  );
}
