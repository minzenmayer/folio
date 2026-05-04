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

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { findSimilar, reflect, type SimilarHit } from '../actions';
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
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [reflection, setReflection] = useState<ReflectionState>({
    kind: 'idle',
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryStampRef = useRef(0);
  const reflectStampRef = useRef(0);

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
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
            Resonance
          </h2>
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
        </div>
        {awake ? (
          <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5]">
            What your space is humming with — surfaced as you write. Click a
            row to drop it into the draft.
          </p>
        ) : (
          <p className="font-sans text-[12.5px] text-tag leading-[1.5]">
            Self-pilot — resonance is off. Toggle <strong className="text-ink">On</strong>{' '}
            when you want sources surfacing.
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
          <span>Dormant</span>
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
            Nothing in your space resonates with this yet. Keep going —
            sources surface as you build the archive.
          </p>
        </div>
      );

    case 'error':
      return (
        <p
          className="font-sans text-[12.5px] text-ink leading-[1.55]"
          title={status.message}
        >
          Sources unavailable for a moment. Keep typing — it'll retry.
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
      className="w-full text-left rounded-soft px-3 py-3 -mx-1 hover:bg-paper-2 transition-colors group focus:outline-none focus:ring-1 focus:ring-rule-strong"
    >
      <div className="flex items-baseline gap-2 font-mono text-[10px] tracking-[0.16em] uppercase text-tag mb-1">
        <span>{KIND_LABEL[hit.kind]}</span>
        <span className="ml-auto normal-case tracking-[0.04em] text-tag/70">
          {hit.similarity.toFixed(2)}
        </span>
      </div>
      {hit.title && (
        <div className="font-sans text-[13.5px] font-medium text-ink leading-[1.4] group-hover:underline underline-offset-4 decoration-rule-strong">
          {hit.title}
        </div>
      )}
      {hit.snippet && (
        <div
          className={`font-sans text-[12.5px] text-ink-soft leading-[1.55] ${hit.title ? 'mt-1' : ''} line-clamp-3`}
        >
          {hit.snippet}
        </div>
      )}
      <div className="mt-2 font-mono text-[9px] tracking-[0.22em] uppercase text-tag opacity-0 group-hover:opacity-100 transition-opacity">
        + Pull into draft
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
