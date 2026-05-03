// Thoughtbed · Composer
//
// The writing-first entry on /studio. Inspired by chat-style composers
// (Ghostbase, Linear's quick-create) but intentionally quieter — no
// playbooks, no slash menu, no model picker. Just: a greeting, a textarea,
// and three modes that pick where the typed thought lands.
//
// Modes:
//   · Draft  → new Tiptap doc, redirects into /studio/page/[id] to keep writing
//   · Idea   → first line = title, rest = essence; redirects into the orbit view
//   · Plant  → quick paste into the Inbox (capture); redirects to /studio/inbox
//
// Cmd/Ctrl+Enter submits. The button is disabled while empty or in flight,
// so accidental empty submits don't ping the server.

'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { composeNew } from './actions';

type Mode = 'draft' | 'idea' | 'plant';

const MODE_META: Record<
  Mode,
  { label: string; glyph: string; hint: string }
> = {
  draft: {
    label: 'Draft',
    glyph: '✎',
    hint: 'open the page and keep writing',
  },
  idea: {
    label: 'Idea',
    glyph: '▸',
    hint: 'plant it as a named idea you can mature',
  },
  plant: {
    label: 'Plant',
    glyph: '"',
    hint: 'drop it in the Inbox to file later',
  },
};

const PLACEHOLDER_BY_MODE: Record<Mode, string> = {
  draft:
    "Start writing. The first line will become the title. Cmd+Enter to open the page.",
  idea: "What's the idea? First line is the title; press return for the essence.",
  plant:
    "Paste a passage, a quote, a fragment. It lands in your Inbox to file when you're ready.",
};

export function Composer({ initialMode = 'draft' }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [text, setText] = useState('');
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    startTransition(async () => {
      try {
        await composeNew({ text: trimmed, mode });
      } catch (err) {
        // composeNew calls redirect() on success — Next surfaces a special
        // error that the runtime swallows. Real failures land here.
        const message = err instanceof Error ? err.message : 'unknown';
        // NEXT_REDIRECT is normal — anything else is worth logging.
        if (!/NEXT_REDIRECT/.test(message)) {
          console.error('[Composer] submit failed', err);
        }
      }
    });
  }, [text, mode]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isSubmit =
        (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isSubmit) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const meta = MODE_META[mode];
  const canSubmit = text.trim().length > 0 && !isPending;

  return (
    <div className="bg-paper border border-rule rounded-[3px]">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={5}
        placeholder={PLACEHOLDER_BY_MODE[mode]}
        aria-label="Compose"
        className="w-full resize-none bg-transparent px-6 pt-5 pb-3 font-serif text-[18px] leading-[1.6] text-ink placeholder:text-tag/80 placeholder:italic focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-rule">
        {/* Mode pills */}
        <div
          role="radiogroup"
          aria-label="Compose mode"
          className="flex items-center gap-1.5"
        >
          {(['draft', 'idea', 'plant'] as Mode[]).map((m) => {
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(m)}
                className={`font-mono text-[10px] tracking-[0.18em] uppercase rounded-full border px-3 py-1 transition-colors ${
                  selected
                    ? 'bg-accent text-bg border-accent'
                    : 'bg-paper-2 text-tag border-rule hover:border-accent hover:text-accent'
                }`}
              >
                <span className="mr-1.5" aria-hidden>
                  {MODE_META[m].glyph}
                </span>
                {MODE_META[m].label}
              </button>
            );
          })}
        </div>

        {/* Hint text — describes what the current mode will do */}
        <div className="font-serif italic text-[12px] text-tag flex-1 min-w-0 truncate">
          {meta.hint}
        </div>

        {/* Submit */}
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] px-4 py-2 bg-ink text-bg hover:bg-accent disabled:bg-tag/40 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Sending…' : `⏎ ${meta.label}`}
        </button>
      </div>

      <p className="px-6 pb-3 font-mono text-[10px] tracking-[0.04em] text-tag/70">
        ⌘+Enter to submit · Esc to clear
      </p>
    </div>
  );
}
