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
import { generateText } from 'ai';

import type { SimilarKind } from '@/lib/retrieval-kinds';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[thoughtbed/llm] ANTHROPIC_API_KEY is not set. Reflection will fail until added.'
  );
}

const REFLECTION_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022';

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
 * Generate a reflection on what the user is circling around in their draft,
 * grounded in the retrieved bank passages. Returns the raw model text —
 * typically with [1], [2] inline citations to the hits.
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
}): Promise<string> {
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

  const prompt = `You are a quiet thinking-partner inside Thoughtbed, a private bed where someone matures their own ideas into writing. The user is writing this draft right now:

<draft>
${trimmedDraft}
</draft>

These items from their own captures, ideas, drafts, newsletter issues, vault notes, and extracted ideas resemble what they're writing about. The (label) tag tells you what kind of source each one is. When an item shows 'the idea you call X — claim: ...', that's a curated Idea pulled from the source — refer to it by NAME, not by quoting the claim text.

<bank>
${bankBlock}
</bank>

${voice.instruction}`;

  const { text } = await generateText({
    // The SDK's typed model id is a union of known IDs. We deliberately
    // cast through `any` here so a configurable env override (newer
    // models, fine-tuned variants) doesn't fight the type system. The
    // runtime call passes the id straight to the Anthropic API as a
    // plain string; if it's invalid the API surfaces a clear error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(REFLECTION_MODEL as any),
    prompt,
    maxTokens: voice.maxTokens,
    temperature: 0.7,
  });

  return text.trim();
}
