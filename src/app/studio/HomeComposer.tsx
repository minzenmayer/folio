// Thoughtbed · HomeComposer
//
// Phase 23 v2 slice 1 (2026-05-06). The homepage's writing entry —
// a centered chat box with a mode dropdown and two path chips
// below it. Replaces the Phase 15b/16 Spar as the visible homepage
// composer; the existing Spar stays in the codebase for now and
// will retire when slice 4 wires the With-assistant chat surface
// for real.
//
// Two orthogonal selectors live here:
//   • mode dropdown — how the system behaves on submit:
//       'with-assistant' (default) — chat-based collaborative writing
//       'beside'                   — blank editor + thought bed pane
//       'self-driving'             — autonomous draft, deliberate opt-in
//   • path chips — what category of work:
//       'writing'  — sub-prompts: newsletter / LinkedIn / sermon / etc.
//       'ideation' — sub-prompts: brainstorm / search Garden / etc.
//
// Slice 1 wires state and visuals. Submit returns a placeholder —
// slices 4-7 wire each path × mode combination to its actual layout
// morph and submit handler.

'use client';

import { useEffect, useRef, useState } from 'react';

type Mode = 'with-assistant' | 'beside' | 'self-driving';
type Path = 'writing' | 'ideation';

const MODE_LABEL: Record<Mode, string> = {
  'with-assistant': 'With assistant',
  beside: 'Beside me',
  'self-driving': 'Self-driving',
};

const MODE_DESCRIPTION: Record<Mode, string> = {
  'with-assistant':
    'Chat-based writing. The system asks questions, surfaces ideas from your Garden, returns multi-option proposals. You steer.',
  beside:
    'A blank editor opens. The thought bed surfaces ideas as you write. You hold the pen.',
  'self-driving':
    'Autonomously take the next sensible step until done or blocked.',
};

const PATH_PLACEHOLDER: Record<'default' | Path, string> = {
  default: 'Ask anything, / for playbooks',
  writing: 'What would you like to write?',
  ideation: 'What are you thinking about?',
};

const WRITING_PROMPTS: ReadonlyArray<string> = [
  'Write a newsletter about…',
  'Write a LinkedIn post about…',
  'Write a sermon about…',
  'Write a blog post about…',
  'Refine this draft…',
  'More posts like my recent ones',
];

const IDEATION_PROMPTS: ReadonlyArray<string> = [
  'Help me brainstorm new content angles',
  'Search the Garden for ideas on…',
  "What topics haven't I covered yet?",
  'Connect two ideas I keep circling',
];

export function HomeComposer() {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('with-assistant');
  const [path, setPath] = useState<Path | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [placeholderResult, setPlaceholderResult] = useState<string | null>(
    null
  );
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Close the mode dropdown on outside click.
  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) {
      if (!modeMenuRef.current) return;
      if (!modeMenuRef.current.contains(e.target as Node)) {
        setModeOpen(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modeOpen]);

  // Auto-grow the textarea as the user types.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  function pickPath(next: Path) {
    setPath((prev) => (prev === next ? null : next));
  }

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Slice 1 placeholder. Slices 4-7 wire each path × mode combination.
    const pathLabel = path ?? 'default';
    setPlaceholderResult(
      `Slice 1 — would launch ${pathLabel} × ${mode}. Slices 4-7 wire each combination.`
    );
    setText('');
  }

  function fillPrompt(prompt: string) {
    setText(prompt);
    textareaRef.current?.focus();
  }

  const placeholder = PATH_PLACEHOLDER[path ?? 'default'];

  return (
    <div className="w-full max-w-[720px] mx-auto">
      <div className="rounded-card border border-rule bg-paper overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                !e.shiftKey
              ) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={placeholder}
            rows={1}
            className="w-full resize-none bg-transparent border-0 outline-none font-sans text-[15px] text-ink placeholder:text-tag leading-[1.5] min-h-[24px]"
          />
        </div>

        <div className="border-t border-rule px-3 py-2 flex items-center gap-2">
          <button
            type="button"
            aria-label="Attach"
            title="Attach (coming soon)"
            className="p-1.5 rounded-full text-tag hover:text-ink hover:bg-paper-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="7" y1="3" x2="7" y2="11" />
              <line x1="3" y1="7" x2="11" y2="7" />
            </svg>
          </button>

          <div ref={modeMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setModeOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={modeOpen}
              className="flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 hover:bg-paper-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
            >
              <FeatherGlyph />
              <span className="font-sans text-[12px] text-ink leading-none">
                {MODE_LABEL[mode]}
              </span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="text-tag"
              >
                <polyline points="2.5,3.8 5,6.3 7.5,3.8" />
              </svg>
            </button>

            {modeOpen && (
              <div
                role="menu"
                className="absolute bottom-full left-0 mb-2 min-w-[200px] rounded-card border border-rule bg-paper shadow-soft overflow-hidden z-10"
              >
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMode(m);
                      setModeOpen(false);
                    }}
                    title={MODE_DESCRIPTION[m]}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-paper-2 transition-colors ${
                      m === mode ? 'bg-paper-2' : ''
                    }`}
                  >
                    {m === 'with-assistant' ? (
                      <FeatherGlyph />
                    ) : m === 'beside' ? (
                      <BulbGlyph />
                    ) : (
                      <WandGlyph />
                    )}
                    <span className="font-sans text-[13px] text-ink leading-none">
                      {MODE_LABEL[m]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {path && (
            <PathBadge active={path} onClear={() => setPath(null)} />
          )}

          <div className="flex-1" />

          <button
            type="button"
            aria-label="Voice (coming soon)"
            title="Voice (coming soon)"
            className="p-1.5 rounded-full text-tag hover:text-ink transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="5.5" y="2" width="3" height="6.5" rx="1.5" />
              <path d="M3.5 7a3.5 3.5 0 0 0 7 0" />
              <line x1="7" y1="10.5" x2="7" y2="12.5" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            aria-label="Send"
            title="Send"
            disabled={text.trim().length === 0}
            className="p-1.5 rounded-full bg-ink text-paper hover:bg-ink-soft disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="7" y1="11" x2="7" y2="3" />
              <polyline points="3.5,6.5 7,3 10.5,6.5" />
            </svg>
          </button>
        </div>

        {path && (
          <div className="border-t border-rule">
            <ul>
              {(path === 'writing' ? WRITING_PROMPTS : IDEATION_PROMPTS).map(
                (prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      onClick={() => fillPrompt(prompt)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-paper-2 transition-colors text-left"
                    >
                      <SearchGlyph />
                      <span className="font-sans text-[13px] text-ink-soft leading-snug flex-1">
                        {prompt}
                      </span>
                      <ArrowOutGlyph />
                    </button>
                  </li>
                )
              )}
            </ul>
          </div>
        )}
      </div>

      {!path && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <PathChip
            value="writing"
            active={false}
            onClick={() => pickPath('writing')}
          />
          <PathChip
            value="ideation"
            active={false}
            onClick={() => pickPath('ideation')}
          />
        </div>
      )}

      {placeholderResult && (
        <p className="mt-6 text-center font-mono text-[11px] tracking-[0.18em] uppercase text-tag">
          {placeholderResult}
        </p>
      )}
    </div>
  );
}

function PathBadge({
  active,
  onClear,
}: {
  active: Path;
  onClear: () => void;
}) {
  const label = active === 'writing' ? 'Writing' : 'Ideation';
  const Icon = active === 'writing' ? PencilGlyph : BulbGlyph;
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Clear ${label} path`}
      aria-label={`Clear ${label} path`}
      className="flex items-center gap-1.5 rounded-full border border-rule bg-paper-2 px-2.5 py-1 hover:bg-paper-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
    >
      <Icon />
      <span className="font-sans text-[12px] text-ink leading-none">
        {label}
      </span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden="true"
        className="text-tag"
      >
        <line x1="3" y1="3" x2="7" y2="7" />
        <line x1="7" y1="3" x2="3" y2="7" />
      </svg>
    </button>
  );
}

function PathChip({
  value,
  active,
  onClick,
}: {
  value: Path;
  active: boolean;
  onClick: () => void;
}) {
  const label = value === 'writing' ? 'Writing' : 'Ideation';
  const Icon = value === 'writing' ? PencilGlyph : BulbGlyph;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
        active
          ? 'bg-paper-2 text-ink border-rule'
          : 'bg-transparent text-tag border-rule hover:text-ink hover:bg-paper'
      }`}
    >
      <Icon />
      <span className="font-sans text-[13px] leading-none">{label}</span>
    </button>
  );
}

function FeatherGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 3.5 6 8.5l-2 2 1 1 2-2 5-5a1.5 1.5 0 0 0-1-2.5h-.5Z" />
      <line x1="6" y1="8.5" x2="9.5" y2="8.5" />
    </svg>
  );
}

function BulbGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 1.5a3.5 3.5 0 0 0-2 6.4V10h4V7.9a3.5 3.5 0 0 0-2-6.4Z" />
      <line x1="5.5" y1="11.5" x2="8.5" y2="11.5" />
      <line x1="6" y1="13" x2="8" y2="13" />
    </svg>
  );
}

function WandGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="11" x2="9" y2="5" />
      <path d="M9 2v2M11.5 3v1M11 5.5h1M10 7h1.5" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 11.5h2l7-7-2-2-7 7v2Z" />
      <line x1="9" y1="3" x2="11" y2="5" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-tag shrink-0"
    >
      <circle cx="6" cy="6" r="3.5" />
      <line x1="8.5" y1="8.5" x2="11" y2="11" />
    </svg>
  );
}

function ArrowOutGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-tag shrink-0"
    >
      <line x1="3" y1="8" x2="8" y2="3" />
      <polyline points="4,3 8,3 8,7" />
    </svg>
  );
}
