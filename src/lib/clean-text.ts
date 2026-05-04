// Thoughtbed · pre-embed / pre-LLM text cleaning (Sprint 15 Wave 3 layer 1)
//
// The Reflect rail and extractIdeas() both feed source text into LLMs.
// Without cleaning, that text carries newsletter chrome ("Hey, this is
// Payton…" intros, sign-offs, unsubscribe footers) and Obsidian artifacts
// (leftover dataview blocks, code fences the parser missed) that make the
// model quote boilerplate back at the user. This module strips the most
// obvious chrome with rule-based regex.
//
// Scope of this layer:
//   - Newsletter: openings, sign-offs, unsubscribe / view-in-browser /
//     manage-preferences footers, Beehiiv share rows, repeated subscribe
//     CTAs, "Powered by beehiiv" outros, P.S. promotional paragraphs.
//   - Obsidian: leftover frontmatter delimiters, dataview code blocks,
//     trailing wikilink-only lines that the parser sometimes preserves.
//
// What this layer DOES NOT do:
//   - LLM-marker pass (Wave 3 brief mentions a first-ingest Haiku pass to
//     mark stubborn ranges; punted to Phase 3b if read-time rule-based
//     proves insufficient).
//   - Re-embedding existing rows. New writes go through this; existing
//     rows still have body_text = uncleaned. Phase 4 retrieval ranking
//     can compensate for that drift, but a one-shot re-embed remains
//     available if needed.
//   - Stripping "## Related Files" sections — those carry breadth
//     signal that calibrateSignals() reads in extract-ideas. Leaving in.

export type CleanableKind = 'newsletter_issue' | 'obsidian_note' | 'linkedin_post';

// ─── Newsletter patterns ─────────────────────────────────────

export const NEWSLETTER_BOILERPLATE_PATTERNS: RegExp[] = [
  // Founder-specific opener (Wave 3 brief calls this out by name).
  /^\s*Hey,?\s+(?:this\s+is\s+Payton|friends|all|everyone|y'all|folks|reader)[\s\S]{0,400}?(?=\n\n)/im,
  // Generic salutation lines (Hi NAME, Hey there, Hello reader, etc.).
  /^\s*(?:Hi|Hey|Hello),?\s+[A-Z][a-z]+!?[\s\S]{0,250}?(?=\n\n)/im,

  // Sign-offs anchored to end of doc.
  /\n+(?:Until next time|Talk soon|Catch you|Cheers|Take care|Yours,?|Onward,?|Best,?|—\s*[A-Z])[\s\S]+$/im,

  // P.S. promotional paragraphs at the end (newsletter convention to
  // shove CTAs in a P.S.).
  /\n+P\.\s*S\.[\s\S]+$/im,

  // Unsubscribe / view-in-browser / manage-preferences footers.
  /\b(?:Unsubscribe|View in browser|Read online|Manage preferences|Email preferences|Forwarded\s*\?)\b[\s\S]*$/im,

  // "If you enjoyed this…" share/forward CTAs.
  /\n+If you (?:enjoyed|liked|loved) this[\s\S]{0,400}?(?=\n\n|$)/im,

  // "Refer a friend" / "Share this" rows.
  /\n+(?:Refer a friend|Share this|Forward to a friend|Subscribe)[\s\S]{0,200}?(?=\n\n|$)/im,

  // Beehiiv-specific outro.
  /Powered by beehiiv[\s\S]*$/im,
];

// ─── Obsidian patterns ───────────────────────────────────────

export const OBSIDIAN_BOILERPLATE_PATTERNS: RegExp[] = [
  // Leftover frontmatter delimiters that survived the parser. The
  // markdown parser strips frontmatter cleanly in the typical case;
  // this is defense in depth.
  /^---\s*\n[\s\S]+?\n---\s*\n/m,

  // Dataview code blocks. The parser keeps them as code blocks; for
  // LLM purposes they're pseudo-SQL and not idea content.
  /```dataview[\s\S]*?```/g,

  // Trailing horizontal-rule + bare metadata footer (some users put
  // "created: ..." / "updated: ..." lines below ---).
  /\n---\s*\n(?:\s*(?:created|updated|modified|tags?):.*\n?){1,4}\s*$/im,
];

// ─── Public API ──────────────────────────────────────────────

/**
 * Strip the most obvious chrome from a source's text before it reaches
 * an LLM (extraction or synthesis) or before it's surfaced as a snippet
 * to the user. Pure regex — no LLM call — so it's free to run on every
 * read.
 *
 * Patterns are kind-specific: newsletter chrome doesn't apply to vault
 * notes, obsidian artifacts don't apply to newsletters. Returns a
 * trimmed string with no leading/trailing whitespace.
 */
export function cleanText(kind: CleanableKind, text: string): string {
  if (!text) return '';
  // Phase 12: LinkedIn posts have their own quirks (the "...see more"
  // truncation marker, LinkedIn's hashtag/mention encoding) but we
  // already handle those at the linkedin-sync layer in
  // cleanLinkedinPostText(). Here we just pass through with the
  // collapse-blank-lines fallback below — no false-positive boilerplate
  // strips against post bodies.
  const patterns =
    kind === 'newsletter_issue'
      ? NEWSLETTER_BOILERPLATE_PATTERNS
      : kind === 'obsidian_note'
        ? OBSIDIAN_BOILERPLATE_PATTERNS
        : ([] as RegExp[]);
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, '');
  }
  // Collapse 3+ consecutive blank lines that the strips often leave
  // behind. Two newlines = paragraph break stays intact.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
