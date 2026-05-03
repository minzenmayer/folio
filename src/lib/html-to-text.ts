// Thoughtbed · html-to-text — Beehiiv prose → plain text for embedding.
//
// Sprint 13: when ingesting newsletter issues we get full HTML in
// `content.free.web`. The embedding model wants plain prose. Rather than
// pull in `htmlparser2` or `cheerio` for one use case, we hand-roll a
// minimal converter that's good enough for newsletter-shaped HTML
// (paragraphs, headings, lists, blockquotes, links). Everything else
// (script/style/SVG/etc.) is dropped.
//
// We're optimising for retrieval quality, not perfect markdown. A
// stray `[image]` placeholder is fine; lossy tables are fine; HTML
// entities should decode cleanly so embeddings see the right unicode.
//
// If Beehiiv ever ships a Markdown-rendering expand option, this file
// becomes deletable. Until then, this is the smallest dep-free option.

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'pre',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
]);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const STRIP_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'video',
  'audio',
  'source',
  'picture',
  'object',
  'embed',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);

const SELF_CLOSING_PLACEHOLDERS: Record<string, string> = {
  br: '\n',
  hr: '\n\n———\n\n',
  img: ' [image] ',
};

/**
 * HTML entity decoder for the common cases. Beehiiv-rendered prose almost
 * exclusively contains numeric (&#x2014;) and the named-entity short list
 * below. We deliberately avoid pulling in a full table.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d');
}

/**
 * Drop every element whose tagName is in STRIP_ELEMENTS, including its
 * inner content. Operates lexically — we don't build a real DOM.
 */
function stripElements(html: string): string {
  let out = html;
  for (const tag of STRIP_ELEMENTS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(re, ' ');
    // catch self-closed forms that some renderers emit
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Convert a Beehiiv-shaped HTML string to plain text optimized for
 * embeddings + snippet display.
 *
 *   - Block tags become paragraph breaks.
 *   - Headings get a trailing newline (we don't preserve the # hierarchy).
 *   - <li> items get a leading "- " bullet.
 *   - <a href> drops the link target; only the link text survives.
 *   - <br> → newline; <hr> → "———" rule.
 *   - HTML entities decoded for the common cases.
 *   - Whitespace collapses to ≤2 consecutive newlines.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  // Beehiiv (and most renderers) prefix the body with <!DOCTYPE html>.
  // Drop those + HTML comments before any tag pass — they leak through
  // the <\/?[a-zA-Z][^>]*> catch-all (which only matches tags starting
  // with a letter, not '!').
  let text = html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  text = stripElements(text);

  // Replace self-closing/inline tags with their placeholders before the
  // generic block-tag pass so we don't lose them.
  for (const [tag, placeholder] of Object.entries(SELF_CLOSING_PLACEHOLDERS)) {
    const re = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    text = text.replace(re, placeholder);
  }

  // <li> → "\n- " before the content; closing </li> just stays a newline.
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  // Headings: insert blank line before, blank line after.
  for (const h of HEADING_TAGS) {
    text = text.replace(new RegExp(`<${h}\\b[^>]*>`, 'gi'), '\n\n');
    text = text.replace(new RegExp(`<\\/${h}>`, 'gi'), '\n\n');
  }

  // Block tags: each open/close becomes a paragraph break.
  for (const tag of BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '\n');
    text = text.replace(new RegExp(`<\\/${tag}>`, 'gi'), '\n');
  }

  // <a href="..."> → keep the inner text only.
  text = text.replace(/<a\b[^>]*>/gi, '');
  text = text.replace(/<\/a>/gi, '');

  // Remove any other tag we haven't explicitly handled.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  text = decodeEntities(text);

  // Collapse internal whitespace + cap on consecutive newlines.
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/** Cheap word count for the newsletter_issues.word_count column. */
export function wordCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
