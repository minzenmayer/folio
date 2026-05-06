// Thoughtbed · OnTheRise — Phase 19.3 (2026-05-06)
//
// Visual grid of hot / ready / rising ideas below the digest.
// Sparks curiosity. Each card shows title, one-line preview, a
// reason tag (hot / ready / rising), temperature pill, theme.

import Link from 'next/link';
import type { RisingItem } from '@/lib/garden/on-the-rise';
import { TempPill } from './pills';

const REASON_COPY: Record<RisingItem['reason'], string> = {
  hot: 'Hot',
  ready: 'Ready',
  rising: 'On the rise',
};

const REASON_CLASS: Record<RisingItem['reason'], string> = {
  hot: 'bg-[#dcfce7] text-[#14532d] border-[#15803d]',
  ready: 'bg-paper-3 text-ink border-rule-strong',
  rising: 'bg-paper-2 text-ink-soft border-rule',
};

export function OnTheRise({ items }: { items: RisingItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        On the rise
      </h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/studio/garden/${item.id}`}
            className="block rounded-card border border-rule bg-paper p-4 hover:border-rule-strong hover:bg-paper-2 transition-colors group"
          >
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <span
                className={`font-mono text-[9px] tracking-[0.18em] uppercase rounded px-1.5 py-[1px] border ${REASON_CLASS[item.reason]}`}
              >
                {REASON_COPY[item.reason]}
              </span>
              <TempPill t={item.temperature} />
            </div>
            <h3 className="font-sans text-[14.5px] font-medium text-ink leading-[1.35] mb-1 group-hover:underline underline-offset-4 decoration-rule-strong line-clamp-2">
              {item.title}
            </h3>
            {item.essence && (
              <p className="font-sans text-[12.5px] text-ink-soft leading-[1.45] line-clamp-2">
                {item.essence}
              </p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
