/**
 * src/lib/markdown.ts
 *
 * Pure-function markdown utilities for the Obsidian connector.
 * No external dependencies beyond Node builtins — keeps the edge
 * runtime happy and avoids pulling in a full AST library.
 *
 * Exports
 * ───────
 * parseFrontmatter(raw)        → { data, content }
 * extractWikilinks(content)    → string[]
 * extractTags(content, data)   → string[]
 * extractTitle(content, data, path) → string | undefined
 * parseMarkdownNote(raw, path) → ParsedNote
 */

export interface Frontmatter {
  [key: string]: unknown;
}

export interface ParsedNote {
  title: string | undefined;
  frontmatter: Frontmatter;
  tags: string[];
  wikilinks: string[];
  /** Raw markdown body (frontmatter stripped). */
  body: string;
}

// ── Frontmatter ──────────────────────────────────────────────────────────────

/**
 * Parses YAML-like frontmatter delimited by `---` fences.
 * Deliberately minimal: only handles the scalar + list shapes
 * that Obsidian actually writes (no nested objects, no multiline
 * scalars).  Returns an empty object on any parse failure.
 */
export function parseFrontmatter(raw: string): {
  data: Frontmatter;
  content: string;
} {
  const fence = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
  const match = raw.match(fence);
  if (!match) return { data: {}, content: raw };

  const yamlBlock = match[1];
  const content = raw.slice(match[0].length);
  const data: Frontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    // Inline list: key: [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      data[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Boolean shorthand
    if (rawVal === 'true')  { data[key] = true;  continue; }
    if (rawVal === 'false') { data[key] = false; continue; }

    // Numeric
    if (rawVal !== '' && !isNaN(Number(rawVal))) {
      data[key] = Number(rawVal);
      continue;
    }

    // Strip surrounding quotes then store as string
    data[key] = rawVal.replace(/^["']|["']$/g, '');
  }

  // Second pass: collect YAML block-sequence lists
  //   tags:
  //     - foo
  //     - bar
  let currentKey: string | null = null;
  for (const line of yamlBlock.split('\n')) {
    if (/^\w.*:$/.test(line.trim())) {
      currentKey = line.trim().slice(0, -1);
      data[currentKey] = [];
    } else if (currentKey && /^\s*-\s+/.test(line)) {
      (data[currentKey] as string[]).push(
        line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')
      );
    } else if (line.trim() !== '') {
      currentKey = null;
    }
  }

  return { data, content };
}

// ── Wikilinks ─────────────────────────────────────────────────────────────────

/** Extracts all [[wikilink]] and [[wikilink|alias]] targets. */
export function extractWikilinks(content: string): string[] {
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    links.push(m[1].trim());
  }
  return [...new Set(links)];
}

// ── Tags ──────────────────────────────────────────────────────────────────────

/**
 * Collects tags from two sources:
 *  1. Frontmatter `tags:` field (string | string[]).
 *  2. Inline `#tag` syntax in the body (not inside code spans/blocks).
 *
 * All returned tags are lowercase, without the leading `#`.
 */
export function extractTags(
  content: string,
  frontmatter: Frontmatter
): string[] {
  const tags = new Set<string>();

  // Frontmatter tags
  const fmTags = frontmatter['tags'] ?? frontmatter['tag'];
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === 'string') tags.add(t.toLowerCase().replace(/^#/, ''));
    }
  } else if (typeof fmTags === 'string') {
    tags.add(fmTags.toLowerCase().replace(/^#/, ''));
  }

  // Inline tags — skip code blocks and code spans
  const strippedCode = content
    .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
    .replace(/`[^`]+`/g, '');         // inline code spans

  const inlinePattern = /(?:^|\s)#([\w/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = inlinePattern.exec(strippedCode)) !== null) {
    tags.add(m[1].toLowerCase());
  }

  return [...tags];
}

// ── Title ─────────────────────────────────────────────────────────────────────

/**
 * Resolves a human-readable title for the note.
 * Priority: frontmatter `title` → first H1 → filename stem.
 */
export function extractTitle(
  content: string,
  frontmatter: Frontmatter,
  vaultPath: string
): string {
  if (typeof frontmatter['title'] === 'string' && frontmatter['title']) {
    return frontmatter['title'];
  }

  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();

  // Fall back to the file's basename without extension
  return vaultPath
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '') ?? vaultPath;
}

// ── Composite ─────────────────────────────────────────────────────────────────

/** Parses a raw vault file into a structured note object. */
export function parseMarkdownNote(
  raw: string,
  vaultPath: string
): ParsedNote {
  const { data: frontmatter, content: body } = parseFrontmatter(raw);
  return {
    title:      extractTitle(body, frontmatter, vaultPath),
    frontmatter,
    tags:       extractTags(body, frontmatter),
    wikilinks:  extractWikilinks(body),
    body,
  };
}
