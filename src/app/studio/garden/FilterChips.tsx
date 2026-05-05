// Phase 14b — Garden filter chips for the ranked feed.

import Link from 'next/link';

const CHIPS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'hot', label: 'Hot' },
  { key: 'ready', label: 'Ready' },
  { key: 'unclaimed', label: 'Unclaimed' },
  { key: 'set_aside', label: 'Set aside' },
];

export function FilterChips({ active }: { active: string }) {
  return (
    <div className="flex gap-2 flex-wrap mb-4 mt-10">
      {CHIPS.map((c) => {
        const isActive = c.key === active;
        const href = c.key === 'all' ? '/studio/garden' : `/studio/garden?filter=${c.key}`;
        return (
          <Link
            key={c.key}
            href={href}
            className={
              isActive
                ? 'font-sans text-[12px] px-3 py-1 rounded-full bg-ink text-paper border border-ink'
                : 'font-sans text-[12px] px-3 py-1 rounded-full bg-paper text-ink-soft border border-rule hover:border-rule-strong'
            }
          >
            {c.label}
          </Link>
        );
      })}
    </div>
  );
}
