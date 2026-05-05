// Thoughtbed · Spar — Phase 15b home composer (sparring partner)
//
// 2026-05-05. Replaces the Sprint 14 Composer's mode-tabs + textbox
// shape with a hybrid-rhythm sparring view: submit a topic, see what
// the system pulled from your space, get three angles + a follow-up
// question, push back, and either commit to a draft or escape to a
// blank page.
//
// State machine:
//   idle      — initial textarea; user types a topic.
//   thinking  — submit fired; waiting on proposeFromTopic.
//   spar      — proposal returned; angles/outline/question shown.
//                 user can pick an angle, answer the question, or
//                 type their own direction; each submit iterates
//                 (server re-runs retrieval + proposal with
//                 conversationSoFar appended).
//   error     — proposal failed; fallback message + escape-hatch link.
//
// Keyboard:
//   Cmd/Ctrl+Enter submits (idle and spar response box).
//   Escape collapses spar back to idle (only when not pending).
//
// Hand-off:
//   "Open the page" → commitProposal action → /studio/page/[id].
//   "Just open a blank page →" → composeNew { mode: 'self-pilot' }.
//
// Anti-goals (spec): no "Thinking…" spinner without showing what
// was retrieved; no chat-style turn UI; no mode tabs; no emoji.

'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import Link from 'next/link';
import {
  composeNew,
  proposeFromTopic,
  commitProposal,
  draftSection,
  type ProposeFromTopicResult,
  type ProposeAngle,
  type DraftSectionResult,
} from './actions';

type Phase = 'idle' | 'thinking' | 'spar' | 'error';

type ConversationTurn =
  | { kind: 'topic'; text: string }
  | { kind: 'anchor'; angle: string }
  | { kind: 'response'; text: string };

function renderConversation(turns: ConversationTurn[]): string {
  // Compact transcript for the server. Mirrors a sparring rhythm —
  // the topic is the anchor; anchors and responses get a short label.
  const lines: string[] = [];
  for (const t of turns) {
    if (t.kind === 'topic') lines.push(`TOPIC: ${t.text}`);
    if (t.kind === 'anchor') lines.push(`ANCHORED on: ${t.angle}`);
    if (t.kind === 'response') lines.push(`USER: ${t.text}`);
  }
  return lines.join('\n');
}

export function Spar() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [topic, setTopic] = useState('');
  const [response, setResponse] = useState('');
  const [proposal, setProposal] = useState<
    Extract<ProposeFromTopicResult, { ok: true }> | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [platformOverride, setPlatformOverride] = useState<
    'newsletter' | 'linkedin' | null
  >(null);

  // Phase 15a section drafts. Keyed by beatIndex; cleared on Start
  // over / new topic. Persisted into the draft only when the user
  // hits "Open the page" — commitProposal accepts a sections map.
  const [sections, setSections] = useState<Record<number, string>>({});
  const [sectionPendingIndex, setSectionPendingIndex] = useState<
    number | null
  >(null);
  const [sectionError, setSectionError] = useState<{
    beatIndex: number;
    reason: 'no_voice_profile' | 'invalid_input' | 'error';
    message: string;
  } | null>(null);

  const [isSubmitting, startSubmitTransition] = useTransition();
  const [isCommitting, startCommitTransition] = useTransition();
  const [isEscaping, startEscapeTransition] = useTransition();
  const [, startDraftSectionTransition] = useTransition();

  const topicTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const responseTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const propose = useCallback(
    (opts: {
      topic: string;
      conversation: ConversationTurn[];
      platformHint?: 'newsletter' | 'linkedin';
    }) => {
      setPhase('thinking');
      setErrorMessage(null);
      // Outline shape can change between iterations; section indices
      // would drift. Clear sections on every retrieval so they only
      // ever pair with the current outline.
      setSections({});
      setSectionPendingIndex(null);
      setSectionError(null);
      startSubmitTransition(async () => {
        try {
          const res = await proposeFromTopic({
            topic: opts.topic,
            conversationSoFar:
              opts.conversation.length > 1
                ? renderConversation(opts.conversation)
                : undefined,
            platformHint: opts.platformHint,
          });
          if (res.ok) {
            setProposal(res);
            setPhase('spar');
          } else {
            setErrorMessage(res.message);
            setPhase('error');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown';
          setErrorMessage(message);
          setPhase('error');
        }
      });
    },
    []
  );

  const handleTopicSubmit = useCallback(() => {
    const trimmed = topic.trim();
    if (trimmed.length < 3) return;
    const initial: ConversationTurn[] = [{ kind: 'topic', text: trimmed }];
    setConversation(initial);
    setResponse('');
    propose({ topic: trimmed, conversation: initial });
  }, [topic, propose]);

  const handleResponseSubmit = useCallback(() => {
    if (!proposal) return;
    const trimmed = response.trim();
    if (trimmed.length === 0) return;
    const next: ConversationTurn[] = [
      ...conversation,
      { kind: 'response', text: trimmed },
    ];
    setConversation(next);
    setResponse('');
    propose({
      topic: proposal.topic,
      conversation: next,
      platformHint: platformOverride ?? undefined,
    });
  }, [proposal, response, conversation, propose, platformOverride]);

  const anchorAngle = useCallback(
    (angle: ProposeAngle) => {
      if (!proposal) return;
      const next: ConversationTurn[] = [
        ...conversation,
        { kind: 'anchor', angle: angle.line },
      ];
      setConversation(next);
      propose({
        topic: proposal.topic,
        conversation: next,
        platformHint: platformOverride ?? undefined,
      });
    },
    [proposal, conversation, propose, platformOverride]
  );

  const escapeToIdle = useCallback(() => {
    if (isSubmitting || isCommitting) return;
    setPhase('idle');
    setProposal(null);
    setConversation([]);
    setResponse('');
    setErrorMessage(null);
    setPlatformOverride(null);
    setSections({});
    setSectionPendingIndex(null);
    setSectionError(null);
    setTimeout(() => topicTextareaRef.current?.focus(), 0);
  }, [isSubmitting, isCommitting]);

  // Global Escape — collapse the spar view back to idle.
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        escapeToIdle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, escapeToIdle]);

  // When angles land, drop focus on the response textarea — the
  // natural next move is "what would you say back". Only fires on the
  // transition INTO spar so iterations don't yank the cursor away
  // from where the user is reading.
  const enteredSparOnce = useRef(false);
  useEffect(() => {
    if (phase !== 'spar') {
      enteredSparOnce.current = false;
      return;
    }
    if (enteredSparOnce.current) return;
    enteredSparOnce.current = true;
    // Defer past paint so the textarea is mounted.
    const id = setTimeout(() => responseTextareaRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [phase]);

  const onTopicKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isSubmit = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isSubmit) {
        e.preventDefault();
        handleTopicSubmit();
      }
    },
    [handleTopicSubmit]
  );

  const onResponseKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isSubmit = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isSubmit) {
        e.preventDefault();
        handleResponseSubmit();
      }
    },
    [handleResponseSubmit]
  );

  const onDraftBeat = useCallback(
    (beatIndex: number) => {
      if (!proposal) return;
      const platform: 'newsletter' | 'linkedin' =
        platformOverride ??
        (proposal.platformGuess === 'linkedin' ? 'linkedin' : 'newsletter');
      setSectionPendingIndex(beatIndex);
      setSectionError(null);
      startDraftSectionTransition(async () => {
        try {
          const res: DraftSectionResult = await draftSection({
            topic: proposal.topic,
            outline: proposal.outline,
            beatIndex,
            platform,
            conversationSoFar:
              conversation.length > 0
                ? renderConversation(conversation)
                : undefined,
          });
          if (res.ok) {
            setSections((prev) => ({ ...prev, [beatIndex]: res.prose }));
          } else {
            setSectionError({
              beatIndex,
              reason: res.reason,
              message: res.message,
            });
          }
        } catch (err) {
          setSectionError({
            beatIndex,
            reason: 'error',
            message: err instanceof Error ? err.message : 'draft failed',
          });
        } finally {
          setSectionPendingIndex(null);
        }
      });
    },
    [proposal, platformOverride, conversation]
  );

  const onDismissSection = useCallback((beatIndex: number) => {
    setSections((prev) => {
      const next = { ...prev };
      delete next[beatIndex];
      return next;
    });
    setSectionError((prev) =>
      prev?.beatIndex === beatIndex ? null : prev
    );
  }, []);

  const handleOpenPage = useCallback(() => {
    if (!proposal) return;
    const platform: 'newsletter' | 'linkedin' =
      platformOverride ??
      (proposal.platformGuess === 'linkedin' ? 'linkedin' : 'newsletter');
    startCommitTransition(async () => {
      try {
        await commitProposal({
          topic: proposal.topic,
          outline: proposal.outline,
          platform,
          // Phase 15a slice B3 — splice drafted sections under their
          // H2 headers. commitProposal handles the empty-map case.
          sections,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        if (!/NEXT_REDIRECT/.test(message)) {
          console.error('[Spar] commit failed', err);
          setErrorMessage(message);
          setPhase('error');
        }
      }
    });
  }, [proposal, platformOverride, sections]);

  const handleEscapeHatch = useCallback(() => {
    // 'Just open a blank page →' — preserves the Sprint 14 self-pilot
    // path. Doesn't touch the spar conversation; goes straight to a
    // blank draft.
    startEscapeTransition(async () => {
      try {
        await composeNew({ text: '', mode: 'self-pilot' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        if (!/NEXT_REDIRECT/.test(message)) {
          console.error('[Spar] escape-hatch failed', err);
        }
      }
    });
  }, []);

  const trimmedTopic = topic.trim();
  const canSubmitTopic = !isSubmitting && trimmedTopic.length >= 3;

  return (
    <div className="bg-paper rounded-card border border-rule">
      {phase === 'idle' && (
        <IdleView
          textareaRef={topicTextareaRef}
          topic={topic}
          setTopic={setTopic}
          onKeyDown={onTopicKeyDown}
          onSubmit={handleTopicSubmit}
          canSubmit={canSubmitTopic}
          isPending={isSubmitting}
        />
      )}

      {phase === 'thinking' && (
        <ThinkingView
          topic={
            conversation.find((t) => t.kind === 'topic')?.text ?? trimmedTopic
          }
          onCancel={escapeToIdle}
        />
      )}

      {phase === 'spar' && proposal && (
        <SparView
          proposal={proposal}
          conversation={conversation}
          response={response}
          setResponse={setResponse}
          responseTextareaRef={responseTextareaRef}
          onResponseKeyDown={onResponseKeyDown}
          onResponseSubmit={handleResponseSubmit}
          onAnchor={anchorAngle}
          onOpenPage={handleOpenPage}
          onEscape={escapeToIdle}
          isThinking={isSubmitting}
          isCommitting={isCommitting}
          platformOverride={platformOverride}
          setPlatformOverride={setPlatformOverride}
          sections={sections}
          sectionPendingIndex={sectionPendingIndex}
          sectionError={sectionError}
          onDraftBeat={onDraftBeat}
          onDismissSection={onDismissSection}
        />
      )}

      {phase === 'error' && (
        <ErrorView
          message={errorMessage}
          onReset={escapeToIdle}
          onEscapeHatch={handleEscapeHatch}
          isEscaping={isEscaping}
        />
      )}

      {/* Escape hatch — always visible below the surface, including idle */}
      <div className="border-t border-rule px-5 py-3 flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-[0.04em] text-tag">
          {phase === 'idle'
            ? '⌘+Enter to think it through'
            : 'Esc to start over'}
        </p>
        <button
          type="button"
          onClick={handleEscapeHatch}
          disabled={isEscaping}
          className="font-mono text-[11px] tracking-[0.16em] uppercase text-tag hover:text-ink disabled:text-rule transition-colors"
        >
          {isEscaping ? 'Opening…' : 'Just open a blank page →'}
        </button>
      </div>
    </div>
  );
}

// ─── Idle ─────────────────────────────────────

type StarterMode = 'writing' | 'ideas' | 'research';

const STARTERS_BY_MODE: Record<
  StarterMode,
  Array<{ label: string; prefix: string }>
> = {
  writing: [
    { label: 'Write a newsletter about…', prefix: 'Write a newsletter about ' },
    { label: 'Write a LinkedIn post about…', prefix: 'Write a LinkedIn post about ' },
    { label: 'Write a sermon about…', prefix: 'Write a sermon about ' },
    { label: 'Write a blog post about…', prefix: 'Write a blog post about ' },
    { label: 'Write an email about…', prefix: 'Write an email about ' },
    { label: 'Write more like my recent pieces', prefix: 'Write more like my recent pieces' },
  ],
  ideas: [
    { label: 'Help me brainstorm new content angles', prefix: 'Help me brainstorm new content angles on ' },
    { label: 'Search my space for some new ideas', prefix: 'Search my space for new ideas on ' },
    { label: 'What topics haven\'t I covered yet?', prefix: "What topics haven\'t I covered yet around " },
  ],
  research: [
    { label: 'Help me explore a topic before I write about it', prefix: 'Help me explore the topic of ' },
    { label: 'What can you pull from my knowledge on…', prefix: 'What can you pull from my knowledge on ' },
    { label: 'Help me find a fresh angle on…', prefix: 'Help me find a fresh angle on ' },
  ],
};

const MODE_LABELS: Record<StarterMode, string> = {
  writing: 'Writing',
  ideas: 'Ideas',
  research: 'Research',
};

function IdleView({
  textareaRef,
  topic,
  setTopic,
  onKeyDown,
  onSubmit,
  canSubmit,
  isPending,
}: {
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  topic: string;
  setTopic: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  isPending: boolean;
}) {
  const [mode, setMode] = useState<StarterMode>('writing');

  const onStarter = (prefix: string) => {
    setTopic(prefix);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        // Cursor at end so the user types right where the prefix ends.
        const len = prefix.length;
        ta.setSelectionRange(len, len);
      }
    }, 0);
  };

  const starters = STARTERS_BY_MODE[mode];

  return (
    <>
      <textarea
        ref={textareaRef}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={onKeyDown}
        rows={4}
        placeholder="What would you like to write?"
        aria-label="Topic"
        className="w-full resize-none bg-transparent px-5 pt-5 pb-2 font-sans text-[16px] leading-[1.55] text-ink placeholder:text-tag focus:outline-none"
      />

      {/* Mode chips + arrow send button */}
      <div className="flex items-center gap-2 px-5 pb-4 pt-1">
        <div role="tablist" aria-label="Starter mode" className="flex items-center gap-1.5 flex-1 min-w-0">
          {(Object.keys(STARTERS_BY_MODE) as StarterMode[]).map((m) => {
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setMode(m)}
                className={`font-sans text-[12.5px] rounded-soft px-3 py-1.5 transition-colors ${
                  selected
                    ? 'bg-ink text-bg'
                    : 'bg-transparent text-tag hover:text-ink hover:bg-paper-2'
                }`}
              >
                {MODE_LABELS[m]}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          aria-label={isPending ? 'Thinking' : 'Send'}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {isPending ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.2-8.55" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </div>

      {/* Starter list per active mode */}
      <div className="border-t border-rule">
        <ul className="divide-y divide-rule">
          {starters.map((p) => (
            <li key={p.label}>
              <button
                type="button"
                onClick={() => onStarter(p.prefix)}
                className="w-full flex items-baseline justify-between gap-3 px-5 py-3 text-left hover:bg-paper-2 transition-colors group"
              >
                <span className="font-sans text-[14px] text-ink leading-[1.4]">
                  {p.label}
                </span>
                <span
                  className="font-mono text-[11px] text-tag group-hover:text-ink transition-colors"
                  aria-hidden
                >
                  ↗
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ─── Thinking ─────────────────────────────────

function ThinkingView({
  topic,
  onCancel,
}: {
  topic: string;
  onCancel: () => void;
}) {
  return (
    <div className="px-5 py-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
          Thinking
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
        >
          Cancel
        </button>
      </div>
      <p className="font-sans text-[15px] text-ink leading-[1.55] mb-3">
        {topic}
      </p>
      <p className="font-sans text-[13px] italic text-ink-soft leading-[1.55]">
        Pulling from your space…
      </p>
    </div>
  );
}

// ─── Spar ────────────────────────────────────

function SparView({
  proposal,
  conversation,
  response,
  setResponse,
  responseTextareaRef,
  onResponseKeyDown,
  onResponseSubmit,
  onAnchor,
  onOpenPage,
  onEscape,
  isThinking,
  isCommitting,
  platformOverride,
  setPlatformOverride,
  sections,
  sectionPendingIndex,
  sectionError,
  onDraftBeat,
  onDismissSection,
}: {
  proposal: Extract<ProposeFromTopicResult, { ok: true }>;
  conversation: ConversationTurn[];
  response: string;
  setResponse: (v: string) => void;
  responseTextareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onResponseKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onResponseSubmit: () => void;
  onAnchor: (a: ProposeAngle) => void;
  onOpenPage: () => void;
  onEscape: () => void;
  isThinking: boolean;
  isCommitting: boolean;
  platformOverride: 'newsletter' | 'linkedin' | null;
  setPlatformOverride: (p: 'newsletter' | 'linkedin' | null) => void;
  sections: Record<number, string>;
  sectionPendingIndex: number | null;
  sectionError:
    | { beatIndex: number; reason: 'no_voice_profile' | 'invalid_input' | 'error'; message: string }
    | null;
  onDraftBeat: (beatIndex: number) => void;
  onDismissSection: (beatIndex: number) => void;
}) {
  const platform: 'newsletter' | 'linkedin' =
    platformOverride ??
    (proposal.platformGuess === 'linkedin' ? 'linkedin' : 'newsletter');
  const platformAmbiguous =
    !platformOverride && proposal.platformGuess === 'unknown';

  const trimmedResponse = response.trim();
  const canSubmitResponse = !isThinking && trimmedResponse.length > 0;

  return (
    <div className="px-5 py-5">
      {/* Topic + visible thinking */}
      <div className="mb-5">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className="font-sans text-[15px] text-ink leading-[1.45] flex-1">
            {proposal.topic}
          </p>
          <button
            type="button"
            onClick={onEscape}
            className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors whitespace-nowrap"
          >
            Start over
          </button>
        </div>

        {(proposal.visibleThinking.lines.length > 0 ||
          proposal.visibleThinking.summary) && (
          <div
            className="mt-3 border-l-2 border-rule pl-4"
            aria-live="polite"
            aria-atomic="true"
          >
            {proposal.visibleThinking.summary && (
              <p className="font-sans text-[13.5px] italic text-ink-soft leading-[1.55] mb-2">
                {proposal.visibleThinking.summary}
              </p>
            )}
            {proposal.visibleThinking.lines.length > 0 && (
              <ul className="font-sans text-[12.5px] text-ink-soft leading-[1.5] space-y-0.5">
                {proposal.visibleThinking.lines.map((line, i) => (
                  <li key={i}>— {line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {proposal.retrievalCount === 0 && (
          <p className="mt-3 font-sans text-[12.5px] text-tag leading-[1.5] italic">
            You don&apos;t have much in your space on this yet — leaning
            on the topic itself.
          </p>
        )}
      </div>

      {/* Angles */}
      {proposal.angles.length > 0 && (
        <div className="mb-5">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            Angles
          </h3>
          <ul className="flex flex-col gap-2">
            {proposal.angles.map((a, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onAnchor(a)}
                  disabled={isThinking}
                  className="w-full text-left rounded-soft border border-rule bg-paper hover:border-ink/40 hover:bg-paper-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors px-4 py-3"
                >
                  <p className="font-sans text-[14px] text-ink leading-[1.45]">
                    {a.line}
                  </p>
                  {a.sources.length > 0 && (
                    <p className="font-mono text-[10px] tracking-[0.04em] text-tag mt-1.5 leading-[1.4]">
                      from{' '}
                      {a.sources
                        .map(
                          (s) =>
                            `${s.label}${s.title ? ` "${s.title}"` : ''}`
                        )
                        .join(' + ')}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Outline */}
      {proposal.outline.length > 0 && (
        <div className="mb-5">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            Outline
          </h3>
          <ol className="flex flex-col gap-3 list-none">
            {proposal.outline.map((b, i) => (
              <BeatRow
                key={i}
                index={i}
                beat={b.beat}
                drafted={sections[i]}
                isPending={sectionPendingIndex === i}
                error={
                  sectionError?.beatIndex === i ? sectionError : null
                }
                onDraft={() => onDraftBeat(i)}
                onDismiss={() => onDismissSection(i)}
                disableDraftButton={isThinking || isCommitting}
              />
            ))}
          </ol>
          {Object.keys(sections).length > 0 && (
            <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-tag italic">
              Drafted sections will land under their headings when you
              open the page.
            </p>
          )}
        </div>
      )}

      {/* Follow-up question + response */}
      {proposal.followUpQuestion && (
        <div className="mb-5 rounded-soft bg-paper-2 px-4 py-3">
          <p className="font-sans text-[13.5px] text-ink leading-[1.5] mb-2 font-medium">
            {proposal.followUpQuestion}
          </p>
          <textarea
            ref={responseTextareaRef}
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            onKeyDown={onResponseKeyDown}
            rows={2}
            placeholder="Answer, push back, or type your own direction…"
            aria-label="Response"
            disabled={isThinking}
            className="w-full resize-none bg-transparent font-sans text-[13.5px] leading-[1.5] text-ink placeholder:text-tag focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between mt-1">
            <p className="font-mono text-[10px] tracking-[0.04em] text-tag">
              ⌘+Enter
            </p>
            <button
              type="button"
              onClick={onResponseSubmit}
              disabled={!canSubmitResponse}
              className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed transition-colors"
            >
              {isThinking ? 'Thinking…' : 'Reply'}
            </button>
          </div>
        </div>
      )}

      {/* Platform hint when ambiguous */}
      {platformAmbiguous && (
        <div className="mb-4 flex items-center gap-2">
          <p className="font-mono text-[10px] tracking-[0.04em] uppercase text-tag flex-1">
            Platform
          </p>
          <button
            type="button"
            onClick={() => setPlatformOverride('newsletter')}
            className="font-mono text-[10px] tracking-[0.14em] uppercase rounded-soft px-3 py-1 border border-rule hover:border-ink hover:bg-paper-2 transition-colors"
          >
            Newsletter
          </button>
          <button
            type="button"
            onClick={() => setPlatformOverride('linkedin')}
            className="font-mono text-[10px] tracking-[0.14em] uppercase rounded-soft px-3 py-1 border border-rule hover:border-ink hover:bg-paper-2 transition-colors"
          >
            LinkedIn
          </button>
        </div>
      )}

      {/* Open the page */}
      <div className="flex items-center gap-3 pt-2">
        <p className="font-sans text-[12.5px] text-tag flex-1 min-w-0">
          When you&apos;re ready, open the page with this outline as
          section headers.
        </p>
        <button
          type="button"
          onClick={onOpenPage}
          disabled={isCommitting || isThinking}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
        >
          {isCommitting ? 'Opening…' : `Open the page (${platform})`}
        </button>
      </div>
    </div>
  );
}

// ─── Beat row (with optional drafted section) ─────

function BeatRow({
  index,
  beat,
  drafted,
  isPending,
  error,
  onDraft,
  onDismiss,
  disableDraftButton,
}: {
  index: number;
  beat: string;
  drafted: string | undefined;
  isPending: boolean;
  error: { reason: 'no_voice_profile' | 'invalid_input' | 'error'; message: string } | null;
  onDraft: () => void;
  onDismiss: () => void;
  disableDraftButton: boolean;
}) {
  return (
    <li className="">
      <div className="grid grid-cols-[24px_1fr_auto] gap-2 items-baseline">
        <span className="font-mono text-[10px] tracking-[0.04em] text-tag pt-1">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="font-sans text-[14px] text-ink leading-[1.45]">
          {beat}
        </span>
        {!drafted && !isPending && (
          <button
            type="button"
            onClick={onDraft}
            disabled={disableDraftButton}
            className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1 border border-rule hover:border-ink hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            Draft section
          </button>
        )}
        {isPending && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag whitespace-nowrap">
            Drafting…
          </span>
        )}
      </div>

      {error && (
        <div className="ml-[32px] mt-2 rounded-soft border border-rule bg-paper-2 px-3 py-2">
          <p className="font-sans text-[12.5px] text-ink leading-[1.5]">
            {error.message}
          </p>
          {error.reason === 'no_voice_profile' && (
            <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] mt-1">
              <Link
                href="/studio/voice"
                className="underline underline-offset-2 hover:text-ink"
              >
                Build a voice profile →
              </Link>
            </p>
          )}
        </div>
      )}

      {drafted && (
        <div className="ml-[32px] mt-2 rounded-soft border border-rule bg-paper-2">
          <div className="px-4 py-3 border-b border-rule flex items-baseline justify-between gap-3">
            <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag">
              Draft · in your voice
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onDraft}
                disabled={disableDraftButton}
                className="font-mono text-[9px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
              >
                Redraft
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="font-mono text-[9px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
          <div className="px-4 py-3">
            {drafted.split(/\n\s*\n/).map((para, i) => (
              <p
                key={i}
                className="font-sans text-[13.5px] text-ink leading-[1.6] mb-2 last:mb-0 whitespace-pre-wrap"
              >
                {para.trim()}
              </p>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

// ─── Error ────────────────────────────────────

function ErrorView({
  message,
  onReset,
  onEscapeHatch,
  isEscaping,
}: {
  message: string | null;
  onReset: () => void;
  onEscapeHatch: () => void;
  isEscaping: boolean;
}) {
  return (
    <div className="px-5 py-6">
      <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        Something went wrong
      </h3>
      <p className="font-sans text-[14px] text-ink leading-[1.55] mb-4">
        {message ??
          "The partner didn't come back. Try once more, or open a blank page."}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onReset}
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 border border-rule hover:border-ink hover:bg-paper-2 transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onEscapeHatch}
          disabled={isEscaping}
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag transition-colors"
        >
          {isEscaping ? 'Opening…' : 'Blank page'}
        </button>
      </div>
    </div>
  );
}
