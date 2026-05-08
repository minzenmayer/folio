// Thoughtbed · Beside PhaseToggle
//
// Phase 24 slice 1 (2026-05-07). Two-state pill in the toolbar's
// left edge. Click flips phase; the pill mirrors current state.
// Slice 1 only changes the chrome — no surfacing or originality
// behavior is tied to phase yet (those land in slice 5).

'use client';

import { useBesidePhase, type BesidePhase } from './useBesidePhase';

export function PhaseToggle() {
  const { phase, setPhase } = useBesidePhase();
  return (
    <div
      role="group"
      aria-label="Writing phase"
      className="inline-flex items-center rounded-card border border-rule bg-paper p-0.5"
    >
      <PhaseButton
        label="Thinking"
        active={phase === 'thinking'}
        onClick={() => setPhase('thinking')}
        glyph={<SaplingGlyph />}
      />
      <PhaseButton
        label="Shipping"
        active={phase === 'shipping'}
        onClick={() => setPhase('shipping')}
        glyph={<SparkGlyph />}
      />
    </div>
  );
}

function PhaseButton({
  label,
  active,
  onClick,
  glyph,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  glyph: React.ReactNode;
}) {
  // Active state uses paper-hot for thinking and ink for shipping
  // so the chrome difference reads at a glance, even before any
  // surfacing rules are wired.
  const activeClass =
    label === 'Thinking'
      ? 'bg-paper-hot text-ink'
      : 'bg-ink text-paper';
  const inactiveClass = 'text-tag hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] transition-colors ${
        active ? activeClass : inactiveClass
      }`}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function SaplingGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 11 V6" />
      <path d="M6 7 C 4 6 3.2 4 4 2.5 C 5.5 3 6 4.5 6 6.5" />
      <path d="M6 7 C 8 6 8.8 4 8 2.5 C 6.5 3 6 4.5 6 6.5" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 1.5 L7 5 L10.5 6 L7 7 L6 10.5 L5 7 L1.5 6 L5 5 Z" />
    </svg>
  );
}

// Re-export for callers that want to type-narrow on phase.
export type { BesidePhase };
