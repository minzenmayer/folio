// Thoughtbed · extractIdeas (Sprint 15 Wave 2)
//
// Pulls the "unit of meaning" — what the founder calls an Idea — out of
// a written source (a newsletter issue, an Obsidian note). Each Idea
// carries both the textual shape (title / claim / evidence / links) AND
// signals (depth, breadth) that Wave 3's retrieval ranking will use to
// boost ideas-rich matches over raw embedding cosine.
//
// The extraction is hybrid:
//   1. Deterministic structuring — pull headings, frontmatter properties,
//      link density, word count. These give us heuristics that don't
//      cost an LLM call.
//   2. LLM judgment via `generateObject` (Anthropic Haiku, same model
//      Reflect uses) with a strict Zod schema for the output. Returns
//      0..5 ideas per source — biased conservative, "better one strong
//      idea than five thin ones".
//   3. Signal calibration — the LLM proposes 0..1 floats; we sanity-check
//      against deterministic signals (link density, frontmatter type,
//      word count) and clamp.
//
// Why hybrid: pure rule-based misses the recursive structure of how the
// founder writes (depth often reads as "this paragraph builds on the
// last"); pure LLM is too easy to fool with surface signals (a 3000-word
// note can still be shallow). Combining both keeps the function tunable
// per-vault as we learn the founder's actual conventions.
//
// See docs/curation-formula.md for the detailed framework + the gap that
// the runtime profileVault() step will fill once an actual vault connects.

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  db,
  extractedIdeas,
  newsletterIssues,
  obsidianNotes,
  type NewExtractedIdea,
} from '@/db';
import { embedText } from '@/lib/embed';

// ─── model + prompt ───────────────────────────────────────

const EXTRACTION_MODEL =
  process.env.ANTHROPIC_EXTRACT_MODEL ??
  process.env.ANTHROPIC_MODEL ??
  'claude-3-5-haiku-20241022';

// Hard ceilings so a runaway source doesn't blow the prompt budget.
const MAX_SOURCE_CHARS = 12_000;
const MAX_IDEAS = 5;

// LLM output schema. Looser than the DB column types on purpose — we
// post-process (clamp signals, default missing evidence) before insert.
const llmIdeaSchema = z.object({
  title: z.string().min(2).max(160),
  claim: z.string().min(8).max(800),
  evidence: z.string().max(1200).optional().default(''),
  depth_signal: z.number().min(0).max(1),
  breadth_signal: z.number().min(0).max(1),
  links: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
});

const llmOutputSchema = z.object({
  ideas: z.array(llmIdeaSchema).max(MAX_IDEAS),
});

// ─── public types ─────────────────────────────────────────

export type IdeaSource = {
  kind: 'newsletter_issue' | 'obsidian_note';
  id: string;
  title: string;
  text: string;
  // Optional structural signals — present for Obsidian notes, absent for
  // most newsletter issues.
  frontmatter?: Record<string, unknown>;
  links?: string[];
  tags?: string[];
  // Where to point the user back to.
  url?: string | null;
  path?: string | null;
};

export type Idea = {
  title: string;
  claim: string;
  evidence: string;
  depthSignal: number;
  breadthSignal: number;
  links: string[];
  sourceRef: {
    kind: IdeaSource['kind'];
    sourceId: string;
    title: string;
    url?: string | null;
    path?: string | null;
  };
};

// ─── core function ─────────────────────────────────────────

/**
 * Run the LLM extraction on a single source. Returns 0..5 Ideas. Caller
 * is responsible for persisting (extractIdeasFromNewsletter /
 * extractIdeasFromObsidian wrap this with the upsert + embedding work).
 *
 * Throws on hard LLM failures (the caller's try/catch decides whether to
 * fail the sync or just log + continue — typically the latter, so a flaky
 * Anthropic doesn't block a vault import).
 */
export async function extractIdeas(source: IdeaSource): Promise<Idea[]> {
  const trimmed = stripBoilerplate(source.text).slice(0, MAX_SOURCE_CHARS);
  if (trimmed.trim().length < 200) {
    // Sources too short to mean something coherent. Don't burn an LLM call.
    return [];
  }

  const structureBlock = buildStructureBlock(source);

  const prompt = buildPrompt(source, structureBlock, trimmed);

  const { object } = await generateObject({
    // The SDK's typed model id is a union of known IDs; we cast to keep the
    // env override flexible (same pattern as src/lib/llm.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: anthropic(EXTRACTION_MODEL as any),
    schema: llmOutputSchema,
    prompt,
    // Lower temperature than Reflect — extraction is a labeling task,
    // creativity hurts more than it helps.
    temperature: 0.2,
    maxTokens: 1500,
  });

  const calibrated = (object.ideas ?? []).map((raw) => {
    const calibratedSignals = calibrateSignals(raw, source, trimmed);
    const idea: Idea = {
      title: raw.title.trim(),
      claim: raw.claim.trim(),
      evidence: (raw.evidence ?? '').trim(),
      depthSignal: calibratedSignals.depth,
      breadthSignal: calibratedSignals.breadth,
      links: (raw.links ?? []).slice(0, 20).map((l) => l.trim()).filter(Boolean),
      sourceRef: {
        kind: source.kind,
        sourceId: source.id,
        title: source.title,
        url: source.url ?? null,
        path: source.path ?? null,
      },
    };
    return idea;
  });

  return calibrated;
}

// ─── persistence helpers ────────────────────────────────────

/**
 * Extract + persist ideas for one Obsidian note. Replace-by-source: we
 * delete the note's existing extracted_ideas rows and re-insert. Cheaper
 * than diffing, and idea identity (title is fuzzy) makes a stable diff
 * hard anyway.
 *
 * Best-effort: if extraction or embedding fails we leave the source row
 * intact and log. Callers shouldn't fail their parent sync on this.
 */
export async function extractIdeasFromObsidian(input: {
  userId: string;
  noteId: string;
  title: string;
  bodyText: string;
  frontmatter: Record<string, unknown>;
  links: string[];
  tags: string[];
  path: string;
}): Promise<number> {
  const ideas = await extractIdeas({
    kind: 'obsidian_note',
    id: input.noteId,
    title: input.title,
    text: input.bodyText,
    frontmatter: input.frontmatter,
    links: input.links,
    tags: input.tags,
    path: input.path,
    url: null,
  });

  await db
    .delete(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, input.userId),
        eq(extractedIdeas.obsidianNoteId, input.noteId)
      )
    );

  if (ideas.length === 0) return 0;

  const rows = await Promise.all(
    ideas.map(async (idea): Promise<NewExtractedIdea> => {
      let embedding: number[] | undefined;
      try {
        const text = `${idea.title}\n\n${idea.claim}${idea.evidence ? '\n\n' + idea.evidence : ''}`;
        embedding = await embedText(text);
      } catch (err) {
        console.warn('[extract:obsidian] embed failed', input.path, err);
      }
      return {
        userId: input.userId,
        sourceKind: 'obsidian_note',
        obsidianNoteId: input.noteId,
        title: idea.title,
        claim: idea.claim,
        evidence: idea.evidence || null,
        depthSignal: idea.depthSignal,
        breadthSignal: idea.breadthSignal,
        links: idea.links,
        sourceRef: idea.sourceRef as unknown as Record<string, unknown>,
        embedding,
      };
    })
  );

  await db.insert(extractedIdeas).values(rows);
  return rows.length;
}

/**
 * Same shape as extractIdeasFromObsidian but for newsletter issues.
 * Used by the Wave 1 sync engine (when post.sent fires we re-extract)
 * and by the Wave 2 backfill action that sweeps all already-ingested
 * issues so the garden populates retroactively.
 */
export async function extractIdeasFromNewsletter(input: {
  userId: string;
  issueId: string;
  title: string;
  bodyText: string;
  webUrl?: string | null;
}): Promise<number> {
  const ideas = await extractIdeas({
    kind: 'newsletter_issue',
    id: input.issueId,
    title: input.title,
    text: input.bodyText,
    url: input.webUrl ?? null,
  });

  await db
    .delete(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, input.userId),
        eq(extractedIdeas.newsletterIssueId, input.issueId)
      )
    );

  if (ideas.length === 0) return 0;

  const rows = await Promise.all(
    ideas.map(async (idea): Promise<NewExtractedIdea> => {
      let embedding: number[] | undefined;
      try {
        const text = `${idea.title}\n\n${idea.claim}${idea.evidence ? '\n\n' + idea.evidence : ''}`;
        embedding = await embedText(text);
      } catch (err) {
        console.warn('[extract:newsletter] embed failed', input.issueId, err);
      }
      return {
        userId: input.userId,
        sourceKind: 'newsletter_issue',
        newsletterIssueId: input.issueId,
        title: idea.title,
        claim: idea.claim,
        evidence: idea.evidence || null,
        depthSignal: idea.depthSignal,
        breadthSignal: idea.breadthSignal,
        links: idea.links,
        sourceRef: idea.sourceRef as unknown as Record<string, unknown>,
        embedding,
      };
    })
  );

  await db.insert(extractedIdeas).values(rows);
  return rows.length;
}

// ─── prompt construction ────────────────────────────────────

function buildPrompt(
  source: IdeaSource,
  structureBlock: string,
  text: string
): string {
  const sourceLabel =
    source.kind === 'newsletter_issue'
      ? 'a newsletter issue the user wrote'
      : 'a note from the user\'s Obsidian vault';

  return `You are extracting "ideas" from one source written by the user. An idea is a unit of meaning that could recur across the user's writing — not a topic, not a category, but the actual claim plus the evidence behind it.

This source is ${sourceLabel}, titled "${source.title}".

Extract 0–${MAX_IDEAS} distinct ideas. Be conservative — better one or two strong ideas than five thin ones. Only extract ideas the source actually argues; do not infer beyond what is written.

For each idea, return:
- title: 6–10 words. The idea's stable name. Use the user's own framing where possible.
- claim: 1–2 sentences stating what the idea asserts.
- evidence: 1–3 sentences from the source that ground the claim. Quote or close paraphrase. May be empty if the source is purely assertive.
- depth_signal: 0..1 float. How thoroughly THIS source treats the idea.
    · 0.1 = mentioned in passing, single sentence.
    · 0.5 = developed across a few paragraphs with examples.
    · 0.9 = the source is mostly about this idea; recursive treatment.
- breadth_signal: 0..1 float. How broadly applicable / cross-cutting the idea is.
    · 0.1 = single-domain detail, only useful in one context.
    · 0.5 = applies across a few related domains.
    · 0.9 = a cross-cutting principle that recurs in many domains.
- links: array of related concept names mentioned in this same source. Pull names from headings, [[wikilinks]], explicit "see also" lines, and concepts the user names by capitalization or quotation. Max 10.

Output format: a JSON object with key "ideas", an array. If no clear ideas exist, return { "ideas": [] }.

${structureBlock}

<source>
${text}
</source>`;
}

/**
 * Surface the deterministic signals the LLM should weight when judging
 * depth/breadth. We literally hand it the structural shape — frontmatter
 * properties, link density, wordcount — so it doesn't have to guess at
 * data we already extracted.
 */
function buildStructureBlock(source: IdeaSource): string {
  const lines: string[] = [];

  if (source.kind === 'obsidian_note' && source.path) {
    const folder = source.path.split('/').slice(0, -1).join('/');
    if (folder) lines.push(`Folder: ${folder}`);
  }
  if (source.frontmatter && Object.keys(source.frontmatter).length > 0) {
    const fmSummary = Object.entries(source.frontmatter)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${formatScalar(v)}`)
      .join('; ');
    if (fmSummary) lines.push(`Frontmatter: ${fmSummary}`);
  }
  if (source.tags && source.tags.length > 0) {
    lines.push(`Tags: ${source.tags.slice(0, 12).join(', ')}`);
  }
  if (source.links && source.links.length > 0) {
    lines.push(`Outbound links: ${source.links.slice(0, 12).join(', ')}`);
  }

  if (lines.length === 0) return '';
  return `<structure>
${lines.join('\n')}
</structure>

`;
}

function formatScalar(v: unknown): string {
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => String(x)).join(', ');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 120);
}

// ─── boilerplate strip + signal calibration ───────────

const NEWSLETTER_BOILERPLATE_PATTERNS: RegExp[] = [
  // common opening
  /^\s*Hey,?\s+(?:friends|all|everyone|y'all|folks|reader)[\s\S]{0,300}?(?=\n\n)/im,
  /^\s*(?:Hi|Hey|Hello),?\s+[A-Z][a-z]+!?[\s\S]{0,250}?(?=\n\n)/im,
  // sign-offs
  /\n+(?:Until next time|Talk soon|Catch you|Cheers|Take care|Yours,?|Onward,?|Best,?|—\s*[A-Z])[\s\S]+$/im,
  // unsubscribe / view in browser
  /\b(?:Unsubscribe|View in browser|Manage preferences|Forwarded[\s\S]+?\?)\b[\s\S]*$/im,
];

/**
 * V0 boilerplate strip — Wave 3 will replace this with a more thorough
 * pre-embed cleaning pass (rule-based + first-ingest LLM marking). For
 * now we cut the most obvious newsletter chrome so the LLM gets cleaner
 * input to extract from.
 */
function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of NEWSLETTER_BOILERPLATE_PATTERNS) {
    out = out.replace(re, '');
  }
  return out.trim();
}

/**
 * Sanity-check the LLM's signal floats against deterministic structural
 * cues. If the LLM said depth=0.9 but the source is 200 words with no
 * link density, we clamp. Conservative: we don't *increase* signals,
 * only decrease — the LLM is the judgment-maker, we just keep it honest.
 */
function calibrateSignals(
  raw: { depth_signal: number; breadth_signal: number },
  source: IdeaSource,
  trimmed: string
): { depth: number; breadth: number } {
  const wc = trimmed.split(/\s+/).filter(Boolean).length;
  const linkCount = (source.links?.length ?? 0) + (source.tags?.length ?? 0);
  const hasFrontmatterType =
    !!source.frontmatter &&
    typeof source.frontmatter['type'] === 'string' &&
    String(source.frontmatter['type']).trim().length > 0;

  let depth = clamp01(raw.depth_signal);
  let breadth = clamp01(raw.breadth_signal);

  // Word-count-based depth ceiling: a 100-word source can't be a 0.9
  // exploration of an idea, almost by definition.
  if (wc < 250 && depth > 0.5) depth = 0.5;
  else if (wc < 600 && depth > 0.75) depth = 0.75;

  // Breadth ceiling: a source with no outbound links and no tags is
  // almost certainly single-domain, regardless of how the LLM reads it.
  if (linkCount === 0 && breadth > 0.6) breadth = 0.6;

  // Frontmatter `type: MOC` (Map of Content) is a strong breadth signal
  // — bias the floor up. (See curation-formula.md for the convention.)
  if (
    hasFrontmatterType &&
    String(source.frontmatter!['type']).toLowerCase().includes('moc')
  ) {
    breadth = Math.max(breadth, 0.7);
  }

  return { depth, breadth };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── backfill helper for retroactive newsletter sweep ─

/**
 * Iterate every newsletter issue with bodyText and run extractIdeas.
 * Skips issues that already have at least one extracted_ideas row (cheap
 * idempotency). Returns counts so the caller can render a result.
 *
 * Used by /studio/knowledge BackfillButton → backfillExtractedIdeas
 * action. Per-issue failures don't unwind the sweep.
 */
export async function backfillNewsletterIdeas(userId: string): Promise<{
  scanned: number;
  extracted: number;
  failed: number;
}> {
  const issues = await db
    .select({
      id: newsletterIssues.id,
      title: newsletterIssues.title,
      bodyText: newsletterIssues.bodyText,
      webUrl: newsletterIssues.webUrl,
    })
    .from(newsletterIssues)
    .where(eq(newsletterIssues.userId, userId));

  let extracted = 0;
  let failed = 0;

  for (const issue of issues) {
    if (!issue.bodyText || issue.bodyText.trim().length < 200) continue;
    // Skip already-extracted issues. (User can delete + re-run for a
    // forced re-extract.)
    const [hit] = await db
      .select({ id: extractedIdeas.id })
      .from(extractedIdeas)
      .where(
        and(
          eq(extractedIdeas.userId, userId),
          eq(extractedIdeas.newsletterIssueId, issue.id)
        )
      )
      .limit(1);
    if (hit) continue;

    try {
      const n = await extractIdeasFromNewsletter({
        userId,
        issueId: issue.id,
        title: issue.title,
        bodyText: issue.bodyText,
        webUrl: issue.webUrl,
      });
      extracted += n;
    } catch (err) {
      console.warn('[backfill:newsletter] failed', issue.id, err);
      failed++;
    }
  }

  return { scanned: issues.length, extracted, failed };
}

/** Same shape but for Obsidian notes — useful after a vault re-import. */
export async function backfillObsidianIdeas(userId: string): Promise<{
  scanned: number;
  extracted: number;
  failed: number;
}> {
  const notes = await db
    .select({
      id: obsidianNotes.id,
      title: obsidianNotes.title,
      bodyText: obsidianNotes.bodyText,
      frontmatter: obsidianNotes.frontmatter,
      links: obsidianNotes.links,
      tags: obsidianNotes.tags,
      path: obsidianNotes.path,
    })
    .from(obsidianNotes)
    .where(eq(obsidianNotes.userId, userId));

  let extracted = 0;
  let failed = 0;

  for (const note of notes) {
    if (!note.bodyText || note.bodyText.trim().length < 200) continue;
    const [hit] = await db
      .select({ id: extractedIdeas.id })
      .from(extractedIdeas)
      .where(
        and(
          eq(extractedIdeas.userId, userId),
          eq(extractedIdeas.obsidianNoteId, note.id)
        )
      )
      .limit(1);
    if (hit) continue;

    try {
      const n = await extractIdeasFromObsidian({
        userId,
        noteId: note.id,
        title: note.title,
        bodyText: note.bodyText,
        frontmatter: (note.frontmatter ?? {}) as Record<string, unknown>,
        links: (note.links ?? []) as string[],
        tags: (note.tags ?? []) as string[],
        path: note.path,
      });
      extracted += n;
    } catch (err) {
      console.warn('[backfill:obsidian] failed', note.id, err);
      failed++;
    }
  }

  return { scanned: notes.length, extracted, failed };
}
