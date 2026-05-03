// Thoughtbed · Composer (Sprint 12)
//
// The writing-first entry on /studio. Sprint 12 replaces the old
// data-shape modes (Draft / Idea / Plant) with intent-driven modes that
// match how the user actually writes:
//
//   · Newsletter (default) — "Write a newsletter on…" → seeded draft with
//     the typed topic as the H1, redirect into the editor.
//   · LinkedIn — "Write a LinkedIn post on…" → body-only draft (no H1)
//     with a soft 3000-char target counter.
//   · Ideas — query interface, NOT a draft creator. Three preset prompts
//     plus an inline semantic search over the user's ideas.
//   · Self-pilot — "Open a blank page." Empty draft; the garden rail
//     starts dormant. Honours "sometimes I just want to write".
//
// The current composeNew() server action grew a richer mode discriminator;
// Ideas mode is a separate exploreIdeas({ intent, query }) action that
// returns ranked items rather than creating anything.
//
// Cmd/Ctrl+Enter submits in newsletter / linkedin / self-pilot modes. The
// button is disabled while empty (newsletter / linkedin) or in flight,
// so accidental empty submits don't ping the server.
//
// Aesthetic: rounded-card outer (~14px), generous internal padding, mode
// pills as rounded-full pill toggles. The textarea is the hero.

'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  composeNew,
  exploreIdeas,
  type ExploredIdea,
  type ExploreIdeasResult,
} from './actions';

export type ComposerMode = 'newsletter' | 'linkedin' | 'ideas' | 'self-pilot';

type IdeasIntent = 'untouched' | 'mature' | 'search';

const MODE_DEFS: Array<{
  id: ComposerMode;
  label: string;
  glyph: string;
  hint: string;
}> = [
  {
    id: 'newsletter',
    label: 'Newsletter',
    glyph: '✉',
    hint: 'a draft scaffolded with your topic as the title',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    glyph: '⊟',
    hint: 'a body-only draft with a soft 3000-char target',
  },
  {
    id: 'ideas',
    label: 'Ideas',
    glyph: '▸',
    hint: 'explore what your bed already holds — no draft created',
  },
  {
    id: 'self-pilot',
    label: 'Self-pilot',
    glyph: '○',
    hint: 'a blank page; the garden stays asleep',
  },
];

const PLACEHOLDER: Record<Exclude<ComposerMode, 'ideas'>, string> = {
  newsletter: 'Write a newsletter on…',
  linkedin: 'Write a LinkedIn post on…',
  'self-pilot': "Open a blank page. (Optional: drop a one-line note to start with.)",
};

const SUBMIT_LABEL: Record<Exclude<ComposerMode, 'ideas'>, string> = {
  newsletter: 'Start newsletter',
  linkedin: 'Start post',
  'self-pilot': 'Open blank',
};

const IDEA_PRESETS: Array<{
  id: IdeasIntent;
  label: string;
  glyph: string;
}> = [
  {
    id: 'untouched',
    label: "What's something I haven't written about?",
    glyph: '◌',
  },
  {
    id: 'mature',
    label: 'What are some mature ideas I can write on?',
    glyph: '☘',
  },
  {
    id: 'search',
    label: 'Help me search through my ideas.',
    glyph: '⌕',
  },
];

const LINKEDIN_TARGET = 3000;

export function Composer({
  initialMode = 'newsletter',
}: {
  initialMode?: ComposerMode;
}) {
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const [text, setText] = useState('');
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Ideas-mode state. Kept here (not in a child) so the choice persists
  // when the user toggles back to Ideas after a detour into another mode.
  const [activePreset, setActivePreset] = useState<IdeasIntent | null>(null);
  const [ideaQuery, setIdeaQuery] = useState('');
  const [ideasResult, setIdeasResult] = useState<ExploreIdeasResult | null>(
    null
  );
  const [ideasPending, startIdeasTransition] = useTransition();

  // composeNew handles its own redirect; we just relay the trimmed text +
  // mode. Self-pilot accepts an empty submit (= just open a blank page).
  const submit = useCallback(() => {
    if (mode === 'ideas') return;
    const trimmed = text.trim();
    if (mode !== 'self-pilot' && trimmed.length === 0) return;
    startTransition(async () => {
      try {
        await composeNew({ text: trimmed, mode });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        // Next.js wraps redirect() in a special throw the runtime swallows.
        if (!/NEXT_REDIRECT/.test(message)) {
          console.error('[Composer] submit failed', err);
        }
      }
    });
  }, [text, mode]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isSubmit = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isSubmit) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  // Switching mode resets the per-mode state so previous text doesn't
  // bleed into the next one's textarea.
  function switchMode(next: ComposerMode) {
    if (next === mode) return;
    setMode(next);
    setText('');
    setActivePreset(null);
    setIdeaQuery('');
    setIdeasResult(null);
  }

  const isDraftMode =
    mode === 'newsletter' || mode === 'linkedin' || mode === 'self-pilot';
  const trimmed = text.trim();
  const canSubmit =
    isDraftMode &&
    !isPending &&
    (mode === 'self-pilot' || trimmed.length > 0);
  const charCount = text.length;

  return (
    <div className="bg-paper rounded-card border border-rule shadow-soft">
      {/* Mode pills */}
      <div
        role="tablist"
        aria-label="Compose mode"
        className="flex flex-wrap items-center gap-1.5 px-5 pt-5"
      >
        {MODE_DEFS.map((m) => {
          const selected = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => switchMode(m.id)}
              className={`font-sans text-[12px] font-medium rounded-full px-3 py-1.5 transition-colors ${
                selected
                  ? 'bg-ink text-bg'
                  : 'bg-transparent text-tag hover:bg-paper-2 hover:text-ink'
              }`}
            >
              <span className="mr-1.5" aria-hidden>
                {m.glyph}
              </span>
              {m.label}
            </button>
          );
        })}
      </div>

      {mode === 'ideas' ? (
        <IdeasPanel
          activePreset={activePreset}
          ideaQuery={ideaQuery}
          ideasResult={ideasResult}
          ideasPending={ideasPending}
          onPreset={(preset) => {
            setActivePreset(preset);
            setIdeasResult(null);
            if (preset !== 'search') {
              startIdeasTransition(async () => {
                try {
                  const res = await exploreIdeas({ intent: preset });
                  setIdeasResult(res);
                } catch (err) {
                  console.error('[Composer.ideas] failed', err);
                  setIdeasResult({
                    ok: false,
                    reason: 'error',
                    message:
                      err instanceof Error ? err.message : 'request failed',
                  });
                }
              });
            }
          }}
          onSearchChange={setIdeaQuery}
          onSearchSubmit={() => {
            const q = ideaQuery.trim();
            if (q.length === 0) return;
            startIdeasTransition(async () => {
              try {
                const res = await exploreIdeas({
                  intent: 'search',
                  query: q,
                });
                setIdeasResult(res);
              } catch (err) {
                console.error('[Composer.ideas-search] failed', err);
                setIdeasResult({
                  ok: false,
                  reason: 'error',
                  message:
                    err instanceof Error ? err.message : 'request failed',
                });
              }
            });
          }}
        />
      ) : (
        <DraftPanel
          mode={mode as Exclude<ComposerMode, 'ideas'>}
          text={text}
          setText={setText}
          textareaRef={textareaRef}
          onKeyDown={onKeyDown}
          submit={submit}
          canSubmit={canSubmit}
          isPending={isPending}
          charCount={charCount}
        />
      )}
    </div>
  );
}

// ─── Draft modes (newsletter / linkedin / self-pilot) ───────────────

function DraftPanel({
  mode,
  text,
  setText,
  textareaRef,
  onKeyDown,
  submit,
  canSubmit,
  isPending,
  charCount,
}: {
  mode: Exclude<ComposerMode, 'ideas'>;
  text: string;
  setText: (v: string) => void;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  submit: () => void;
  canSubmit: boolean;
  isPending: boolean;
  charCount: number;
}) {
  const meta = MODE_DEFS.find((m) => m.id === mode)!;
  const showCharCount = mode === 'linkedin';
  const overTarget = charCount > LINKEDIN_TARGET;

  return (
    <>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={mode === 'self-pilot' ? 3 : 5}
        placeholder={PLACEHOLDER[mode]}
        aria-label={`${meta.label} composer`}
        className="w-full resize-none bg-transparent px-6 pt-5 pb-3 font-serif text-[18px] leading-[1.6] text-ink placeholder:text-tag/80 placeholder:italic focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="font-serif italic text-[12px] text-tag flex-1 min-w-0 truncate">
          {meta.hint}
        </div>

        {showCharCount && (
          <div
            className={`font-mono text-[10px] tracking-[0.04em] ${
              overTarget ? 'text-accent' : 'text-tag'
            }`}
            aria-label="LinkedIn character target"
          >
            {charCount.toLocaleString()} / {LINKEDIN_TARGET.toLocaleString()}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="font-sans text-[12px] font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-accent disabled:bg-tag/40 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Sending…' : `⏎ ${SUBMIT_LABEL[mode]}`}
        </button>
      </div>

      <p className="px-6 pb-3 font-mono text-[10px] tracking-[0.04em] text-tag/70">
        ⌘+Enter to submit
      </p>
    </>
  );
}

// ─── Ideas mode ────────────────────────────────

function IdeasPanel({
  activePreset,
  ideaQuery,
  ideasResult,
  ideasPending,
  onPreset,
  onSearchChange,
  onSearchSubmit,
}: {
  activePreset: IdeasIntent | null;
  ideaQuery: string;
  ideasResult: ExploreIdeasResult | null;
  ideasPending: boolean;
  onPreset: (intent: IdeasIntent) => void;
  onSearchChange: (q: string) => void;
  onSearchSubmit: () => void;
}) {
  const router = useRouter();

  return (
    <div className="px-5 pt-4 pb-5">
      <p className="font-serif italic text-[14px] text-tag leading-[1.5] mb-4">
        Pick a question, or search by idea — nothing here creates a draft.
      </p>

      <div className="flex flex-col gap-2 mb-4">
        {IDEA_PRESETS.map((p) => {
          const active = p.id === activePreset;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id)}
              aria-pressed={active}
              className={`flex items-center gap-3 text-left rounded-soft border px-4 py-3 transition-colors ${
                active
                  ? 'border-accent bg-paper-2 text-ink'
                  : 'border-rule bg-paper hover:border-accent hover:bg-paper-2 text-ink-soft'
              }`}
            >
              <span
                className={`font-mono text-[14px] w-5 text-center shrink-0 ${
                  active ? 'text-accent' : 'text-tag'
                }`}
                aria-hidden
              >
                {p.glyph}
              </span>
              <span className="font-serif text-[15px] leading-[1.4]">
                {p.label}
              </span>
            </button>
          );
        })}
      </div>

      {activePreset === 'search' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSearchSubmit();
          }}
          className="flex items-center gap-2 mb-4"
        >
          <input
            type="text"
            value={ideaQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search ideas by what they're about…"
            className="flex-1 bg-paper-2 rounded-soft border border-rule px-3 py-2 font-serif text-[14px] text-ink placeholder:text-tag/80 placeholder:italic focus:outline-none focus:border-accent"
            aria-label="Search ideas"
          />
          <button
            type="submit"
            disabled={ideasPending || ideaQuery.trim().length === 0}
            className="font-sans text-[12px] font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-accent disabled:bg-tag/40 disabled:cursor-not-allowed transition-colors"
          >
            {ideasPending ? 'Searching…' : '⌕ Search'}
          </button>
        </form>
      )}

      <IdeasResultsBlock
        result={ideasResult}
        loading={ideasPending}
        activePreset={activePreset}
        onSelect={(idea) => router.push(`/studio/ideas/${idea.id}`)}
      />
    </div>
  );
}

function IdeasResultsBlock({
  result,
  loading,
  activePreset,
  onSelect,
}: {
  result: ExploreIdeasResult | null;
  loading: boolean;
  activePreset: IdeasIntent | null;
  onSelect: (idea: ExploredIdea) => void;
}) {
  if (loading) {
    return (
      <p className="font-serif italic text-[13px] text-tag leading-[1.5]">
        thinking<span className="opacity-60">…</span>
      </p>
    );
  }

  if (!result) {
    if (activePreset === 'search') {
      return (
        <p className="font-serif italic text-[13px] text-tag leading-[1.5]">
          Type a phrase to search your ideas semantically.
        </p>
      );
    }
    return null;
  }

  if (!result.ok) {
    return (
      <p className="font-serif italic text-[13px] text-accent leading-[1.5]">
        {result.message}
      </p>
    );
  }

  if (result.ideas.length === 0) {
    return (
      <p className="font-serif italic text-[13px] text-tag leading-[1.5]">
        Nothing surfaced. Try a different prompt or plant more seeds first.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5 mt-1">
      {result.ideas.map((idea) => (
        <li key={idea.id}>
          <button
            type="button"
            onClick={() => onSelect(idea)}
            className="w-full text-left rounded-soft px-3 py-2.5 hover:bg-paper-2 transition-colors group focus:outline-none focus:bg-paper-2"
          >
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-[10px] text-accent" aria-hidden>
                ▸
              </span>
              <span className="font-serif text-[14px] text-ink leading-[1.35] flex-1 truncate group-hover:text-accent transition-colors">
                {idea.title}
              </span>
              {typeof idea.similarity === 'number' && (
                <span className="font-mono text-[10px] text-tag tracking-[0.04em]">
                  {idea.similarity.toFixed(2)}
                </span>
              )}
              {idea.maturity && idea.maturity !== 'unknown' && (
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-tag whitespace-nowrap">
                  {idea.maturity}
                </span>
              )}
            </div>
            {idea.essence && (
              <p className="font-serif italic text-[12px] text-ink-soft leading-[1.4] mt-1 pl-6 line-clamp-2">
                {idea.essence}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
