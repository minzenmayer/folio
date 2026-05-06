// Thoughtbed · Phase 17 onboarding banner
//
// 2026-05-05. Top-of-Garden banner that fires the chunked mass-claim
// pass. Visible until users.phase17_seeded_at is set. Polls runSeedChunk
// until hasMore is false. Each chunk processes 25 extracted ideas, so
// ~860 ideas takes ~35 chunks; with chunks completing in ~3-5s, the
// full pass finishes in roughly two minutes. The banner shows progress
// the whole time.
//
// Dismissible per-day via localStorage. Reappears on first load each
// day if seeding is incomplete (so the user knows it's running again).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { runSeedChunk, type SeedChunkResult, type SeedStatus } from './seed-actions';

const STORAGE_KEY = 'tb_phase17_banner_dismissed';

function dismissedToday(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const today = new Date().toISOString().slice(0, 10);
    return stored === today;
  } catch {
    return false;
  }
}

function markDismissedToday() {
  if (typeof window === 'undefined') return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    window.localStorage.setItem(STORAGE_KEY, today);
  } catch {
    // localStorage unavailable; just no-op
  }
}

export function SeedBanner({
  initialStatus,
}: {
  initialStatus: SeedStatus;
}) {
  const [status, setStatus] = useState<SeedStatus>(initialStatus);
  const [running, setRunning] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [lastChunk, setLastChunk] = useState<SeedChunkResult | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    setDismissed(dismissedToday());
  }, []);

  const runChunk = useCallback(async () => {
    if (stoppedRef.current) return;
    setRunning(true);
    try {
      const res = await runSeedChunk();
      if (stoppedRef.current) return;
      setLastChunk(res);
      setStatus((prev) => ({
        ...prev,
        alreadyClaimed: res.totalClaimed,
        seeded: !res.hasMore,
      }));
      if (res.hasMore) {
        // Next chunk fires immediately; UI updates between calls.
        setTimeout(runChunk, 80);
      }
    } catch (err) {
      console.error('[SeedBanner] chunk failed', err);
    } finally {
      setRunning(false);
    }
  }, []);

  // Auto-fire on mount when seeding hasn't completed.
  useEffect(() => {
    if (status.seeded) return;
    runChunk();
    return () => {
      stoppedRef.current = true;
    };
  }, [status.seeded, runChunk]);

  if (status.seeded) {
    // The pass finished. If we ran chunks during this mount (i.e.
    // there was something to claim and it's now done), keep the
    // banner up briefly to confirm; otherwise hide entirely.
    if (lastChunk) {
      return (
        <div className="mb-6 rounded-card border border-rule bg-paper-2 px-5 py-4 flex items-center justify-between gap-4">
          <p className="font-sans text-[14px] text-ink leading-[1.5]">
            <span className="font-medium">Garden ready.</span> {status.alreadyClaimed}{' '}
            {status.alreadyClaimed === 1 ? 'idea' : 'ideas'} claimed from your own writing.
          </p>
          <button
            type="button"
            onClick={() => {
              markDismissedToday();
              setDismissed(true);
            }}
            className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors"
          >
            Dismiss
          </button>
        </div>
      );
    }
    return null;
  }

  if (dismissed) return null;

  const target = status.totalEligible;
  const done = status.alreadyClaimed;
  const remaining = Math.max(0, target - done);

  return (
    <div className="mb-6 rounded-card border border-rule bg-paper-2 px-5 py-4">
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <p className="font-sans text-[14px] text-ink leading-[1.5]">
          <span className="font-medium">Welcome back.</span> We&apos;re claiming
          your ideas from your own writing so the Garden has something
          to show you. {done} of {target} done.
        </p>
        <button
          type="button"
          onClick={() => {
            stoppedRef.current = true;
            markDismissedToday();
            setDismissed(true);
          }}
          className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors shrink-0"
        >
          Hide for today
        </button>
      </div>
      <div className="h-1 bg-rule rounded-full overflow-hidden">
        <div
          className="h-full bg-ink transition-all duration-300"
          style={{
            width: target > 0 ? `${Math.min(100, (done / target) * 100)}%` : '0%',
          }}
        />
      </div>
      <p className="font-mono text-[10px] tracking-[0.04em] text-tag mt-2">
        {running
          ? `Claiming next batch… ${remaining} remaining.`
          : remaining > 0
            ? `Paused. ${remaining} remaining.`
            : 'Wrapping up.'}
      </p>
    </div>
  );
}
