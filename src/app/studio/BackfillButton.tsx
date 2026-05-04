// Thoughtbed · BackfillButton
// Sprint 14 brand pivot: monochrome restyle.
// Sprint 15 Wave 2: second button for retroactive Idea extraction across
// newsletter issues + obsidian notes (kicks Anthropic Haiku once per
// source, so it's a manual click — not on the cron).

'use client';

import { useState, useTransition } from 'react';
import { backfillEmbeddings, backfillExtractedIdeas } from './actions';
import type { BackfillResult, BackfillIdeasResult } from './actions';

export function BackfillButton() {
  const [isPending, startTransition] = useTransition();
  const [embedResult, setEmbedResult] = useState<BackfillResult | null>(null);
  const [ideasResult, setIdeasResult] =
    useState<BackfillIdeasResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function runEmbeddings() {
    setError(null);
    setEmbedResult(null);
    setIdeasResult(null);
    startTransition(async () => {
      try {
        const res = await backfillEmbeddings({ kind: 'all' });
        setEmbedResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      }
    });
  }

  // Phase 9: chunked backfill loop. Each server-action call processes a
  // small batch and returns; we keep calling until both kinds report
  // hasMore=false. Tab must stay open — closing it kills the loop.
  function runIdeas() {
    setError(null);
    setEmbedResult(null);
    setIdeasResult(null);
    startTransition(async () => {
      try {
        let aggNewsletter = { scanned: 0, extracted: 0, failed: 0, hasMore: false };
        let aggObsidian = { scanned: 0, extracted: 0, failed: 0, hasMore: false };
        let iterations = 0;
        const maxIterations = 1000; // safety stop

        while (iterations < maxIterations) {
          const res = await backfillExtractedIdeas({ limit: 3 });
          aggNewsletter = {
            scanned: res.newsletter.scanned, // last-call scanned (total source count)
            extracted: aggNewsletter.extracted + res.newsletter.extracted,
            failed: aggNewsletter.failed + res.newsletter.failed,
            hasMore: res.newsletter.hasMore,
          };
          aggObsidian = {
            scanned: res.obsidian.scanned,
            extracted: aggObsidian.extracted + res.obsidian.extracted,
            failed: aggObsidian.failed + res.obsidian.failed,
            hasMore: res.obsidian.hasMore,
          };
          // Surface running progress so the user sees it tick up.
          setIdeasResult({
            newsletter: aggNewsletter,
            obsidian: aggObsidian,
            hasMore: res.hasMore,
          });
          if (!res.hasMore) break;
          iterations++;
          // Brief pause between chunks so we don't hammer Anthropic.
          await new Promise((r) => setTimeout(r, 300));
        }
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
          onClick={runEmbeddings}
          disabled={isPending}
          className="font-mono text-[11px] tracking-[0.16em] uppercase border border-rule rounded-soft px-3 py-1.5 text-ink-soft hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending && !ideasResult ? 'Backfilling…' : 'Backfill embeddings'}
        </button>
        <button
          onClick={runIdeas}
          disabled={isPending}
          className="font-mono text-[11px] tracking-[0.16em] uppercase border border-rule rounded-soft px-3 py-1.5 text-ink-soft hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending && !embedResult ? 'Extracting…' : 'Extract ideas'}
        </button>
        {embedResult && (
          <span className="font-mono text-[11px] text-tag tracking-[0.04em]">
            embedded {embedResult.embedded.captures}/{embedResult.scanned.captures}{' '}
            captures · {embedResult.embedded.ideas}/{embedResult.scanned.ideas} ideas ·{' '}
            {embedResult.embedded.drafts}/{embedResult.scanned.drafts} drafts
            {embedResult.failed > 0 && (
              <span className="text-ink"> · {embedResult.failed} failed</span>
            )}
          </span>
        )}
        {ideasResult && (
          <span className="font-mono text-[11px] text-tag tracking-[0.04em]">
            extracted {ideasResult.newsletter.extracted} from issues · {ideasResult.obsidian.extracted} from notes
            {ideasResult.newsletter.failed + ideasResult.obsidian.failed > 0 && (
              <span className="text-ink">
                {' · '}
                {ideasResult.newsletter.failed + ideasResult.obsidian.failed} failed
              </span>
            )}
            {ideasResult.hasMore && (
              <span className="text-ink"> · still working…</span>
            )}
          </span>
        )}
        {error && (
          <span className="font-mono text-[11px] text-ink">{error}</span>
        )}
      </div>
      <p className="font-sans text-[12.5px] text-tag mt-3 max-w-[60ch]">
        Backfill embeddings sweeps rows where the embedding is null. Extract
        ideas runs the curation formula across already-ingested sources —
        idempotent per source, so it's safe to re-run when the formula changes.
      </p>
    </div>
  );
}
