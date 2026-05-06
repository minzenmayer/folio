// Thoughtbed · EditorEmptyState
//
// Phase 22 slice 1 (2026-05-06). The first thing the user sees on a
// blank draft. Centered greeting + chat input + four entry chips.
// Replaces the editor + chat-companion shell when the draft has no
// content yet.
//
// Modeled after Ghostbase's "Hello, [name] — what can I help you
// with?" empty state, observed live 2026-05-06. Adapted to
// Thoughtbed's wedge: the four chips are intent-shaped paths into
// the writing flow, not Ghostbase's domain chips.
//
// Slice 1 ships only the visual + transition — clicking a chip or
// submitting the input transitions to the normal layout. Slice 5
// wires each chip to seed the chat with a specific opener.

'use client';

import { useState } from 'react';

type EntryChip = {
  id: 'write' | 'find' | 'refine' | 'think';
  label: string;
  hint: string;
};

const CHIPS: ReadonlyArray<EntryChip> = [
  { id: 'write', label: 'Write a post', hint: "I'll ask which platform." },
  { id: 'find', label: 'Find a thought', hint: 'Surface from your Garden.' },
  { id: 'refine', label: 'Refine a draft', hint: 'Paste in something rough.' },
  { id: 'think', label: 'Just think', hint: 'Talk it out, no artifact.' },
];

export function EditorEmptyState({
  userName,
  onContinue,
}: {
  userName?: string | null;
  onContinue: (seed?: { kind: EntryChip['id']; text?: string }) => void;
}) {
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);

  const greeting = userName ? `Hello, ${userName}` : 'Hello';

  function handleSubmit() {
    if (composing) return;
    const value = text.trim();
    if (value.length === 0) return;
    onContinue({ kind: 'write', text: value });
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-0px)] px-6 py-12 bg-bg">
      <div className="w-full max-w-[640px] flex flex-col items-center gap-8 text-center">
        <div className="flex flex-col items-center gap-2">
          <SeedlingGlyph />
          <h1 className="font-sans text-[24px] font-medium text-ink leading-[1.2] m-0">
            {greeting}
          </h1>
          <h2 className="font-sans text-[28px] font-medium text-ink-soft leading-[1.2] m-0">
            What do you want to write?
          </h2>
        </div>

        <div className="w-full bg-paper border border-rule rounded-card shadow-soft px-4 py-3 flex items-end gap-2">
          <textarea
            rows={1}
            placeholder="Ask anything…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !composing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            className="flex-1 resize-none bg-transparent font-sans text-[15px] text-ink leading-[1.55] focus:outline-none placeholder:text-tag/70 max-h-[200px]"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={text.trim().length === 0}
            aria-label="Send"
            title="Send (Enter)"
            className="shrink-0 w-8 h-8 rounded-full bg-ink text-bg flex items-center justify-center hover:bg-accent transition-colors disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="6" y1="9.5" x2="6" y2="3" />
              <polyline points="3.5,5.5 6,3 8.5,5.5" />
            </svg>
          </button>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onContinue({ kind: chip.id })}
              className="group flex flex-col items-start gap-0.5 px-3.5 py-2 rounded-card border border-rule bg-paper hover:border-ink hover:bg-paper-2 transition-colors text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
            >
              <span className="font-sans text-[13px] font-medium text-ink leading-[1.2]">
                {chip.label}
              </span>
              <span className="font-sans text-[11.5px] text-tag leading-[1.3] group-hover:text-ink-soft">
                {chip.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SeedlingGlyph() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-glyph-hot"
    >
      <path d="M16 28V18" />
      <path d="M16 18C12 16 9 14 9 10C9 8 11 7 13 8C15 9 16 12 16 18Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M16 18C20 16 23 14 23 10C23 8 21 7 19 8C17 9 16 12 16 18Z" fill="currentColor" fillOpacity="0.18" />
      <line x1="11" y1="29" x2="21" y2="29" strokeWidth="1.4" />
    </svg>
  );
}
