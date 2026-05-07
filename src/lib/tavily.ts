// Thoughtbed · Tavily web-search wrapper
//
// Phase 23 v2 slice 6 (2026-05-06). Used by the 'Add depth and
// research' refinement chip. Tavily is built for RAG — clean
// snippets, single-call shape, generous free tier. Graceful
// fallback when the env var is not set: returns an empty array
// so the caller can ship 'your space only' depth without
// breaking.
//
// ENV: TAVILY_API_KEY — set in Vercel project settings.

export type TavilyResult = {
  title: string;
  url: string;
  content: string;
};

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export async function tavilySearch(
  query: string,
  maxResults: number = 5
): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  if (!query.trim()) return [];

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query.slice(0, 400),
        max_results: Math.min(Math.max(maxResults, 1), 10),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      // Hobby plan caps server actions at 10s; keep search snappy.
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      console.warn('[tavily] search failed', res.status, res.statusText);
      return [];
    }
    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
      }>;
    };
    const out: TavilyResult[] = [];
    for (const r of json.results ?? []) {
      if (!r.title || !r.url || !r.content) continue;
      out.push({ title: r.title, url: r.url, content: r.content });
      if (out.length >= maxResults) break;
    }
    return out;
  } catch (err) {
    console.warn('[tavily] search error', err);
    return [];
  }
}

export function isTavilyConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}
