/**
 * src/lib/extract-ideas.ts
 *
 * Hybrid idea-extraction pipeline:
 *   1. Anthropic Claude Haiku (via Vercel AI SDK `generateObject`) produces
 *      a structured list of ideas from raw markdown text.
 *   2. Deterministic post-processing calibrates depth/breadth signals and
 *      clamps obvious LLM over-claims.
 *
 * The function is intentionally stateless — callers (upsertIssue,
 * upsertParsedNote, backfillExtractedIdeas) own the DB writes.
 *
 * Wave 3 will consume the depth/breadth signals for retrieval ranking.
 */

import { generateObject }   from 'ai';
import { anthropic }        from '@ai-sdk/anthropic';
import { z }                from 'zod';

// ── Schema ───────────────────────────────────────────────────────────────────

const IdeaSchema = z.object({
  title:    z.string().describe('Short label for the idea (≤ 12 words)'),
  claim:    z.string().describe('One-sentence statement of the core claim'),
  evidence: z.string().optional().describe('Supporting quote or sentence from the source'),
  links:    z.array(z.string()).optional().describe('URLs or [[wikilinks]] referenced by this idea'),
});

const IdeasResponseSchema = z.object({
  ideas: z.array(IdeaSchema).max(12),
});

export type RawIdea = z.infer<typeof IdeaSchema>;

// ── Calibration ──────────────────────────────────────────────────────────────

/**
 * Context passed by the caller to help calibrate signals.
 * All fields are optional — extraction degrades gracefully.
 */
export interface IdeaContext {
  /** Vault-relative path or newsletter slug — stored as sourceRef. */
  sourceRef?: string;
  /** Tags from frontmatter or inline #tags. */
  tags?: string[];
  /** Raw frontmatter object for MOC / type detection. */
  frontmatter?: Record<string, unknown>;
}

/** Fully calibrated idea ready for DB insertion. */
export interface Idea {
  title:        string;
  claim:        string;
  evidence?:    string;
  depthScore?:  number;   // 0–1
  breadthScore?: number;  // 0–1
  links?:       string[];
  sourceRef?:   string;
}

// ── Signal calibration helpers ────────────────────────────────────────────────

/**
 * Depth signal — penalises short, thin text.
 *
 * Heuristic: depth correlates with word count (a proxy for argument
 * development) up to a ceiling of ~600 words, beyond which extra length
 * stops adding signal quality.
 */
function calibrateDepth(body: string, idea: RawIdea): number {
  const words       = body.split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.min(words / 600, 1);   // 0 → 1 at ≥ 600 words

  // Penalise if the idea has no evidence quote.
  const evidenceBonus = idea.evidence ? 0.15 : 0;

  return Math.min(lengthScore + evidenceBonus, 1);
}

/**
 * Breadth signal — rewards densely-linked notes.
 *
 * Heuristic: a high ratio of wikilinks/URLs to words suggests the note
 * integrates many concepts (Map-of-Content pattern).  Capped at 0.9 to
 * leave room for the MOC frontmatter bonus.
 */
function calibrateBreadth(
  body:        string,
  idea:        RawIdea,
  frontmatter: Record<string, unknown> = {}
): number {
  const words      = body.split(/\s+/).filter(Boolean).length || 1;
  const linkCount  = (idea.links?.length ?? 0);
  const density    = Math.min(linkCount / (words / 50), 1); // 1 link per 50 words → 1.0

  // MOC bonus: frontmatter type:MOC or type:map-of-content
  const type = String(frontmatter['type'] ?? '').toLowerCase();
  const mocBonus = (type === 'moc' || type === 'map-of-content') ? 0.15 : 0;

  return Math.min(density + mocBonus, 1);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extracts up to 12 ideas from `body` using Claude Haiku, then
 * calibrates depth + breadth signals deterministically.
 *
 * @param body     Raw markdown / prose text (frontmatter already stripped).
 * @param context  Optional caller-supplied metadata for richer calibration.
 * @returns        Array of calibrated Idea objects (may be empty if the
 *                 model finds nothing worth extracting).
 */
export async function extractIdeas(
  body:    string,
  context: IdeaContext = {}
): Promise<Idea[]> {
  // ── Guard: skip obviously empty or non-prose content ────────────────────
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 30) return [];

  // Truncate to ~4 000 words to stay inside Haiku's context window and
  // keep costs predictable.  We lose the tail but preserve structure.
  const trimmed = body.split(/\s+/).slice(0, 4_000).join(' ');

  // ── LLM call ─────────────────────────────────────────────────────────────
  let rawIdeas: RawIdea[];
  try {
    const { object } = await generateObject({
      model: anthropic('claude-haiku-4-5'),
      schema: IdeasResponseSchema,
      system: [
        'You are an expert knowledge curator.',
        'Extract the most substantive, non-obvious ideas from the text below.',
        'Each idea must have a clear claim sentence.',
        'Return at most 12 ideas, ordered by importance.',
        'Do not invent ideas not present in the text.',
      ].join(' '),
      prompt: trimmed,
    });
    rawIdeas = object.ideas;
  } catch (err) {
    console.error('[extract-ideas] LLM call failed:', err);
    return [];
  }

  // ── Post-processing ───────────────────────────────────────────────────────
  const ideas: Idea[] = rawIdeas.map((raw) => {
    const depth   = calibrateDepth(body, raw);
    const breadth = calibrateBreadth(body, raw, context.frontmatter ?? {});

    // Word-count ceiling: very short claims are likely not real ideas.
    const claimWords = raw.claim.split(/\s+/).filter(Boolean).length;
    const tooThin    = claimWords < 6;

    return {
      title:        raw.title,
      claim:        raw.claim,
      evidence:     raw.evidence,
      depthScore:   tooThin ? depth  * 0.5 : depth,
      breadthScore: tooThin ? breadth * 0.5 : breadth,
      links:        raw.links,
      sourceRef:    context.sourceRef,
    };
  });

  return ideas;
}
