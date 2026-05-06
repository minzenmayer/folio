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
        if (!res.ok) {
          setLastResult(`Pass failed: ${res.reason}`);
        } else if (res.inspected === 0) {
          setLastResult('Inspected 0 ideas — Garden is empty.');
        } else if (res.lifted === 0) {
          // Diagnostic: which signals are firing? If all zeros, the
          // formula has nothing to work with and thresholds need
          // tuning.
          setLastResult(
            `Lifted 0 of ${res.inspected} · signals: depth ${res.signal1} · resonance ${res.signal2} · cluster ${res.signal3} · drafts ${res.signal4} · edges ${res.signal5}`
          );
        } else {
          setLastResult(
            `Lifted ${res.lifted} of ${res.inspected} · signals: depth ${res.signal1} · resonance ${res.signal2} · cluster ${res.signal3} · drafts ${res.signal4} · edges ${res.signal5}`
          );
        }
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
