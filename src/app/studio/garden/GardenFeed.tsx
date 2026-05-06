// Phase 14b — the ranked feed below the digest. Sorted by ripeness.

import Link from 'next/link';
import type { GardenItem } from '@/lib/garden/types';
import { TempPill, MaturityDots } from './pills';
import { AddNoteInline } from './AddNoteInline';

const SOURCE_LABEL: Record<string, string> = {
  newsletter_issue: 'newsletter',
  obsidian_note: 'vault',
  linkedin_post: 'LinkedIn',
  gmail_message: 'Gmail',
};

function relativeTime(d: Date | null): string {
  if (!d) return '';
  const ms = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ms < 60 * 60 * 1000) return 'just now';
  if (ms < day) return `${Math.floor(ms / (60 * 60 * 1000))}h ago`;
  if (ms < 7 * day) return `${Math.floor(ms / day)}d ago`;
  if (ms < 30 * day) return `${Math.floor(ms / (7 * day))}w ago`;
  return `${Math.floor(ms / (30 * day))}mo ago`;
}

export function GardenFeed({ items }: { items: GardenItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
          Empty
        </div>
        <p className="font-sans text-[14px] text-tag">
          No ideas match this filter.
        </p>
      </div>
    );
  }

  return (
    <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="relative">
          <Link
            href={
              item.isClaimed
                ? `/studio/garden/${item.id}`
                : `/studio/garden/extracted/${item.id}`
            }
            className="block py-4 px-5 pb-3 hover:bg-paper-2 transition-colors group"
          >
            <div className="flex gap-3 items-baseline mb-1">
              <h2 className="font-sans font-medium text-[15px] leading-[1.35] tracking-tight text-ink group-hover:underline underline-offset-4 decoration-rule-strong">
                {item.title}
              </h2>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-tag/70 whitespace-nowrap">
                {item.isClaimed
                  ? relativeTime(item.lastVisitedAt)
                  : item.sourceKind
                    ? SOURCE_LABEL[item.sourceKind] ?? 'source'
                    : 'unclaimed'}
              </span>
            </div>
            {item.preview && (
              <p className="font-sans text-[13px] text-ink-soft leading-[1.55] mb-2 max-w-[64ch] line-clamp-2">
                {item.preview}
              </p>
            )}
            <div className="flex gap-2 flex-wrap items-center">
              <TempPill t={item.temperature} />
              {item.isClaimed && <MaturityDots m={item.maturity} />}
              {item.themes.slice(0, 2).map((th) => (
                <span
                  key={th}
                  className="font-mono text-[10px] px-2 py-[2px] rounded bg-paper-2 text-tag"
                >
                  {th}
                </span>
              ))}
              {!item.isClaimed && (
                <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-tag/70 ml-1">
                  unclaimed
                </span>
              )}
            </div>
          </Link>
          {item.isClaimed && (
            <div className="px-5 pb-3 -mt-1">
              <AddNoteInline ideaId={item.id} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
