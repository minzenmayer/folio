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

import { useEffect, useState } from 'react';
import { type SeedStatus } from './seed-actions';

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
  const [status] = useState<SeedStatus>(initialStatus);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(dismissedToday());
  }, []);

  // Phase 18 hotfix (2026-05-05): banner no longer auto-fires
  // chunks. The Mature now button (in the Garden header) drives
  // both seed claims AND the maturation pass in one click. Banner
  // is now informational — shows what would happen if you click
  // Mature now.

  if (status.seeded) return null;
  if (dismissed) return null;

  return (
    <div className="mb-6 rounded-card border border-rule bg-paper-2 px-5 py-4 flex items-baseline justify-between gap-4">
      <p className="font-sans text-[14px] text-ink leading-[1.5]">
        <span className="font-medium">{status.totalEligible}</span>{' '}
        {status.totalEligible === 1 ? 'idea' : 'ideas'} from your own writing
        are ready to claim. Click{' '}
        <span className="font-mono text-[12px] tracking-[0.16em] uppercase border border-rule rounded px-1.5 py-[1px]">
          ↗ Mature now
        </span>{' '}
        above to claim them and run the lift formula.
      </p>
      <button
        type="button"
        onClick={() => {
          markDismissedToday();
          setDismissed(true);
        }}
        className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors shrink-0"
      >
        Hide for today
      </button>
    </div>
  );
}
