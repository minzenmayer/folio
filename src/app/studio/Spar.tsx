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
  useMemo,
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
  draftBeat,
  type ProposeFromTopicResult,
  type ProposeAngle,
  type DraftSectionResult,
  type DraftBeatResult,
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
  // Phase 16 (2026-05-05): per-beat user intent + UI expansion state
  // for the new "what do you want to say here?" input. Anchored beats
  // (separate from drafted) are tracked in a Set; clicking a beat pill
  // body anchors / unanchors. usedFallbackVoice flags beats whose
  // draft was generated without a voice profile so the UI can show a
  // soft "Build voice profile to refine →" note.
  const [beatIntents, setBeatIntents] = useState<Record<number, string>>({});
  const [beatExpanded, setBeatExpanded] = useState<Set<number>>(new Set());
  const [anchoredBeats, setAnchoredBeats] = useState<Set<number>>(new Set());
  const [beatFallbackVoice, setBeatFallbackVoice] = useState<Set<number>>(
    new Set()
  );

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
      // Phase 16: same drift problem applies to beat intents +
      // expansion + anchors + voice-fallback flags. Clear on each
      // retrieval so they only pair with the current outline.
      setBeatIntents({});
      setBeatExpanded(new Set());
      setAnchoredBeats(new Set());
      setBeatFallbackVoice(new Set());
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
      // Toggle anchor — clicking the same angle again unanchors. Don't
      // re-fire propose; the spar stays where it is. Iteration only
      // happens when the user hits Reply, so 'click an angle' becomes
      // a deliberate selection move rather than a context-blowing jolt.
      setConversation((prev) => {
        const already = prev.some(
          (t) => t.kind === 'anchor' && t.angle === angle.line
        );
        if (already) {
          return prev.filter(
            (t) => !(t.kind === 'anchor' && t.angle === angle.line)
          );
        }
        return [...prev, { kind: 'anchor', angle: angle.line }];
      });
    },
    [proposal]
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
    setBeatIntents({});
    setBeatExpanded(new Set());
    setAnchoredBeats(new Set());
    setBeatFallbackVoice(new Set());
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
    setBeatFallbackVoice((prev) => {
      if (!prev.has(beatIndex)) return prev;
      const next = new Set(prev);
      next.delete(beatIndex);
      return next;
    });
  }, []);

  // Phase 16 — beat anchoring is independent of drafting. Click a
  // beat pill body to anchor / unanchor; anchored beats survive
  // regenerateOutline (slice 4) and render filled in the plan ribbon
  // (slice 6). For now the state lives only in client memory + carries
  // into commitProposal (slice 5) via the data-tb-beat-status attr.
  const toggleAnchorBeat = useCallback((beatIndex: number) => {
    setAnchoredBeats((prev) => {
      const next = new Set(prev);
      if (next.has(beatIndex)) next.delete(beatIndex);
      else next.add(beatIndex);
      return next;
    });
  }, []);

  // Expand / collapse the per-beat intent input ("what do you want
  // to say here?"). Expanding a beat does NOT auto-anchor it — the
  // user can still anchor via the pill body click — but it DOES
  // pre-create an empty intent string so the controlled textarea
  // stays controlled even before the first keystroke.
  const toggleExpandBeat = useCallback((beatIndex: number) => {
    setBeatExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(beatIndex)) next.delete(beatIndex);
      else next.add(beatIndex);
      return next;
    });
    setBeatIntents((prev) =>
      prev[beatIndex] !== undefined ? prev : { ...prev, [beatIndex]: '' }
    );
  }, []);

  const setBeatIntent = useCallback((beatIndex: number, text: string) => {
    setBeatIntents((prev) => ({ ...prev, [beatIndex]: text }));
  }, []);

  // Phase 16 primary draft path. Submit fires draftBeat with the user's
  // stated intent. On success, splice prose into sections; on soft
  // fallback (no voice profile), flag the beat so the UI can render
  // the "Build voice profile to refine →" note.
  const onSubmitBeatIntent = useCallback(
    (beatIndex: number) => {
      if (!proposal) return;
      const intent = (beatIntents[beatIndex] ?? '').trim();
      if (intent.length === 0) return;
      const platform: 'newsletter' | 'linkedin' =
        platformOverride ??
        (proposal.platformGuess === 'linkedin' ? 'linkedin' : 'newsletter');
      setSectionPendingIndex(beatIndex);
      setSectionError(null);
      startDraftSectionTransition(async () => {
        try {
          const res: DraftBeatResult = await draftBeat({
            topic: proposal.topic,
            outline: proposal.outline,
            beatIndex,
            platform,
            userIntent: intent,
            conversationSoFar:
              conversation.length > 0
                ? renderConversation(conversation)
                : undefined,
          });
          if (res.ok) {
            setSections((prev) => ({ ...prev, [beatIndex]: res.prose }));
            setBeatExpanded((prev) => {
              const next = new Set(prev);
              next.delete(beatIndex);
              return next;
            });
            setBeatFallbackVoice((prev) => {
              const next = new Set(prev);
              if (res.usedFallbackVoice) next.add(beatIndex);
              else next.delete(beatIndex);
              return next;
            });
          } else {
            setSectionError({
              beatIndex,
              // draftBeat doesn't surface no_voice_profile (soft fallback);
              // collapse its reasons onto the existing union.
              reason: res.reason === 'invalid_input' ? 'invalid_input' : 'error',
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
    [proposal, platformOverride, conversation, beatIntents]
  );

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

  const anchoredAngles = useMemo(() => {
    const s = new Set<string>();
    for (const t of conversation) {
      if (t.kind === 'anchor') s.add(t.angle);
    }
    return s;
  }, [conversation]);

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
          anchoredAngles={anchoredAngles}
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
          beatIntents={beatIntents}
          setBeatIntent={setBeatIntent}
          beatExpanded={beatExpanded}
          toggleExpandBeat={toggleExpandBeat}
          anchoredBeats={anchoredBeats}
          toggleAnchorBeat={toggleAnchorBeat}
          beatFallbackVoice={beatFallbackVoice}
          onSubmitBeatIntent={onSubmitBeatIntent}
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
  const [mode, setMode] = useState<StarterMode | null>(null);

  const togglePill = (m: StarterMode) => {
    setMode((prev) => (prev === m ? null : m));
  };

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

  const starters = mode ? STARTERS_BY_MODE[mode] : [];

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

      {/* Mode pills + arrow send button.
          Pills are dropdown toggles. No pill active = no starter
          list shown (tight composer). Click a pill to open its
          starter list below; click again to close. Active pill is
          rounded-full with light-green fill + dark-green outline. */}
      <div className="flex items-center gap-2 px-5 pb-4 pt-1">
        <div role="tablist" aria-label="Starter mode" className="flex items-center gap-2 flex-1 min-w-0">
          {(Object.keys(STARTERS_BY_MODE) as StarterMode[]).map((m) => {
            const active = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                aria-expanded={active}
                onClick={() => togglePill(m)}
                className={`flex items-center gap-1.5 font-sans text-[12.5px] rounded-full border px-3 py-1.5 transition-colors ${
                  active
                    ? 'bg-[#dcfce7] border-[#15803d] text-[#14532d]'
                    : 'bg-paper border-rule text-tag hover:text-ink hover:border-ink/40 hover:bg-paper-2'
                }`}
              >
                <ModeIcon mode={m} />
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

      {/* Starter list — only shown when a pill is active. Empty
          state (mode === null) keeps the composer tight. */}
      {mode !== null && (
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
      )}
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
  anchoredAngles,
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
  beatIntents,
  setBeatIntent,
  beatExpanded,
  toggleExpandBeat,
  anchoredBeats,
  toggleAnchorBeat,
  beatFallbackVoice,
  onSubmitBeatIntent,
}: {
  proposal: Extract<ProposeFromTopicResult, { ok: true }>;
  conversation: ConversationTurn[];
  response: string;
  setResponse: (v: string) => void;
  responseTextareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onResponseKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onResponseSubmit: () => void;
  onAnchor: (a: ProposeAngle) => void;
  anchoredAngles: Set<string>;
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
  beatIntents: Record<number, string>;
  setBeatIntent: (beatIndex: number, text: string) => void;
  beatExpanded: Set<number>;
  toggleExpandBeat: (beatIndex: number) => void;
  anchoredBeats: Set<number>;
  toggleAnchorBeat: (beatIndex: number) => void;
  beatFallbackVoice: Set<number>;
  onSubmitBeatIntent: (beatIndex: number) => void;
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

        {proposal.visibleThinking.summary && (
          <div
            className="mt-3 border-l-2 border-rule pl-4"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="font-sans text-[13.5px] italic text-ink-soft leading-[1.55] mb-2">
              {proposal.visibleThinking.summary}
            </p>
            {/* Phase 16 (2026-05-05): drop the bulleted breakdown.
                Real-use feedback was that '3 ideas in your garden /
                1 of your CSL issues' read as heavy. A small icon row
                signals source breadth without enumerating each count.
                Each icon's title attribute carries the count for
                hover and screen readers. */}
            <SourceIconRow counts={proposal.visibleThinking.kindCounts} />
          </div>
        )}
        {proposal.retrievalCount === 0 && (
          <p className="mt-3 font-sans text-[12.5px] text-tag leading-[1.5] italic">
            Not much in your space on this yet. Leaning on the topic
            itself.
          </p>
        )}
      </div>

      {/* Anchored chips — visible record of what the user has selected.
          Click to unanchor. */}
      {anchoredAngles.size > 0 && (
        <div className="mb-4 flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium">
            Anchored
          </span>
          {Array.from(anchoredAngles).map((line) => (
            <button
              key={line}
              type="button"
              onClick={() => {
                const angle = proposal.angles.find((a) => a.line === line);
                if (angle) onAnchor(angle);
              }}
              className="font-sans text-[12px] rounded-full border bg-[#dcfce7] border-[#15803d] text-[#14532d] px-3 py-1 hover:opacity-80 transition-opacity"
              title="Click to unanchor"
            >
              {line.length > 80 ? line.slice(0, 80) + '…' : line}
              <span className="ml-1.5 font-mono text-[10px]">×</span>
            </button>
          ))}
        </div>
      )}

      {/* Angles — Phase 16 zone: subtle card + slot icon header. */}
      {proposal.angles.length > 0 && (
        <section className="mb-8 rounded-soft bg-paper-2 border border-rule px-4 py-4">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3 flex items-center gap-2">
            <ZoneIcon kind="angles" />
            Angles
          </h3>
          <ul className="flex flex-col gap-2">
            {proposal.angles.map((a, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onAnchor(a)}
                  disabled={isThinking}
                  aria-pressed={anchoredAngles.has(a.line)}
                  className={`w-full text-left rounded-soft border transition-colors px-4 py-3 disabled:opacity-60 disabled:cursor-not-allowed ${
                    anchoredAngles.has(a.line)
                      ? 'bg-[#dcfce7] border-[#15803d]'
                      : 'bg-paper border-rule hover:border-ink/40 hover:bg-paper-2'
                  }`}
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
        </section>
      )}

      {/* Outline — Phase 16 zone: clean paper card + numbered-list icon. */}
      {proposal.outline.length > 0 && (
        <section className="mb-8 rounded-soft bg-paper border border-rule px-4 py-4">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3 flex items-center gap-2">
            <ZoneIcon kind="outline" />
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
                onDraftAnyway={() => onDraftBeat(i)}
                onDismiss={() => onDismissSection(i)}
                disableDraftButton={isThinking || isCommitting}
                isAnchored={anchoredBeats.has(i)}
                onToggleAnchor={() => toggleAnchorBeat(i)}
                isExpanded={beatExpanded.has(i)}
                onToggleExpand={() => toggleExpandBeat(i)}
                intentText={beatIntents[i] ?? ''}
                onIntentChange={(t) => setBeatIntent(i, t)}
                onSubmitIntent={() => onSubmitBeatIntent(i)}
                usedFallbackVoice={beatFallbackVoice.has(i)}
              />
            ))}
          </ol>
          {Object.keys(sections).length > 0 && (
            <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-tag italic">
              Drafted sections will land under their headings when you
              open the page.
            </p>
          )}
        </section>
      )}

      {/* Follow-up question + response — Phase 16 zone: paper-3 fill + question icon. */}
      {proposal.followUpQuestion && (
        <section className="mb-8 rounded-soft bg-paper-3 px-4 py-3">
          <div className="flex items-baseline gap-2 mb-1">
            <ZoneIcon kind="question" />
            <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
              Keep going
            </span>
          </div>
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
        </section>
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

// ─── Beat row — Phase 16 pill shape with intent input + drafted card ──
//
// 2026-05-05. Replaces the Phase 15a Draft-section button with a
// pill-shaped beat row + per-piece micro-drafting flow:
//
//   [01] beat text                           ⚑   →
//        ↑ click body to anchor              ↑   ↑
//        (anchored beats survive rethink)    │   click chevron to
//                                             │   open intent input
//                                             green dot when anchored
//
// Expanded state slides an inline textarea under the beat:
//   "What do you want to say here?"
//   [Submit] [Draft anyway] [Cancel]
//
// Drafted state shows a card under the pill with Refine / Redraft /
// Dismiss controls. Refine reopens the intent input pre-filled.
//
// "Draft anyway" is the legacy no-intent path (calls draftSection
// via onDraftAnyway), retained for users who want a take without
// supplying intent first.

function BeatRow({
  index,
  beat,
  drafted,
  isPending,
  error,
  onDraftAnyway,
  onDismiss,
  disableDraftButton,
  isAnchored,
  onToggleAnchor,
  isExpanded,
  onToggleExpand,
  intentText,
  onIntentChange,
  onSubmitIntent,
  usedFallbackVoice,
}: {
  index: number;
  beat: string;
  drafted: string | undefined;
  isPending: boolean;
  error: { reason: 'no_voice_profile' | 'invalid_input' | 'error'; message: string } | null;
  onDraftAnyway: () => void;
  onDismiss: () => void;
  disableDraftButton: boolean;
  isAnchored: boolean;
  onToggleAnchor: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  intentText: string;
  onIntentChange: (t: string) => void;
  onSubmitIntent: () => void;
  usedFallbackVoice: boolean;
}) {
  const intentTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmedIntent = intentText.trim();

  // Focus the textarea on expand. Mirrors the pattern used elsewhere
  // in the file (response textarea in SparView). Defer past paint so
  // the element is mounted.
  useEffect(() => {
    if (!isExpanded) return;
    const id = setTimeout(() => intentTextareaRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [isExpanded]);

  const onIntentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (trimmedIntent.length > 0 && !disableDraftButton) onSubmitIntent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onToggleExpand();
    }
  };

  // Anchored / pending fill states. Anchored uses the same green
  // palette as anchored angle pills so the visual language matches.
  const pillFill = isAnchored
    ? 'bg-[#dcfce7] border-[#15803d]'
    : isExpanded
      ? 'bg-paper-2 border-rule-strong'
      : 'bg-paper border-rule hover:border-ink/40 hover:bg-paper-2';

  return (
    <li>
      {/* Pill row — body click toggles anchor; chevron toggles intent input. */}
      <div
        className={`grid grid-cols-[28px_1fr_auto] gap-2 items-center rounded-soft border transition-colors ${pillFill} px-3 py-2`}
      >
        <span className="font-mono text-[10px] tracking-[0.04em] text-tag font-medium">
          {String(index + 1).padStart(2, '0')}
        </span>

        <button
          type="button"
          onClick={onToggleAnchor}
          aria-pressed={isAnchored}
          disabled={disableDraftButton}
          className="text-left font-sans text-[14px] text-ink leading-[1.45] disabled:cursor-not-allowed break-words"
          title={isAnchored ? 'Click to unanchor' : 'Click to anchor this beat'}
        >
          {beat}
        </button>

        {!drafted && !isPending && (
          <button
            type="button"
            onClick={onToggleExpand}
            disabled={disableDraftButton}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Close intent input' : 'Add your thoughts to this beat'}
            title={isExpanded ? 'Close' : 'Add your thoughts'}
            className={`font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-2.5 py-1 border transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
              isExpanded
                ? 'bg-paper-3 border-rule-strong text-ink'
                : 'bg-paper border-rule text-tag hover:border-ink hover:text-ink hover:bg-paper-2'
            }`}
          >
            {isExpanded ? 'Close' : '+ Write'}
          </button>
        )}
        {isPending && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag whitespace-nowrap">
            Drafting…
          </span>
        )}
        {drafted && !isPending && (
          <span
            className="font-mono text-[12px] text-[#15803d]"
            aria-label="Drafted"
            title="Drafted"
          >
            ✓
          </span>
        )}
      </div>

      {/* Intent input — slides under the beat when expanded. */}
      {isExpanded && !drafted && (
        <div className="ml-[32px] mt-2 rounded-soft bg-paper-2 border border-rule px-3 py-2">
          <p className="font-sans text-[12.5px] text-ink leading-[1.4] mb-1.5 font-medium">
            What do you want to say here?
          </p>
          <textarea
            ref={intentTextareaRef}
            value={intentText}
            onChange={(e) => onIntentChange(e.target.value)}
            onKeyDown={onIntentKeyDown}
            rows={2}
            placeholder="The point you want this beat to make…"
            aria-label="Intent for this beat"
            disabled={isPending || disableDraftButton}
            className="w-full resize-none bg-transparent font-sans text-[13px] leading-[1.5] text-ink placeholder:text-tag focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between mt-1 gap-3">
            <p className="font-mono text-[10px] tracking-[0.04em] text-tag">
              ⌘+Enter
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDraftAnyway}
                disabled={disableDraftButton || isPending}
                title="Draft without supplying intent (uses voice profile only)"
                className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink disabled:opacity-50 transition-colors"
              >
                Draft anyway
              </button>
              <button
                type="button"
                onClick={onSubmitIntent}
                disabled={
                  trimmedIntent.length === 0 || disableDraftButton || isPending
                }
                className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1 bg-ink text-bg hover:bg-ink-soft disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed transition-colors"
              >
                {isPending ? 'Drafting…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                onClick={onToggleExpand}
                disabled={disableDraftButton}
                title="Reopen intent input to refine"
                className="font-mono text-[9px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
              >
                Refine
              </button>
              <button
                type="button"
                onClick={onDraftAnyway}
                disabled={disableDraftButton}
                title="Regenerate without intent"
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
            {usedFallbackVoice && (
              <p className="font-sans text-[12px] text-tag leading-[1.5] mt-2 italic">
                No voice profile yet — drafted from retrieval +
                intent. <Link href="/studio/voice" className="underline underline-offset-2 hover:text-ink">Build voice profile to refine →</Link>
              </p>
            )}
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

// ─── Mode icons ────────────────────────────────
//
// Tiny inline SVGs next to each mode chip. 14px, currentColor so
// they pick up the chip's text color (bg when selected, tag/ink on
// hover otherwise). Lucide-shape pencil / sprout / globe.

function ModeIcon({ mode }: { mode: StarterMode }) {
  const props = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (mode === 'writing') {
    return (
      <svg {...props}>
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        <path d="m15 5 4 4" />
      </svg>
    );
  }
  if (mode === 'ideas') {
    return (
      <svg {...props}>
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
        <path d="M9 18h6" />
        <path d="M10 22h4" />
      </svg>
    );
  }
  // research → globe
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

// ─── Zone icons ────────────────────────────────
//
// Phase 16 (2026-05-05). Tiny line-only icons at each zone header so
// Angles / Outline / Keep going read as structurally distinct rather
// than as one paper-on-paper word wall. 12px, currentColor — pick up
// the header's `text-tag`. Lucide-shape: flag / list / help-circle.

function ZoneIcon({ kind }: { kind: 'angles' | 'outline' | 'question' }) {
  const props = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'angles') {
    return (
      <svg {...props}>
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    );
  }
  if (kind === 'outline') {
    return (
      <svg {...props}>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    );
  }
  // question → help-circle
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// ─── Source icon row — Phase 16 visible-thinking ──────────
//
// 2026-05-05. Replaces the bulleted "3 ideas / 1 CSL issue / 4 vault"
// breakdown under the visible-thinking summary with a tighter row of
// small mono-line icons — one per source kind that contributed > 0
// hits. Each icon's title attribute carries the count for hover /
// screen-reader confirmation. Real-use feedback after slice 2 push:
// the bullets read as heavy; a row of icons signals depth without
// enumerating every count.

function SourceIconRow({
  counts,
}: {
  counts: {
    ideas: number;
    cslIssues: number;
    linkedin: number;
    vault: number;
    gmail: number;
  };
}) {
  const present: Array<{
    key: keyof typeof counts;
    label: string;
    count: number;
  }> = [
    { key: 'ideas', label: 'Garden ideas', count: counts.ideas },
    { key: 'cslIssues', label: 'CSL issues', count: counts.cslIssues },
    { key: 'linkedin', label: 'LinkedIn posts', count: counts.linkedin },
    { key: 'vault', label: 'Vault notes', count: counts.vault },
    { key: 'gmail', label: 'Newsletters you read', count: counts.gmail },
  ].filter((item) => item.count > 0);

  if (present.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 mt-1"
      aria-label="Sources drawn from your space"
    >
      {present.map(({ key, label, count }) => (
        <span
          key={key}
          title={`${count} ${label.toLowerCase()}`}
          className="inline-flex items-center justify-center w-6 h-6 rounded-soft border border-rule bg-paper text-tag"
        >
          <SourceIcon kind={key} />
        </span>
      ))}
    </div>
  );
}

function SourceIcon({
  kind,
}: {
  kind: 'ideas' | 'cslIssues' | 'linkedin' | 'vault' | 'gmail';
}) {
  const props = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'ideas') {
    // lightbulb (matches the existing 'ideas' mode pill icon shape)
    return (
      <svg {...props}>
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
        <path d="M9 18h6" />
        <path d="M10 22h4" />
      </svg>
    );
  }
  if (kind === 'cslIssues') {
    // newspaper / mail
    return (
      <svg {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <line x1="7" y1="9" x2="17" y2="9" />
        <line x1="7" y1="13" x2="17" y2="13" />
        <line x1="7" y1="17" x2="13" y2="17" />
      </svg>
    );
  }
  if (kind === 'linkedin') {
    // small "in" mark — square with two posts
    return (
      <svg {...props}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="8" y1="11" x2="8" y2="16" />
        <line x1="8" y1="8" x2="8.01" y2="8" />
        <path d="M12 16v-3a2 2 0 0 1 4 0v3" />
        <line x1="12" y1="11" x2="12" y2="16" />
      </svg>
    );
  }
  if (kind === 'vault') {
    // book / notebook
    return (
      <svg {...props}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  // gmail → @ inbox
  return (
    <svg {...props}>
      <path d="M22 12c0 5.5-4.5 10-10 10S2 17.5 2 12 6.5 2 12 2c5 0 9 3.5 9.5 8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v6a2 2 0 0 0 4 0" />
    </svg>
  );
}
