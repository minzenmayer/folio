// Thoughtbed · BackfillButton
// Sprint 14 brand pivot: monochrome restyle.

'use client';

import { useState, useTransition } from 'react';
import { backfillEmbeddings } from './actions';
import type { BackfillResult } from './actions';

export function BackfillButton() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await backfillEmbeddings({ kind: 'all' });
        setResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      }
    });
  }

  return (
    <div className="border-t border-rule pt-6 mt-12">
      <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        Maintenance
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={isPending}
          className="font-mono text-[11px] tracking-[0.16em] uppercase border border-rule rounded-soft px-3 py-1.5 text-ink-soft hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? 'Backfilling…' : 'Backfill embeddings'}
        </button>
        {result && (
          <span className="font-mono text-[11px] text-tag tracking-[0.04em]">
            embedded {result.embedded.captures}/{result.scanned.captures}{' '}
            captures · {result.embedded.ideas}/{result.scanned.ideas} ideas ·{' '}
            {result.embedded.drafts}/{result.scanned.drafts} drafts
            {result.failed > 0 && (
              <span className="text-ink"> · {result.failed} failed</span>
            )}
          </span>
        )}
        {error && (
          <span className="font-mono text-[11px] text-ink">{error}</span>
        )}
      </div>
      <p className="font-sans text-[12.5px] text-tag mt-3 max-w-[60ch]">
        Sweeps rows where the embedding is null. Safe to run repeatedly —
        already-embedded rows are skipped.
      </p>
    </div>
  );
}
