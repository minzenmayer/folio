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
import { markIdeaPulledIntoDraft } from '../garden/actions';
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

// Phase 21 slice 8 (2026-05-06): user-driven conversation turns
// stack on top of the auto-debounced retrieval feed. Each turn is
// either the user's message, a Thoughtbed reply, or a tool-result
// rendered inline. The auto-feed (Status above) lives BELOW the
// turn log — those are the system's running observations from your
// editor; the turn log is anything the user explicitly asked for.
type ChatTurn =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'thoughtbed'; text: string }
  | { id: string; kind: 'tool'; label: string; body: string }
  | {
      id: string;
      kind: 'related';
      query: string;
      hits: SimilarHit[];
    };

// Phase 21 slice 8 (2026-05-06): supported slash commands.
//   /related <query>  — re-run findSimilar against the user's text
//   /hook              — propose hook options (slice 11 LLM round)
//   /closer            — propose closers (slice 11 LLM round)
//   /originality       — check against user's archive (slice 10)

type ChatCompanionProps = {
  draftId: string;
};

export function ChatCompanion({ draftId }: ChatCompanionProps) {
  const { editor, insertThoughtBubble } = useEditorContext();
  const { state: collapseState, toggleCollapsed } = useRailCollapse();
  const isCollapsed = collapseState === 'collapsed';
  const { platform } = usePlatform();

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pulledIdeaIds, setPulledIdeaIds] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [composing, setComposing] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryStampRef = useRef(0);
  const lastQueryRef = useRef<string>('');

  const newId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  const appendTurn = useCallback((turn: ChatTurn) => {
    setTurns((prev) => [...prev, turn]);
  }, []);

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

  // Phase 21 slice 8: chat input handler. Routes slash commands to
  // their handlers; everything else lands as a user turn followed
  // by a placeholder Thoughtbed acknowledgement. The LLM round for
  // free-form replies wires in slice 11 once the per-platform
  // skills (slice 9) and originality tool (slice 10) are in place.
  const handleSend = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text.length === 0) return;

      const isSlash = text.startsWith('/');
      const cmd = isSlash ? text.split(/\s+/)[0] : null;
      const arg = isSlash ? text.replace(cmd ?? '', '').trim() : text;

      // Push user's message as a turn first.
      appendTurn({ id: newId(), kind: 'user', text });

      if (cmd === '/related') {
        const queryText = arg.length > 0 ? arg : lastQueryRef.current;
        if (queryText.trim().length < MIN_QUERY_CHARS) {
          appendTurn({
            id: newId(),
            kind: 'thoughtbed',
            text:
              'Give me a few more words to search on — paste a sentence or pass one with /related <query>.',
          });
          return;
        }
        appendTurn({
          id: newId(),
          kind: 'thoughtbed',
          text: 'Searching your Garden…',
        });
        try {
          const hits = await findSimilar({
            text: queryText,
            kinds: [...SIMILAR_KINDS],
            limit: RESULT_LIMIT,
            excludeDraftId: draftId,
          });
          appendTurn({
            id: newId(),
            kind: 'related',
            query: queryText.slice(0, 80),
            hits,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'retrieval failed';
          appendTurn({
            id: newId(),
            kind: 'thoughtbed',
            text: `That search didn't land (${message}). Try again in a moment.`,
          });
        }
        return;
      }

      if (cmd === '/hook' || cmd === '/closer') {
        appendTurn({
          id: newId(),
          kind: 'thoughtbed',
          text:
            cmd === '/hook'
              ? 'Hook generator is wiring next slice. For now: write the most specific true sentence about the moment, then put a contrast right after it.'
              : 'Closer generator is wiring next slice. For now: end on a sentence that lands the through-line of the post in 7 words or fewer.',
        });
        return;
      }

      if (cmd === '/originality') {
        appendTurn({
          id: newId(),
          kind: 'thoughtbed',
          text:
            'Originality check wires in the next slice. For now I can re-run /related against your archive — try /related <your sentence>.',
        });
        return;
      }

      // Free-form text. Acknowledge for now; slice 11 wires the
      // LLM round.
      appendTurn({
        id: newId(),
        kind: 'thoughtbed',
        text:
          'I hear you. The free-form reply layer is wiring next; for now try a slash command: /related, /hook, /closer, /originality.',
      });
    },
    [appendTurn, draftId]
  );

  // Phase 21 slice 7 (2026-05-06): Pull-into-editor handoff.
  // Routes idea / extracted_idea hits through insertThoughtBubble
  // (which dedupes against existing bubbles for the same ideaId
  // and scrolls to them). Other kinds (drafts, captures, etc.)
  // fall back to a blockquote insert so they still drop something
  // useful into the prose. Fires markIdeaPulledIntoDraft on
  // 'idea' for the implicit-claim signal Phase 17 wired.
  const onPullCard = useCallback(
    (hit: SimilarHit) => {
      if (!editor) return;

      if (hit.kind === 'idea' || hit.kind === 'extracted_idea') {
        const title = (hit.title ?? '').trim();
        const preview = (
          hit.kind === 'extracted_idea' && hit.claimFull
            ? hit.claimFull
            : hit.snippet ?? ''
        ).trim();

        const result = insertThoughtBubble({
          source: 'idea',
          ideaId: hit.id,
          kind: hit.kind,
          title,
          preview,
        });
        if (!result.ok) return;

        if (hit.kind === 'idea') {
          markIdeaPulledIntoDraft(hit.id).catch((err) => {
            console.warn('[chat] markIdeaPulledIntoDraft failed', err);
          });
        }
      } else {
        const text = (hit.snippet ?? '').trim() || (hit.title ?? '').trim();
        if (text.length > 0) {
          editor
            .chain()
            .focus()
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
        }
      }

      setPulledIdeaIds((prev) => {
        if (prev.has(hit.id)) return prev;
        const next = new Set(prev);
        next.add(hit.id);
        return next;
      });
    },
    [editor, insertThoughtBubble]
  );

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

          {/* Phase 21 slice 8 (2026-05-06): user-driven turn log
              renders below the auto-feed. Slash-command results
              and free-form replies live here. */}
          {turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              expandedCardId={expandedCardId}
              pulledIdeaIds={pulledIdeaIds}
              onExpand={(id) =>
                setExpandedCardId((prev) => (prev === id ? null : id))
              }
              onCollapse={() => setExpandedCardId(null)}
              onPull={onPullCard}
            />
          ))}
        </div>
      )}

      {!isCollapsed && (
        <ChatInput
          value={inputValue}
          composing={composing}
          onChange={setInputValue}
          onCompositionChange={setComposing}
          onSend={() => {
            if (composing) return;
            const text = inputValue;
            setInputValue('');
            handleSend(text);
          }}
        />
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

// Phase 21 slice 8 (2026-05-06): turn renderer. Switches on the
// turn kind. User turns get a small 'You' bubble; thoughtbed turns
// reuse the existing ThoughtbedTurn frame; tool results render
// with a label header; related-search results render an embedded
// IdeaCard list under a Thoughtbed turn.
function TurnView({
  turn,
  expandedCardId,
  pulledIdeaIds,
  onExpand,
  onCollapse,
  onPull,
}: {
  turn: ChatTurn;
  expandedCardId: string | null;
  pulledIdeaIds: Set<string>;
  onExpand: (id: string) => void;
  onCollapse: () => void;
  onPull: (hit: SimilarHit) => void;
}) {
  if (turn.kind === 'user') {
    return (
      <div className="flex gap-2 justify-end">
        <div className="flex-1 min-w-0" />
        <div className="max-w-[85%] bg-paper-2 border border-rule rounded-card px-3 py-2">
          <p className="font-sans text-[12.5px] text-ink leading-[1.55] m-0 whitespace-pre-wrap">
            {turn.text}
          </p>
        </div>
        <div
          aria-hidden="true"
          className="w-5 h-5 rounded-full bg-paper-hot border border-rule flex items-center justify-center font-mono text-[9px] font-medium text-tag shrink-0 mt-0.5"
        >
          You
        </div>
      </div>
    );
  }

  if (turn.kind === 'thoughtbed') {
    return (
      <ThoughtbedTurn>
        <p className="font-sans text-[13px] text-ink-soft leading-[1.55] m-0 whitespace-pre-wrap">
          {turn.text}
        </p>
      </ThoughtbedTurn>
    );
  }

  if (turn.kind === 'tool') {
    return (
      <ThoughtbedTurn>
        <div className="rounded-soft border border-rule bg-paper px-3 py-2">
          <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag font-medium m-0 mb-1">
            {turn.label}
          </p>
          <p className="font-sans text-[12px] text-ink-soft leading-[1.55] m-0 whitespace-pre-wrap">
            {turn.body}
          </p>
        </div>
      </ThoughtbedTurn>
    );
  }

  // related — embedded card list under a Thoughtbed turn
  return (
    <>
      <ThoughtbedTurn>
        <p className="font-sans text-[12.5px] text-ink-soft leading-[1.55] m-0">
          {turn.hits.length === 0
            ? `Nothing in your Garden matches "${turn.query}" yet.`
            : `${turn.hits.length} from your Garden on "${turn.query}":`}
        </p>
      </ThoughtbedTurn>
      {turn.hits.map((hit) => {
        const cardId = `related-${turn.id}-${hit.kind}-${hit.id}`;
        return (
          <IdeaCard
            key={cardId}
            hit={hit}
            expanded={expandedCardId === cardId}
            pulled={pulledIdeaIds.has(hit.id)}
            onExpand={() => onExpand(cardId)}
            onCollapse={onCollapse}
            onPull={() => onPull(hit)}
          />
        );
      })}
    </>
  );
}

// Phase 21 slice 8: chat input. Auto-grows up to 6 lines. Enter
// sends; Shift+Enter inserts a newline. IME composition is
// respected so Asian-language input doesn't fire send mid-word.
// Slash-command suggestions could land here next slice.
function ChatInput({
  value,
  composing,
  onChange,
  onCompositionChange,
  onSend,
}: {
  value: string;
  composing: boolean;
  onChange: (next: string) => void;
  onCompositionChange: (next: boolean) => void;
  onSend: () => void;
}) {
  return (
    <div className="border-t border-rule bg-paper px-3 py-2.5 flex items-end gap-2">
      <textarea
        rows={1}
        placeholder="Reply to Thoughtbed… try /related, /hook, /closer"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={() => onCompositionChange(true)}
        onCompositionEnd={() => onCompositionChange(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !composing) {
            e.preventDefault();
            onSend();
          }
        }}
        className="flex-1 resize-none bg-transparent font-sans text-[13px] text-ink leading-[1.55] focus:outline-none placeholder:text-tag/70 max-h-[120px]"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={value.trim().length === 0}
        aria-label="Send"
        title="Send (Enter)"
        className="shrink-0 w-7 h-7 rounded-full bg-ink text-bg flex items-center justify-center hover:bg-accent transition-colors disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed"
      >
        <svg
          width="12"
          height="12"
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
  );
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
