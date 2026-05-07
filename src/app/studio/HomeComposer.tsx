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

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  proposeFromTopic,
  regenerateAngles,
  commitProposal,
  type ProposeFromTopicResult,
  type ProposeAngle,
} from './actions';

type Mode = 'with-assistant' | 'beside' | 'self-driving';
type Path = 'writing' | 'ideation';
// Phase 23 v2 slice 4 (2026-05-06): the homepage transitions through
// these stages on a Writing × With-assistant submit. Other path × mode
// combinations stay in 'default' for now and surface a placeholder.
type Stage = 'default' | 'thinking' | 'thread' | 'coaching' | 'error';

// Phase 23 v2 slice 4.5 (2026-05-06): each turn in the coaching
// thread. user turns are plain text; assistant turns carry the
// proposeFromTopic structured result so angles render inline.
type CoachTurn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; proposal: SparProposal };

// Narrow the success branch out so JSX can rely on the angles/outline/
// question fields without re-checking ok every render.
type SparProposal = Extract<ProposeFromTopicResult, { ok: true }>;

const MODE_LABEL: Record<Mode, string> = {
  'with-assistant': 'With assistant',
  beside: 'Beside me',
  'self-driving': 'Self-driving',
};

const MODE_DESCRIPTION: Record<Mode, string> = {
  'with-assistant': 'Chat-based writing',
  beside: 'Blank editor, ideas alongside',
  'self-driving': 'I draft on my own',
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
  const [stage, setStage] = useState<Stage>('default');
  const [proposal, setProposal] = useState<SparProposal | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submittedTopic, setSubmittedTopic] = useState<string>('');
  const [selectedAngleIndex, setSelectedAngleIndex] = useState<number | null>(
    null
  );
  const [replyText, setReplyText] = useState<string>('');
  const [coachTurns, setCoachTurns] = useState<CoachTurn[]>([]);
  const [isProposing, startProposeTransition] = useTransition();
  const [isRegenerating, startRegenTransition] = useTransition();
  const [isCommitting, startCommitTransition] = useTransition();

  // Phase 23 v2 slice 4.5 (2026-05-06): the studio sidebar hides
  // while the coaching stage is active. We toggle the body class
  // and clean up on unmount / stage change so the sidebar always
  // returns when the user steps out of coaching.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (stage === 'coaching') {
      document.body.classList.add('tb-coach-mode');
      return () => {
        document.body.classList.remove('tb-coach-mode');
      };
    }
    document.body.classList.remove('tb-coach-mode');
  }, [stage]);
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
    if (trimmed.length < 3) return;

    // Phase 23 v2 slice 4 (2026-05-06): only Writing × With-assistant
    // is wired in this slice. Other combinations still surface the
    // slice-1 placeholder until slices 5-7 land.
    if (path === 'writing' && mode === 'with-assistant') {
      setSubmittedTopic(trimmed);
      setErrorMsg(null);
      setStage('thinking');
      setText('');
      const platformHint = inferPlatformHint(trimmed);
      startProposeTransition(async () => {
        try {
          const res = await proposeFromTopic({
            topic: trimmed,
            ...(platformHint ? { platformHint } : {}),
          });
          if (res.ok) {
            setProposal(res);
            setStage('thread');
          } else {
            setErrorMsg(res.message);
            setStage('error');
          }
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Unknown error.');
          setStage('error');
        }
      });
      return;
    }

    const pathLabel = path ?? 'default';
    setPlaceholderResult(
      `Slice 1 — would launch ${pathLabel} × ${mode}. Slices 5-7 wire the other combinations.`
    );
    setText('');
  }

  function startOver() {
    setStage('default');
    setProposal(null);
    setErrorMsg(null);
    setSubmittedTopic('');
    setSelectedAngleIndex(null);
    setReplyText('');
    setCoachTurns([]);
  }

  // Phase 23 v2 slice 4.5 (2026-05-06): cards toggle a selection
  // (single-select). A second click on the same card deselects.
  function toggleAngle(index: number) {
    setSelectedAngleIndex((prev) => (prev === index ? null : index));
  }

  // Refresh the three angles in place. Uses regenerateAngles so the
  // outline stays stable; the LLM rolls a different cut of angles
  // against the same retrieval set.
  function refreshAngles() {
    if (!proposal) return;
    const platform: 'newsletter' | 'linkedin' =
      proposal.platformGuess === 'linkedin' ? 'linkedin' : 'newsletter';
    setSelectedAngleIndex(null);
    startRegenTransition(async () => {
      try {
        const res = await regenerateAngles({
          topic: proposal.topic,
          outline: proposal.outline,
          platformHint: platform,
        });
        if (res.ok) {
          setProposal({ ...proposal, angles: res.angles });
        } else {
          setErrorMsg(res.message);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error.');
      }
    });
  }

  // "Continue →" — transition to the coach chat stage. Build the
  // first user turn from the selected angle (if any) plus any extra
  // direction the user typed, then immediately fire the next round
  // of proposeFromTopic with conversation context so the assistant
  // has something to say back.
  function continueToCoaching() {
    if (!proposal) return;
    const selected =
      selectedAngleIndex !== null ? proposal.angles[selectedAngleIndex] : null;
    const reply = replyText.trim();
    const userTurnText = composeUserTurn(selected, reply);
    if (!userTurnText) return;
    const initialThread: CoachTurn[] = [
      { kind: 'assistant', proposal },
      { kind: 'user', text: userTurnText },
    ];
    setCoachTurns(initialThread);
    setReplyText('');
    setSelectedAngleIndex(null);
    setStage('coaching');
    runCoachReply(initialThread, proposal.topic, proposal.platformGuess);
  }

  // Run a coach round — re-fire proposeFromTopic with the full
  // transcript and append the assistant's response to the thread.
  function runCoachReply(
    thread: CoachTurn[],
    topic: string,
    platformGuess: SparProposal['platformGuess']
  ) {
    const platformHint =
      platformGuess === 'linkedin' || platformGuess === 'newsletter'
        ? platformGuess
        : undefined;
    startProposeTransition(async () => {
      try {
        const res = await proposeFromTopic({
          topic,
          conversationSoFar: renderTranscript(topic, thread),
          ...(platformHint ? { platformHint } : {}),
        });
        if (res.ok) {
          setCoachTurns((prev) => [...prev, { kind: 'assistant', proposal: res }]);
        } else {
          setErrorMsg(res.message);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error.');
      }
    });
  }

  function sendCoachReply() {
    const reply = replyText.trim();
    if (!reply || coachTurns.length === 0) return;
    const lastAssistant = [...coachTurns]
      .reverse()
      .find((t): t is { kind: 'assistant'; proposal: SparProposal } =>
        t.kind === 'assistant'
      );
    if (!lastAssistant) return;
    const next: CoachTurn[] = [...coachTurns, { kind: 'user', text: reply }];
    setCoachTurns(next);
    setReplyText('');
    runCoachReply(next, lastAssistant.proposal.topic, lastAssistant.proposal.platformGuess);
  }

  // Finalize from coaching: take the latest assistant turn's outline +
  // topic, commit a draft, redirect to the editor at /studio/page/[id].
  function openEditorFromCoaching() {
    const lastAssistant = [...coachTurns]
      .reverse()
      .find((t): t is { kind: 'assistant'; proposal: SparProposal } =>
        t.kind === 'assistant'
      );
    if (!lastAssistant) return;
    const platform: 'newsletter' | 'linkedin' =
      lastAssistant.proposal.platformGuess === 'linkedin'
        ? 'linkedin'
        : 'newsletter';
    startCommitTransition(async () => {
      try {
        await commitProposal({
          topic: lastAssistant.proposal.topic,
          outline: lastAssistant.proposal.outline,
          platform,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error.');
        setStage('error');
      }
    });
  }

  function fillPrompt(prompt: string) {
    setText(prompt);
    textareaRef.current?.focus();
  }

  const placeholder = PATH_PLACEHOLDER[path ?? 'default'];

  if (stage === 'thinking') {
    return (
      <div className="w-full max-w-[720px] mx-auto">
        <ThinkingCard topic={submittedTopic} />
      </div>
    );
  }

  if (stage === 'thread' && proposal) {
    return (
      <div className="w-full max-w-[720px] mx-auto">
        <ThreadView
          proposal={proposal}
          selectedAngleIndex={selectedAngleIndex}
          replyText={replyText}
          isRegenerating={isRegenerating}
          isProposing={isProposing}
          onToggleAngle={toggleAngle}
          onRefreshAngles={refreshAngles}
          onReplyChange={setReplyText}
          onContinue={continueToCoaching}
          onStartOver={startOver}
        />
      </div>
    );
  }

  if (stage === 'coaching') {
    return (
      <CoachView
        turns={coachTurns}
        replyText={replyText}
        isProposing={isProposing}
        isCommitting={isCommitting}
        onReplyChange={setReplyText}
        onSendReply={sendCoachReply}
        onOpenEditor={openEditorFromCoaching}
        onStartOver={startOver}
      />
    );
  }

  if (stage === 'error') {
    return (
      <div className="w-full max-w-[720px] mx-auto">
        <ErrorCard message={errorMsg} onStartOver={startOver} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-[720px] mx-auto">
      <div className="rounded-card border border-rule bg-paper">
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
              <ModeIcon mode={mode} />
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
                className="absolute bottom-full left-0 mb-2 min-w-[260px] rounded-card border border-rule bg-paper shadow-soft overflow-hidden z-10"
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
                    className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-paper-2 transition-colors ${
                      m === mode ? 'bg-paper-2' : ''
                    }`}
                  >
                    <span className="shrink-0 mt-0.5">
                      {m === 'with-assistant' ? (
                        <PencilGlyph />
                      ) : m === 'beside' ? (
                        <BulbGlyph />
                      ) : (
                        <SteeringGlyph />
                      )}
                    </span>
                    <span className="flex flex-col items-start gap-0.5 flex-1">
                      <span className="font-sans text-[13px] text-ink leading-none">
                        {MODE_LABEL[m]}
                      </span>
                      <span className="font-sans text-[11.5px] text-tag leading-snug">
                        {MODE_DESCRIPTION[m]}
                      </span>
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
            disabled={text.trim().length === 0 || isProposing}
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
          <div className="border-t border-rule rounded-b-card overflow-hidden">
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
  const Icon = active === 'writing' ? PencilGlyph : SparklesGlyph;
  // Phase 23 v2 slice 1.1 (2026-05-06): Writing reads green, Ideation
  // reads amber. Soft tint, not a saturated highlight — the badge is
  // a state indicator, not an alarm.
  const colorClasses =
    active === 'writing'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
      : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100';
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Clear ${label} path`}
      aria-label={`Clear ${label} path`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${colorClasses}`}
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
  const Icon = value === 'writing' ? PencilGlyph : SparklesGlyph;
  // Phase 23 v2 slice 1.1 (2026-05-06): Writing glows green when
  // active, Ideation glows amber. Inactive stays neutral with the
  // brand's monochrome ink/zinc palette.
  const activeClasses =
    value === 'writing'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
      : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100';
  const inactiveClasses =
    'bg-transparent text-tag border-rule hover:text-ink hover:bg-paper';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
        active ? activeClasses : inactiveClasses
      }`}
    >
      <Icon />
      <span className="font-sans text-[13px] leading-none">{label}</span>
    </button>
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

function SteeringGlyph() {
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
      <circle cx="7" cy="7" r="5" />
      <circle cx="7" cy="7" r="1.4" />
      <line x1="7" y1="2" x2="7" y2="5.6" />
      <line x1="7" y1="8.4" x2="7" y2="12" />
      <line x1="2" y1="7" x2="5.6" y2="7" />
      <line x1="8.4" y1="7" x2="12" y2="7" />
    </svg>
  );
}

function SparklesGlyph() {
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
      <path d="M5.5 2.5L6.2 4.3L8 5L6.2 5.7L5.5 7.5L4.8 5.7L3 5L4.8 4.3Z" />
      <path d="M10 7.5L10.5 8.7L11.7 9.2L10.5 9.7L10 10.9L9.5 9.7L8.3 9.2L9.5 8.7Z" />
      <path d="M3 9.5L3.4 10.4L4.3 10.8L3.4 11.2L3 12.1L2.6 11.2L1.7 10.8L2.6 10.4Z" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === 'with-assistant') return <PencilGlyph />;
  if (mode === 'beside') return <BulbGlyph />;
  return <SteeringGlyph />;
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


// Phase 23 v2 slice 4 (2026-05-06): infer the platform from the
// user's topic text. Cheap heuristic — the LLM also auto-detects via
// platformGuess, but supplying a hint up front gives proposeFromTopic
// a stronger signal when the user used the curated sub-prompts.
function inferPlatformHint(
  text: string
): 'newsletter' | 'linkedin' | undefined {
  const lower = text.toLowerCase();
  if (lower.includes('linkedin')) return 'linkedin';
  if (
    lower.includes('newsletter') ||
    lower.includes('csl issue') ||
    lower.includes('email course')
  ) {
    return 'newsletter';
  }
  return undefined;
}

function ThinkingCard({ topic }: { topic: string }) {
  return (
    <div className="rounded-card border border-rule bg-paper p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1">
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-1">
            You
          </p>
          <p className="font-sans text-[14.5px] text-ink leading-snug">
            {topic}
          </p>
        </div>
      </div>
      <div className="border-t border-rule pt-4">
        <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
          Thoughtbed
        </p>
        <p className="font-sans text-[13px] text-ink-soft leading-snug flex items-center gap-2">
          <SpinGlyph />
          Pulling what you've already written about this…
        </p>
      </div>
    </div>
  );
}

function ThreadView({
  proposal,
  selectedAngleIndex,
  replyText,
  isRegenerating,
  isProposing,
  onToggleAngle,
  onRefreshAngles,
  onReplyChange,
  onContinue,
  onStartOver,
}: {
  proposal: SparProposal;
  selectedAngleIndex: number | null;
  replyText: string;
  isRegenerating: boolean;
  isProposing: boolean;
  onToggleAngle: (index: number) => void;
  onRefreshAngles: () => void;
  onReplyChange: (text: string) => void;
  onContinue: () => void;
  onStartOver: () => void;
}) {
  const { topic, visibleThinking, angles, outline, followUpQuestion } =
    proposal;
  const canContinue =
    !isProposing &&
    !isRegenerating &&
    (selectedAngleIndex !== null || replyText.trim().length >= 3);
  return (
    <div className="space-y-4">
      <div className="rounded-card border border-rule bg-paper p-6 space-y-5">
        <div>
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-1">
            You
          </p>
          <p className="font-sans text-[14.5px] text-ink leading-snug">
            {topic}
          </p>
        </div>

        <div className="border-t border-rule pt-5">
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
            Thoughtbed
          </p>
          <p className="font-sans text-[13px] text-ink-soft leading-snug">
            {visibleThinking.summary}
          </p>
        </div>

        {angles.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
                {angles.length === 1 ? 'One angle' : `${angles.length} angles`}
              </p>
              <button
                type="button"
                onClick={onRefreshAngles}
                disabled={isRegenerating || isProposing}
                className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isRegenerating ? <SpinGlyph /> : <RefreshGlyph />}
                {isRegenerating ? 'Refreshing' : 'New angles'}
              </button>
            </div>
            <ul className="space-y-2">
              {angles.map((angle, i) => {
                const selected = selectedAngleIndex === i;
                return (
                  <li key={`${i}-${angle.line.slice(0, 24)}`}>
                    <button
                      type="button"
                      onClick={() => onToggleAngle(i)}
                      aria-pressed={selected}
                      className={`w-full text-left rounded-card border px-4 py-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
                        selected
                          ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100'
                          : 'border-rule bg-paper hover:bg-paper-2 hover:border-rule-strong'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`font-mono text-[10px] pt-0.5 shrink-0 ${
                            selected ? 'text-emerald-700' : 'text-tag'
                          }`}
                        >
                          {String.fromCharCode(65 + i)}
                        </span>
                        <span
                          className={`font-sans text-[14px] leading-snug flex-1 ${
                            selected ? 'text-emerald-900' : 'text-ink'
                          }`}
                        >
                          {angle.line}
                        </span>
                        {selected && (
                          <span className="text-emerald-600 shrink-0">
                            <CheckGlyph />
                          </span>
                        )}
                      </div>
                      {angle.sources.length > 0 && (
                        <div className="mt-2 ml-7 flex flex-wrap gap-1.5">
                          {angle.sources.map((s) => (
                            <span
                              key={`${s.kind}-${s.id}`}
                              className={`font-mono text-[10px] rounded-full px-2 py-0.5 border ${
                                selected
                                  ? 'text-emerald-700 bg-emerald-100 border-emerald-200'
                                  : 'text-tag bg-paper-2 border-rule'
                              }`}
                            >
                              {s.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {selectedAngleIndex === null && (
              <p className="mt-2 font-sans text-[12px] text-tag">
                Click an angle to select it (click again to clear), refresh
                for a new three, or skip selection and tell me where to take
                this below.
              </p>
            )}
          </div>
        )}

        {outline.length > 0 && (
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
              Outline so far
            </p>
            <ol className="space-y-1.5 ml-1">
              {outline.map((b, i) => (
                <li
                  key={i}
                  className="font-sans text-[13px] text-ink-soft leading-snug flex gap-2.5"
                >
                  <span className="font-mono text-[11px] text-tag shrink-0">
                    {i + 1}
                  </span>
                  <span className="flex-1">{b.beat}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {followUpQuestion && (
          <div className="border-t border-rule pt-4">
            <p className="font-sans text-[14px] text-ink leading-snug mb-3">
              {followUpQuestion}
            </p>
            <textarea
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              placeholder="Add direction here, or just pick an angle above and continue."
              rows={2}
              className="w-full resize-none rounded-card border border-rule bg-paper px-3 py-2.5 font-sans text-[14px] text-ink placeholder:text-tag leading-snug focus:outline-none focus:border-rule-strong"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onStartOver}
          disabled={isProposing || isRegenerating}
          className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors disabled:opacity-50"
        >
          ← Start over
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-full px-4 py-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed bg-ink text-paper hover:bg-ink-soft"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

// ─── helpers + CoachView ─────────────────────────────────────────────

function composeUserTurn(
  selected: ProposeAngle | null,
  reply: string
): string {
  const parts: string[] = [];
  if (selected) parts.push(`I'll go with: ${selected.line}`);
  if (reply) parts.push(reply);
  return parts.join('\n\n');
}

// Render the coach thread into the transcript shape proposeFromTopic
// expects via conversationSoFar. Mirrors the Spar surface's format
// (TOPIC: / USER: lines) so the LLM prompt sees a familiar shape.
function renderTranscript(topic: string, turns: CoachTurn[]): string {
  const lines: string[] = [`TOPIC: ${topic}`];
  for (const t of turns) {
    if (t.kind === 'user') lines.push(`USER: ${t.text}`);
    if (t.kind === 'assistant') {
      lines.push(`THOUGHTBED: ${t.proposal.followUpQuestion}`);
    }
  }
  return lines.join('\n');
}

function CoachView({
  turns,
  replyText,
  isProposing,
  isCommitting,
  onReplyChange,
  onSendReply,
  onOpenEditor,
  onStartOver,
}: {
  turns: CoachTurn[];
  replyText: string;
  isProposing: boolean;
  isCommitting: boolean;
  onReplyChange: (text: string) => void;
  onSendReply: () => void;
  onOpenEditor: () => void;
  onStartOver: () => void;
}) {
  const lastAssistant = [...turns]
    .reverse()
    .find((t): t is { kind: 'assistant'; proposal: SparProposal } =>
      t.kind === 'assistant'
    );
  const canSend =
    !isProposing && !isCommitting && replyText.trim().length >= 1;
  const canOpen = !isCommitting && lastAssistant !== undefined;
  return (
    <div className="min-h-[calc(100vh-0px)] flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-rule shrink-0">
        <button
          type="button"
          onClick={onStartOver}
          disabled={isCommitting}
          className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors disabled:opacity-50"
        >
          ← Start over
        </button>
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
          Coaching
        </span>
        <button
          type="button"
          onClick={onOpenEditor}
          disabled={!canOpen}
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-full px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong disabled:opacity-50 disabled:cursor-not-allowed bg-paper-2 text-ink hover:bg-paper-3"
        >
          Open the editor →
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] mx-auto px-6 py-8 space-y-6">
          {turns.map((turn, i) =>
            turn.kind === 'user' ? (
              <UserTurn key={i} text={turn.text} />
            ) : (
              <AssistantTurn key={i} proposal={turn.proposal} />
            )
          )}
          {isProposing && (
            <div className="flex items-center gap-2">
              <SpinGlyph />
              <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag">
                Thinking…
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-rule px-6 py-4 shrink-0 bg-paper">
        <div className="max-w-[720px] mx-auto">
          <div className="flex items-end gap-2 rounded-card border border-rule bg-paper px-3 py-2">
            <textarea
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === 'Enter' &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  onSendReply();
                }
              }}
              placeholder="Reply…"
              rows={1}
              className="flex-1 resize-none bg-transparent border-0 outline-none font-sans text-[14.5px] text-ink placeholder:text-tag leading-snug min-h-[24px] max-h-[160px]"
            />
            <button
              type="button"
              onClick={onSendReply}
              disabled={!canSend}
              aria-label="Send reply"
              title="Send reply"
              className="p-1.5 rounded-full bg-ink text-paper hover:bg-ink-soft disabled:bg-rule disabled:text-tag disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong shrink-0"
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
        </div>
      </div>
    </div>
  );
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-card bg-paper-2 px-4 py-2.5">
        <p className="font-sans text-[14.5px] text-ink leading-snug whitespace-pre-wrap">
          {text}
        </p>
      </div>
    </div>
  );
}

function AssistantTurn({ proposal }: { proposal: SparProposal }) {
  const { visibleThinking, angles, followUpQuestion } = proposal;
  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
        Thoughtbed
      </p>
      <p className="font-sans text-[13.5px] text-ink-soft leading-snug">
        {visibleThinking.summary}
      </p>
      {angles.length > 0 && (
        <ul className="space-y-1.5">
          {angles.map((angle, i) => (
            <li
              key={`${i}-${angle.line.slice(0, 16)}`}
              className="flex items-start gap-2.5 rounded-soft border border-rule bg-paper px-3 py-2"
            >
              <span className="font-mono text-[10px] text-tag pt-0.5 shrink-0">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="font-sans text-[13.5px] text-ink leading-snug flex-1">
                {angle.line}
              </span>
            </li>
          ))}
        </ul>
      )}
      {followUpQuestion && (
        <p className="font-sans text-[14px] text-ink leading-snug pt-1">
          {followUpQuestion}
        </p>
      )}
    </div>
  );
}

function RefreshGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6a4 4 0 0 1 7.2-2.4" />
      <polyline points="9.5,2 9.5,4 7.5,4" />
      <path d="M10 6a4 4 0 0 1-7.2 2.4" />
      <polyline points="2.5,10 2.5,8 4.5,8" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3,7.5 5.5,10 11,4" />
    </svg>
  );
}

function ErrorCard({
  message,
  onStartOver,
}: {
  message: string | null;
  onStartOver: () => void;
}) {
  return (
    <div className="rounded-card border border-rule bg-paper p-6">
      <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
        Couldn't pull from your space
      </p>
      <p className="font-sans text-[14px] text-ink leading-snug mb-4">
        {message || 'Something went sideways. Try again.'}
      </p>
      <button
        type="button"
        onClick={onStartOver}
        className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink hover:text-tag transition-colors"
      >
        ← Start over
      </button>
    </div>
  );
}

function SpinGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      className="animate-spin text-tag shrink-0"
    >
      <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
    </svg>
  );
}
