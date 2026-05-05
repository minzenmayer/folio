// Thoughtbed · LLM helpers (Anthropic / Claude)
//
// Sprint 9: turns the dormant @ai-sdk/anthropic dep into the generative half
// of the Assistant. The retrieval half (Sprint 7's findSimilar) supplies
// grounded context; this module supplies the synthesis on top of it.
//
// Sprint 12: the reflection prompt now adapts to the composer mode the
// draft was opened in. Newsletter mode reflects in newsletter voice
// ("what would land in next week's issue"); LinkedIn mode reflects shorter
// and punchier (one or two sentences, optimized for the post's body).
// Self-pilot / undefined keeps the original neutral thinking-partner voice.
//
// Voice principles, drawn straight from the brand: "from you, not for you".
//   · Reflect, don't advise. The Assistant is a thinking-partner, not a coach.
//   · Use ONLY the user's own material. Quote where natural. Cite by [1], [2].
//   · Editorial restraint. No preamble. No "I notice".
//
// The model is Haiku by default — reflections are light, fast tasks. Override
// via ANTHROPIC_MODEL if you want Sonnet-grade synthesis.

import { anthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';

import type { SimilarKind } from '@/lib/retrieval-kinds';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[thoughtbed/llm] ANTHROPIC_API_KEY is not set. Reflection will fail until added.'
  );
}

const REFLECTION_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

export type ReflectionHit = {
  index: number; // 1-based, used for [1], [2] citations in the output
  // Sprint 13 added 'newsletter_issue' so Reflect can label the source as
  // "from your own newsletter" rather than a generic capture. Sprint 15
  // Wave 3 added 'obsidian_note' (vault notes) and 'extracted_idea' (the
  // curated Idea layer pulled by extractIdeas() during sync). The union
  // is now sourced from src/lib/retrieval-kinds.ts.
  kind: SimilarKind;
  title: string | null;
  snippet: string | null;
  // Sprint 15 Wave 3: when the source has an extracted Idea attached, the
  // synthesis layer prefers the Idea's claim over a raw body excerpt. This
  // optional field carries that. Only populated for kinds that are
  // backed by extracted_ideas rows.
  ideaTitle?: string | null;
  ideaClaim?: string | null;
};

// Mode signal that adapts the prompt's voice. 'newsletter' biases toward
// "what would close out your next issue"; 'linkedin' shrinks the response
// to one or two punchier sentences. Undefined falls back to the original
// neutral voice — "a thoughtful friend who's been listening".
export type ReflectionVoiceMode = 'newsletter' | 'linkedin';

const MAX_DRAFT_CHARS = 8000;
const MAX_HIT_CHARS = 800;

// Per-mode instruction blocks. The base prompt frames Thoughtbed and the
// grounding rules; the mode block tunes voice and length.
const VOICE_INSTRUCTIONS: Record<
  ReflectionVoiceMode | 'default',
  { instruction: string; maxTokens: number }
> = {
  default: {
    instruction:
      "Surface 2 to 4 connections between their draft and items in the bank. For each connection, write a short 'You explored [idea or source name] in [source title] — that connects to [your draft] because [one sentence of real reasoning]' beat. Refer to ideas by name. Do NOT quote source text verbatim. After the beats, drop a blank line and list 'Sources: [1] [2] [3]' as bracket-numbered receipts (the same numbers you used in the beats). No preamble. No advice. No 'I notice that' or 'It seems like'. Editorial tone, the voice of a thoughtful friend who's been listening.",
    maxTokens: 500,
  },
  newsletter: {
    instruction:
      "Surface 2 to 4 connections between their draft and items in the bank, in newsletter voice. For each, write a confident, observational beat in the shape 'You explored [idea or source name] in [source title] — that connects to [what they're writing now] because [reasoning].' One sentence of real reasoning per beat, no padding. Refer to ideas by name; do NOT quote source text. After the beats, blank line, then 'Sources: [1] [2] [3]' receipts. Reads like a section closer of next week's issue: direct, no hedge language ('I notice', 'It seems'), no preamble.",
    maxTokens: 500,
  },
  linkedin: {
    instruction:
      "Surface 2 to 3 connections between their draft and items in the bank, LinkedIn-post energy — punchier and tighter. For each, one sentence in the shape 'You explored [idea or source name] in [source title] — that connects to [draft] because [reasoning].' Refer to ideas by name; do NOT quote source text. After the lines, blank line, then 'Sources: [1] [2]' receipts. No hashtags, no preamble, no advice, no 'I notice' or 'It seems like'. Not a generic motivational beat.",
    maxTokens: 400,
  },
};

/**
 * Phase 14a (2026-05-04): the reflection API now returns BOTH the prose
 * synthesis AND a per-hit one-sentence "this is here because…" reasoning
 * line. The rail renders the reasoning under each card; the synthesis
 * still drives the existing reflection panel. Single Claude call (more
 * tokens out, same number of round-trips).
 */
export type ReflectionResult = {
  reflection: string;
  // Keyed by ReflectionHit.index (1-based).
  reasoningByIndex: Record<number, string>;
};

/**
 * Generate a reflection on what the user is circling around in their draft,
 * grounded in the retrieved bank passages. Returns the synthesis text plus
 * per-hit reasoning indexed by ReflectionHit.index.
 *
 * Mode (Sprint 12): when present, biases the voice. Newsletter and LinkedIn
 * variants are tuned for those surfaces; undefined keeps the neutral voice.
 *
 * Failure modes:
 *   · ANTHROPIC_API_KEY missing → throws on first call.
 *   · Network / 5xx → throws; caller decides how to surface.
 *   · Empty draft text → caller should short-circuit before calling here;
 *     we still build a prompt but Claude will produce a short non-answer.
 */
export async function generateReflection({
  draftText,
  hits,
  mode,
}: {
  draftText: string;
  hits: ReflectionHit[];
  mode?: ReflectionVoiceMode;
}): Promise<ReflectionResult> {
  const trimmedDraft = draftText.slice(0, MAX_DRAFT_CHARS);

  const bankBlock =
    hits.length === 0
      ? '(nothing in the bank resembles this draft yet)'
      : hits
          .map((h) => {
            // Sprint 15 Wave 3 layer 3: when an extracted Idea is attached
            // to the source (ideaTitle + ideaClaim), we surface the curated
            // claim instead of the raw body excerpt. The LLM is then asked
            // to refer to the idea BY NAME — not to quote the body — which
            // is what the synthesis-prompt rewrite enforces in the voice
            // instruction. Sources without an attached Idea fall back to
            // the snippet (still cleaned by Phase 3's cleanText).
            const label =
              h.kind === 'idea' && h.title
                ? `idea: ${h.title}`
                : h.kind === 'draft' && h.title
                  ? `earlier draft: ${h.title}`
                  : h.kind === 'newsletter_issue' && h.title
                    ? `your own newsletter: ${h.title}`
                    : h.kind === 'obsidian_note' && h.title
                      ? `vault note: ${h.title}`
                      : h.kind === 'extracted_idea' && h.title
                        ? `extracted idea: ${h.title}`
                        : h.kind === 'linkedin_post' && h.title
                          ? `your LinkedIn post: ${h.title}`
                          : h.kind === 'gmail_message' && h.title
                            ? `newsletter you read: ${h.title}`
                            : h.kind;

            const ideaName = h.ideaTitle?.trim();
            const ideaClaim = h.ideaClaim?.trim();
            const fallbackBody = (h.snippet?.trim() || h.title?.trim() || '').slice(
              0,
              MAX_HIT_CHARS
            );

            // Prefer 'the idea you call X — claim: …' rendering when the
            // source has an extracted_idea attached. This is what makes
            // the reflection sound like 'you explored X in Y' instead of
            // 'this passage from your newsletter says blah blah blah'.
            const body =
              ideaName && ideaClaim
                ? `the idea you call \"${ideaName}\" — claim: ${ideaClaim.slice(0, MAX_HIT_CHARS)}`
                : ideaName
                  ? `the idea you call \"${ideaName}\"`
                  : fallbackBody;

            return `[${h.index}] (${label}) ${body}`;
          })
          .join('\n\n');

  const voice = VOICE_INSTRUCTIONS[mode ?? 'default'];

  // Reasoning shape — per-hit "this is here because you wrote about X"
  // sentence. Indices match ReflectionHit.index so the rail can join
  // back to the SimilarHit list.
  const reasoningSchema = z.array(
    z.object({
      index: z.number().int().min(1),
      reasoning: z.string().min(1).max(280),
    })
  );

  const outputSchema = z.object({
    reflection: z
      .string()
      .min(0)
      .max(2000)
      .describe('The synthesis prose — same shape as the prior text-only output.'),
    perHitReasoning: reasoningSchema.describe(
      'One sentence per hit explaining why THIS hit is here given the draft. Use the same [index] numbers as in <bank>. Each sentence starts after a quiet conjunction — never repeats the synthesis prose verbatim. About 12-22 words. No preamble, no "this is here because".'
    ),
  });

  const prompt = `You are a quiet thinking-partner inside Thoughtbed, a private bed where someone matures their own ideas into writing. The user is writing this draft right now:

<draft>
${trimmedDraft}
</draft>

These items from their own captures, ideas, drafts, newsletter issues, vault notes, and extracted ideas resemble what they're writing about. The (label) tag tells you what kind of source each one is. When an item shows 'the idea you call X — claim: ...', that's a curated Idea pulled from the source — refer to it by NAME, not by quoting the claim text.

<bank>
${bankBlock}
</bank>

You will produce TWO things in a single structured response:

1. \`reflection\`: ${voice.instruction}

2. \`perHitReasoning\`: For EACH bank item above (use its [index] number), write one short sentence (12-22 words) saying why this item is here given what they're writing — what specific thread of the draft it threads back to. Direct, one specific connection, no preamble. Don't start with 'this is' or 'because'. Examples: "echoes how you framed embodied attention in the buffalo essay" or "picks up the same trust-vs-verification tension you opened with".`;

  const { object } = await generateObject({
    // The SDK's typed model id is a union of known IDs. We deliberately
    // cast through `any` here so a configurable env override (newer
    // models, fine-tuned variants) doesn't fight the type system. The
    // runtime call passes the id straight to the Anthropic API as a
    // plain string; if it's invalid the API surfaces a clear error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(REFLECTION_MODEL as any),
    schema: outputSchema,
    prompt,
    maxTokens: voice.maxTokens + 400,
    temperature: 0.7,
  });

  const reasoningByIndex: Record<number, string> = {};
  for (const r of object.perHitReasoning ?? []) {
    if (typeof r.index === 'number' && typeof r.reasoning === 'string') {
      const trimmed = r.reasoning.trim();
      if (trimmed.length > 0) reasoningByIndex[r.index] = trimmed;
    }
  }

  return {
    reflection: (object.reflection ?? '').trim(),
    reasoningByIndex,
  };
}


// ─── Phase 15b · generateProposal — home composer's sparring partner ──
//
// 2026-05-05. The home composer at /studio submits a topic; the partner
// retrieves from the user's space (split into voice_longform /
// voice_shortform / knowledge buckets), then asks Claude for:
//
//   · a one-or-two-sentence retrievalSummary — what's in the space on
//     this; reads like a thinking-out-loud line, not a system status.
//   · a platformGuess (newsletter / linkedin / unknown) — derived from
//     topic shape, used to pick voice samples and outline shape.
//   · 3 angles — short one-liners. Each names which retrieval indices
//     fed it so the UI can show "from your CSL issue X + vault note Y".
//   · an outline — 3 to 5 beats, section-shaped for newsletters,
//     hooky-and-tight for linkedin.
//   · a follow-up question — one, picked from a small palette so the
//     thinking keeps moving without the UI turning into a chat.
//
// Voice / knowledge boundary (Phase 15b, prompt-only — no schema work):
//   - voice buckets are how the user writes. The partner studies them
//     for shape, vocabulary, sentence rhythm. Used for angle voice and
//     (when 15a ships) section-draft voice.
//   - knowledge is what the user has read. Surfaced as references and
//     angle-fuel only. Never a voice anchor.
//
// Voice ID profile slot (forward-compatible): the action accepts an
// optional voiceProfile that 15a will populate. Ignored if undefined;
// when present, the prompt uses the profile's summary/attributes
// instead of the raw few-shot samples.
//
// Anti-goals (spec): no "I notice that", no "It seems like", no "Great
// topic", no preamble, no emoji, no "Have you considered". Editorial
// restraint. The partner is a thinking-partner, not a coach.

export type ProposalVoiceProfile = {
  summary?: string;
  attributes?: string[];
  thingsToAvoid?: string[];
};

export type ProposalRetrievalItem = {
  index: number; // 1-based, used for angle citations
  bucket: 'voice_longform' | 'voice_shortform' | 'knowledge';
  // Human label like "your CSL issue", "vault note", "newsletter you read"
  label: string;
  title: string | null;
  // Body excerpt or claim — already cleaned + truncated by caller
  body: string | null;
};

export type ProposalAngle = {
  line: string;
  sourceCitations: number[];
};

export type ProposalResult = {
  retrievalSummary: string;
  platformGuess: 'newsletter' | 'linkedin' | 'unknown';
  angles: ProposalAngle[];
  // Phase 16 (2026-05-05): hook is the LinkedIn-only opener (6-12
  // words). Empty / undefined for newsletter and unknown platforms.
  // Lives at the top of the plan as its own structural slot, separate
  // from outline beats.
  hook: string | null;
  outline: { beat: string }[];
  followUpQuestion: string;
};

const PROPOSAL_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

const PROPOSAL_HIT_BODY_MAX = 600;

const FOLLOW_UP_PALETTE = [
  "What's the takeaway you want?",
  "Who's this for?",
  "What's the tension you're naming?",
  "Is there an idea here you want to bring forward?",
  'Newsletter or LinkedIn? Or just thinking?',
];

export async function generateProposal({
  topic,
  conversationSoFar,
  platformHint,
  voiceProfile,
  retrieval,
}: {
  topic: string;
  conversationSoFar?: string;
  platformHint?: 'newsletter' | 'linkedin';
  // Phase 15a will populate; 15b leaves undefined.
  voiceProfile?: {
    longform?: ProposalVoiceProfile;
    linkedin?: ProposalVoiceProfile;
  };
  retrieval: ProposalRetrievalItem[];
}): Promise<ProposalResult> {
  const trimmedTopic = topic.slice(0, 1000);
  const trimmedConvo = conversationSoFar?.slice(0, 4000);

  // Group the retrieval items by bucket for the prompt. Each group is
  // emitted as its own block so Claude can tell voice from knowledge at
  // a glance — the boundary the spec's prompt-split is built around.
  const longform = retrieval.filter((h) => h.bucket === 'voice_longform');
  const shortform = retrieval.filter((h) => h.bucket === 'voice_shortform');
  const knowledge = retrieval.filter((h) => h.bucket === 'knowledge');

  function renderBlock(items: ProposalRetrievalItem[]): string {
    if (items.length === 0) return '(empty)';
    return items
      .map((h) => {
        const body = (h.body ?? '').slice(0, PROPOSAL_HIT_BODY_MAX).trim();
        const head = h.title ? `${h.label}: "${h.title}"` : h.label;
        return body.length > 0
          ? `[${h.index}] (${head}) ${body}`
          : `[${h.index}] (${head})`;
      })
      .join('\n\n');
  }

  // Voice profile block — empty until 15a ships. When present, this
  // replaces the few-shot reliance with a clean schema Claude can read.
  const voiceProfileBlock = (() => {
    if (!voiceProfile) return '(no voice profile yet — read the voice bucket samples for how the user writes)';
    const parts: string[] = [];
    if (voiceProfile.longform) {
      parts.push(
        `LONGFORM voice:
  summary: ${voiceProfile.longform.summary ?? '—'}
  attributes: ${(voiceProfile.longform.attributes ?? []).join('; ') || '—'}
  avoid: ${(voiceProfile.longform.thingsToAvoid ?? []).join('; ') || '—'}`
      );
    }
    if (voiceProfile.linkedin) {
      parts.push(
        `LINKEDIN voice:
  summary: ${voiceProfile.linkedin.summary ?? '—'}
  attributes: ${(voiceProfile.linkedin.attributes ?? []).join('; ') || '—'}
  avoid: ${(voiceProfile.linkedin.thingsToAvoid ?? []).join('; ') || '—'}`
      );
    }
    return parts.length > 0 ? parts.join('\n\n') : '(profile present but empty)';
  })();

  const platformHintLine = platformHint
    ? `The user already indicated this is a ${platformHint} piece. Don't ask again — set platformGuess accordingly.`
    : 'If the topic shape clearly suggests newsletter (essay-length, multi-beat) or linkedin (single-thread, hooky), set platformGuess. Otherwise leave it "unknown" and ask the platform clarifying question as your follow-up.';

  const sparseCorpusNote =
    retrieval.length < 3
      ? 'NOTE: the user does not have much in their space on this yet. Acknowledge that in retrievalSummary in one short clause; lean on what little did surface; do not invent connections.'
      : '';

  const conversationBlock = trimmedConvo
    ? `

<conversation_so_far>
${trimmedConvo}
</conversation_so_far>

The user has already been sparring with you on this topic. Read the conversation. Your angles and follow-up question should advance the thinking from where it left off — not restart it.`
    : '';

  const outputSchema = z.object({
    retrievalSummary: z
      .string()
      .max(1200)
      .describe(
        "One or two sentences reflecting what's in the user's space on this topic. Direct, observational. Not a status report. Reads like a thinking-out-loud line. No 'I notice', no 'It seems', no 'Here's what I found'."
      ),
    platformGuess: z
      .enum(['newsletter', 'linkedin', 'unknown'])
      .describe(
        'Newsletter for essay-shape topics; linkedin for single-thread / hooky topics; unknown if ambiguous and the user should be asked.'
      ),
    angles: z
      .array(
        z.object({
          line: z
            .string()
            .min(1)
            .max(600)
            .describe('A one-line angle — a way into the topic. Specific, declarative. Not a question.'),
          sourceCitations: z
            .array(z.number().int().min(1))
            .max(12)
            .default([])
            .describe('Indices [n] from the retrieval blocks above whose framing fed this angle.'),
        })
      )
      .min(1)
      .max(6)
      .describe('Three default. Two if the topic surfaces a clear two-direction tension. Four if open-ended.'),
    hook: z
      .string()
      .max(140)
      .nullable()
      .default(null)
      .describe(
        'LINKEDIN ONLY. The opener — 6 to 12 words. Stops the scroll. Promises a clear payoff. No jargon. Concrete. Set to null for newsletter or unknown platforms (the spar surfaces hook only as a LinkedIn structural slot).'
      ),
    outline: z
      .array(
        z.object({
          beat: z
            .string()
            .min(1)
            .max(600)
            .describe(
              'A single beat — section-shape for newsletter (one line summarizing the section); hooky-and-tight for linkedin (one beat = one move).'
            ),
        })
      )
      .min(1)
      .max(8)
      .describe('A working outline aligned to platformGuess. Tight, no padding.'),
    followUpQuestion: z
      .string()
      .min(1)
      .max(400)
      .describe(
        `One question to keep the thinking moving. Pick the one that fits the topic from this palette (or write a close variant): ${FOLLOW_UP_PALETTE.map((q) => `"${q}"`).join(', ')}. Don't ask all of them.`
      ),
  });

  const prompt = `You are a sparring writing partner inside Thoughtbed — a private bed where someone matures their own ideas into writing. The user has just submitted a topic. Your job is the blank-page-to-clear-direction stretch: surface what's in their space on this, take a real swing at three angles, sketch an outline, and ask one question that keeps the thinking moving. You do NOT draft the body. You do NOT answer questions you weren't asked. You are not a coach.

<topic>
${trimmedTopic}
</topic>${conversationBlock}

The retrieval blocks below are split into voice and knowledge.
  - VOICE LONGFORM is how the user writes essay-shape pieces (newsletter / vault).
  - VOICE SHORTFORM is how the user writes LinkedIn-shape pieces — a different voice.
  - KNOWLEDGE is what the user reads, not writes. Use these as references and angle-fuel. NEVER as voice samples.

<voice_longform>
${renderBlock(longform)}
</voice_longform>

<voice_shortform>
${renderBlock(shortform)}
</voice_shortform>

<knowledge>
${renderBlock(knowledge)}
</knowledge>

<voice_profile>
${voiceProfileBlock}
</voice_profile>

${platformHintLine}
${sparseCorpusNote}

Voice rules. No "I notice that", no "It seems like", no "Great topic", no "Here's what I came up with", no preamble. No emoji. No tone-policing. No "Have you considered". Editorial restraint. When you cite an angle's source, the UI will render the citation; you don't need to write "based on your CSL issue X" in the angle line itself — keep the line tight, let sourceCitations do the work.

If platformGuess is "linkedin", emit a `hook` — 6 to 12 words, opener-shape, stops the scroll. If platformGuess is "newsletter" or "unknown", set hook to null. The hook is its own structural slot, separate from the outline beats; do not duplicate the hook as the first beat.

Now produce the structured output.`;

  const { object } = await generateObject({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(PROPOSAL_MODEL as any),
    schema: outputSchema,
    prompt,
    maxTokens: 1200,
    temperature: 0.7,
  });

  return {
    retrievalSummary: (object.retrievalSummary ?? '').trim(),
    platformGuess: object.platformGuess ?? 'unknown',
    angles: (object.angles ?? []).map((a) => ({
      line: a.line.trim(),
      sourceCitations: a.sourceCitations ?? [],
    })),
    hook: object.hook ? object.hook.trim() : null,
    outline: (object.outline ?? []).map((b) => ({
      beat: b.beat.trim(),
    })),
    followUpQuestion: (object.followUpQuestion ?? '').trim(),
  };
}


// ─── Phase 15a · generateVoiceProfile — Voice ID build pipeline ─────
//
// 2026-05-05. profileVault (in src/lib/voice/profile-vault.ts) hands
// this function a per-platform sample of representative pieces, and
// gets back the Ghostbase-shape schema to persist into voice_profiles.
//
// One Haiku call per platform. Voice profiles are NOT cumulative —
// each rebuild overwrites the prior auto fields (manual fields persist
// in the schema and are merged at read time).
//
// The prompt is shaped slightly differently per platform: longform
// piece samples can be long (several thousand chars) so the prompt
// asks for sentence-rhythm + paragraph-shape patterns; linkedin is
// shorter and the prompt asks for hook patterns + line breaks +
// closer-shape. Same output schema; different framing.

export type VoiceProfileSample = {
  // 'newsletter_issue' | 'obsidian_note' | 'linkedin_post'
  sourceKind: string;
  title: string | null;
  // Author-facing date — used in the prompt only as context, not
  // sorted/weighted by Claude.
  postedAt: Date | null;
  // Already truncated to per-kind budget by the caller.
  body: string;
};

export type VoiceProfileOutput = {
  summary: string;
  attributes: string[];
  thingsToAvoid: string[];
};

const VOICE_PROFILE_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

// Longform attribute count caps. Longform tolerates more nuance; LinkedIn
// is tighter — trying to extract 12 LinkedIn-voice attributes from 30
// short posts produces filler, so the cap is lower.
const LONGFORM_ATTR_TARGET = { min: 6, max: 12 };
const LINKEDIN_ATTR_TARGET = { min: 4, max: 8 };
const AVOID_TARGET = { min: 0, max: 6 };

export async function generateVoiceProfile({
  platform,
  samples,
}: {
  platform: 'longform' | 'linkedin';
  samples: VoiceProfileSample[];
}): Promise<VoiceProfileOutput> {
  if (samples.length === 0) {
    // Return an empty-but-valid shape rather than throw — caller
    // (profileVault) checks emptiness against the cold-start placeholder
    // logic before persisting.
    return { summary: '', attributes: [], thingsToAvoid: [] };
  }

  const attrTarget =
    platform === 'longform' ? LONGFORM_ATTR_TARGET : LINKEDIN_ATTR_TARGET;

  const sampleBlock = samples
    .map((s, i) => {
      const head = s.title
        ? `[${i + 1}] ${labelForKind(s.sourceKind)}: "${s.title}"`
        : `[${i + 1}] ${labelForKind(s.sourceKind)}`;
      return `${head}\n${s.body.trim()}`;
    })
    .join('\n\n----\n\n');

  const platformFraming =
    platform === 'longform'
      ? `These are samples of how the user writes longform pieces — newsletter issues and vault notes (essays, drafts, sustained arguments). Read them as a body of work, not isolated pieces. Look for sentence rhythm, paragraph shape, where they put pressure, what kinds of openings and closings they favor, characteristic transitions, recurring vocabulary that's actually theirs (not generic).`
      : `These are samples of how the user writes for LinkedIn — short-form posts, often hooky, often single-thread. Voice runs different here than in longform. Look for hook patterns (the first line and how it sets up the rest), line break shape, where they land the takeaway, whether they end with a question or a call to action or a single-word punch, what kinds of moves they actually make on this surface (not what generic LinkedIn "best practice" says).`;

  const outputSchema = z.object({
    summary: z
      .string()
      .max(1200)
      .describe(
        'A single short paragraph summarizing how this person writes on this platform. Direct, observational, second-person ("you"). One paragraph, not bullet points. No "I notice", no "It seems", no preamble. About 60-100 words.'
      ),
    attributes: z
      .array(z.string().min(1).max(400))
      .max(20)
      .describe(
        `Concrete voice attributes. Short declarative phrases. Each one a specific pattern you can point to in the samples. Examples (don\'t copy these, write fresh): "opens with a question more often than not", "uses em-dashes as breath, not commas", "closes essays with a one-line zinger", "names ideas before naming people". Aim for ${attrTarget.min}-${attrTarget.max} items.`
      ),
    thingsToAvoid: z
      .array(z.string().min(1).max(400))
      .max(20)
      .describe(
        'Words, phrases, or moves the user consistently does NOT make. Taboos inferred from their absence in the samples. Examples (don\'t copy): "no exclamation marks", "never uses the word \'really\'", "no marketing-speak verbs (unlock, leverage, supercharge)". 0-6 items. Only include when the absence is striking enough to be a real signal; don\'t pad.'
      ),
  });

  const prompt = `You are profiling a writer's voice from samples of their own work. The output goes into a voice profile that an AI will read when imitating this person's voice. The profile must be sharp enough that a different AI reading it later can produce prose that sounds like THIS writer, not a generic version.

${platformFraming}

<samples>
${sampleBlock}
</samples>

Voice rules for your output:
  - Direct observational tone. Second-person ("you").
  - No preamble, no "I notice", no "It seems", no "this writer".
  - Don't summarize what they write ABOUT — describe HOW they write.
  - Be specific. "Uses em-dashes" beats "punctuation-aware".
  - Things-to-avoid: only include when the absence is a real signal. Don't pad.

Now produce the structured output.`;

  const { object } = await generateObject({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(VOICE_PROFILE_MODEL as any),
    schema: outputSchema,
    prompt,
    maxTokens: 1500,
    temperature: 0.5,
  });

  return {
    summary: (object.summary ?? '').trim(),
    attributes: (object.attributes ?? []).map((a) => a.trim()).filter(Boolean),
    thingsToAvoid: (object.thingsToAvoid ?? [])
      .map((a) => a.trim())
      .filter(Boolean),
  };
}

function labelForKind(kind: string): string {
  if (kind === 'newsletter_issue') return 'newsletter issue';
  if (kind === 'obsidian_note') return 'vault note';
  if (kind === 'linkedin_post') return 'linkedin post';
  return kind;
}



// ─── Phase 15a · generateSectionDraft — Draft-a-section in voice ─────
//
// 2026-05-05. Called by the Spar surface's per-beat 'Draft section'
// button. Takes a voice profile, the beat we're drafting, the
// surrounding outline context, and a slice of the user's own retrieval
// for that beat — returns prose for that one beat in their voice.
//
// Hard requirement: voiceProfile MUST be present for the platform.
// Generic-voice section drafts are worse than no drafts (spec
// rationale; Payton picked Voice ID before section-drafts for this
// reason). The action layer enforces this; this function trusts the
// caller has already validated.

export type SectionDraftResult = {
  prose: string;
};

const SECTION_DRAFT_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

const SECTION_DRAFT_HIT_BODY_MAX = 600;

export async function generateSectionDraft({
  topic,
  beatIndex,
  outline,
  platform,
  voiceProfile,
  retrieval,
  conversationSoFar,
}: {
  topic: string;
  // 0-based index into outline[] of the beat we are drafting.
  beatIndex: number;
  outline: { beat: string }[];
  platform: 'newsletter' | 'linkedin';
  // Required (not optional). The caller must enforce.
  voiceProfile: ProposalVoiceProfile;
  // Retrieval slice — same ProposalRetrievalItem shape, scoped to the
  // beat being drafted (caller can re-run findSimilar with the beat
  // text or pass the topic-level retrieval if scoping isn't worth a
  // round-trip).
  retrieval: ProposalRetrievalItem[];
  conversationSoFar?: string;
}): Promise<SectionDraftResult> {
  const beat = outline[beatIndex]?.beat?.trim();
  if (!beat) {
    throw new Error(`generateSectionDraft: beat at index ${beatIndex} is empty`);
  }

  const trimmedTopic = topic.slice(0, 1000);
  const trimmedConvo = conversationSoFar?.slice(0, 4000);

  // Frame the surrounding outline so Claude knows what comes before
  // and after this beat — cohesion across sections matters even when
  // we only draft one.
  const outlineFrame = outline
    .map((b, i) => {
      const marker = i === beatIndex ? '→ THIS BEAT' : '  ';
      return `${marker} ${String(i + 1).padStart(2, '0')} ${b.beat}`;
    })
    .join('\n');

  const retrievalBlock =
    retrieval.length === 0
      ? '(no retrieval items — write from voice profile + outline only)'
      : retrieval
          .slice(0, 8)
          .map((h) => {
            const body = (h.body ?? '').slice(0, SECTION_DRAFT_HIT_BODY_MAX).trim();
            const head = h.title ? `${h.label}: "${h.title}"` : h.label;
            return body.length > 0
              ? `(${head}) ${body}`
              : `(${head})`;
          })
          .join('\n\n');

  const platformLength =
    platform === 'newsletter'
      ? '120-260 words for this beat. One to three short paragraphs. Each paragraph does one move.'
      : '50-120 words for this beat. Tight, hooky, single-thread shape. LinkedIn-style formatting: short lines, line breaks between thoughts, occasional one-word lines for emphasis. Not a paragraph block.';

  const voiceBlock = renderVoiceProfileBlock(voiceProfile);

  const conversationFrame = trimmedConvo
    ? `\n\n<conversation_so_far>\n${trimmedConvo}\n</conversation_so_far>\n`
    : '';

  const outputSchema = z.object({
    prose: z
      .string()
      .min(20)
      .max(2000)
      .describe(
        'The drafted prose for this single beat — in the user\'s voice. No headings, no bullet markers in the output (the editor will own structure). One coherent piece that fits inside the beat.'
      ),
  });

  const prompt = `You are drafting one section of a piece for the user. They will read it inside their writing surface and decide whether to keep, swap, or rewrite. Your job: produce prose for ONE beat in their voice. NOT the whole piece. NOT a summary. Just this one beat.

<topic>
${trimmedTopic}
</topic>

<outline>
${outlineFrame}
</outline>${conversationFrame}

<voice_profile>
${voiceBlock}
</voice_profile>

<retrieval>
${retrievalBlock}
</retrieval>

Voice rules:
  - Write IN the user\'s voice as described in the voice profile. If the profile says they avoid certain words or moves, do NOT use them. If it says they open with X or close with Y, honor that pattern.
  - No preamble. No "Here\'s a draft of section X." Open with the prose itself.
  - No headings, no markdown structure. Plain paragraphs only — the editor adds structure.
  - ${platformLength}
  - Don\'t pad. Don\'t recap the outline. Write only this beat.
  - If the retrieval block has the user\'s own past framing on this, lean on it — but in their voice, not as a quote.

Now produce the structured output.`;

  const { object } = await generateObject({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(SECTION_DRAFT_MODEL as any),
    schema: outputSchema,
    prompt,
    maxTokens: 800,
    temperature: 0.65,
  });

  return {
    prose: (object.prose ?? '').trim(),
  };
}

function renderVoiceProfileBlock(profile: ProposalVoiceProfile): string {
  const parts: string[] = [];
  if (profile.summary) parts.push(`SUMMARY: ${profile.summary}`);
  if (profile.attributes && profile.attributes.length > 0) {
    parts.push(
      `ATTRIBUTES:\n${profile.attributes.map((a) => `  - ${a}`).join('\n')}`
    );
  }
  if (profile.thingsToAvoid && profile.thingsToAvoid.length > 0) {
    parts.push(
      `AVOID:\n${profile.thingsToAvoid.map((a) => `  - ${a}`).join('\n')}`
    );
  }
  return parts.length > 0 ? parts.join('\n\n') : '(empty profile)';
}


// ─── Phase 16 · generateBeatDraft — Per-piece micro-drafting ────────
//
// 2026-05-05. Replaces draftSection as the primary per-beat drafting
// path. Difference from generateSectionDraft: the user supplies an
// intent ("what do you want to say in this beat?") and the LLM drafts
// 2-4 sentences that pay off that intent in the user's voice. Output
// is intentionally short — closer to a paragraph than a full section.
//
// Voice profile fallback is SOFTER than draftSection. If the profile
// is missing for this platform, the function still drafts — leaning
// on retrieval-only voice cues + the user's stated intent. The
// rationale: when the user has typed an intent, they've already given
// the LLM enough material to draft something useful; a hard-block
// would feel punitive. draftSection's no-intent path keeps the
// hard-block (see generateSectionDraft above).

export type BeatDraftResult = {
  prose: string;
};

const BEAT_DRAFT_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

const BEAT_DRAFT_HIT_BODY_MAX = 500;

export async function generateBeatDraft({
  topic,
  beatIndex,
  outline,
  platform,
  voiceProfile,
  retrieval,
  conversationSoFar,
  userIntent,
}: {
  topic: string;
  beatIndex: number;
  outline: { beat: string }[];
  platform: 'newsletter' | 'linkedin';
  // Optional in v2 — soft fallback when missing.
  voiceProfile?: ProposalVoiceProfile;
  retrieval: ProposalRetrievalItem[];
  conversationSoFar?: string;
  // The user's stated intent for this beat. The whole point of v2.
  userIntent: string;
}): Promise<BeatDraftResult> {
  const beat = outline[beatIndex]?.beat?.trim();
  if (!beat) {
    throw new Error(`generateBeatDraft: beat at index ${beatIndex} is empty`);
  }

  const trimmedTopic = topic.slice(0, 1000);
  const trimmedConvo = conversationSoFar?.slice(0, 4000);
  const trimmedIntent = userIntent.slice(0, 1500).trim();

  const outlineFrame = outline
    .map((b, i) => {
      const marker = i === beatIndex ? '→ THIS BEAT' : '  ';
      return `${marker} ${String(i + 1).padStart(2, '0')} ${b.beat}`;
    })
    .join('\n');

  const retrievalBlock =
    retrieval.length === 0
      ? '(no retrieval items — write from intent + outline only)'
      : retrieval
          .slice(0, 6)
          .map((h) => {
            const body = (h.body ?? '').slice(0, BEAT_DRAFT_HIT_BODY_MAX).trim();
            const head = h.title ? `${h.label}: "${h.title}"` : h.label;
            return body.length > 0 ? `(${head}) ${body}` : `(${head})`;
          })
          .join('\n\n');

  // Phase 16: shorter than generateSectionDraft. The intent is "say
  // this one thing" — 2-4 sentences, not a full section.
  const platformLength =
    platform === 'newsletter'
      ? '50-90 words. 2-4 sentences. One coherent paragraph that pays off the user\'s stated intent.'
      : '30-60 words. 2-3 short lines, LinkedIn-style — short rhythm, line breaks for emphasis. Not a paragraph block.';

  const voiceBlock = voiceProfile
    ? renderVoiceProfileBlock(voiceProfile)
    : '(no voice profile — lean on retrieval and the user\'s stated intent for voice cues. Avoid generic AI cadences. Avoid "I notice", "It seems", "Great question", preamble of any kind.)';

  const conversationFrame = trimmedConvo
    ? `\n\n<conversation_so_far>\n${trimmedConvo}\n</conversation_so_far>\n`
    : '';

  const outputSchema = z.object({
    prose: z
      .string()
      .min(15)
      .max(1200)
      .describe(
        'The drafted prose for this single beat — paying off the user\'s stated intent in their voice. No headings, no bullet markers. Plain paragraph(s) only.'
      ),
  });

  const prompt = `You are drafting one short section of a piece. The user has TOLD you what they want to say here. Your job: write 2-4 sentences that pay off that intent in their voice. NOT the whole piece. NOT a summary. Just this one beat.

<topic>
${trimmedTopic}
</topic>

<outline>
${outlineFrame}
</outline>${conversationFrame}

<voice_profile>
${voiceBlock}
</voice_profile>

<retrieval>
${retrievalBlock}
</retrieval>

<user_intent_for_this_beat>
${trimmedIntent}
</user_intent_for_this_beat>

Voice rules:
  - The user's stated intent is the FRAME. Don't ignore it. Don't drift into a different point. Honor what they said they want to say.
  - Write IN the user's voice (per the voice profile). If the profile flags words/moves to avoid, do not use them.
  - No preamble. No "Here's a draft." Open with the prose itself.
  - No headings, no markdown structure. Plain paragraphs only.
  - ${platformLength}
  - Don't pad. Don't recap the outline. Just this beat.
  - If retrieval surfaces the user's own past framing on this, lean on it — but in their voice, not as a quote.

Now produce the structured output.`;

  const { object } = await generateObject({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(BEAT_DRAFT_MODEL as any),
    schema: outputSchema,
    prompt,
    maxTokens: 600,
    temperature: 0.7,
  });

  return {
    prose: (object.prose ?? '').trim(),
  };
}
