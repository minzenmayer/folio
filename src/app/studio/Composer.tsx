// Thoughtbed · Composer
//
// Sprint 14 brand pivot: Ghostbase shape — monochrome, no glyphs, system
// sans, mono-uppercase letterspaced labels for system actions.
//
// Modes (intent-driven, unchanged from Sprint 12):
//   · Newsletter (default) — seeded draft with topic as H1
//   · LinkedIn — body-only draft with 3000-char target counter
//   · Ideas — query interface, three preset prompts + search
//   · Self-pilot — blank page; rail starts dormant
//
// Cmd/Ctrl+Enter submits in newsletter / linkedin / self-pilot modes.

'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
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
  hint: string;
}> = [
  {
    id: 'newsletter',
    label: 'Newsletter',
    hint: 'A draft scaffolded with your topic as the title.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    hint: 'A body-only draft with a soft 3,000-character target.',
  },
  {
    id: 'ideas',
    label: 'Ideas',
    hint: 'Explore what Thoughtbed already holds — no draft created.',
  },
  {
    id: 'self-pilot',
    label: 'Self-pilot',
    hint: 'A blank page. Resonance stays quiet until you call for it.',
  },
];

const PLACEHOLDER: Record<Exclude<ComposerMode, 'ideas'>, string> = {
  newsletter: 'Write a newsletter on…',
  linkedin: 'Write a LinkedIn post on…',
  'self-pilot':
    'Open a blank page. (Optional: drop a one-line note to start with.)',
};

const SUBMIT_LABEL: Record<Exclude<ComposerMode, 'ideas'>, string> = {
  newsletter: 'Start newsletter',
  linkedin: 'Start post',
  'self-pilot': 'Open blank',
};

const IDEA_PRESETS: Array<{
  id: IdeasIntent;
  label: string;
}> = [
  {
    id: 'untouched',
    label: "What's something I haven't written about?",
  },
  {
    id: 'mature',
    label: 'What are some mature ideas I can write on?',
  },
  {
    id: 'search',
    label: 'Help me search through my ideas.',
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

  const [activePreset, setActivePreset] = useState<IdeasIntent | null>(null);
  const [ideaQuery, setIdeaQuery] = useState('');
  const [ideasResult, setIdeasResult] = useState<ExploreIdeasResult | null>(
    null
  );
  const [ideasPending, startIdeasTransition] = useTransition();

  const submit = useCallback(() => {
    if (mode === 'ideas') return;
    const trimmed = text.trim();
    if (mode !== 'self-pilot' && trimmed.length === 0) return;
    startTransition(async () => {
      try {
        await composeNew({ text: trimmed, mode });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
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
    <div className="bg-paper rounded-card border border-rule">
      {/* Mode pills — monochrome, sans-uppercase letterspaced */}
      <div
        role="tablist"
        aria-label="Compose mode"
        className="flex flex-wrap items-center gap-1 px-4 pt-4"
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
              className={`font-mono text-[11px] tracking-[0.16em] uppercase rounded-soft px-3 py-1.5 transition-colors ${
                selected
                  ? 'bg-ink text-bg'
                  : 'bg-transparent text-tag hover:bg-paper-2 hover:text-ink'
              }`}
            >
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
        className="w-full resize-none bg-transparent px-5 pt-4 pb-2 font-sans text-[16px] leading-[1.55] text-ink placeholder:text-tag focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-3 px-5 pb-4 pt-1">
        <div className="font-sans text-[12.5px] text-ink-soft flex-1 min-w-0 truncate">
          {meta.hint}
        </div>

        {showCharCount && (
          <div
            className={`font-mono text-[10px] tracking-[0.06em] ${
              overTarget ? 'text-ink' : 'text-tag'
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
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Sending…' : SUBMIT_LABEL[mode]}
        </button>
      </div>

      <p className="px-5 pb-3 font-mono text-[10px] tracking-[0.04em] text-tag">
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
    <div className="px-5 pt-3 pb-5">
      <p className="font-sans text-[13px] text-ink-soft leading-[1.5] mb-4">
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
              className={`text-left rounded-soft border px-4 py-3 transition-colors font-sans text-[14px] ${
                active
                  ? 'border-ink bg-paper-2 text-ink font-medium'
                  : 'border-rule bg-paper hover:border-ink/40 hover:bg-paper-2 text-ink-soft'
              }`}
            >
              {p.label}
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
            className="flex-1 bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
            aria-label="Search ideas"
          />
          <button
            type="submit"
            disabled={ideasPending || ideaQuery.trim().length === 0}
            className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
          >
            {ideasPending ? 'Searching…' : 'Search'}
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
      <p className="font-sans text-[13px] text-tag leading-[1.5]">
        Thinking…
      </p>
    );
  }

  if (!result) {
    if (activePreset === 'search') {
      return (
        <p className="font-sans text-[13px] text-tag leading-[1.5]">
          Type a phrase to search your ideas semantically.
        </p>
      );
    }
    return null;
  }

  if (!result.ok) {
    return (
      <p className="font-sans text-[13px] text-ink leading-[1.5]">
        {result.message}
      </p>
    );
  }

  if (result.ideas.length === 0) {
    return (
      <p className="font-sans text-[13px] text-tag leading-[1.5]">
        Nothing surfaced. Try a different prompt or capture more first.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1 mt-1">
      {result.ideas.map((idea) => (
        <li key={idea.id}>
          <button
            type="button"
            onClick={() => onSelect(idea)}
            className="w-full text-left rounded-soft px-3 py-2.5 hover:bg-paper-2 transition-colors group focus:outline-none focus:bg-paper-2"
          >
            <div className="flex items-baseline gap-3">
              <span className="font-sans text-[14px] text-ink leading-[1.35] flex-1 truncate group-hover:underline underline-offset-4 decoration-rule-strong">
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
              <p className="font-sans text-[12.5px] text-ink-soft leading-[1.4] mt-1 line-clamp-2">
                {idea.essence}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
