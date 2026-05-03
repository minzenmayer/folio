// Folio · LLM helpers (Anthropic / Claude)
//
// Sprint 9: turns the dormant @ai-sdk/anthropic dep into the generative half
// of the Assistant. The retrieval half (Sprint 7's findSimilar) supplies
// grounded context; this module supplies the synthesis on top of it.
//
// Voice principles, drawn straight from the brand: "from you, not for you".
//   · Reflect, don't advise. The Assistant is a thinking-partner, not a coach.
//   · Use ONLY the user's own material. Quote where natural. Cite by [1], [2].
//   · Editorial restraint. Two or three sentences. No preamble. No "I notice".
//
// The model is Haiku by default — reflections are light, fast tasks. Override
// via ANTHROPIC_MODEL if you want Sonnet-grade synthesis.

import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[folio/llm] ANTHROPIC_API_KEY is not set. Reflection will fail until added.'
  );
}

const REFLECTION_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022';

export type ReflectionHit = {
  index: number; // 1-based, used for [1], [2] citations in the output
  kind: 'capture' | 'idea' | 'draft';
  title: string | null;
  snippet: string | null;
};

const MAX_DRAFT_CHARS = 8000;
const MAX_HIT_CHARS = 800;

/**
 * Generate a 2-3 sentence reflection on what the user is circling around in
 * their draft, grounded in the retrieved bank passages. Returns the raw
 * model text — typically with [1], [2] inline citations to the hits.
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
}: {
  draftText: string;
  hits: ReflectionHit[];
}): Promise<string> {
  const trimmedDraft = draftText.slice(0, MAX_DRAFT_CHARS);

  const bankBlock =
    hits.length === 0
      ? '(nothing in the bank resembles this draft yet)'
      : hits
          .map((h) => {
            // Label by kind, with the title for ideas/drafts so the source is
            // self-evident in the reflection.
            const label =
              h.kind === 'idea' && h.title
                ? `idea: ${h.title}`
                : h.kind === 'draft' && h.title
                  ? `earlier draft: ${h.title}`
                  : h.kind;
            const body = (h.snippet?.trim() || h.title?.trim() || '').slice(
              0,
              MAX_HIT_CHARS
            );
            return `[${h.index}] (${label}) ${body}`;
          })
          .join('\n\n');

  const prompt = `You are a quiet thinking-partner inside Folio, a private studio someone keeps for their own thinking. The user is writing this draft right now:

<draft>
${trimmedDraft}
</draft>

These passages from their own captures, ideas, and earlier drafts resemble what they're writing about — in their own words:

<bank>
${bankBlock}
</bank>

Reflect back what they seem to be circling around or working toward — in 2-3 short sentences. Use ONLY their own material; quote it where natural. Reference items by bracket number, like [1] or [2], inline. No preamble. No advice. No "I notice that" or "It seems like". Editorial tone, the voice of a thoughtful friend who's been listening.`;

  const { text } = await generateText({
    // The SDK's typed model id is a union of known IDs. We deliberately
    // cast through `any` here so a configurable env override (newer
    // models, fine-tuned variants) doesn't fight the type system. The
    // runtime call passes the id straight to the Anthropic API as a
    // plain string; if it's invalid the API surfaces a clear error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(REFLECTION_MODEL as any),
    prompt,
    maxTokens: 400,
    temperature: 0.7,
  });

  return text.trim();
}
