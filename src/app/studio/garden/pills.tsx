// Phase 14b — small visual primitives shared across Garden surfaces.

import type { Temperature, Maturity } from '@/lib/garden/types';

const TEMP_COLOR: Record<Temperature, string> = {
  hot: 'bg-[#FAECE7] text-[#993C1D]',
  warm: 'bg-[#FAEEDA] text-[#854F0B]',
  cool: 'bg-[#E6F1FB] text-[#0C447C]',
  cold: 'bg-paper-2 text-tag',
  set_aside: 'bg-paper-2 text-tag line-through',
};

export function TempPill({ t }: { t: Temperature }) {
  const label = t === 'set_aside' ? 'set aside' : t;
  return (
    <span
      className={`font-mono text-[10px] tracking-[0.04em] px-2 py-[2px] rounded-full ${TEMP_COLOR[t]}`}
    >
      {label}
    </span>
  );
}

const MATURITY_ORDER: Maturity[] = [
  'seed',
  'forming',
  'shaping',
  'ready',
  'circulated',
  'dormant',
];

export function MaturityDots({ m }: { m: Maturity }) {
  const idx = MATURITY_ORDER.indexOf(m);
  // 4 dots; how many filled = position in maturity ladder, capped 4
  const filled = Math.min(4, Math.max(0, idx));
  return (
    <span
      className="font-mono text-[10px] tracking-[0.06em] text-tag uppercase whitespace-nowrap"
      title={m}
    >
      {Array.from({ length: 4 })
        .map((_, i) => (i < filled ? '●' : '○'))
        .join('')}{' '}
      {m}
    </span>
  );
}
