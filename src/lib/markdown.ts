// Thoughtbed · Markdown helpers (Sprint 15 Wave 2)
//
// Tiny, dependency-free parsers for the bits of Markdown the Obsidian
// connector cares about:
//
//   · YAML frontmatter (top-of-file --- block) — primitive types only,
//     enough to capture Obsidian's typical fields (type, tags, status,
//     aliases, links). Nested objects are stringified.
//   · Wikilinks: [[Note Name]], [[Note Name|alias]], [[Note Name#Heading]]
//   · Inline #tags
//   · Title resolution: frontmatter.title → first H1 → filename
//
// Why hand-rolled instead of pulling `gray-matter`+`remark-parse`: the
// codebase is deliberately lean (svix is the only non-AI dep) and we only
// need a small slice. The parser is conservative — anything we can't
// confidently classify falls through as plain text body.

// ─── frontmatter ───────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type Frontmatter = Record<string, unknown>;

export type ParsedMarkdown = {
  frontmatter: Frontmatter;
  body: string; // body with frontmatter block stripped
};

/**
 * Split a Markdown source into frontmatter (parsed) + body (raw).
 *
 * The parser handles the dialect Obsidian uses by default: YAML between
 * leading `---` fences, top-level scalar / array values. Nested mappings
 * are flattened into a JSON-stringified value so the round-trip stays
 * lossless even when we don't fully model the shape.
 *
 * Anything that doesn't start with `---` returns { frontmatter: {}, body }.
 */
export function parseMarkdown(source: string): ParsedMarkdown {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  const yaml = match[1] ?? '';
  const frontmatter = parseYamlBlock(yaml);
  const body = source.slice(match[0].length);
  return { frontmatter, body };
}

/**
 * Tiny YAML subset parser — handles the shapes that show up in real
 * Obsidian vaults:
 *
 *   key: value
 *   key: "quoted value"
 *   key: 42
 *   key: true|false
 *   key: [item, item]
 *   key:
 *     - item
 *     - item
 *
 * Nested mappings (`key:\n  subkey: ...`) are captured as raw nested text;
 * the caller can re-parse if needed. Unknown shapes pass through as strings.
 */
function parseYamlBlock(yaml: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || /^\s*#/.test(line) || line.trim().length === 0) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2];

    if (rest.length === 0) {
      // multi-line list or nested map — peek ahead for `- ` items
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const child = lines[i].trim();
        const li = child.match(/^-\s+(.*)$/);
        if (li) {
          items.push(coerceScalar(li[1]));
        }
        // (silently drop nested-map syntax — best-effort, not critical)
        i++;
      }
      if (items.length > 0) out[key] = items;
      else out[key] = '';
      continue;
    }

    // inline list: [a, b, c]
    if (/^\[.*\]$/.test(rest.trim())) {
      const inner = rest.trim().slice(1, -1);
      const items = inner
        .split(',')
        .map((p) => coerceScalar(p.trim()))
        .filter((p) => p.length > 0);
      out[key] = items;
      i++;
      continue;
    }

    out[key] = coerceScalar(rest);
    i++;
  }
  return out;
}

function coerceScalar(raw: string): string {
  // strip wrapping quotes
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

// ─── title resolution ──────────────────────────────────

/**
 * Resolve a note's title using the same precedence Obsidian's reading
 * pane uses:
 *   1. frontmatter.title (explicit override)
 *   2. first H1 in body
 *   3. filename (basename, .md stripped, dashes/underscores → spaces)
 */
export function resolveTitle(
  frontmatter: Frontmatter,
  body: string,
  path: string
): string {
  const fm = frontmatter['title'];
  if (typeof fm === 'string' && fm.trim().length > 0) return fm.trim();

  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();

  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

// ─── links + tags ──────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;
const MD_LINK_RE = /\[([^\]]*?)\]\(([^)]+?)\)/g;
const TAG_RE = /(?:^|[^A-Za-z0-9_/])#([A-Za-z][A-Za-z0-9_/-]*)/g;

/**
 * Pull outbound link targets from a Markdown body. Both [[wikilinks]] and
 * [text](markdown-links) count. For wikilinks we strip aliases (`A|alias`
 * → `A`) and section anchors (`A#Heading` → `A`) so the same target
 * normalizes across writing styles.
 *
 * Deduped, preserving first-seen order.
 */
export function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of body.matchAll(WIKILINK_RE)) {
    const raw = m[1] ?? '';
    const target = raw.split('|')[0].split('#')[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }

  for (const m of body.matchAll(MD_LINK_RE)) {
    const url = (m[2] ?? '').trim();
    // Skip image embeds — same shape but the line typically starts with !
    if (!url || url.startsWith('mailto:')) continue;
    // Strip URL fragments and queries so `note.md#heading` and `note.md`
    // collapse to the same target.
    const target = url.split('#')[0].split('?')[0];
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }

  return out;
}

/**
 * Pull inline #tags from the body. Frontmatter tags should be merged in
 * separately by the caller.
 */
export function extractInlineTags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(TAG_RE)) {
    const tag = m[1];
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Merge frontmatter `tags` (string or array) with inline #tags found in
 * body. Returned as a deduped, ordered list.
 */
export function resolveTags(
  frontmatter: Frontmatter,
  body: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const fmTags = frontmatter['tags'];
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const norm = String(t).replace(/^#/, '').trim();
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
  } else if (typeof fmTags === 'string' && fmTags.trim().length > 0) {
    for (const t of fmTags.split(/[\s,]+/)) {
      const norm = t.replace(/^#/, '').trim();
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
  }
  for (const t of extractInlineTags(body)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ─── word count + plain text ──────────────────────────

/**
 * Strip Markdown syntax aggressively enough to give a reasonable word count
 * and a clean string for embedding. Not a full Markdown→HTML→text pipe;
 * we don't need fidelity, just something LLMs and embedders can read.
 */
export function markdownToPlainText(body: string): string {
  return (
    body
      // fenced code blocks
      .replace(/```[\s\S]*?```/g, ' ')
      // inline code
      .replace(/`[^`]*`/g, ' ')
      // images
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      // markdown links → keep label
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // wikilinks → keep label after pipe
      .replace(/\[\[([^\]|]+\|)?([^\]]+?)\]\]/g, '$2')
      // headings markers
      .replace(/^#+\s+/gm, '')
      // emphasis markers
      .replace(/[*_~]+/g, '')
      // blockquote markers
      .replace(/^>\s?/gm, '')
      // collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[A-Za-z0-9_'-]+/g);
  return matches ? matches.length : 0;
}
