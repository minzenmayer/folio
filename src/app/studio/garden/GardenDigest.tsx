// Phase 14b — Today's digest. 5 ideas + 1 juxtaposition card.

import Link from 'next/link';
import type { GardenItem } from '@/lib/garden/types';
import { TempPill, MaturityDots } from './pills';
import { JuxtapositionCard } from './JuxtapositionCard';

export function GardenDigest({
  items,
  juxtaposition,
}: {
  items: Array<{ reason: string; item: GardenItem }>;
  juxtaposition: null | {
    id: string;
    question: string;
    reasoning: string;
    leftTitle: string;
    rightTitle: string;
    heuristic: string;
  };
}) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
  return (
    <div className="bg-paper rounded-card border border-rule overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-rule flex items-baseline justify-between">
        <h2 className="font-serif text-[18px] font-medium tracking-tight text-ink">
          Today, {dateStr}
        </h2>
        <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag">
          {items.length} surfaced
        </span>
      </div>

      <ul className="divide-y divide-rule">
        {items.map(({ reason, item }) => (
          <li key={`${item.kind}-${item.id}`} className="px-5 py-4 hover:bg-paper-2 transition-colors">
            <Link
              href={
                item.isClaimed
                  ? `/studio/garden/${item.id}`
                  : `/studio/garden/extracted/${item.id}`
              }
              className="block"
            >
              <h3 className="font-sans font-medium text-[15px] leading-[1.35] text-ink mb-1 group-hover:underline">
                {item.title}
              </h3>
              <p className="font-sans text-[13px] italic text-ink-soft leading-[1.55] mb-2">
                ↳ {reason}
              </p>
              <div className="flex gap-2 flex-wrap items-center">
                <TempPill t={item.temperature} />
                <MaturityDots m={item.maturity} />
                {item.themes.slice(0, 2).map((th) => (
                  <span
                    key={th}
                    className="font-mono text-[10px] px-2 py-[2px] rounded bg-paper-2 text-tag"
                  >
                    {th}
                  </span>
                ))}
                {!item.isClaimed && (
                  <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-tag/70 ml-auto">
                    unclaimed
                  </span>
                )}
              </div>
            </Link>
          </li>
        ))}

        {juxtaposition && (
          <li className="px-5 py-4">
            <JuxtapositionCard {...juxtaposition} />
          </li>
        )}
      </ul>
    </div>
  );
}
