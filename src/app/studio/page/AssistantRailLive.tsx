// Thoughtbed · GardenRail (live)
//
// The right pane on /studio/page/[id]. As the user writes, we debounce
// the editor's text, call findSimilar against captures + ideas + drafts,
// and surface the top hits as pull-able rows. Click "▸ Reflect" to ask
// Claude to weave them back into a 2-3 sentence reflection on what
// they're circling around.
//
// Sprint 10 renamed this from "AssistantRailLive" in copy — the word
// "Assistant" didn't fit. The file name is preserved to keep the import
// surface stable; the copy now reads as "the garden" everywhere.
//
// Sprint 12: takes a `mode` prop ('newsletter' | 'linkedin' | 'self-pilot'
// or undefined when opened outside the composer). Two effects:
//   · The reflect call is mode-aware so the reflection's voice matches
//     how the draft was started (newsletter voice / LinkedIn voice /
//     neutral when self-pilot or unspecified).
//   · Self-pilot starts the rail in a *dormant* state — no debounced
//     retrieval, no listening copy. The header carries a small toggle
//     to wake it up if/when the user wants the garden's company.
//
// Design tenets carried over from the rest of the bed:
//   · Garden, not assistant — retrieval is remembering; generation is
//     reflecting. Empty/sparse states should feel calm, not broken.
//   · Editorial restraint — Fraunces for content, JetBrains Mono for
//     system labels, single-character glyphs as decoration.
//   · Sacred saves — the rail is observational. It never blocks the
//     editor and never holds onto input focus.
//
// Pull behaviour: clicking a row inserts the source text into the editor
// at the current selection. Captures and drafts insert as a blockquote
// (you're working from words — your own past words count). Ideas insert
// as an H2 + a paragraph for the essence (you're picking up a thread of
// your own thinking).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { findSimilar, reflect, type SimilarHit } from '../actions';

const DEBOUNCE_MS = 1500;
const MIN_QUERY_CHARS = 12;
const MAX_QUERY_CHARS = 4000;
const RESULT_LIMIT = 6;

const KIND_GLYPH: Record<SimilarHit['kind'], string> = {
  capture: '"',
  idea: '▸',
  draft: '✎',
};

const KIND_LABEL: Record<SimilarHit['kind'], string> = {
  capture: 'capture',
  idea: 'idea',
  draft: 'draft',
};

export type GardenRailMode = 'newsletter' | 'linkedin' | 'self-pilot';

type Status =
  | { kind: 'idle' } // waiting for enough text
  | { kind: 'loading' }
  | { kind: 'ok'; hits: SimilarHit[]; basedOnChars: number }
  | { kind: 'empty'; basedOnChars: number }
  | { kind: 'error'; message: string };

type ReflectionState =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | {
      kind: 'ok';
      reflection: string;
      sources: SimilarHit[];
      basedOnChars: number;
    }
  | { kind: 'soft'; message: string } // too_short / no_text — friendly nudge
  | { kind: 'error'; message: string };

export function AssistantRailLive({
  draftId,
  mode,
}: {
  draftId: string;
  mode?: GardenRailMode;
}) {
  const { editor } = useEditorContext();

  // Self-pilot opens dormant; everything else opens awake. Once the user
  // wakes the rail, it stays awake for the rest of the session — we
  // intentionally don't persist the dormant flag back into the URL or
  // localStorage. Coming back to a self-pilot draft = fresh quiet rail.
  const [awake, setAwake] = useState(mode !== 'self-pilot');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [reflection, setReflection] = useState<ReflectionState>({
    kind: 'idle',
  });

  // Refs for debounced retrieval. We don't store the timer ID in state to
  // avoid re-renders on every keystroke; we only set state when retrieval
  // results change.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stamps the latest retrieval call. If a newer one starts before this
  // one finishes, the older one's setStatus is ignored — same idea as
  // the editor's coalesced saves.
  const queryStampRef = useRef(0);
  // Same pattern for reflection so a stale request doesn't overwrite a
  // newer one's result if the user double-clicks Reflect.
  const reflectStampRef = useRef(0);

  const runRetrieval = useCallback(
    async (text: string) => {
      const stamp = ++queryStampRef.current;
      setStatus({ kind: 'loading' });
      try {
        const hits = await findSimilar({
          text,
          kinds: ['capture', 'idea', 'draft'],
          limit: RESULT_LIMIT,
          excludeDraftId: draftId,
        });
        if (stamp !== queryStampRef.current) return;
        if (hits.length === 0) {
          setStatus({ kind: 'empty', basedOnChars: text.length });
        } else {
          setStatus({ kind: 'ok', hits, basedOnChars: text.length });
        }
      } catch (err) {
        if (stamp !== queryStampRef.current) return;
        const message = err instanceof Error ? err.message : 'retrieval failed';
        setStatus({ kind: 'error', message });
      }
    },
    [draftId]
  );

  // Subscribe to editor updates. Each `update` event triggers a debounced
  // retrieval call against the editor's current plain text. When the rail
  // is dormant (self-pilot, before wake), we skip the subscription
  // entirely so even the listening loop is silent.
  useEffect(() => {
    if (!editor) return;
    if (!awake) return;

    const trigger = () => {
      const text = editor.getText().trim().slice(0, MAX_QUERY_CHARS);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (text.length < MIN_QUERY_CHARS) {
        // Not enough signal — go idle and cancel any inflight retrieval.
        queryStampRef.current++;
        setStatus({ kind: 'idle' });
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        runRetrieval(text);
      }, DEBOUNCE_MS);
    };

    // Run once on mount so a draft you load with existing content
    // immediately surfaces neighbours.
    trigger();
    editor.on('update', trigger);
    return () => {
      editor.off('update', trigger);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, runRetrieval, awake]);

  // Click handler: insert the hit's content into the editor at the cursor
  // position. Captures + drafts → blockquote (working from words). Ideas
  // → H2 + paragraph (picking up your own thinking).
  const onPull = useCallback(
    (hit: SimilarHit) => {
      if (!editor) return;
      const chain = editor.chain().focus();

      if (hit.kind === 'idea') {
        const titleNode = hit.title
          ? {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: hit.title }],
            }
          : null;
        const essenceNode = hit.snippet
          ? {
              type: 'paragraph',
              content: [{ type: 'text', text: hit.snippet }],
            }
          : null;
        const nodes = [titleNode, essenceNode].filter(Boolean) as object[];
        if (nodes.length === 0) return;
        chain.insertContent(nodes).run();
        return;
      }

      // captures + drafts → blockquote with the body / snippet text.
      const text = hit.snippet?.trim() || hit.title?.trim();
      if (!text) return;
      chain
        .insertContent({
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text }],
            },
          ],
        })
        .run();
    },
    [editor]
  );

  // Sprint 9: trigger a reflection. The server action loads the most
  // recently saved draft state — autosave's 1s debounce means in the
  // common case (clicking Reflect after a typing pause) the saved state
  // already reflects what the user sees. Sprint 12: pass mode through so
  // the reflection's voice matches.
  const onReflect = useCallback(async () => {
    const stamp = ++reflectStampRef.current;
    setReflection({ kind: 'thinking' });
    try {
      const result = await reflect({ draftId, mode });
      if (stamp !== reflectStampRef.current) return;
      if (!result.ok) {
        // Discriminated single-test narrowing — see the gotchas doc:
        // checking !ok alone is enough; TS narrows to the failure variant.
        if (result.reason === 'error') {
          setReflection({ kind: 'error', message: result.message });
        } else {
          setReflection({ kind: 'soft', message: result.message });
        }
        return;
      }
      setReflection({
        kind: 'ok',
        reflection: result.reflection,
        sources: result.sources,
        basedOnChars: result.basedOnChars,
      });
    } catch (err) {
      if (stamp !== reflectStampRef.current) return;
      const message =
        err instanceof Error ? err.message : 'reflection failed';
      setReflection({ kind: 'error', message });
    }
  }, [draftId, mode]);

  const closeReflection = useCallback(() => {
    reflectStampRef.current++; // cancel any inflight result
    setReflection({ kind: 'idle' });
  }, []);

  return (
    <aside
      className="border-l border-rule bg-paper/40 flex flex-col"
      aria-label="The garden"
    >
      <div className="px-5 pt-6 pb-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold">
            ☘ The garden
          </div>
          {mode === 'self-pilot' && (
            <button
              type="button"
              onClick={() => setAwake((v) => !v)}
              aria-pressed={awake}
              title={awake ? 'Quiet the garden' : 'Wake the garden'}
              className={`font-mono text-[9px] tracking-[0.18em] uppercase rounded-full px-2.5 py-1 transition-colors border ${
                awake
                  ? 'bg-paper-2 text-ink border-rule hover:border-accent hover:text-accent'
                  : 'bg-transparent text-tag border-rule hover:bg-paper-2 hover:text-ink'
              }`}
            >
              {awake ? '◉ Awake' : '◌ Asleep'}
            </button>
          )}
        </div>
        {awake ? (
          <p className="font-serif italic text-[14px] text-ink-soft leading-[1.5]">
            What your bed is humming with — surfaced as you write. Click a row
            to drop it into the draft.
          </p>
        ) : (
          <p className="font-serif italic text-[14px] text-tag leading-[1.5]">
            Self-pilot — the garden's resting. Tap{' '}
            <span className="not-italic font-mono text-[11px] tracking-[0.18em]">
              ◌ Asleep
            </span>{' '}
            above when you want it to listen.
          </p>
        )}
      </div>

      {awake && (
        <div className="flex-1 px-5 py-6 overflow-y-auto flex flex-col gap-6">
          {reflection.kind !== 'idle' && (
            <ReflectionPanel
              state={reflection}
              onClose={closeReflection}
              onRetry={onReflect}
            />
          )}

          <BodyForStatus status={status} onPull={onPull} />

          <ReflectButton
            onClick={onReflect}
            thinking={reflection.kind === 'thinking'}
            hasResult={reflection.kind === 'ok'}
          />
        </div>
      )}

      {!awake && <div className="flex-1" />}

      <div className="px-5 py-3 font-mono text-[10px] tracking-[0.16em] uppercase text-tag/80 flex items-center gap-2">
        {awake ? (
          <FootnoteForStatus status={status} />
        ) : (
          <span>· dormant</span>
        )}
      </div>
    </aside>
  );
}

function BodyForStatus({
  status,
  onPull,
}: {
  status: Status;
  onPull: (hit: SimilarHit) => void;
}) {
  switch (status.kind) {
    case 'idle':
      return (
        <div className="flex flex-col items-start gap-3">
          <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 rounded-full px-3 py-1">
            Listening
          </span>
          <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
            Start writing. Once a sentence or two lands, the garden will
            surface what your seeds and earlier drafts already have to say
            about it.
          </p>
        </div>
      );

    case 'loading':
      return (
        <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
          remembering<span className="opacity-60">…</span>
        </p>
      );

    case 'empty':
      return (
        <div className="flex flex-col items-start gap-3">
          <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 rounded-full px-3 py-1">
            Quiet
          </span>
          <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
            Nothing in your bed is resonating with this yet. Keep going —
            the garden grows denser as you plant more.
          </p>
        </div>
      );

    case 'error':
      return (
        <p
          className="font-serif italic text-[13px] text-accent leading-[1.55]"
          title={status.message}
        >
          Couldn't reach the garden just now. Keep typing — it'll try again.
        </p>
      );

    case 'ok':
      return (
        <ul className="flex flex-col gap-1">
          {status.hits.map((hit) => (
            <li key={`${hit.kind}-${hit.id}`}>
              <HitRow hit={hit} onPull={onPull} />
            </li>
          ))}
        </ul>
      );
  }
}

function HitRow({
  hit,
  onPull,
}: {
  hit: SimilarHit;
  onPull: (hit: SimilarHit) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPull(hit)}
      className="w-full text-left rounded-soft px-3 py-3 -mx-1 hover:bg-paper-2 transition-colors group focus:outline-none focus:ring-1 focus:ring-accent/40"
    >
      <div className="flex items-baseline gap-2 font-mono text-[10px] tracking-[0.16em] uppercase text-tag mb-1">
        <span className="text-accent" aria-hidden>
          {KIND_GLYPH[hit.kind]}
        </span>
        <span>{KIND_LABEL[hit.kind]}</span>
        <span className="ml-auto text-tag/70 normal-case tracking-[0.04em]">
          · {hit.similarity.toFixed(2)}
        </span>
      </div>
      {hit.title && (
        <div className="font-serif text-[14px] text-ink leading-[1.4] group-hover:text-accent transition-colors">
          {hit.title}
        </div>
      )}
      {hit.snippet && (
        <div
          className={`font-serif text-[13px] text-ink-soft leading-[1.55] ${hit.title ? 'mt-1' : ''} line-clamp-3`}
        >
          {hit.snippet}
        </div>
      )}
      <div className="mt-2 font-mono text-[9px] tracking-[0.22em] uppercase text-tag/70 opacity-0 group-hover:opacity-100 transition-opacity">
        + pull into draft
      </div>
    </button>
  );
}

function ReflectButton({
  onClick,
  thinking,
  hasResult,
}: {
  onClick: () => void;
  thinking: boolean;
  hasResult: boolean;
}) {
  // Three labels:
  //   · idle (no reflection yet) → "Reflect on this draft"
  //   · thinking → "Reflecting…" (disabled)
  //   · result already showing → "Reflect again" (re-runs)
  const label = thinking
    ? 'Reflecting…'
    : hasResult
      ? '↻ Reflect again'
      : '⚉ Reflect on this draft';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={thinking}
      className="self-start font-mono text-[10px] tracking-[0.22em] uppercase border border-rule rounded-soft px-3 py-2 text-ink-soft hover:border-accent hover:text-accent hover:bg-paper transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}

function ReflectionPanel({
  state,
  onClose,
  onRetry,
}: {
  state: Exclude<ReflectionState, { kind: 'idle' }>;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="border border-accent/40 rounded-card bg-paper px-4 py-4 relative shadow-soft">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold">
          ▸ Reflection
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reflection"
          className="font-mono text-[14px] leading-none text-tag hover:text-accent transition-colors"
        >
          ✕
        </button>
      </div>

      {state.kind === 'thinking' && (
        <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
          weaving<span className="opacity-60">…</span>
        </p>
      )}

      {state.kind === 'soft' && (
        <p className="font-serif italic text-[14px] text-ink-soft leading-[1.55]">
          {state.message}
        </p>
      )}

      {state.kind === 'error' && (
        <div className="flex flex-col gap-2">
          <p
            className="font-serif italic text-[14px] text-accent leading-[1.55]"
            title={state.message}
          >
            Couldn't reach the garden. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="self-start font-mono text-[10px] tracking-[0.22em] uppercase text-tag hover:text-accent transition-colors"
          >
            ↻ Retry
          </button>
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          <p className="font-serif text-[14px] text-ink leading-[1.6] whitespace-pre-wrap">
            {state.reflection}
          </p>

          {state.sources.length > 0 && (
            <div className="mt-4 pt-3 border-t border-rule">
              <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
                ▸ Drawn from
              </div>
              <ul className="flex flex-col gap-1.5">
                {state.sources.map((src, i) => (
                  <li
                    key={`${src.kind}-${src.id}`}
                    className="flex items-baseline gap-2 font-mono text-[10px] text-tag"
                  >
                    <span className="text-tag/70">[{i + 1}]</span>
                    <span className="text-accent" aria-hidden>
                      {KIND_GLYPH[src.kind]}
                    </span>
                    <span className="font-serif italic text-[12px] text-ink-soft truncate normal-case tracking-normal">
                      {src.title || src.snippet?.slice(0, 60) || '(untitled)'}
                    </span>
                    <span className="ml-auto text-tag/60 tracking-[0.04em]">
                      · {src.similarity.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FootnoteForStatus({ status }: { status: Status }) {
  switch (status.kind) {
    case 'idle':
      return <span>· waiting for ink</span>;
    case 'loading':
      return <span>· retrieving</span>;
    case 'ok':
      return (
        <span>
          · {status.hits.length} based on {status.basedOnChars} chars
        </span>
      );
    case 'empty':
      return <span>· nothing matched ({status.basedOnChars} chars)</span>;
    case 'error':
      return <span className="text-accent">· retrieval offline</span>;
  }
}
