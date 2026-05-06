// Thoughtbed · TitleInput (Phase 14a, 2026-05-04)
//
// Dedicated title input for The Page editor. Lives above the Tiptap body
// editor inside <EditorPane>. Replaces the previous "first H1 of the body
// IS the title" affordance, which conflated post-title with body-section
// headers ("WHY IT MATTERS" was being treated as the post title).
//
// Behavior:
//   · Controlled input bound to the parent's title state.
//   · Debounced (700ms after the last keystroke) auto-save via
//     updateDraftTitle. Force-flushes on blur.
//   · Empty string clears title back to null so a future first-H1 can
//     auto-promote.
//   · The version cursor is shared with the body editor via a ref the
//     parent owns. The body's expectedVersion ref is THE source of truth;
//     this input bumps it on every successful save.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateDraftTitle } from '../actions';

const DEBOUNCE_MS = 700;

export type TitleInputProps = {
  draftId: string;
  /** Current title (controlled). null/empty renders the placeholder. */
  value: string | null;
  /** Called on every keystroke so the parent can keep its state in sync. */
  onChange: (next: string) => void;
  /**
   * Live ref to the body editor's expectedVersion cursor. We READ before
   * each save (use whatever the body just bumped to) and WRITE after each
   * save (so the body's next save uses the version we bumped to here).
   */
  versionRef: React.MutableRefObject<number>;
  /** Set true while a body-side save is in flight to back off. */
  bodyInFlightRef: React.MutableRefObject<boolean>;
};

export function TitleInput({
  draftId,
  value,
  onChange,
  versionRef,
  bodyInFlightRef,
}: TitleInputProps) {
  const router = useRouter();
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>(
    'idle'
  );

  const pendingTitleRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    if (bodyInFlightRef.current) {
      // The body autosave is mid-flight — back off and try again on the
      // next debounce tick. Avoids a cross-action version race.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, 250);
      return;
    }
    const pending = pendingTitleRef.current;
    if (pending === null) return;

    inFlightRef.current = true;
    pendingTitleRef.current = null;
    setSavingState('saving');
    try {
      const res = await updateDraftTitle({
        draftId,
        expectedVersion: versionRef.current,
        title: pending,
      });
      if (res.ok) {
        versionRef.current = res.version;
        setSavingState('saved');
        // The router refresh propagates the new title into the URL bar
        // / breadcrumbs / draft list without a reload.
        router.refresh();
      } else {
        // Conflict — adopt the server's version cursor and re-queue our
        // title. Body editor's separate conflict UI handles the doc-side
        // race; we just stay in sync with the version.
        versionRef.current = res.currentVersion;
        pendingTitleRef.current = pending;
        setSavingState('idle');
      }
    } catch (err) {
      console.warn('[TitleInput] save failed', err);
      pendingTitleRef.current = pending;
      setSavingState('idle');
    } finally {
      inFlightRef.current = false;
      if (pendingTitleRef.current !== null) {
        flush();
      }
    }
  }, [draftId, router, versionRef, bodyInFlightRef]);

  function schedule(next: string) {
    pendingTitleRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, DEBOUNCE_MS);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    onChange(next);
    schedule(next);
  }

  function handleBlur() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingTitleRef.current !== null) {
      flush();
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <input
        type="text"
        value={value ?? ''}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Title. What's this about?"
        aria-label="Title"
        className="w-full bg-transparent border-none outline-none font-serif text-[clamp(28px,4vw,40px)] leading-[1.1] text-ink placeholder:italic placeholder:text-tag/60 placeholder:font-light focus:ring-0 px-0 py-1"
      />
      {savingState === 'saving' && (
        <span
          aria-live="polite"
          className="absolute -top-5 right-0 font-mono text-[10px] tracking-[0.16em] uppercase text-tag pointer-events-none"
        >
          · saving
        </span>
      )}
    </div>
  );
}
