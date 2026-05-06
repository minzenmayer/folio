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
import { autoClaimExtractedRow } from './garden/auto-claim';
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
import { cleanText, type CleanableKind } from '@/lib/clean-text';

// ─── model + prompt ───────────────────────────────────────

const EXTRACTION_MODEL =
  process.env.ANTHROPIC_EXTRACT_MODEL ??
  process.env.ANTHROPIC_MODEL ??
  'claude-haiku-4-5-20251001';

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
  kind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post' | 'gmail_message';
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
  const trimmed = stripBoilerplate(source.text, source.kind).slice(0, MAX_SOURCE_CHARS);
  if (trimmed.trim().length < 200) {
    // Sources too short to mean something coherent. Don't burn an LLM call.
    return [];
  }

  const structureBlock = buildStructureBlock(source, trimmed);

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

  // Phase 17 (2026-05-05): auto-claim every extracted row from this
  // user-authored source. The user already wrote the prose; the partner
  // ideas row gets created automatically. Best-effort — failures are
  // logged but don't fail the parent sync (ideas can still be claimed
  // manually later).
  const inserted = await db
    .insert(extractedIdeas)
    .values(rows)
    .returning({ id: extractedIdeas.id, title: extractedIdeas.title, claim: extractedIdeas.claim, evidence: extractedIdeas.evidence, depthSignal: extractedIdeas.depthSignal, embedding: extractedIdeas.embedding });
  for (const row of inserted) {
    try {
      await autoClaimExtractedRow({
        userId: input.userId,
        extractedId: row.id,
        sourceKind: 'obsidian_note',
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        depthSignal: row.depthSignal,
        themes: [],
        embedding: row.embedding ?? null,
      });
    } catch (err) {
      console.warn('[extract:obsidian] auto-claim failed', row.id, err);
    }
  }
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

  // Phase 17 (2026-05-05): auto-claim every extracted row from this
  // user-authored source. Best-effort.
  const inserted = await db
    .insert(extractedIdeas)
    .values(rows)
    .returning({ id: extractedIdeas.id, title: extractedIdeas.title, claim: extractedIdeas.claim, evidence: extractedIdeas.evidence, depthSignal: extractedIdeas.depthSignal, embedding: extractedIdeas.embedding });
  for (const row of inserted) {
    try {
      await autoClaimExtractedRow({
        userId: input.userId,
        extractedId: row.id,
        sourceKind: 'newsletter_issue',
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        depthSignal: row.depthSignal,
        themes: [],
        embedding: row.embedding ?? null,
      });
    } catch (err) {
      console.warn('[extract:newsletter] auto-claim failed', row.id, err);
    }
  }
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
- links: array of related concept names mentioned in this same source. Pull names from headings, [[wikilinks]] (especially in any "## Related Files" section at the end), explicit "see also" lines, and concepts the user names by capitalization or quotation. Max 10.

The user's writing convention: **bolded labels** like "**Lesson:**", "**Why it worked:**", "**For X:**" mark cross-cutting takeaways — the same idea applying in multiple contexts. When you see two or more of these in a source, the central idea is likely high-breadth. A populated "Related Files" section at the end of a note has the same signal.

Output format: a JSON object with key "ideas", an array. If no clear ideas exist, return { "ideas": [] }.

${structureBlock}

<source>
${text}
</source>`;
}

/**
 * Surface the deterministic signals the LLM should weight when judging
 * depth/breadth. We literally hand it the structural shape — frontmatter
 * properties, link density, wordcount, and the founder's observed
 * convention markers ("**Lesson:**" / "**Why it worked:**" bold labels,
 * "Related Files" trailing sections) — so it doesn't have to guess at
 * data we already extracted.
 *
 * The convention markers are documented in docs/curation-formula.md;
 * they came out of reading the heybubble slice of the founder's vault
 * and showing the same bold-label pattern across multiple notes.
 */
function buildStructureBlock(source: IdeaSource, text: string): string {
  const lines: string[] = [];

  if (source.kind === 'obsidian_note' && source.path) {
    // Surface PARA-style top-level folder separately when present
    // (`01-Projects/`, `02-Areas/`, `03-Resources/`, `04-Archives/`) —
    // the founder's vault uses this convention. Items in 02/03 are
    // typically more cross-cutting; items in 01 are project-scoped.
    const segments = source.path.split('/');
    const folder = segments.slice(0, -1).join('/');
    if (folder) lines.push(`Folder: ${folder}`);
    const top = segments[0];
    if (top && /^\d{2}-/.test(top)) {
      lines.push(`PARA top-level: ${top}`);
    }
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

  // Voice / convention markers observed in the founder's writing.
  // These are bold-label patterns ("**Lesson:**", "**Why it worked:**",
  // "**For HeyBubble:**") that mark cross-cutting takeaways and "Related
  // Files" sections that enumerate related notes. When present, they
  // indicate this idea connects beyond a single source — a breadth signal.
  const markerCount = countConventionMarkers(text);
  if (markerCount > 0) {
    lines.push(`Cross-cutting markers (Lesson:/Why it worked:/For X:): ${markerCount}`);
  }
  const relatedCount = countRelatedFilesLinks(text);
  if (relatedCount > 0) {
    lines.push(`"Related Files" wikilinks: ${relatedCount}`);
  }

  if (lines.length === 0) return '';
  return `<structure>
${lines.join('\n')}
</structure>

`;
}

// ─── observed convention markers ──────────────────────────────────
//
// These regexes encode patterns documented in docs/curation-formula.md
// (under "Voice patterns observed"). Drawn from reading the founder's
// heybubble slice on GitHub. If the broader vault deviates, refine here.

const CONVENTION_MARKER_RE =
  /\*\*(?:Lesson|Why it worked|For\s+[A-Z][\w\s]*?|Borrow|Don't borrow|Note):\*\*/g;

const RELATED_FILES_HEADING_RE =
  /(?:^|\n)#{1,3}\s+(?:Related Files?|Related Notes?|Related|See Also)\s*\n([\s\S]*?)(?=\n#{1,3}\s|\n*$)/i;

const WIKILINK_IN_SECTION_RE = /\[\[([^\]]+?)\]\]/g;

/**
 * Count "**Lesson:**" / "**Why it worked:**" / "**For X:**" bold labels.
 * The founder uses these as breath-marks for cross-cutting takeaways —
 * the more of them, the more the source is doing comparative analysis
 * (broad applicability) vs. narrative depth.
 */
function countConventionMarkers(text: string): number {
  const matches = text.match(CONVENTION_MARKER_RE);
  return matches ? matches.length : 0;
}

/**
 * Count wikilinks inside a trailing "Related Files" / "Related Notes"
 * section. Distinct from inline body links: the founder uses this section
 * as an explicit "this idea connects to these notes" enumeration, which
 * is a breadth signal more direct than scattered inline links.
 */
function countRelatedFilesLinks(text: string): number {
  const m = text.match(RELATED_FILES_HEADING_RE);
  if (!m) return 0;
  const section = m[1] ?? '';
  const links = section.match(WIKILINK_IN_SECTION_RE);
  return links ? links.length : 0;
}

function formatScalar(v: unknown): string {
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => String(x)).join(', ');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 120);
}

// ─── boilerplate strip + signal calibration ───────────
//
// Sprint 15 Wave 3 layer 1: the pattern set + dispatch lives in
// src/lib/clean-text.ts so the rail's snippet projection (in
// findSimilar) can apply the same cleaning before showing source
// text to the LLM during synthesis. Keeping stripBoilerplate as a
// thin wrapper preserves the existing call sites in this module
// (extractIdeas dispatches off source.kind, which matches
// CleanableKind exactly).

function stripBoilerplate(
  text: string,
  kind: CleanableKind = 'newsletter_issue'
): string {
  return cleanText(kind, text);
}

/**
 * Sanity-check the LLM's signal floats against deterministic structural
 * cues. The LLM is the judgment-maker; this layer keeps it honest by
 * pulling toward what the founder's actual vault conventions say about
 * depth and breadth (see docs/curation-formula.md for the observed
 * patterns).
 *
 * Calibration moves both directions: we clamp DOWN when the LLM
 * over-claims (e.g. "0.9 depth" on a 150-word note) and lift FLOORS UP
 * when strong structural signals are present (e.g. multiple "Lesson:"
 * markers, a populated "Related Files" section, PARA top-level folder
 * indicating cross-cutting scope). The lift is conservative — we never
 * exceed the LLM by more than ~0.1.
 */
function calibrateSignals(
  raw: { depth_signal: number; breadth_signal: number },
  source: IdeaSource,
  trimmed: string
): { depth: number; breadth: number } {
  const wc = trimmed.split(/\s+/).filter(Boolean).length;
  const linkCount = (source.links?.length ?? 0) + (source.tags?.length ?? 0);

  let depth = clamp01(raw.depth_signal);
  let breadth = clamp01(raw.breadth_signal);

  // ─── depth ceilings ───────────────────────────────────
  // The founder's vault notes range from 200 to 2000 words and pack
  // claims densely (bullet-heavy, "Why it worked:" sub-arguments). We
  // keep the volume sanity-check but loosen vs. the v0 default since
  // 600-word notes can be genuinely 0.8 depth here.
  if (wc < 200 && depth > 0.45) depth = 0.45;
  else if (wc < 500 && depth > 0.7) depth = 0.7;
  else if (wc < 900 && depth > 0.85) depth = 0.85;

  // Frontmatter `status: approved` (or `evergreen`) means the user has
  // finalized the idea — a depth lift, but capped to avoid the LLM
  // claiming 0.9 on a casual approval.
  const status =
    source.frontmatter && typeof source.frontmatter['status'] === 'string'
      ? String(source.frontmatter['status']).toLowerCase()
      : '';
  if (status === 'approved' || status === 'evergreen') {
    depth = Math.max(depth, 0.6);
  } else if (status === 'exploring' && depth > 0.7) {
    // Founder marks early-stage ideas `exploring`. Cap depth there —
    // the source itself is signaling "I haven't fully worked this out."
    depth = 0.7;
  }

  // ─── breadth ceilings + lifts ──────────────────────────
  if (linkCount === 0 && breadth > 0.6) breadth = 0.6;

  // PARA top-level folders signal scope. The founder's vault uses
  // numbered prefixes (`01-Projects/`, `02-Areas/`, `03-Resources/`,
  // `04-Archives/`). Items in Areas/Resources are typically cross-
  // cutting (apply across multiple projects); items in Projects are
  // project-scoped. Apply gentle ceilings/floors accordingly.
  const top =
    source.kind === 'obsidian_note' && source.path
      ? source.path.split('/')[0]
      : '';
  if (/^01-Projects?$/i.test(top) && breadth > 0.75) {
    breadth = 0.75; // project-scoped → cap breadth
  } else if (/^(?:02-Areas?|03-Resources?)$/i.test(top)) {
    breadth = Math.max(breadth, 0.55); // cross-cutting → modest floor
  }

  // Cross-cutting bold-label markers ("**Lesson:**", "**Why it worked:**",
  // "**For X:**") tell us the source is doing comparative analysis. Two
  // or more of them lifts breadth toward 0.7. (Documented as the
  // founder's voice convention in docs/curation-formula.md.)
  const markerCount = countConventionMarkers(trimmed);
  if (markerCount >= 4) {
    breadth = Math.max(breadth, 0.75);
  } else if (markerCount >= 2) {
    breadth = Math.max(breadth, 0.6);
  }

  // A populated "Related Files" section explicitly enumerates connections
  // to other vault notes — a direct breadth signal. The founder uses this
  // section consistently in the heybubble slice.
  const relatedLinks = countRelatedFilesLinks(trimmed);
  if (relatedLinks >= 3) {
    breadth = Math.max(breadth, 0.7);
  } else if (relatedLinks >= 2) {
    breadth = Math.max(breadth, 0.55);
  }

  // Frontmatter `type: MOC` (Map of Content) — kept as a fallback for
  // notes that DO use this convention. Not observed in the heybubble
  // slice, but other Obsidian users widely use it; harmless if absent.
  const fmType =
    source.frontmatter && typeof source.frontmatter['type'] === 'string'
      ? String(source.frontmatter['type']).toLowerCase()
      : '';
  if (fmType.includes('moc')) {
    breadth = Math.max(breadth, 0.75);
  }

  // Hard ceilings: don't let lifts push past 0.95 (no idea is "always
  // applicable") or below the LLM's clamp at 0.0.
  if (breadth > 0.95) breadth = 0.95;
  if (depth > 0.95) depth = 0.95;

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
export async function backfillNewsletterIdeas(
  userId: string,
  options: { limit?: number } = {}
): Promise<{
  scanned: number;
  extracted: number;
  failed: number;
  hasMore: boolean;
}> {
  const limit = options.limit ?? Infinity;
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
  let processed = 0;
  let hasMore = false;

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

    // Phase 9 chunked backfill: stop after `limit` newly-processed sources
    // so the server action stays under Vercel Hobby's 10s timeout. The
    // client (BackfillButton) loops until hasMore = false.
    if (processed >= limit) {
      hasMore = true;
      break;
    }

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
    processed++;
  }

  return { scanned: issues.length, extracted, failed, hasMore };
}

/** Same shape but for Obsidian notes — useful after a vault re-import. */
export async function backfillObsidianIdeas(
  userId: string,
  options: { limit?: number } = {}
): Promise<{
  scanned: number;
  extracted: number;
  failed: number;
  hasMore: boolean;
}> {
  const limit = options.limit ?? Infinity;
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
  let processed = 0;
  let hasMore = false;

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

    if (processed >= limit) {
      hasMore = true;
      break;
    }

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
    processed++;
  }

  return { scanned: notes.length, extracted, failed, hasMore };
}

/**
 * Extract ideas from one LinkedIn post. Same shape as the newsletter +
 * Obsidian variants: clear-then-insert by source row id, embed each
 * extracted idea best-effort, never block the parent sync on a flaky
 * Anthropic call.
 *
 * Phase 12: LinkedIn posts are short (typically 100-2000 words) but
 * dense — Payton's voice training corpus. extractIdeas() runs the
 * standard prompt + calibrate pipeline against them, same as a vault
 * note. The calibrator's word-count ceilings already work fine for
 * post-length text without special-casing.
 */
export async function extractIdeasFromLinkedinPost(input: {
  userId: string;
  postId: string;
  title: string;
  bodyText: string;
  webUrl: string | null;
  postedAt?: string | null;
}): Promise<number> {
  const ideas = await extractIdeas({
    kind: 'linkedin_post',
    id: input.postId,
    title: input.title,
    text: input.bodyText,
    url: input.webUrl ?? null,
  });

  await db
    .delete(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, input.userId),
        eq(extractedIdeas.linkedinPostId, input.postId)
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
        console.warn('[extract:linkedin] embed failed', input.postId, err);
      }
      return {
        userId: input.userId,
        sourceKind: 'linkedin_post',
        linkedinPostId: input.postId,
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

  // Phase 17 (2026-05-05): auto-claim every extracted row from this
  // user-authored source. Best-effort.
  const inserted = await db
    .insert(extractedIdeas)
    .values(rows)
    .returning({ id: extractedIdeas.id, title: extractedIdeas.title, claim: extractedIdeas.claim, evidence: extractedIdeas.evidence, depthSignal: extractedIdeas.depthSignal, embedding: extractedIdeas.embedding });
  for (const row of inserted) {
    try {
      await autoClaimExtractedRow({
        userId: input.userId,
        extractedId: row.id,
        sourceKind: 'linkedin_post',
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        depthSignal: row.depthSignal,
        themes: [],
        embedding: row.embedding ?? null,
      });
    } catch (err) {
      console.warn('[extract:linkedin] auto-claim failed', row.id, err);
    }
  }
  return rows.length;
}


// ─── Phase 13: gmail_message variant ───────────────────────
//
// Same shape as extractIdeasFromLinkedinPost. Triggered from the triage
// promote action — only promoted Gmail messages get ideas extracted.
//
// Note: gmail_message_id on extracted_ideas was added by
// drizzle/0009_gmail.sql (Phase 13). The XOR check on extracted_ideas
// gates the four source kinds; this writer sets gmailMessageId AND
// sourceKind='gmail_message' to satisfy it.

export async function extractIdeasFromGmailMessage(input: {
  userId: string;
  messageId: string;
  title: string;
  bodyText: string;
  webUrl: string | null;
  postedAt?: string | null;
}): Promise<number> {
  const ideas = await extractIdeas({
    kind: 'gmail_message',
    id: input.messageId,
    title: input.title,
    text: input.bodyText,
    url: input.webUrl ?? null,
  });

  await db
    .delete(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, input.userId),
        eq(extractedIdeas.gmailMessageId, input.messageId)
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
        console.warn('[extract:gmail] embed failed', input.messageId, err);
      }
      return {
        userId: input.userId,
        sourceKind: 'gmail_message',
        gmailMessageId: input.messageId,
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

