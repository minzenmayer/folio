// Thoughtbed · GardenRail (live)
//
// The right pane on /studio/page/[id]. As the user writes, we debounce
// the editor's text, call findSimilar against captures + ideas + drafts,
// and surface the top hits as pull-able rows. Click "Reflect" to ask
// Claude to weave them back into a 2-3 sentence reflection.
//
// Sprint 14 brand pivot: dropped "The garden" copy and decorative glyphs.
// Header reads "Resonance". Hit rows lose the per-kind glyph (the
// uppercase mono kind label carries the signal). The file name stays the
// same to preserve the import surface across the app.
//
// Sprint 12: takes a `mode` prop ('newsletter' | 'linkedin' | 'self-pilot'
// or undefined). Reflect call is mode-aware so the reflection's voice
// matches how the draft was started. Self-pilot starts the rail dormant
// — no debounced retrieval, no listening copy. The header carries a small
// On/Off toggle to wake it up.
//
// Phase 20 (2026-05-06): editor redesign — slice 1 lays in the new header
// shape. A collapse chevron + a "Refresh ideas" button sit alongside the
// title. The chevron is wired to local state for now (visual collapse on
// click); slice 6 lifts the state into useRailCollapse with localStorage
// persistence and adds the 56px collapsed strip + hidden state. Refresh
// re-fires findSimilar with the current draft text (no separate path —
// shares the same runRetrieval the debounced trigger uses).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { findSimilar, reflect, type SimilarHit } from '../actions';
import { RailIdeaPill } from './RailIdeaPill';
import { markIdeaPulledIntoDraft } from '../garden/actions';
import { SIMILAR_KINDS } from '@/lib/retrieval-kinds';

const DEBOUNCE_MS = 1500;
const MIN_QUERY_CHARS = 12;
const MAX_QUERY_CHARS = 4000;
const RESULT_LIMIT = 6;

// Sprint 14 brand pivot: drop decorative glyphs from rail rows. The
// kind label alone (mono-uppercase) carries the source-type signal — the
// previous "/▸/✎/✉" set was decorative and didn't read well in monochrome.
const KIND_LABEL: Record<SimilarHit['kind'], string> = {
  capture: 'Capture',
  idea: 'Idea',
  draft: 'Draft',
  newsletter_issue: 'Issue',
  // Sprint 15 Wave 3 — see ideas/[id]/page.tsx for label rationale.
  obsidian_note: 'Note',
  extracted_idea: 'Lesson',
  // Phase 12 (2026-05-04): LinkedIn post in the rail.
  linkedin_post: 'LinkedIn',
  // Phase 13 (2026-05-04): a newsletter you read in Gmail (promoted-only).
  gmail_message: 'Newsletter',
};

export type GardenRailMode = 'newsletter' | 'linkedin' | 'self-pilot';

type Status =
  | { kind: 'idle' }
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
  | { kind: 'soft'; message: string }
  | { kind: 'error'; message: string };

export function AssistantRailLive({
  draftId,
  mode,
}: {
  draftId: string;
  mode?: GardenRailMode;
}) {
  const { editor } = useEditorContext();

  const [awake, setAwake] = useState(mode !== 'self-pilot');
  // Phase 20 slice 1: visual collapse state. Slice 6 lifts this into a
  // dedicated hook (useRailCollapse) with localStorage persistence and a
  // 56px collapsed strip. For now the collapsed branch just hides the body
  // so we can ship the header redesign in isolation.
  const [collapsedLocal, setCollapsedLocal] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [reflection, setReflection] = useState<ReflectionState>({
    kind: 'idle',
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryStampRef = useRef(0);
  const reflectStampRef = useRef(0);
  // Phase 20: most-recent query text. The debounced trigger writes here on
  // every editor update; the Refresh button reads here to re-run findSimilar
  // without waiting for the next keystroke.
  const lastQueryRef = useRef<string>('');

  const runRetrieval = useCallback(
    async (text: string) => {
      const stamp = ++queryStampRef.current;
      setStatus({ kind: 'loading' });
      try {
        const hits = await findSimilar({
          text,
          // Sprint 15 Wave 3: rail pulls from every retrieval kind. Driven
          // off the same SIMILAR_KINDS const that drives the schema —
          // adding a kind requires touching one place, not three.
          kinds: [...SIMILAR_KINDS],
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

  useEffect(() => {
    if (!editor) return;
    if (!awake) return;

    const trigger = () => {
      const text = editor.getText().trim().slice(0, MAX_QUERY_CHARS);
      lastQueryRef.current = text;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (text.length < MIN_QUERY_CHARS) {
        queryStampRef.current++;
        setStatus({ kind: 'idle' });
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        runRetrieval(text);
      }, DEBOUNCE_MS);
    };

    trigger();
    editor.on('update', trigger);
    return () => {
      editor.off('update', trigger);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, runRetrieval, awake]);

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
        // Phase 17 (2026-05-05): implicit-claim signal. If this idea
        // was auto_claimed, the act of pulling it into a draft flips
        // it to user-claimed. Fire-and-forget — no UI block on the
        // round-trip; the badge disappears on next render.
        markIdeaPulledIntoDraft(hit.id).catch((err) => {
          console.warn('[rail] markIdeaPulledIntoDraft failed', err);
        });
        return;
      }

      // captures + drafts + newsletter_issues → blockquote
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

  // Phase 20: Refresh button in the rail header. Fires findSimilar with
  // whatever text the editor currently holds — bypasses the debounce so
  // the user gets a fresh pass when they want one. If the text is below
  // the minimum (12 chars), we fall back to the editor's current text in
  // case lastQueryRef hasn't been seeded yet (first render before any
  // keystroke after a paste).
  const refreshIdeas = useCallback(() => {
    if (!editor) return;
    if (!awake) return;
    const fromRef = lastQueryRef.current;
    const text = (
      fromRef.length >= MIN_QUERY_CHARS
        ? fromRef
        : editor.getText().trim().slice(0, MAX_QUERY_CHARS)
    );
    if (text.length < MIN_QUERY_CHARS) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    runRetrieval(text);
  }, [editor, awake, runRetrieval]);

  const onReflect = useCallback(async () => {
    const stamp = ++reflectStampRef.current;
    setReflection({ kind: 'thinking' });
    try {
      const result = await reflect({ draftId, mode });
      if (stamp !== reflectStampRef.current) return;
      if (!result.ok) {
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
    reflectStampRef.current++;
    setReflection({ kind: 'idle' });
  }, []);

  return (
    <aside
      className="border-l border-rule bg-bg flex flex-col"
      aria-label="Resonance"
    >
      <div className="px-5 pt-6 pb-4 border-b border-rule">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
            Resonance
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            {awake && (
              <button
                type="button"
                onClick={refreshIdeas}
                disabled={status.kind === 'loading'}
                title="Refresh ideas"
                aria-label="Refresh ideas"
                className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag border border-rule rounded-full px-2.5 py-1 hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Refresh
              </button>
            )}
            {mode === 'self-pilot' && (
              <button
                type="button"
                onClick={() => setAwake((v) => !v)}
                aria-pressed={awake}
                title={awake ? 'Quiet resonance' : 'Wake resonance'}
                className={`font-mono text-[9px] tracking-[0.18em] uppercase rounded-full px-2.5 py-1 transition-colors border ${
                  awake
                    ? 'bg-paper-2 text-ink border-rule hover:border-ink'
                    : 'bg-transparent text-tag border-rule hover:bg-paper-2 hover:text-ink'
                }`}
              >
                {awake ? 'On' : 'Off'}
              </button>
            )}
            {/* Phase 20 slice 1: collapse chevron. Local visual state for now;
                slice 6 lifts to useRailCollapse with localStorage. */}
            <button
              type="button"
              onClick={() => setCollapsedLocal((v) => !v)}
              aria-pressed={collapsedLocal}
              aria-label={collapsedLocal ? 'Expand rail' : 'Collapse rail'}
              title={collapsedLocal ? 'Expand rail' : 'Collapse rail'}
              className="text-tag hover:text-ink transition-colors rounded-soft p-1 -mr-1"
            >
              <ChevronGlyph direction={collapsedLocal ? 'left' : 'right'} />
            </button>
          </div>
        </div>
        {awake ? (
          <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5]">
            What your space is humming with, surfaced as you write. Click a
            row to drop it into the draft.
          </p>
        ) : (
          <p className="font-sans text-[12.5px] text-tag leading-[1.5]">
            Self-pilot. Resonance is off. Toggle <strong className="text-ink">On</strong>{' '}
            when you want sources surfacing.
          </p>
        )}
      </div>

      {awake && !collapsedLocal && (
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

      {(!awake || collapsedLocal) && <div className="flex-1" />}

      {!collapsedLocal && (
        <div className="px-5 py-3 font-mono text-[10px] tracking-[0.16em] uppercase text-tag/80 flex items-center gap-2">
          {awake ? (
            <FootnoteForStatus status={status} />
          ) : (
            <span>Dormant</span>
          )}
        </div>
      )}
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
          <p className="font-sans text-[12.5px] text-tag leading-[1.55]">
            Start writing. Once a sentence or two lands, sources from your
            captures, ideas, and earlier drafts will surface here.
          </p>
        </div>
      );

    case 'loading':
      return (
        <p className="font-sans text-[12.5px] text-tag leading-[1.55]">
          Searching…
        </p>
      );

    case 'empty':
      return (
        <div className="flex flex-col items-start gap-3">
          <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 rounded-full px-3 py-1">
            Quiet
          </span>
          <p className="font-sans text-[12.5px] text-tag leading-[1.55]">
            Nothing in your space resonates with this yet. Keep going.
            Sources surface as you build the archive.
          </p>
        </div>
      );

    case 'error':
      return (
        <p
          className="font-sans text-[12.5px] text-ink leading-[1.55]"
          title={status.message}
        >
          Sources unavailable for a moment. Keep typing and it'll retry.
        </p>
      );

    case 'ok': {
      // Phase 20 slice 3: heat-color rank derived from list position. Hits
      // come back from findSimilar already sorted by similarity descending,
      // so we key off index — top 1-2 are 'hot', next two are 'ready', the
      // rest are 'cool'. Tying rank to rank position (not absolute score)
      // means the hottest pill always reads as hot even on quiet days when
      // every score is in the 0.3 range.
      const rankFor = (i: number): 'hot' | 'ready' | 'cool' =>
        i < 2 ? 'hot' : i < 4 ? 'ready' : 'cool';
      return (
        <ul className="flex flex-col gap-1.5">
          {status.hits.map((hit, i) => (
            <li key={`${hit.kind}-${hit.id}`}>
              {/* Phase 20 slice 2: minimal pill replaces the verbose row.
                  Slice 3 layers heat-color rank on top. Slice 5 swaps
                  onPull to insert an ideaBubble node. Slice 8 wires
                  onOpen to the Garden surface. */}
              <RailIdeaPill hit={hit} onPull={onPull} rank={rankFor(i)} />
            </li>
          ))}
        </ul>
      );
    }
  }
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
  const label = thinking
    ? 'Reflecting…'
    : hasResult
      ? 'Reflect again'
      : 'Reflect on this draft';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={thinking}
      className="self-start font-mono text-[10px] tracking-[0.22em] uppercase border border-rule rounded-soft px-3 py-2 text-ink-soft hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
    <div className="border border-rule rounded-card bg-paper px-4 py-4 relative shadow-soft">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-ink font-medium">
          Reflection
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reflection"
          className="font-mono text-[14px] leading-none text-tag hover:text-ink transition-colors"
        >
          ✕
        </button>
      </div>

      {state.kind === 'thinking' && (
        <p className="font-sans text-[13px] text-tag leading-[1.55]">
          Thinking…
        </p>
      )}

      {state.kind === 'soft' && (
        <p className="font-sans text-[13.5px] text-ink-soft leading-[1.55]">
          {state.message}
        </p>
      )}

      {state.kind === 'error' && (
        <div className="flex flex-col gap-2">
          <p
            className="font-sans text-[13.5px] text-ink leading-[1.55]"
            title={state.message}
          >
            Reflection unavailable. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="self-start font-mono text-[10px] tracking-[0.22em] uppercase text-tag hover:text-ink transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          <p className="font-sans text-[13.5px] text-ink leading-[1.6] whitespace-pre-wrap">
            {state.reflection}
          </p>

          {state.sources.length > 0 && (
            <div className="mt-4 pt-3 border-t border-rule">
              <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
                Drawn from
              </div>
              <ul className="flex flex-col gap-1.5">
                {state.sources.map((src, i) => (
                  <li
                    key={`${src.kind}-${src.id}`}
                    className="flex items-baseline gap-2 font-mono text-[10px] text-tag"
                  >
                    <span className="text-tag/70">[{i + 1}]</span>
                    <span className="text-tag/70">
                      {KIND_LABEL[src.kind]}
                    </span>
                    <span className="font-sans text-[12px] text-ink-soft truncate normal-case tracking-normal">
                      {src.title || src.snippet?.slice(0, 60) || '(untitled)'}
                    </span>
                    <span className="ml-auto tracking-[0.04em]">
                      {src.similarity.toFixed(2)}
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
      return <span>Waiting for ink</span>;
    case 'loading':
      return <span>Retrieving</span>;
    case 'ok':
      return (
        <span>
          {status.hits.length} based on {status.basedOnChars} chars
        </span>
      );
    case 'empty':
      return <span>Nothing matched ({status.basedOnChars} chars)</span>;
    case 'error':
      return <span className="text-ink">Retrieval offline</span>;
  }
}

// Phase 20 slice 1: tiny inline SVG chevron used in the rail header. Inline
// so we don't pull in an icon library. `direction` mirrors which way the
// chevron points — 'right' when the rail is open (signals collapse), 'left'
// when the rail is collapsed (signals expand).
function ChevronGlyph({ direction }: { direction: 'left' | 'right' }) {
  return (
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
      {direction === 'right' ? (
        <polyline points="5,3 9,7 5,11" />
      ) : (
        <polyline points="9,3 5,7 9,11" />
      )}
    </svg>
  );
}
