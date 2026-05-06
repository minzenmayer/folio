// Thoughtbed · MatureNowButton — Phase 18 (2026-05-05)
//
// On-demand trigger for the maturation pass. The cron + the inline
// fallback already fire once per day per user, so this is mainly an
// admin / "I want to see results NOW" affordance. Clicking calls a
// server action that runs runMaturationPass + revalidates the
// Garden page.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runMaturationNow } from './edge-actions';

export function MatureNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [lastResult, setLastResult] = useState<string | null>(null);

  function run() {
    if (pending) return;
    start(async () => {
      try {
        const res = await runMaturationNow();
        setLastResult(
          res.ok
            ? `Lifted ${res.lifted} of ${res.inspected} inspected`
            : `Pass failed: ${res.reason}`
        );
        router.refresh();
      } catch (err) {
        setLastResult(
          'Pass failed: ' + (err instanceof Error ? err.message : 'unknown')
        );
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Run the maturation formula now. Lifts ideas based on cross-source resonance, cluster density, draft-resonance, depth on entry, and connectedness."
        className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1.5 border border-rule hover:border-ink hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? 'Maturing…' : '↗ Mature now'}
      </button>
      {lastResult && (
        <span className="font-mono text-[10px] tracking-[0.04em] text-tag">
          {lastResult}
        </span>
      )}
    </div>
  );
}
