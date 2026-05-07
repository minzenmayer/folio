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
  getSourceDetail,
  runRefinement,
  type ProposeFromTopicResult,
  type ProposeAngle,
  type GetSourceDetailResult,
} from './actions';
import { type SimilarKind } from '@/lib/retrieval-kinds';

type Mode = 'with-assistant' | 'beside' | 'self-driving';
type Path = 'writing' | 'ideation';
// Phase 23 v2 slice 4 (2026-05-06): the homepage transitions through
// these stages on a Writing × With-assistant submit. Other path × mode
// combinations stay in 'default' for now and surface a placeholder.
type Stage = 'default' | 'thinking' | 'thread' | 'coaching' | 'error';

// Phase 23 v2 slice 4.5 (2026-05-06): each turn in the coaching
// thread. user turns are plain text; assistant turns carry the
// proposeFromTopic structured result so angles render inline.
// Phase 23 v2 slice 6 (2026-05-06): refinement keys mirror
// RefinementKind in src/lib/llm.ts so the action layer and UI
// stay in lockstep.
type RefinementKey =
  | 'sharpen_hook'
  | 'add_takeaway'
  | 'refine_stakes'
  | 'add_depth';

type CoachTurn =
  | {
      kind: 'user';
      text: string;
      carriedAngleLine?: string;
      carriedSourceIds?: ReadonlyArray<string>;
      // Phase 23 v2 slice 6 (2026-05-06): the refinement chip the
      // user had selected when they sent. Drives runRefinement
      // instead of generic proposeFromTopic on the next round.
      refinementKey?: RefinementKey;
    }
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

// Phase 23 v2 slice 4.7 (2026-05-06): the With-assistant coaching
// arc. Five beats, four working + a done state. Each beat carries a
// hand-written craft intro (Saunders, McPhee, Clark) so the user is
// being TAUGHT a principle, not just answering questions. The angles
// the LLM returns are only displayed on Hook + Close — beats where
// multi-option actually helps. Tension and Stakes are single-question
// turns so the loop doesn't feel like it keeps asking the same thing.
type BeatKey = 'hook' | 'tension' | 'stakes' | 'close' | 'done';

type Beat = {
  key: BeatKey;
  label: string;
  // Phase 23 v2 slice 5.1 (2026-05-06): coachIntro is the
  // definition / teaching that lands directly under the beat
  // header, BEFORE the SpaceStrip + LLM follow-up question. For
  // Tension and Stakes that means a longer line that frames what
  // the beat is hunting for; for Hook and Close it stays a short
  // craft note.
  coachIntro: string;
  showAngles: boolean;
  anglesIntro?: string;
};

// Phase 23 v2 slice 4.8 (2026-05-06): one-line beat intros, no
// writer-credit copy. Each beat has a matching icon (rendered by
// BeatIcon) so the eye anchors before the words.
const BEATS: ReadonlyArray<Beat> = [
  {
    key: 'hook',
    label: 'Hook',
    coachIntro: 'The smallest moment that makes a stranger lean in.',
    showAngles: true,
    anglesIntro: 'Three openers. React to one, or tell me yours.',
  },
  {
    key: 'tension',
    label: 'Tension',
    coachIntro:
      'The spine. The question pulling against itself the whole way through. Look for the friction inside your own take. Where do you almost contradict yourself?',
    showAngles: false,
  },
  {
    key: 'stakes',
    label: 'Stakes',
    coachIntro:
      'Stakes live in time and consequence. What does your reader keep doing if they miss this, and what do they get back if they catch it?',
    showAngles: false,
  },
  {
    key: 'close',
    label: 'Close',
    coachIntro: 'The line they remember after.',
    showAngles: true,
    anglesIntro: 'Three closer-shapes. React to one, or tell me yours.',
  },
  {
    key: 'done',
    label: 'Ready',
    coachIntro: 'Enough to draft. Open the editor.',
    showAngles: false,
  },
];

// Phase 23 v2 slice 6.1 (2026-05-07): when an assistant turn comes
// in response to a user turn that carried a refinement key, we
// override the linear-arc beat with a refinement-specific beat so
// the angles + question render (instead of falling through to the
// Done UI). Each refinement gets its own label + intro so the user
// knows what they're looking at.
function refinementBeat(key: RefinementKey): Beat {
  if (key === 'sharpen_hook') {
    return {
      key: 'hook',
      label: 'Sharpened hook',
      coachIntro:
        'Three sharper openers of your piece. Same angle, tighter line.',
      showAngles: true,
      anglesIntro: 'Pick the one closest to how you actually talk.',
    };
  }
  if (key === 'add_takeaway') {
    return {
      key: 'close',
      label: 'Takeaway',
      coachIntro:
        'Two candidate kicker lines. The kind a reader repeats after.',
      showAngles: true,
      anglesIntro: 'Pick the one that lands hardest.',
    };
  }
  if (key === 'refine_stakes') {
    return {
      key: 'stakes',
      label: 'Sharper stakes',
      coachIntro:
        'Two reframings of the stakes. Each names a specific reader behavior.',
      showAngles: true,
      anglesIntro: 'Pick the one closer to the truth.',
    };
  }
  // add_depth
  return {
    key: 'tension',
    label: 'Depth',
    coachIntro:
      'Notes you could pull in. Your space plus the wider web.',
    showAngles: true,
    anglesIntro: 'Each one is a thread worth tugging.',
  };
}

function beatForTurnCount(userTurns: number): Beat {
  // beat 0 (Hook) = the system's first response (no user replies yet)
  // beat 1 (Tension) = after one user reply
  // ...
  // beat N (Done) = after enough replies to clear the arc
  const idx = Math.min(userTurns, BEATS.length - 1);
  return BEATS[idx];
}

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

  // Phase 23 v2 slice 5.2 (2026-05-06): the angles page (ThreadView)
  // also supports the expand-pill modal + 'bring this with me'
  // selection. State lives at this level so the Continue → handoff
  // can include selected source titles in the first coach turn.
  const [threadSelectedSourceIds, setThreadSelectedSourceIds] = useState<
    Set<string>
  >(new Set());
  const [threadModalSource, setThreadModalSource] =
    useState<AngleSource | null>(null);
  function toggleThreadSourceSelection(id: string) {
    setThreadSelectedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Phase 23 v2 slice 4.5 (2026-05-06): the studio sidebar hides
  // while the coaching stage is active. Slice 4.6 (2026-05-06) also
  // toggles tb-chat-active on every non-default stage so the
  // homepage's recent-drafts / recent-ideas / inbox blocks hide
  // once the user has moved past the entry surface.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    if (stage === 'coaching') body.classList.add('tb-coach-mode');
    else body.classList.remove('tb-coach-mode');
    if (stage !== 'default') body.classList.add('tb-chat-active');
    else body.classList.remove('tb-chat-active');
    return () => {
      body.classList.remove('tb-coach-mode');
      body.classList.remove('tb-chat-active');
    };
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
    setThreadSelectedSourceIds(new Set());
    setThreadModalSource(null);
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
    // Phase 23 v2 slice 5.2 (2026-05-06): selected sources from
    // the angles page travel into the first coach turn so the LLM
    // sees what the user wants to anchor on.
    const sourceTitles: string[] = [];
    if (threadSelectedSourceIds.size > 0) {
      const allSources = proposal.angles.flatMap((a) => a.sources);
      for (const id of threadSelectedSourceIds) {
        const src = allSources.find((s) => s.id === id);
        if (src && src.title) sourceTitles.push(src.title);
      }
    }
    const userTurnText = composeUserTurn(selected, reply, sourceTitles);
    if (!userTurnText) return;
    const carriedSourceIds = Array.from(threadSelectedSourceIds);
    const initialThread: CoachTurn[] = [
      { kind: 'assistant', proposal },
      {
        kind: 'user',
        text: userTurnText,
        ...(selected ? { carriedAngleLine: selected.line } : {}),
        ...(carriedSourceIds.length > 0
          ? { carriedSourceIds }
          : {}),
      },
    ];
    setCoachTurns(initialThread);
    setReplyText('');
    setSelectedAngleIndex(null);
    setThreadSelectedSourceIds(new Set());
    setThreadModalSource(null);
    setStage('coaching');
    runCoachReply(initialThread, proposal.topic, proposal.platformGuess);
  }

  // Run a coach round. If a refinement key is set, fires the
  // refinement-specific server action (sharpens hook / adds
  // takeaway / refines stakes / adds depth + external research).
  // Otherwise the generic proposeFromTopic continues the chat.
  function runCoachReply(
    thread: CoachTurn[],
    topic: string,
    platformGuess: SparProposal['platformGuess'],
    refinementKey?: RefinementKey
  ) {
    const platformHint =
      platformGuess === 'linkedin' || platformGuess === 'newsletter'
        ? platformGuess
        : undefined;
    if (typeof window !== 'undefined') {
      console.log(
        '[Thoughtbed] runCoachReply branch:',
        refinementKey ? `runRefinement(${refinementKey})` : 'proposeFromTopic'
      );
    }
    startProposeTransition(async () => {
      try {
        const args = {
          topic,
          conversationSoFar: renderTranscript(topic, thread),
          ...(platformHint ? { platformHint } : {}),
        };
        const res = refinementKey
          ? await runRefinement({ ...args, refinement: refinementKey })
          : await proposeFromTopic(args);
        if (res.ok) {
          setCoachTurns((prev) => [...prev, { kind: 'assistant', proposal: res }]);
          setErrorMsg(null);
        } else {
          setErrorMsg(res.message || 'Something failed on the server.');
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error.');
      }
    });
  }

  function sendCoachReply(meta: {
    text: string;
    carriedAngleLine?: string;
    carriedSourceIds?: ReadonlyArray<string>;
    refinementKey?: RefinementKey;
  }) {
    if (typeof window !== 'undefined') {
      console.log(
        '[Thoughtbed] sendCoachReply meta JSON:',
        JSON.stringify(meta, null, 2)
      );
    }
    const reply = meta.text.trim();
    if (!reply || coachTurns.length === 0) return;
    const lastAssistant = [...coachTurns]
      .reverse()
      .find((t): t is { kind: 'assistant'; proposal: SparProposal } =>
        t.kind === 'assistant'
      );
    if (!lastAssistant) return;
    const userTurn: CoachTurn = {
      kind: 'user',
      text: reply,
      ...(meta?.carriedAngleLine ? { carriedAngleLine: meta.carriedAngleLine } : {}),
      ...(meta?.carriedSourceIds && meta.carriedSourceIds.length > 0
        ? { carriedSourceIds: meta.carriedSourceIds }
        : {}),
      ...(meta?.refinementKey ? { refinementKey: meta.refinementKey } : {}),
    };
    const next: CoachTurn[] = [...coachTurns, userTurn];
    setCoachTurns(next);
    setReplyText('');
    runCoachReply(
      next,
      lastAssistant.proposal.topic,
      lastAssistant.proposal.platformGuess,
      meta?.refinementKey
    );
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
          selectedSourceIds={threadSelectedSourceIds}
          onPickSource={(src) => setThreadModalSource(src)}
          modalSource={threadModalSource}
          onCloseModal={() => setThreadModalSource(null)}
          onToggleSelectSource={toggleThreadSourceSelection}
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
        errorBanner={errorMsg}
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
              if (e.key === 'Enter' && !e.shiftKey) {
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
          Pulling what you have already written about this.
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
  selectedSourceIds,
  onPickSource,
  modalSource,
  onCloseModal,
  onToggleSelectSource,
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
  selectedSourceIds: ReadonlySet<string>;
  onPickSource: (source: AngleSource) => void;
  modalSource: AngleSource | null;
  onCloseModal: () => void;
  onToggleSelectSource: (id: string) => void;
}) {
  const threadReplyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = threadReplyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [replyText]);
  const { topic, visibleThinking, angles, outline, followUpQuestion } =
    proposal;
  const canContinue =
    !isProposing &&
    !isRegenerating &&
    (selectedAngleIndex !== null || replyText.trim().length >= 3);
  return (
    <>
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

        <div className="border-t border-rule pt-5 space-y-3">
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
            Thoughtbed
          </p>
          <p className="font-sans text-[13px] text-ink-soft leading-snug">
            {visibleThinking.summary}
          </p>
          <SpaceStrip
            sources={angles.flatMap((a) => a.sources)}
            selectedIds={selectedSourceIds}
            onPick={onPickSource}
          />
        </div>

        {angles.length > 0 && (
          <div>
            <p className="font-sans text-[14px] text-ink leading-relaxed mb-3">
              {BEATS[0].coachIntro}
            </p>
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
                {BEATS[0].anglesIntro ?? 'Three places this could open'}
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
                      <div className="mt-2 flex justify-end">
                        <SourcePills
                          sources={angle.sources}
                          tone={selected ? 'selected' : 'default'}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {selectedAngleIndex === null && (
              <p className="mt-2 font-sans text-[12px] text-tag">
                Click one to select it, click it again to clear. Or refresh for a different three. Or skip the selection and tell me where you would take it below.
              </p>
            )}
          </div>
        )}

        {outline.length > 0 && (
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
              Where this is headed
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
              ref={threadReplyRef}
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onContinue();
                }
              }}
              placeholder="Tell me where you would take it. Shift+Enter for a new paragraph."
              rows={2}
              className="w-full resize-none rounded-card border border-rule bg-paper px-3 py-2.5 font-sans text-[14px] text-ink placeholder:text-tag leading-snug focus:outline-none focus:border-rule-strong min-h-[56px] max-h-[200px]"
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
          Got it →
        </button>
      </div>
    </div>
    {modalSource && (
      <SourceDetailModal
        source={modalSource}
        selected={selectedSourceIds.has(modalSource.id)}
        onToggleSelect={() => onToggleSelectSource(modalSource.id)}
        onClose={onCloseModal}
      />
    )}
    </>
  );
}

// ─── helpers + CoachView ─────────────────────────────────────────────

function composeUserTurn(
  selected: ProposeAngle | null,
  reply: string,
  sourceTitles: ReadonlyArray<string> = []
): string {
  const parts: string[] = [];
  if (selected) parts.push(`I'll go with: ${selected.line}`);
  if (sourceTitles.length > 0) {
    parts.push(`Pulling from my space: ${sourceTitles.join('; ')}`);
  }
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
  errorBanner,
}: {
  turns: CoachTurn[];
  replyText: string;
  isProposing: boolean;
  isCommitting: boolean;
  onReplyChange: (text: string) => void;
  onSendReply: (meta: {
    text: string;
    carriedAngleLine?: string;
    carriedSourceIds?: ReadonlyArray<string>;
    refinementKey?: RefinementKey;
  }) => void;
  onOpenEditor: () => void;
  onStartOver: () => void;
  errorBanner?: string | null;
}) {
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the reply textarea as the user types so long replies
  // don't clip behind a single-line preview (slice 4.6).
  useEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [replyText]);

  // Phase 23 v2 slice 5.0: selection of an angle in the latest
  // assistant turn highlights it green. Travels with the next
  // reply submission via the renderTranscript helper.
  const [selectedAngleLineInLatest, setSelectedAngleLineInLatest] =
    useState<string | null>(null);

  // Phase 23 v2 slice 5.0 (2026-05-06): clicking an angle in the
  // coach view now toggles a green highlight on the angle (single
  // select) instead of auto-populating the reply textarea. The
  // textarea stays for the user's own thoughts; the selection
  // travels with the next reply via the conversation transcript.
  function toggleSelectedAngleLine(line: string) {
    setSelectedAngleLineInLatest((prev) => (prev === line ? null : line));
  }

  // Round = how many user turns the user has sent. Round 1 = the
  // continuation from the angles page; bumps with each subsequent
  // reply. After a couple of rounds we surface a softer 'open the
  // editor' invitation near the reply box.
  const round = turns.filter((t) => t.kind === 'user').length;
  const showOffRamp = round >= 2;

  const lastAssistant = [...turns]
    .reverse()
    .find((t): t is { kind: 'assistant'; proposal: SparProposal } =>
      t.kind === 'assistant'
    );

  // Phase 23 v2 slice 5.1 (2026-05-06): refinement chip click
  // toggles a selection without populating the reply textarea. The
  // textarea stays for the user's own additions. Send combines the
  // selected refinement and the typed reply (either, both, or
  // refinement alone).
  const [selectedRefinement, setSelectedRefinement] = useState<{
    label: string;
    prompt: string;
    key: RefinementKey;
  } | null>(null);
  function toggleRefinement(label: string, prompt: string, key: RefinementKey) {
    setSelectedRefinement((prev) =>
      prev?.label === label ? null : { label, prompt, key }
    );
  }

  // Phase 23 v2 slice 5.2 (2026-05-06): selected sources (pills the
  // user wants to bring along) + modal state for the source detail
  // popup. Selected source titles ride along on the next reply via
  // commitSend so the LLM sees what the user wants to anchor on.
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(
    new Set()
  );
  const [modalSource, setModalSource] = useState<AngleSource | null>(null);
  const [allSources, setAllSources] = useState<Map<string, AngleSource>>(
    new Map()
  );
  // Keep an index of every source seen across turns so commitSend can
  // resolve ids → titles when building the user turn.
  useEffect(() => {
    setAllSources((prev) => {
      const next = new Map(prev);
      for (const turn of turns) {
        if (turn.kind !== 'assistant') continue;
        for (const angle of turn.proposal.angles) {
          for (const src of angle.sources) {
            if (!next.has(src.id)) next.set(src.id, src);
          }
        }
      }
      return next;
    });
  }, [turns]);
  function toggleSourceSelection(id: string) {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function openSourceModal(source: AngleSource) {
    setModalSource(source);
  }
  function closeSourceModal() {
    setModalSource(null);
  }

  // Phase 23 v2 slice 5.1 (2026-05-06): commitSend builds the user
  // turn from any selected angle, any selected refinement chip, and
  // the typed reply (any combination, in that priority order). Then
  // it clears the selections so they do not stick to the next turn.
  function commitSend() {
    if (typeof window !== 'undefined') {
      console.log(
        '[Thoughtbed] commitSend selectedRefinement JSON:',
        JSON.stringify(selectedRefinement ?? null)
      );
    }
    const parts: string[] = [];
    if (selectedAngleLineInLatest) {
      parts.push(`I will go with: ${selectedAngleLineInLatest}`);
    }
    if (selectedRefinement) {
      parts.push(selectedRefinement.prompt);
    }
    if (selectedSourceIds.size > 0) {
      const titles: string[] = [];
      for (const id of selectedSourceIds) {
        const src = allSources.get(id);
        if (src && src.title) titles.push(src.title);
      }
      if (titles.length > 0) {
        parts.push(`Pulling from my space: ${titles.join('; ')}`);
      }
    }
    const typed = replyText.trim();
    if (typed) parts.push(typed);
    if (parts.length === 0) return;
    // Phase 23 v2 slice 6.7 (2026-05-07): pass the composed message
    // text directly through meta.text instead of going through
    // onReplyChange + setTimeout. The previous approach hit a
    // stale-closure bug: the setTimeout captured the parent's
    // sendCoachReply with its OLD replyText value, so when only a
    // chip was selected (textarea empty), sendCoachReply early-
    // returned on the empty-reply guard and never fired the LLM.
    const message = parts.join('\n\n');
    const meta = {
      text: message,
      ...(selectedAngleLineInLatest
        ? { carriedAngleLine: selectedAngleLineInLatest }
        : {}),
      ...(selectedSourceIds.size > 0
        ? { carriedSourceIds: Array.from(selectedSourceIds) }
        : {}),
      ...(selectedRefinement?.key
        ? { refinementKey: selectedRefinement.key }
        : {}),
    };
    onReplyChange('');
    setSelectedAngleLineInLatest(null);
    setSelectedRefinement(null);
    setSelectedSourceIds(new Set());
    onSendReply(meta);
  }

  const canSend =
    !isProposing &&
    !isCommitting &&
    (replyText.trim().length >= 1 ||
      selectedAngleLineInLatest !== null ||
      selectedRefinement !== null ||
      selectedSourceIds.size > 0);
  const canOpen = !isCommitting && lastAssistant !== undefined;
  return (
    <>
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
        <BeatProgress current={beatForTurnCount(round)} totalWorking={BEATS.length - 1} />
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
          {(() => {
            let assistantIndex = 0;
            return turns.map((turn, i) => {
              if (turn.kind === 'user') {
                return (
                  <UserTurn
                    key={i}
                    text={turn.text}
                    refinementKey={turn.refinementKey}
                  />
                );
              }
              // Phase 23 v2 slice 6.1: if the prior user turn carried
              // a refinementKey, this assistant turn is a refinement
              // response. Use the refinement beat so angles + question
              // render and DoneRefinements panel still shows.
              const priorTurn = i > 0 ? turns[i - 1] : null;
              const refinementKeyFromPrior =
                priorTurn && priorTurn.kind === 'user'
                  ? priorTurn.refinementKey
                  : undefined;
              const arcBeat = BEATS[Math.min(assistantIndex, BEATS.length - 1)];
              const beat = refinementKeyFromPrior
                ? refinementBeat(refinementKeyFromPrior)
                : arcBeat;
              const isLatest = turn === lastAssistant;
              assistantIndex += 1;
              const nextTurn = turns[i + 1];
              const carriedAngleLine =
                nextTurn && nextTurn.kind === 'user'
                  ? nextTurn.carriedAngleLine ?? null
                  : null;
              const carriedIdsArr =
                nextTurn && nextTurn.kind === 'user'
                  ? nextTurn.carriedSourceIds ?? null
                  : null;
              const carriedSourceIds = carriedIdsArr
                ? new Set(carriedIdsArr)
                : undefined;
              const showRefinementsPanel = isLatest && (
                arcBeat.key === 'done' || Boolean(refinementKeyFromPrior)
              );
              return (
                <AssistantTurn
                  key={i}
                  proposal={turn.proposal}
                  beat={beat}
                  selectedAngleLine={
                    isLatest && beat.showAngles
                      ? selectedAngleLineInLatest
                      : null
                  }
                  onToggleAngle={
                    isLatest && beat.showAngles
                      ? toggleSelectedAngleLine
                      : undefined
                  }
                  selectedRefinementLabel={
                    showRefinementsPanel
                      ? selectedRefinement?.label ?? null
                      : null
                  }
                  onRefinementToggle={
                    showRefinementsPanel ? toggleRefinement : undefined
                  }
                  showRefinementsPanel={showRefinementsPanel}
                  selectedSourceIds={isLatest ? selectedSourceIds : undefined}
                  onPickSource={isLatest ? openSourceModal : undefined}
                  carriedSourceIds={carriedSourceIds}
                  carriedAngleLine={carriedAngleLine}
                />
              );
            });
          })()}
          {isProposing && (
            <div className="flex items-center gap-2">
              <SpinGlyph />
              <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag">
                Thinking through that.
              </p>
            </div>
          )}
          {errorBanner && !isProposing && (
            <div className="rounded-soft border border-rose-200 bg-rose-50 px-3 py-2">
              <p className="font-sans text-[13px] text-rose-700 leading-snug">
                {errorBanner}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-rule px-6 py-4 shrink-0 bg-paper">
        <div className="max-w-[720px] mx-auto space-y-2">
          {showOffRamp && (
            <div className="flex items-center justify-between">
              <span className="font-sans text-[12px] text-tag">
                Take it as far as you want here. The editor is a click away when you are ready.
              </span>
              <button
                type="button"
                onClick={onOpenEditor}
                disabled={!canOpen}
                className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-full px-3 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong disabled:opacity-50 disabled:cursor-not-allowed bg-ink text-paper hover:bg-ink-soft"
              >
                Open the editor →
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-card border border-rule bg-paper px-3 py-2">
            <textarea
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              ref={replyRef}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitSend();
                }
              }}
              placeholder="Your turn. Shift+Enter for a new paragraph."
              rows={1}
              className="flex-1 resize-none bg-transparent border-0 outline-none font-sans text-[14.5px] text-ink placeholder:text-tag leading-snug min-h-[24px] max-h-[200px]"
            />
            <button
              type="button"
              onClick={() => commitSend()}
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
    {modalSource && (
      <SourceDetailModal
        source={modalSource}
        selected={selectedSourceIds.has(modalSource.id)}
        onToggleSelect={() => toggleSourceSelection(modalSource.id)}
        onClose={closeSourceModal}
      />
    )}
    </>
  );
}

function UserTurn({
  text,
  refinementKey,
}: {
  text: string;
  refinementKey?: RefinementKey;
}) {
  // Phase 23 v2 slice 6.4 (2026-05-07): when the user sent with a
  // refinement chip selected, render a small badge above the
  // bubble so they can SEE the system caught it. If this badge
  // does not appear after clicking a chip + Enter, the chip
  // selection never reached the send path.
  const refinementLabel: Record<RefinementKey, string> = {
    sharpen_hook: 'Sharpen hook',
    add_takeaway: 'Takeaway',
    refine_stakes: 'Sharpen stakes',
    add_depth: 'Depth + research',
  };
  return (
    <div className="flex flex-col items-end gap-1">
      {refinementKey && (
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700 px-2 py-0.5">
          ▸ {refinementLabel[refinementKey]}
        </span>
      )}
      <div className="max-w-[80%] rounded-card bg-emerald-50 border border-emerald-100 px-4 py-2.5">
        <p className="font-sans text-[14.5px] text-emerald-900 leading-snug whitespace-pre-wrap">
          {text}
        </p>
      </div>
    </div>
  );
}

function AssistantTurn({
  proposal,
  beat,
  selectedAngleLine,
  onToggleAngle,
  selectedRefinementLabel,
  onRefinementToggle,
  showRefinementsPanel,
  selectedSourceIds,
  onPickSource,
  carriedSourceIds,
  carriedAngleLine,
}: {
  proposal: SparProposal;
  beat?: Beat;
  selectedAngleLine?: string | null;
  onToggleAngle?: (line: string) => void;
  selectedRefinementLabel?: string | null;
  onRefinementToggle?: (label: string, prompt: string, key: RefinementKey) => void;
  showRefinementsPanel?: boolean;
  selectedSourceIds?: ReadonlySet<string>;
  onPickSource?: (source: AngleSource) => void;
  carriedSourceIds?: ReadonlySet<string>;
  carriedAngleLine?: string | null;
}) {
  const { visibleThinking, angles, followUpQuestion } = proposal;
  // Break the summary into sentences so a wall of LLM prose reads as
  // separate paragraphs. Falls back to one block if the regex finds
  // nothing to split on.
  const sentences = visibleThinking.summary
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const summaryParas = sentences.length > 0 ? sentences : [visibleThinking.summary];
  const interactive = typeof onToggleAngle === 'function';
  // Phase 23 v2 slice 4.7 (2026-05-06): the beat carries the craft
  // intro that gets surfaced above the LLM output. When the beat
  // says showAngles is false (Tension, Stakes, Done), the angles
  // the LLM returned stay hidden so the user is not asked to pick.
  // The craft intro becomes the primary text; the LLM follow-up
  // question is the action prompt.
  const showAngles = beat ? beat.showAngles : true;
  const isDone = beat?.key === 'done';
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {beat && <BeatIcon beat={beat} />}
        <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
          {beat ? beat.label : 'Thoughtbed'}
        </p>
      </div>
      {beat && (
        <p className="font-sans text-[14px] text-ink leading-snug">
          {beat.coachIntro}
        </p>
      )}
      {!beat && (
        <div className="space-y-2">
          {summaryParas.map((s, i) => (
            <p
              key={i}
              className="font-sans text-[14px] text-ink leading-relaxed"
            >
              {s}
            </p>
          ))}
        </div>
      )}
      {!isDone && (
        <SpaceStrip
          sources={angles.flatMap((a) => a.sources)}
          selectedIds={selectedSourceIds ?? undefined}
          carriedIds={carriedSourceIds ?? undefined}
          onPick={onPickSource}
        />
      )}
      {showAngles && angles.length > 0 && (
        <div>
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag mb-2">
            {beat?.anglesIntro ??
              (interactive
                ? 'Click an angle to use it'
                : 'Angles from this round')}
          </p>
          <ul className="space-y-1.5">
            {angles.map((angle, i) => {
              const inner = (
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2.5">
                    <span className="font-mono text-[10px] text-tag pt-0.5 shrink-0">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="font-sans text-[13.5px] text-ink leading-snug flex-1">
                      {angle.line}
                    </span>
                  </div>
                  {angle.sources.length > 0 && (
                    <div className="flex justify-end">
                      <SourcePills
                        sources={angle.sources}
                        tone={
                          selectedAngleLine === angle.line ? 'selected' : 'default'
                        }
                      />
                    </div>
                  )}
                </div>
              );
              const selected = selectedAngleLine === angle.line;
              const carried =
                !selected &&
                carriedAngleLine !== undefined &&
                carriedAngleLine !== null &&
                carriedAngleLine === angle.line;
              return (
                <li key={`${i}-${angle.line.slice(0, 16)}`}>
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => onToggleAngle?.(angle.line)}
                      aria-pressed={selected}
                      className={`w-full text-left rounded-soft border px-3 py-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
                        selected
                          ? 'bg-emerald-50 border-emerald-300 hover:bg-emerald-100'
                          : carried
                            ? 'bg-paper border-emerald-300 hover:bg-paper-2'
                            : 'bg-paper border-rule hover:bg-paper-2 hover:border-rule-strong'
                      }`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      className={`rounded-soft border px-3 py-2 ${
                        carried
                          ? 'bg-paper border-emerald-300'
                          : 'bg-paper border-rule'
                      }`}
                    >
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {followUpQuestion && !isDone && (
        <p className="font-sans text-[15px] text-ink font-medium leading-snug pt-1">
          {followUpQuestion}
        </p>
      )}
      {showRefinementsPanel && onRefinementToggle && (
        <DoneRefinements
          selectedLabel={selectedRefinementLabel ?? null}
          onToggle={onRefinementToggle}
        />
      )}
    </div>
  );
}

// Phase 23 v2 slice 5.0 (2026-05-06): on the Done beat the user
// already has enough to draft. Surface refinement options as
// optional next steps before they click Open the editor — each
// chip fires a focused round on that aspect of the piece. The
// 'From your space' strip retires here; it does not match the
// shape of this moment.
function DoneRefinements({
  selectedLabel,
  onToggle,
}: {
  selectedLabel: string | null;
  onToggle: (label: string, prompt: string, key: RefinementKey) => void;
}) {
  const options: ReadonlyArray<{
    label: string;
    prompt: string;
    key: RefinementKey;
  }> = [
    {
      label: 'Sharpen the hook',
      prompt: 'Sharpen the hook. Tighten the opener so it lands harder.',
      key: 'sharpen_hook',
    },
    {
      label: 'Add a key takeaway',
      prompt:
        'Add a key takeaway. What is the one line a reader should walk away repeating to themselves?',
      key: 'add_takeaway',
    },
    {
      label: 'Refine why this matters',
      prompt:
        'Refine why this matters. Make the stakes specific to the reader, not generic.',
      key: 'refine_stakes',
    },
    {
      label: 'Add depth and research',
      prompt:
        'Add depth. Pull in more from my space: relevant evidence, lines I have already written, examples.',
      key: 'add_depth',
    },
  ];
  return (
    <div className="space-y-3 border-t border-rule pt-4">
      <p className="font-sans text-[14.5px] text-ink leading-snug">
        Want to keep refining before you open the editor?
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const selected = selectedLabel === opt.label;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => onToggle(opt.label, opt.prompt, opt.key)}
              aria-pressed={selected}
              className={`font-sans text-[12.5px] rounded-full border px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
                selected
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                  : 'bg-paper text-ink border-rule hover:bg-paper-2 hover:border-rule-strong'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="font-sans text-[13px] text-tag leading-snug">
        Or tell me what else you would add. What makes this distinctly yours?
      </p>
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


function BeatProgress({
  current,
  totalWorking,
}: {
  current: Beat;
  totalWorking: number;
}) {
  const currentIndex = BEATS.findIndex((b) => b.key === current.key);
  return (
    <div className="flex items-center gap-2.5" aria-label={`Coaching beat: ${current.label}`}>
      <div className="flex items-center gap-1">
        {BEATS.slice(0, totalWorking).map((b, i) => {
          const isPast = i < currentIndex;
          const isCurrent = i === currentIndex;
          return (
            <span
              key={b.key}
              className={`h-1.5 w-1.5 rounded-full ${
                isCurrent
                  ? 'bg-ink'
                  : isPast
                    ? 'bg-tag'
                    : 'bg-rule'
              }`}
              aria-hidden="true"
            />
          );
        })}
      </div>
      <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
        {current.label}
      </span>
    </div>
  );
}


// Phase 23 v2 slice 4.8 (2026-05-06): per-beat anchor icon.
function BeatIcon({ beat }: { beat: Beat }) {
  const svgProps = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'text-ink-soft shrink-0',
  };
  if (beat.key === 'hook') {
    return (
      <svg {...svgProps}>
        <line x1="3.2" y1="10.8" x2="10.5" y2="3.5" />
        <polyline points="6.5,3.5 10.5,3.5 10.5,7.5" />
      </svg>
    );
  }
  if (beat.key === 'tension') {
    return (
      <svg {...svgProps}>
        <polyline points="2,7 5,4 7,8 9,4 12,7" />
      </svg>
    );
  }
  if (beat.key === 'stakes') {
    return (
      <svg {...svgProps}>
        <path d="M7 2c0 2 2.5 3 2.5 5.5A2.5 2.5 0 0 1 7 10a2.5 2.5 0 0 1-2.5-2.5C4.5 5.5 5.5 4 7 2Z" />
        <path d="M5.5 11.5h3" />
      </svg>
    );
  }
  if (beat.key === 'close') {
    return (
      <svg {...svgProps}>
        <circle cx="7" cy="7" r="4.5" />
        <circle cx="7" cy="7" r="2" />
        <circle cx="7" cy="7" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  // done — checkmark
  return (
    <svg {...svgProps}>
      <polyline points="3,7.5 5.8,10.2 11,4.5" />
    </svg>
  );
}

// Phase 23 v2 slice 4.8 (2026-05-06): tightened source pills.
// Dedupes by short label, caps at 2 visible with a +N overflow,
// and uses crisper one-word names so the chrome under each angle
// stays calm.
type SourcePillTone = 'default' | 'selected';
type AngleSource = ProposeAngle['sources'][number];

// Phase 23 v2 slice 5.0 (2026-05-06): per-kind tint for source
// pills. Lets the eye scan source kinds at a glance without
// reading the words. Selected pills override to emerald (matches
// the Writing-path selection color used elsewhere in the chat).
// Phase 23 v2 slice 5.1 (2026-05-06): subtler kind tints. Pills
// stay gray on the inside; only the border carries the kind color.
// Selected pills tip into a soft emerald fill so the active state
// reads clearly against the calmer rest. Saturated fills retired.
function kindColorClasses(short: string, selected: boolean): string {
  if (selected) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-300';
  }
  if (short === 'garden') return 'bg-paper-2 text-tag border-emerald-200';
  if (short === 'CSL') return 'bg-paper-2 text-tag border-amber-200';
  if (short === 'LinkedIn') return 'bg-paper-2 text-tag border-sky-200';
  if (short === 'vault') return 'bg-paper-2 text-tag border-violet-200';
  if (short === 'inbox') return 'bg-paper-2 text-tag border-rose-200';
  return 'text-tag bg-paper-2 border-rule';
}

function shortenSourceLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('garden')) return 'garden';
  if (lower.includes('vault')) return 'vault';
  if (lower.includes('linkedin')) return 'LinkedIn';
  if (lower.includes('csl')) return 'CSL';
  if (lower.includes('newsletter')) return 'inbox';
  return raw;
}

function SourcePills({
  sources,
  tone,
}: {
  sources: ReadonlyArray<AngleSource>;
  tone: SourcePillTone;
}) {
  if (sources.length === 0) return null;
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of sources) {
    const short = shortenSourceLabel(s.label);
    if (!seen.has(short)) {
      seen.add(short);
      unique.push(short);
    }
  }
  // Phase 23 v2 slice 5.0 (2026-05-06): per-kind colors, no +N
  // overflow. The strip is descriptive — the user does not click
  // these pills (they live under angle cards, not in the
  // SpaceStrip). Three kinds covers most angles.
  const visible = unique.slice(0, 3);
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((label) => (
        <span
          key={label}
          className={`font-mono text-[10px] rounded-full px-2 py-0.5 border ${kindColorClasses(
            label,
            tone === 'selected'
          )}`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}


// Phase 23 v2 slice 4.9 (2026-05-06): Garden surfacing in the chat
// flow. The angles the LLM returns already cite source ids back to
// retrieval — we lift those into a compact strip at the top of every
// assistant turn so the user can see what the system is pulling
// from. Dedupes by source id, caps at four visible, falls silent
// when there are no sources to surface.
function SpaceStrip({
  sources,
  selectedIds,
  carriedIds,
  onPick,
}: {
  sources: ReadonlyArray<AngleSource>;
  selectedIds?: ReadonlySet<string>;
  carriedIds?: ReadonlySet<string>;
  onPick?: (source: AngleSource) => void;
}) {
  const seen = new Set<string>();
  const unique: AngleSource[] = [];
  for (const s of sources) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      unique.push(s);
    }
  }
  if (unique.length === 0) return null;
  // Phase 23 v2 slice 5.2 (2026-05-06): pills are now clickable
  // expand-buttons (the kind-colored border was reading as a
  // permanent selected state — confusing). Default pills are
  // neutral gray; selected pills tip to emerald to match other
  // selection states across the chat. Clicking a pill opens a
  // modal with the title + excerpt + 'open in garden' link.
  const visible = unique.slice(0, 4);
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-tag">
        From your space
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {visible.map((s) => {
          const isSelected = selectedIds?.has(s.id) ?? false;
          const isCarried = carriedIds?.has(s.id) ?? false;
          const interactive = typeof onPick === 'function';
          // Three pill states: active selection (filled emerald,
          // about to ride along on the next reply), carried
          // (subtle emerald outline, has already traveled with a
          // prior reply — persistent indicator), and neutral.
          const cls = isSelected
            ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
            : isCarried
              ? 'bg-paper-2 text-emerald-700 border-emerald-300'
              : 'bg-paper-2 text-tag border-rule';
          const Tag = interactive ? 'button' : 'span';
          return (
            <Tag
              key={s.id}
              type={interactive ? 'button' : undefined}
              onClick={interactive ? () => onPick?.(s) : undefined}
              title={s.title ?? undefined}
              aria-pressed={interactive ? isSelected : undefined}
              className={`flex items-center gap-2 w-full rounded-2xl border px-3 py-1.5 transition-colors text-left ${cls} ${
                interactive ? 'hover:border-rule-strong cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong' : ''
              }`}
            >
              <span className="shrink-0 self-start mt-0.5">
                <KindGlyph kind={s.kind} />
              </span>
              <span className="font-sans text-[12px] leading-[1.45] line-clamp-2">
                {s.title || 'Untitled'}
              </span>
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

// Tiny kind glyph rendered next to source titles. Stays monochrome
// (zinc family) so the strip reads as ornament, not alarm. Each
// kind has its own line silhouette so the eye learns the shape.
function KindGlyph({ kind }: { kind: SimilarKind }) {
  const svgProps = {
    width: 11,
    height: 11,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'text-tag shrink-0',
  };
  if (kind === 'extracted_idea') {
    // garden — leaf
    return (
      <svg {...svgProps}>
        <path d="M3 11C3 6 6 3 11 3C11 8 8 11 3 11Z" />
        <line x1="3" y1="11" x2="7" y2="7" />
      </svg>
    );
  }
  if (kind === 'newsletter_issue') {
    // CSL — envelope
    return (
      <svg {...svgProps}>
        <rect x="2" y="4" width="10" height="6.5" rx="1" />
        <polyline points="2.5,4.5 7,8 11.5,4.5" />
      </svg>
    );
  }
  if (kind === 'linkedin_post') {
    // LinkedIn — rounded square with a quote stroke
    return (
      <svg {...svgProps}>
        <rect x="2" y="2" width="10" height="10" rx="1.5" />
        <line x1="5" y1="6" x2="5" y2="10" />
        <circle cx="5" cy="4" r="0.6" fill="currentColor" />
        <path d="M8 10V7c0-1 .8-1.5 1.5-1.5S11 6 11 7v3" />
      </svg>
    );
  }
  if (kind === 'obsidian_note') {
    // vault — notebook
    return (
      <svg {...svgProps}>
        <rect x="3" y="2.5" width="8" height="9" rx="0.5" />
        <line x1="3" y1="5" x2="11" y2="5" />
        <line x1="5" y1="7" x2="9" y2="7" />
        <line x1="5" y1="9" x2="9" y2="9" />
      </svg>
    );
  }
  if (kind === 'gmail_message') {
    // inbox — tray
    return (
      <svg {...svgProps}>
        <polyline points="2,8 5,8 6.5,10 7.5,10 9,8 12,8" />
        <path d="M2 8V4l1.5-1.5h7L12 4v4" />
      </svg>
    );
  }
  // fallback dot
  return (
    <svg {...svgProps}>
      <circle cx="7" cy="7" r="2.5" />
    </svg>
  );
}

// Phase 23 v2 slice 5.2 (2026-05-06): expand-pill modal. Click a
// 'From your space' chip to open this — title + ~120-word excerpt
// + 'open in garden →' link + 'Bring this with me' select toggle +
// close. Detail is fetched lazily via getSourceDetail. Backdrop
// click and Esc close the modal. The select toggle persists state
// up in CoachView so the source travels with the next reply.
function SourceDetailModal({
  source,
  selected,
  onToggleSelect,
  onClose,
}: {
  source: AngleSource;
  selected: boolean;
  onToggleSelect: () => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<
    Extract<GetSourceDetailResult, { ok: true }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    getSourceDetail({ id: source.id, kind: source.kind })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setDetail(res);
        } else {
          setError(res.message);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.id, source.kind]);

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kindLabel = shortenSourceLabel(source.label);
  const headerTitle = detail?.title ?? source.title ?? 'Untitled';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-[8vh]">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-ink/40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={headerTitle}
        className="relative w-full max-w-[600px] rounded-card bg-paper border border-rule shadow-modal flex flex-col max-h-[80vh] overflow-hidden"
      >
        <div className="border-b border-rule px-5 py-3 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <KindGlyph kind={source.kind} />
            <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
              {kindLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            title="Close"
            className="p-1.5 rounded-soft text-tag hover:text-ink hover:bg-paper-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
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
              <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
              <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <h2 className="font-sans text-[18px] font-semibold text-ink leading-snug">
            {headerTitle}
          </h2>
          {loading && (
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-tag flex items-center gap-2">
              <SpinGlyph />
              Pulling the rest.
            </p>
          )}
          {error && !loading && (
            <p className="font-sans text-[14px] text-ink-soft leading-snug">
              {error}
            </p>
          )}
          {detail && !loading && (
            <>
              {detail.summary && (
                <div className="space-y-1">
                  <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
                    Summary
                  </p>
                  <p className="font-sans text-[14px] text-ink leading-relaxed">
                    {detail.summary}
                  </p>
                </div>
              )}
              {detail.excerpt && (
                <div className="space-y-1">
                  <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
                    {detail.summary ? 'Body' : 'Excerpt'}
                  </p>
                  <div className="space-y-2">
                    {splitForReading(detail.excerpt).map((para, i) => (
                      <p
                        key={i}
                        className="font-sans text-[14px] text-ink-soft leading-relaxed whitespace-pre-wrap"
                      >
                        {para}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {((detail.themes && detail.themes.length > 0) ||
                (detail.tags && detail.tags.length > 0)) && (
                <div className="space-y-1.5">
                  <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag">
                    Themes &amp; tags
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(detail.themes ?? []).map((t) => (
                      <span
                        key={`theme-${t}`}
                        className="font-mono text-[10px] rounded-full border border-violet-200 bg-violet-50 text-violet-700 px-2 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                    {(detail.tags ?? []).map((t) => (
                      <span
                        key={`tag-${t}`}
                        className="font-mono text-[10px] rounded-full border border-rule bg-paper-2 text-tag px-2 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {!detail.summary && !detail.excerpt && (
                <p className="font-sans text-[14px] text-tag leading-snug">
                  No excerpt available for this source.
                </p>
              )}
            </>
          )}
        </div>

        <div className="border-t border-rule px-5 py-3 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleSelect}
            aria-pressed={selected}
            className={`font-mono text-[11px] tracking-[0.18em] uppercase rounded-full px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong border ${
              selected
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                : 'bg-paper text-ink border-rule hover:bg-paper-2 hover:border-rule-strong'
            }`}
          >
            {selected ? 'Selected ✓' : 'Bring this with me'}
          </button>
          {detail?.url && (
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink hover:text-tag transition-colors"
            >
              Open in garden →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 23 v2 slice 6.5 (2026-05-07): split a body excerpt for
// readable rendering. If the excerpt has explicit paragraph breaks
// (blank lines), use those. Otherwise group sentences into chunks
// of three so LinkedIn-style single-block bodies still get visual
// rhythm in the modal.
function splitForReading(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const explicit = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (explicit.length > 1) return explicit;
  // No explicit paragraphs. Split into sentences, group by 3.
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 3) return [trimmed];
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    chunks.push(sentences.slice(i, i + 3).join(' '));
  }
  return chunks;
}

