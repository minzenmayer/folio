// Thoughtbed · Beside Toolbar
//
// Phase 24 slice 1 (2026-05-07). Top strip for the Beside surface.
// Layout (left → right):
//   • back-to-home button
//   • phase toggle pill (Thinking / Shipping)
//   • platform selector (cycle)
//   • word readout (placeholder, slice 2 wires real count)
//   • Done button (shipping phase only — placeholder click)
//
// Slice 1 keeps everything inert except the back button, the phase
// toggle, and the platform cycle. Mode-dropdown handoff to
// With-assistant lands in slice 7.

'use client';

import { useBesidePhase } from './useBesidePhase';
import { PhaseToggle } from './PhaseToggle';
import {
  usePlatform,
  PLATFORM_LABEL,
  PLATFORM_WORD_TARGET,
} from '../page/usePlatform';

export function BesideToolbar({ onExit }: { onExit: () => void }) {
  const { phase } = useBesidePhase();
  const { platform, cycle } = usePlatform();
  const target = PLATFORM_WORD_TARGET[platform];

  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-paper">
      <div className="flex items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={onExit}
          aria-label="Back to homepage"
          className="font-mono text-[11px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors px-2 py-1"
          title="Back to homepage"
        >
          ← Back
        </button>

        <div className="h-5 w-px bg-rule" aria-hidden="true" />

        <PhaseToggle />

        <div className="h-5 w-px bg-rule" aria-hidden="true" />

        <div
          role="group"
          aria-label="Platform shape"
          className="inline-flex items-center gap-1 text-tag"
        >
          <button
            type="button"
            onClick={() => cycle('left')}
            aria-label="Previous platform"
            className="px-1.5 py-1 hover:text-ink transition-colors font-mono text-[12px]"
          >
            ‹
          </button>
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink min-w-[80px] text-center">
            {PLATFORM_LABEL[platform]}
          </span>
          <button
            type="button"
            onClick={() => cycle('right')}
            aria-label="Next platform"
            className="px-1.5 py-1 hover:text-ink transition-colors font-mono text-[12px]"
          >
            ›
          </button>
        </div>

        <div className="flex-1" />

        <span
          aria-label="Word count"
          className="font-mono text-[11px] tracking-[0.04em] text-tag"
        >
          — / {target ?? '—'}w
        </span>

        {phase === 'shipping' && (
          <button
            type="button"
            disabled
            title="Slice 6 wires the Done flow"
            className="font-mono text-[11px] tracking-[0.16em] uppercase text-paper bg-ink hover:opacity-90 disabled:opacity-60 px-3 py-1.5 rounded-soft"
          >
            Done →
          </button>
        )}
      </div>
    </header>
  );
}
