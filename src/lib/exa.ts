// Thoughtbed · Exa semantic-search wrapper
//
// Phase 23 v2 slice 6 (2026-05-06). Used by the 'Add depth and
// research' refinement chip. Exa's neural search is purpose-built
// for finding semantically relevant articles given a topic, with
// inline content excerpts the LLM can ground on. Graceful fallback
// when the env var is not set: returns an empty array so the
// caller can ship 'your space only' depth without breaking.
//
// ENV: EXA_API_KEY — set in Vercel project settings.

export type ExaResult = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
};

const EXA_ENDPOINT = 'https://api.exa.ai/search';

export async function exaSearch(
  query: string,
  maxResults: number = 5
): Promise<ExaResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return [];
  if (!query.trim()) return [];

  try {
    const res = await fetch(EXA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query: query.slice(0, 400),
        numResults: Math.min(Math.max(maxResults, 1), 10),
        // 'auto' lets Exa pick keyword vs neural based on the query
        // shape. For abstract writing topics neural usually wins;
        // for proper-noun-heavy topics keyword is cleaner.
        type: 'auto',
        contents: {
          text: {
            maxCharacters: 600,
            includeHtmlTags: false,
          },
        },
      }),
      // Hobby plan caps server actions at 10s; keep search snappy.
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      console.warn('[exa] search failed', res.status, res.statusText);
      return [];
    }
    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        publishedDate?: string;
      }>;
    };
    const out: ExaResult[] = [];
    for (const r of json.results ?? []) {
      if (!r.title || !r.url || !r.text) continue;
      out.push({
        title: r.title,
        url: r.url,
        content: r.text,
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      });
      if (out.length >= maxResults) break;
    }
    return out;
  } catch (err) {
    console.warn('[exa] search error', err);
    return [];
  }
}

export function isExaConfigured(): boolean {
  return Boolean(process.env.EXA_API_KEY);
}
