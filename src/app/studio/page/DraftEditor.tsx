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
// A shadow has to be this much newer than the server's updatedAt before we
// assume it represents real unsaved work. Smaller deltas are typically the
// result of clock drift between writes and server-side timestamps.
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
    // Either localStorage is disabled (private mode in some browsers) or
    // the entry is corrupt. Either way, fall back to no shadow.
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
    // Quota exceeded, disabled storage, etc. Non-fatal — autosave still works.
    console.warn('[DraftEditor] shadow write failed', err);
  }
}

function clearShadow(draftId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(shadowKey(draftId));
  } catch {
    // Ignore — write paths already log; a failed clear is harmless.
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
}: {
  draftId: string;
  // Tiptap/ProseMirror JSON. Shape isn't strictly typed by Tiptap's React API;
  // we round-trip it as-is.
  initialContent: unknown;
  // Optimistic-concurrency token for this draft. Bumped after every save.
  initialVersion: number;
  // ISO string of the draft's updated_at on the server. Compared against the
  // localStorage shadow's savedAt to decide whether to surface recovery.
  initialUpdatedAt: string;
}) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);

  // The latest doc we've seen but not yet saved. Coalesces fast typing into
  // a single network call.
  const pendingDocRef = useRef<unknown | null>(null);
  // Debounce timer id for the typing-quiet-beat.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Backoff timer id for retries after save failures.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // navigator.onLine cache. Refs (not state) so flushSave's stable closure
  // can read the latest value.
  const onlineRef = useRef(true);
  // Consecutive save failures since the last success. Resets on success and
  // on user-initiated fresh attempts (Keep-mine, reconnect).
  const retryCountRef = useRef(0);

  const router = useRouter();

  // Single save-and-coalesce loop. Always reads latest pendingDocRef so it
  // sends the freshest document, even if multiple beats fired during flight.
  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return; // already saving; the in-flight call will re-check
    if (conflictRef.current) return; // suspended until user resolves
    if (!onlineRef.current) return; // wait for reconnect; queue stays in pendingDocRef
    const doc = pendingDocRef.current;
    if (doc === null) return;

    // Cancel any pending retry — this fresh attempt supersedes it.
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

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

      // Success — bump our token, clear retry state, drop the shadow (the
      // server now matches), surface the timestamp, refresh server components
      // so the rail title and <title> stay in sync.
      versionRef.current = result.version;
      retryCountRef.current = 0;
      clearShadow(draftId);
      setStatus({
        kind: 'saved',
        at: result.savedAt ? new Date(result.savedAt) : new Date(),
      });
      router.refresh();
    } catch (err) {
      console.error('[DraftEditor] save failed', err);
      // Restore the doc so retry / next typing beat picks it up. Without
      // this, a failed save would silently drop the user's most recent edit.
      if (pendingDocRef.current === null) {
        pendingDocRef.current = doc;
      }

      const message = err instanceof Error ? err.message : 'Save failed';

      // If we went offline mid-save, the online-event listener will retry on
      // reconnect — surface "offline" rather than a hard failure.
      if (!onlineRef.current) {
        setStatus({ kind: 'offline' });
        return;
      }

      const attempt = retryCountRef.current + 1;
      if (attempt > MAX_RETRIES) {
        // Give up on the active retry chain; the next typing beat (or
        // explicit Cmd/Ctrl+S) will start a fresh attempt with a clean
        // counter. Keep the shadow — local data is still in localStorage.
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
      inFlightRef.current = false;
      // If more typing happened while we were saving, run again — but only
      // if we're online, not in a conflict, and not waiting on a retry.
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
      // Always write the shadow — local snapshot survives crashes/refreshes
      // even if the network's down or the save is still pending.
      writeShadow(draftId, doc, versionRef.current);

      if (conflictRef.current) {
        // Autosave is suspended until the user resolves the banner. We still
        // capture their typing into pendingDocRef so "Keep mine" picks up
        // the latest, but skip the debounce timer.
        return;
      }
      if (!onlineRef.current) {
        // Queue locally; will flush on reconnect.
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

  // Lock the editor while the recovery banner is up. If the user types into
  // the (still-visible) server content before deciding, their typing would
  // race the recovery doc and create ambiguity around Discard ("am I
  // dropping the original unsaved work, or the typing I just did?"). Making
  // the editor read-only forces a clean choice.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!recovery);
  }, [editor, recovery]);

  // Online/offline detection — adjusts the save loop's behavior in place.
  useEffect(() => {
    function onOnline() {
      onlineRef.current = true;
      // Reset retry chain — being offline is "fresh slate" for the next try.
      retryCountRef.current = 0;
      if (
        pendingDocRef.current !== null &&
        !conflictRef.current &&
        !inFlightRef.current
      ) {
        flushSave();
      } else {
        // Just clear the offline label if it was showing.
        setStatus((prev) => (prev.kind === 'offline' ? { kind: 'idle' } : prev));
      }
    }
    function onOffline() {
      onlineRef.current = false;
      // Cancel timers — they'd just bail anyway, but cleaner not to keep
      // them around firing every second.
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
    // flushSave is stable enough; we want once-on-mount, once-on-unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shadow recovery — runs once on mount. If the local shadow's savedAt
  // beats the server's updatedAt by more than SHADOW_TOLERANCE_MS, the user
  // has unsaved changes from a previous session that never made it to the
  // server. Surface the banner; let them choose Recover or Discard.
  useEffect(() => {
    const shadow = readShadow(draftId);
    if (!shadow) return;
    const serverTime = new Date(initialUpdatedAt).getTime();
    if (Number.isNaN(serverTime)) {
      // Defensive — initialUpdatedAt should always be a valid ISO from the
      // server, but if something's off, drop the shadow rather than risk a
      // false-positive recovery.
      clearShadow(draftId);
      return;
    }
    if (shadow.savedAt > serverTime + SHADOW_TOLERANCE_MS) {
      setRecovery({ doc: shadow.doc, savedAt: shadow.savedAt });
    } else {
      // Shadow is stale (server caught up or is ahead) — silently clear.
      clearShadow(draftId);
    }
    // Once-on-mount only; draftId/initialUpdatedAt don't change for a given mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On unmount: flush whatever's pending so navigating away doesn't lose work.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (
        pendingDocRef.current !== null &&
        !conflictRef.current &&
        onlineRef.current
      ) {
        // Best-effort: this is a fire-and-forget save during unmount.
        // Skip if a conflict is unresolved (saving with a known-stale
        // version would just produce the same conflict) or if we're offline
        // (the shadow has the data; next mount will surface recovery).
        void flushSave();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Conflict resolution ───────────────────────
  // Reload: take the server's version, replace editor content, drop pending
  // and shadow (the local copy is now stale).
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

  // Keep mine: rebase onto the server's latest version, then push our doc.
  // This overwrites the other session's changes — by design, since the user
  // explicitly chose to. The rebase prevents an infinite conflict loop.
  const handleKeepMine = useCallback(() => {
    if (!conflict || !editor) return;
    versionRef.current = conflict.currentVersion;
    pendingDocRef.current = editor.getJSON();
    retryCountRef.current = 0;
    setConflict(null);
    setStatus({ kind: 'dirty' });
    flushSave();
  }, [conflict, editor, flushSave]);

  // ─── Recovery resolution ───────────────────────
  // Recover: load the shadow's content into the editor, mark dirty, and
  // immediately flush. The successful save will clear the shadow.
  const handleRecover = useCallback(() => {
    if (!recovery || !editor) return;
    editor.commands.setContent(recovery.doc as any, false);
    pendingDocRef.current = recovery.doc;
    setRecovery(null);
    setStatus({ kind: 'dirty' });
    flushSave();
  }, [recovery, editor, flushSave]);

  // Discard: drop the shadow and let the editor stay on the server's content.
  const handleDiscard = useCallback(() => {
    clearShadow(draftId);
    setRecovery(null);
  }, [draftId]);

  return (
    <div className="relative">
      {/* Save indicator — top-right corner of the editor pane, mono + faint */}
      <div
        aria-live="polite"
        className="absolute -top-7 right-0 font-mono text-[10px] tracking-[0.16em] uppercase text-tag pointer-events-none"
      >
        <SaveIndicator status={status} />
      </div>

      {/* Recovery takes priority over conflict — if both exist, resolve
          recovery first (the user's local work) before deciding what to do
          about the server's competing version. */}
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
