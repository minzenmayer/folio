// Thoughtbed · ChatCompanion
//
// Phase 21 slice 6 (2026-05-06). Replaces AssistantRailLive in the
// editor route's right column. Same retrieval primitives
// (findSimilar, debounced on editor text), but rendered as a
// conversation surface — Thoughtbed turns, idea cards as attached
// previews, click-to-expand inline within the thread.
//
// Shape per the Phase 21 spec:
//   • Welcome turn at the top.
//   • Listening status while the editor is below the min query.
//   • Surfaced ideas as compact cards under a Thoughtbed turn.
//   • Click a card → expands in place. Three actions: Pull into
//     editor, Suggest a hook from this, Show related. Close button
//     shrinks back to compact. Other turns above and below stay.
//   • No similarity score numbers (Phase 21 slice 1 feedback).
//   • No kind labels in user-facing copy beyond a small subtitle.
//
// Slice 7 wires the Pull-into-editor button to insertThoughtBubble.
// Slice 8 adds the chat input and slash commands. Slice 9 layers
// per-platform skill prompting on the assistant's voice. Slice 10
// adds the originality-check tool. This slice ships the surface +
// retrieval rendering only.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { findSimilar, type SimilarHit } from '../actions';
import { SIMILAR_KINDS } from '@/lib/retrieval-kinds';
import { useRailCollapse } from './useRailCollapse';
import { usePlatform, PLATFORM_LABEL } from './usePlatform';

const DEBOUNCE_MS = 1500;
const MIN_QUERY_CHARS = 12;
const MAX_QUERY_CHARS = 4000;
const RESULT_LIMIT = 5;

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; hits: SimilarHit[]; basedOnChars: number }
  | { kind: 'empty'; basedOnChars: number }
  | { kind: 'error'; message: string };

type ChatCompanionProps = {
  draftId: string;
};

export function ChatCompanion({ draftId }: ChatCompanionProps) {
  const { editor } = useEditorContext();
  const { state: collapseState, toggleCollapsed } = useRailCollapse();
  const isCollapsed = collapseState === 'collapsed';
  const { platform } = usePlatform();

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pulledIdeaIds, setPulledIdeaIds] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryStampRef = useRef(0);
  const lastQueryRef = useRef<string>('');

  const runRetrieval = useCallback(
    async (text: string) => {
      const stamp = ++queryStampRef.current;
      setStatus({ kind: 'loading' });
      try {
        const hits = await findSimilar({
          text,
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
  }, [editor, runRetrieval]);

  const refreshIdeas = useCallback(() => {
    if (!editor) return;
    const fromRef = lastQueryRef.current;
    const text =
      fromRef.length >= MIN_QUERY_CHARS
        ? fromRef
        : editor.getText().trim().slice(0, MAX_QUERY_CHARS);
    if (text.length < MIN_QUERY_CHARS) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    runRetrieval(text);
  }, [editor, runRetrieval]);

  // Slice 7 wires this to insertThoughtBubble. Slice 6 just tracks
  // local state and toggles the card's "in editor" flag.
  const onPullCard = useCallback((hit: SimilarHit) => {
    setPulledIdeaIds((prev) => {
      if (prev.has(hit.id)) return prev;
      const next = new Set(prev);
      next.add(hit.id);
      return next;
    });
  }, []);

  return (
    <aside
      className="border-l border-rule bg-bg flex flex-col w-full"
      aria-label="Thoughtbed companion"
    >
      <div className="px-4 py-3 border-b border-rule flex items-center gap-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-pressed={isCollapsed}
          aria-label={isCollapsed ? 'Expand chat' : 'Collapse chat'}
          title={isCollapsed ? 'Expand chat' : 'Collapse chat'}
          className="text-tag hover:text-ink transition-colors rounded-soft p-1 -ml-1 shrink-0"
        >
          <ChevronGlyph direction={isCollapsed ? 'right' : 'left'} />
        </button>

        {!isCollapsed && (
          <>
            <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
              Thoughtbed
            </h2>
            <span className="font-mono text-[9px] tracking-[0.16em] uppercase text-tag/60">
              · live
            </span>
            <button
              type="button"
              onClick={refreshIdeas}
              disabled={status.kind === 'loading'}
              title="Refresh ideas"
              aria-label="Refresh ideas"
              className="ml-auto font-mono text-[9px] tracking-[0.18em] uppercase text-tag border border-rule rounded-full px-2.5 py-1 hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Refresh
            </button>
          </>
        )}
      </div>

      {!isCollapsed && (
        <div className="flex-1 px-4 py-4 overflow-y-auto flex flex-col gap-3">
          <WelcomeTurn platform={platform} />

          <ThoughtbedTurn>
            <StatusLine status={status} />
          </ThoughtbedTurn>

          {status.kind === 'ok' && (
            <ThoughtbedTurn note>
              <p className="font-sans text-[12px] text-ink-soft leading-[1.55] m-0">
                Found {status.hits.length} from your Garden that connect.
              </p>
            </ThoughtbedTurn>
          )}

          {status.kind === 'ok' &&
            status.hits.map((hit) => {
              const cardId = `${hit.kind}-${hit.id}`;
              return (
                <IdeaCard
                  key={cardId}
                  hit={hit}
                  expanded={expandedCardId === cardId}
                  pulled={pulledIdeaIds.has(hit.id)}
                  onExpand={() =>
                    setExpandedCardId((prev) =>
                      prev === cardId ? null : cardId
                    )
                  }
                  onCollapse={() => setExpandedCardId(null)}
                  onPull={() => onPullCard(hit)}
                />
              );
            })}
        </div>
      )}

      {isCollapsed && <div className="flex-1" />}
    </aside>
  );
}

function WelcomeTurn({ platform }: { platform: keyof typeof PLATFORM_LABEL }) {
  return (
    <ThoughtbedTurn>
      <p className="font-sans text-[13px] text-ink-soft leading-[1.55] m-0">
        I&apos;ll read what you write and surface what&apos;s already in your
        Garden. Drafting{' '}
        <span className="font-medium text-ink">
          {PLATFORM_LABEL[platform]}
        </span>
        .
      </p>
    </ThoughtbedTurn>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') {
    return (
      <p className="font-sans text-[12.5px] text-tag leading-[1.55] m-0">
        Once a sentence or two lands, I&apos;ll surface what your Garden
        already knows.
      </p>
    );
  }
  if (status.kind === 'loading') {
    return (
      <p className="font-sans text-[12.5px] text-tag leading-[1.55] m-0">
        Reading your Garden…
      </p>
    );
  }
  if (status.kind === 'empty') {
    return (
      <p className="font-sans text-[12.5px] text-tag leading-[1.55] m-0">
        Nothing in your Garden resonates yet. Keep writing — sources surface
        as the archive grows.
      </p>
    );
  }
  if (status.kind === 'error') {
    return (
      <p
        className="font-sans text-[12.5px] text-ink leading-[1.55] m-0"
        title={status.message}
      >
        Sources offline for a moment. Keep typing and it&apos;ll retry.
      </p>
    );
  }
  return null;
}

function ThoughtbedTurn({
  children,
  note,
}: {
  children: React.ReactNode;
  note?: boolean;
}) {
  if (note) {
    return (
      <div className="pl-7 -mt-1">
        <div className="font-sans text-[12px] text-tag leading-[1.55]">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div
        aria-hidden="true"
        className="w-5 h-5 rounded-full bg-paper-2 border border-rule flex items-center justify-center font-mono text-[9px] font-medium text-tag shrink-0 mt-0.5"
      >
        T
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function IdeaCard({
  hit,
  expanded,
  pulled,
  onExpand,
  onCollapse,
  onPull,
}: {
  hit: SimilarHit;
  expanded: boolean;
  pulled: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onPull: () => void;
}) {
  const title = (hit.title ?? '').trim() || '(untitled)';
  const claimFull = (hit.claimFull ?? '').trim();
  const snippet = (hit.snippet ?? '').trim();
  const preview =
    hit.kind === 'extracted_idea' && claimFull.length > 0
      ? claimFull
      : snippet;

  const sourceTitle = (hit.sourceTitle ?? '').trim();

  // Visual: paper-hot tint for ideas + extracted_ideas (Garden source);
  // plain paper for everything else (drafts, captures, newsletter
  // issues, etc.). The dot color matches.
  const isGarden = hit.kind === 'idea' || hit.kind === 'extracted_idea';
  const cardClass = isGarden
    ? 'bg-paper-hot border-rule'
    : 'bg-paper border-rule';
  const dotClass = isGarden ? 'bg-glyph-hot' : 'bg-tag/60';

  return (
    <div className="pl-7 -mt-1">
      <div
        className={`rounded-soft border ${cardClass} transition-shadow ${
          expanded ? 'shadow-soft' : ''
        }`}
      >
        <button
          type="button"
          onClick={expanded ? onCollapse : onExpand}
          aria-expanded={expanded}
          className="w-full text-left px-3 py-2.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong rounded-soft"
        >
          <div className="flex items-center gap-2 mb-1">
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${dotClass}`}
            />
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag font-medium">
              {sourceLabel(hit)}
            </span>
            {pulled && (
              <span
                className="ml-auto font-mono text-[9px] tracking-[0.18em] uppercase text-accent-2"
                aria-label="Already in your draft"
                title="In editor"
              >
                ✓ in editor
              </span>
            )}
          </div>
          <p className="font-sans text-[12.5px] font-medium text-ink leading-[1.4] m-0">
            {title}
          </p>
          {!expanded && preview.length > 0 && (
            <p className="font-sans text-[11.5px] text-ink-soft leading-[1.5] line-clamp-1 mt-1 m-0">
              {preview}
            </p>
          )}
        </button>

        {expanded && (
          <div className="px-3 pb-3 -mt-1">
            {preview.length > 0 && (
              <p className="font-sans text-[12px] text-ink-soft leading-[1.55] m-0 mb-2">
                {preview}
              </p>
            )}
            {sourceTitle.length > 0 && (
              <p className="font-mono text-[9px] tracking-[0.16em] uppercase text-tag/80 m-0 mb-2">
                from {sourceTitle}
              </p>
            )}
            <div className="flex items-center gap-1.5 flex-wrap">
              <CardActionButton onClick={onPull} primary disabled={pulled}>
                {pulled ? 'In editor ✓' : 'Pull into editor →'}
              </CardActionButton>
              <CardActionButton
                onClick={() => {
                  /* slice 8 wires this */
                }}
              >
                Suggest a hook
              </CardActionButton>
              <CardActionButton
                onClick={() => {
                  /* slice 8 wires this */
                }}
              >
                Show related
              </CardActionButton>
              <button
                type="button"
                onClick={onCollapse}
                className="ml-auto font-mono text-[9px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors px-1.5"
                aria-label="Collapse card"
              >
                close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CardActionButton({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`font-mono text-[10px] tracking-[0.16em] uppercase rounded-full px-2.5 py-1 transition-colors border focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong disabled:cursor-not-allowed ${
        primary
          ? disabled
            ? 'bg-paper-2 text-tag border-rule'
            : 'bg-ink text-bg border-ink hover:bg-accent'
          : 'bg-transparent text-ink border-rule hover:border-ink hover:bg-paper-2'
      }`}
    >
      {children}
    </button>
  );
}

function sourceLabel(hit: SimilarHit): string {
  switch (hit.kind) {
    case 'idea':
    case 'extracted_idea':
      return 'From your Garden';
    case 'draft':
      return 'From an earlier draft';
    case 'newsletter_issue':
      return 'From your newsletter';
    case 'obsidian_note':
      return 'From your vault';
    case 'linkedin_post':
      return 'From your LinkedIn';
    case 'gmail_message':
      return 'From a newsletter you read';
    case 'capture':
      return 'From a capture';
    default:
      return 'From your space';
  }
}

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
