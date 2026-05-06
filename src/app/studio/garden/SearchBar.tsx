// Thoughtbed · Garden search — Phase 19.3 (2026-05-06)
//
// Semantic search across the user's ideas. Type a phrase, press
// Enter; the action embeds the query and ranks ideas by cosine.
// Falls back to ILIKE on title + essence + body when embed fails.
// Submitting an empty input clears the results.

'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { searchGarden } from './actions';

type SearchHit = {
  id: string;
  title: string;
  essence: string | null;
  temperature: string;
  maturity: string;
};

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    setError(null);
    start(async () => {
      try {
        const res = await searchGarden({ query: q });
        if (res.ok) {
          setResults(res.results);
        } else {
          setError(res.reason);
          setResults(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'search failed');
      }
    });
  }

  function clear() {
    setQuery('');
    setResults(null);
    setError(null);
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
            if (e.key === 'Escape') clear();
          }}
          placeholder="Search ideas — by topic, framework, anything you remember…"
          aria-label="Search the Garden"
          className="flex-1 rounded-soft border border-rule bg-paper px-4 py-2 font-sans text-[14px] text-ink placeholder:text-tag focus:outline-none focus:border-ink/40 transition-colors"
        />
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-2 bg-ink text-bg hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Searching…' : 'Search'}
        </button>
        {results !== null && (
          <button
            type="button"
            onClick={clear}
            className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 font-sans text-[12.5px] text-tag italic">
          Search failed: {error}
        </p>
      )}

      {results !== null && results.length === 0 && !pending && !error && (
        <p className="mt-3 font-sans text-[13px] text-tag italic">
          No matches.
        </p>
      )}

      {results !== null && results.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag mb-2">
            {results.length} {results.length === 1 ? 'match' : 'matches'}
          </p>
          <ul className="rounded-card border border-rule bg-paper divide-y divide-rule overflow-hidden">
            {results.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/studio/garden/${r.id}`}
                  className="block py-2.5 px-4 hover:bg-paper-2 transition-colors group"
                >
                  <div className="flex items-baseline justify-between gap-3 mb-0.5">
                    <span className="font-sans text-[13.5px] font-medium text-ink leading-[1.4] group-hover:underline underline-offset-4 decoration-rule-strong">
                      {r.title}
                    </span>
                    <span className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
                      {r.temperature} · {r.maturity}
                    </span>
                  </div>
                  {r.essence && (
                    <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] line-clamp-1">
                      {r.essence}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
