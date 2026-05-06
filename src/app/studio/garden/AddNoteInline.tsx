// Thoughtbed · AddNoteInline — Phase 19.x (2026-05-06)
//
// Inline "Add your take" affordance for the idea expand surface.
// Collapsed by default as a link; click to reveal a textarea +
// submit button. The submit calls appendIdeaNote which folds the
// note into the body as a dated "Your take" section AND re-embeds
// the idea so the addition flows into retrieval, AND flips
// auto_claimed → claimed.
//
// Why inline (not a modal): the user said they wanted to add a tag
// or flair "in a way that's not just attaching something but it's
// logically embedding my edition into that idea card more." The
// inline shape keeps focus on the card; the dated section + re-embed
// is the logical embedding part.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { appendIdeaNote } from './actions';

type Props = {
  kind: 'idea' | 'extracted_idea';
  id: string;
};

export function AddNoteInline({ kind, id }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setError(null);
    start(async () => {
      try {
        const r = await appendIdeaNote({ kind, id, note: trimmed });
        if (r.ok) {
          setText('');
          setOpen(false);
          router.refresh();
        } else {
          setError(r.reason);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
      >
        + add your take
      </button>
    );
  }

  return (
    <div className="rounded-md border border-rule bg-paper-2 p-3">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag font-medium mb-2">
        Your take
      </div>
      <p className="font-sans text-[12px] text-ink-soft leading-[1.55] mb-2">
        Add your framing, a counterpoint, or a way to keep maturing this. Lands as a dated section in the body and folds into how the system finds this idea later.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What you'd add or push back on..."
        className="w-full min-h-[64px] font-sans text-[13px] p-2.5 rounded-md border border-rule bg-paper focus:outline-none focus:border-ink-soft"
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setOpen(false);
            setText('');
          }
        }}
      />
      <div className="flex gap-2 items-center mt-2 flex-wrap">
        <button
          type="button"
          onClick={submit}
          disabled={pending || text.trim().length === 0}
          className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-ink text-paper border border-ink disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add to idea'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setText('');
            setError(null);
          }}
          disabled={pending}
          className="font-sans text-[12px] text-tag hover:text-ink"
        >
          Cancel
        </button>
        {error && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-red-700">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
