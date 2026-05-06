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
        } else {
          // Phase 18 hotfix: report claimed + lifted in one line.
          // 'Claimed N' = unclaimed extracted_ideas just turned into
          //   partner ideas rows in this click.
          // 'Lifted M of P' = of the P ideas evaluated by maturation,
          //   M had at least one signal lift.
          // signals = per-signal hit counts for diagnostic clarity.
          const parts: string[] = [];
          parts.push(`Claimed ${res.claimed}`);
          // Surface the seed-phase eligibility count when nothing was
          // claimed — distinguishes 'no work to do' from 'work failed.'
          if (res.claimed === 0) {
            parts.push(`eligible ${res.seedEligibleFound}`);
          }
          if (res.seedFirstError) {
            parts.push(`seed err: ${res.seedFirstError}`);
          }
          if (res.inspected === 0) {
            parts.push('Inspected 0');
          } else {
            parts.push(`Lifted ${res.lifted} of ${res.inspected}`);
            parts.push(
              `signals: depth ${res.signal1} · resonance ${res.signal2} · cluster ${res.signal3} · drafts ${res.signal4} · edges ${res.signal5} · off-topic ${res.signal6}`
            );
          }
          if (res.firstError) {
            parts.push(`mat err: ${res.firstError}`);
          }
          setLastResult(parts.join(' · '));
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
