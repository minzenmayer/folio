// Thoughtbed · AddNoteInline — Phase 19.3 (2026-05-06)
//
// Tiny inline input on idea cards. Type a thought, press Enter,
// it gets appended to the idea's body. Lower friction than opening
// the expand surface. Useful for quick capture while browsing.
//
// Collapsed state: a small mono '+ Add note' button.
// Expanded state: a textarea + Save button. Esc collapses.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { appendToIdea } from './actions';

export function AddNoteInline({ ideaId }: { ideaId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [pending, start] = useTransition();
  const [savedFlash, setSavedFlash] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 30);
  }, [open]);

  function save() {
    const v = value.trim();
    if (v.length === 0) return;
    start(async () => {
      try {
        const res = await appendToIdea(ideaId, v);
        if (res.ok) {
          setValue('');
          setOpen(false);
          setSavedFlash(true);
          setTimeout(() => setSavedFlash(false), 1500);
          router.refresh();
        }
      } catch {
        // swallow — UI shows nothing on failure
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
      >
        {savedFlash ? '✓ saved' : '+ Add note'}
      </button>
    );
  }

  return (
    <div
      className="rounded-soft border border-rule bg-paper-2 px-3 py-2"
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            setValue('');
          }
        }}
        rows={2}
        placeholder="Add a thought to this idea — Enter to save."
        aria-label="Add a thought to this idea"
        disabled={pending}
        className="w-full resize-none bg-transparent font-sans text-[12.5px] leading-[1.5] text-ink placeholder:text-tag focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between mt-1 gap-2">
        <span className="font-mono text-[10px] tracking-[0.04em] text-tag">
          ⏎ save · Esc cancel
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              setValue('');
            }}
            className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              save();
            }}
            disabled={pending || value.trim().length === 0}
            className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-2.5 py-1 bg-ink text-bg hover:bg-ink-soft disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
