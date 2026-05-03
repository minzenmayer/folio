// Folio · Tiptap doc export helpers
// Sprint 6 wave 4: turn a Tiptap/ProseMirror JSON doc into:
//   · Markdown (custom walker; subset of CommonMark)
//   · plain text (strip-and-flatten)
//   · standalone HTML (`editor.getHTML()` plus a small style shell)
//
// The walker only handles nodes/marks that StarterKit emits. New extensions
// later (links, images, tables) need a corresponding case here.
//
// Round-trip caveat: Tiptap → MD → Tiptap is asymmetric. A heading with
// a bold span survives, but exotic mark combinations may flatten. Don't
// promise byte-for-byte fidelity in user-facing copy.

type Node = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: Node[];
};

// ─── Markdown ────────────────────────────────

/**
 * Walk a Tiptap JSON doc and render it as Markdown.
 * Only supports node types from @tiptap/starter-kit:
 *   doc, paragraph, heading (1-3 used; 4-6 fall through to ###),
 *   bulletList, orderedList, listItem, blockquote, codeBlock,
 *   horizontalRule, hardBreak.
 * Marks: bold, italic, code, strike.
 *
 * Returns a string with a single trailing newline.
 */
export function tiptapJsonToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const root = doc as Node;
  const out: string[] = [];
  renderBlocks(root.content || [], out, '');
  // Trim leading/trailing blank lines, then add a single closing newline.
  let text = out.join('').replace(/^\n+/, '').replace(/\n+$/, '');
  return text + '\n';
}

function renderBlocks(nodes: Node[], out: string[], indent: string) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    renderBlock(node, out, indent);
    // Block separator — blank line between most blocks. List items handle
    // their own separators internally.
    if (!isLast && node.type !== 'listItem') {
      out.push('\n');
    }
  }
}

function renderBlock(node: Node, out: string[], indent: string) {
  switch (node.type) {
    case 'paragraph': {
      out.push(indent);
      out.push(renderInline(node.content || []));
      out.push('\n');
      return;
    }
    case 'heading': {
      const rawLevel = (node.attrs?.level as number | undefined) ?? 1;
      const level = Math.min(Math.max(rawLevel, 1), 6);
      out.push(indent);
      out.push('#'.repeat(level));
      out.push(' ');
      out.push(renderInline(node.content || []));
      out.push('\n');
      return;
    }
    case 'bulletList': {
      const items = node.content || [];
      for (let i = 0; i < items.length; i++) {
        renderListItem(items[i], out, indent, '- ');
      }
      return;
    }
    case 'orderedList': {
      const items = node.content || [];
      const start = (node.attrs?.start as number | undefined) ?? 1;
      for (let i = 0; i < items.length; i++) {
        renderListItem(items[i], out, indent, `${start + i}. `);
      }
      return;
    }
    case 'blockquote': {
      // Render children, then prefix each line with "> ".
      const inner: string[] = [];
      renderBlocks(node.content || [], inner, '');
      const lines = inner.join('').split('\n');
      for (const line of lines) {
        out.push(indent);
        out.push('> ');
        out.push(line);
        out.push('\n');
      }
      return;
    }
    case 'codeBlock': {
      const lang = (node.attrs?.language as string | undefined) || '';
      out.push(indent);
      out.push('```');
      out.push(lang);
      out.push('\n');
      // codeBlock's children are text nodes; concatenate raw text.
      const inner = (node.content || [])
        .map((c) => (typeof c.text === 'string' ? c.text : ''))
        .join('');
      // Indent each line of the code block (rare in practice; nested code
      // blocks inside lists are uncommon).
      const lines = inner.split('\n');
      for (const line of lines) {
        out.push(indent);
        out.push(line);
        out.push('\n');
      }
      out.push(indent);
      out.push('```\n');
      return;
    }
    case 'horizontalRule': {
      out.push(indent);
      out.push('---\n');
      return;
    }
    default: {
      // Unknown block — try to flatten its inline content as a paragraph.
      if (node.content && node.content.length > 0) {
        out.push(indent);
        out.push(renderInline(node.content));
        out.push('\n');
      }
      return;
    }
  }
}

function renderListItem(node: Node, out: string[], indent: string, marker: string) {
  // A list item is a block-level container. Render its first child inline
  // with the marker prefix; subsequent children get continuation indent.
  const children = node.content || [];
  if (children.length === 0) {
    out.push(indent);
    out.push(marker);
    out.push('\n');
    return;
  }

  const childIndent = indent + ' '.repeat(marker.length);

  // First child: inline-merged with the marker.
  const first = children[0];
  if (first.type === 'paragraph') {
    out.push(indent);
    out.push(marker);
    out.push(renderInline(first.content || []));
    out.push('\n');
  } else {
    // Unusual — list item leading with a non-paragraph block. Render it
    // with the marker on its own line followed by the child indented.
    out.push(indent);
    out.push(marker);
    out.push('\n');
    renderBlock(first, out, childIndent);
  }

  // Subsequent children continue with childIndent.
  for (let i = 1; i < children.length; i++) {
    renderBlock(children[i], out, childIndent);
  }
}

function renderInline(nodes: Node[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.text === 'string') {
      text += applyMarks(node.text, node.marks || []);
    } else if (node.type === 'hardBreak') {
      // Markdown hard break = two trailing spaces, then newline. Within an
      // inline string we just emit the marker; the block renderer adds the
      // closing \n.
      text += '  \n';
    } else if (node.content) {
      // Defensive — flatten nested inline nodes.
      text += renderInline(node.content);
    }
  }
  return text;
}

function applyMarks(text: string, marks: Array<{ type: string }>): string {
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        result = `**${result}**`;
        break;
      case 'italic':
        result = `*${result}*`;
        break;
      case 'code':
        result = `\`${result}\``;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      default:
        // Unknown mark — skip silently.
        break;
    }
  }
  return result;
}

// ─── Plain text ───────────────────────────────

/**
 * Strip all formatting; preserve paragraph/heading/list breaks as newlines.
 * Useful for "Copy plain" — pasting into apps that don't render Markdown.
 */
export function tiptapJsonToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const root = doc as Node;
  const out: string[] = [];
  renderTextBlocks(root.content || [], out);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderTextBlocks(nodes: Node[], out: string[]) {
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        out.push(flattenInline(node.content || []));
        out.push('\n\n');
        break;
      case 'bulletList':
      case 'orderedList':
        for (const item of node.content || []) {
          out.push(flattenInline(item.content?.[0]?.content || []));
          out.push('\n');
        }
        out.push('\n');
        break;
      case 'blockquote':
        out.push(flattenInline(node.content || []));
        out.push('\n\n');
        break;
      case 'codeBlock':
        out.push(
          (node.content || [])
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .join('')
        );
        out.push('\n\n');
        break;
      case 'horizontalRule':
        out.push('---\n\n');
        break;
      default:
        if (node.content) renderTextBlocks(node.content, out);
        break;
    }
  }
}

function flattenInline(nodes: Node[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.text === 'string') {
      text += node.text;
    } else if (node.type === 'hardBreak') {
      text += '\n';
    } else if (node.content) {
      text += flattenInline(node.content);
    }
  }
  return text;
}

// ─── Standalone HTML ─────────────────────────────

/**
 * Wrap an HTML fragment from `editor.getHTML()` in a minimal standalone
 * document. Editorial defaults that match the in-app .folio-prose styles,
 * so the downloaded file looks like Folio rather than a tag soup.
 */
export function htmlForExport(innerHtml: string, title: string | null): string {
  const safeTitle = escapeHtml(title || 'Untitled');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  html { background: #f6f1e8; color: #15110c; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    max-width: 60ch;
    margin: 4rem auto;
    padding: 0 2rem;
    line-height: 1.65;
  }
  h1 { font-size: 2.4rem; line-height: 1.05; letter-spacing: -0.022em; margin-top: 2rem; }
  h2 { font-size: 1.75rem; line-height: 1.15; letter-spacing: -0.018em; margin-top: 2rem; }
  h3 { font-size: 1.25rem; margin-top: 1.6rem; }
  p, ul, ol, blockquote, pre { margin: 1.1em 0; }
  blockquote {
    border-left: 2px solid #b8331f;
    padding-left: 1.25rem;
    font-style: italic;
    color: #3b342a;
  }
  code {
    background: #f0e8d4;
    padding: 0.12em 0.36em;
    border-radius: 3px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.9em;
  }
  pre {
    background: #f0e8d4;
    border: 1px solid #d8cdb6;
    border-radius: 3px;
    padding: 1rem 1.1rem;
    overflow-x: auto;
    line-height: 1.55;
  }
  pre code { background: transparent; padding: 0; border-radius: 0; }
  hr { border: 0; border-top: 1px solid #d8cdb6; margin: 2em 0; }
  a { color: #b8331f; text-underline-offset: 3px; }
</style>
</head>
<body>
${innerHtml}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Browser download helper ────────────────────────

/**
 * Trigger a file download via an invisible <a download>. Browser-only —
 * no-op during SSR so callers don't need to guard.
 */
export function downloadFile(filename: string, content: string, mimeType: string) {
  if (typeof window === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Sanitize a draft title for use as a filename. Strips unsafe chars. */
export function safeFilename(title: string | null, fallback: string): string {
  const base = (title || fallback).trim() || fallback;
  return base
    .replace(/[\/\\?%*:|"<>\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}
