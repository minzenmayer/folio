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
