// Thoughtbed · Sidebar
//
// Sprint 11: replaces the studio top nav with a Ghostbase-style left
// sidebar. Persistent across every authed surface, sticky on the left.
//
// Sections (top → bottom):
//   1. Brand block — Thoughtbed wordmark + "[name]'s bed" workspace label
//   2. + New writing — full-width prominent CTA → /studio (the composer)
//   3. Named nav items (Write, Inbox, Garden, Knowledge) with active state
//   4. Recent — drafts + ideas mixed, grouped by Today / Last 7 days / Older.
//      The active draft / idea is highlighted so the sidebar doubles as
//      navigation history.
//   5. Footer — Settings + Help (placeholder) + Clerk UserButton
//
// Implementation: this is a client component so it can read usePathname()
// for the active-state highlight. The parent layout (server) does the
// data fetching and passes serializable props (dates as ISO strings).

'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';

export type RecentItem = {
  kind: 'draft' | 'idea';
  id: string;
  title: string | null;
  href: string;
  // ISO 8601 — Date objects don't survive the server → client boundary.
  iso: string;
};

const NAV_ITEMS: Array<{
  label: string;
  href: string;
  glyph: string;
  // Some sections "own" sub-routes (Garden owns /studio/ideas/[id]); others
  // (Write) deliberately claim multiple roots (/studio AND /studio/page/*).
  matches?: (pathname: string) => boolean;
}> = [
  {
    label: 'Write',
    href: '/studio',
    glyph: '✎',
    matches: (p) => p === '/studio' || p.startsWith('/studio/page'),
  },
  {
    label: 'Inbox',
    href: '/studio/inbox',
    glyph: '"',
  },
  {
    label: 'Garden',
    href: '/studio/ideas',
    glyph: '☘',
  },
  {
    label: 'Knowledge',
    href: '/studio/knowledge',
    glyph: '◇',
  },
];

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

export function Sidebar({
  firstName,
  recents,
}: {
  firstName: string;
  recents: RecentItem[];
}) {
  const pathname = usePathname() ?? '/studio';

  // Bucket the recent list. We use the prop's iso string so the grouping
  // is deterministic relative to render time — no flicker when the
  // component re-renders mid-session.
  const groups = useMemo(() => {
    const today: RecentItem[] = [];
    const week: RecentItem[] = [];
    const older: RecentItem[] = [];
    const now = Date.now();
    for (const item of recents) {
      const age = now - new Date(item.iso).getTime();
      if (age < DAY) today.push(item);
      else if (age < WEEK) week.push(item);
      else older.push(item);
    }
    return { today, week, older };
  }, [recents]);

  function isNavActive(item: (typeof NAV_ITEMS)[number]) {
    if (item.matches) return item.matches(pathname);
    return pathname === item.href || pathname.startsWith(item.href + '/');
  }

  return (
    <aside
      className="hidden md:flex w-[260px] shrink-0 border-r border-rule bg-paper/40 flex-col h-screen sticky top-0"
      aria-label="Thoughtbed navigation"
    >
      {/* Brand block — wordmark + workspace label */}
      <div className="px-5 pt-5 pb-4 border-b border-rule">
        <Link
          href="/studio"
          className="font-serif italic text-[20px] text-ink font-medium hover:text-accent transition-colors block"
          aria-label="Thoughtbed — home"
        >
          Thoughtbed
        </Link>
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag mt-1.5 truncate">
          {firstName}'s bed
        </div>
      </div>

      {/* + New writing — the big primary CTA */}
      <div className="px-4 py-3 border-b border-rule">
        <Link
          href="/studio"
          className="block w-full text-center font-sans text-[11px] tracking-[0.22em] uppercase font-bold rounded-[3px] px-3 py-2.5 bg-ink text-bg hover:bg-accent transition-colors"
        >
          + New writing
        </Link>
      </div>

      {/* Nav — Write / Inbox / Garden / Knowledge */}
      <nav className="px-3 py-3" aria-label="Sections">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-[3px] px-3 py-2 mb-0.5 font-sans text-[14px] transition-colors ${
                active
                  ? 'bg-paper-2 text-ink font-medium'
                  : 'text-ink-soft hover:bg-paper hover:text-ink'
              }`}
            >
              <span
                className={`font-mono text-[14px] w-4 text-center ${
                  active ? 'text-accent' : 'text-tag'
                }`}
                aria-hidden
              >
                {item.glyph}
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-rule" />

      {/* Recent — drafts + ideas, bucketed by recency */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {recents.length === 0 ? (
          <p className="px-3 font-serif italic text-[12px] text-tag leading-[1.5]">
            Nothing yet. Plant a seed or start a draft to see your bed grow.
          </p>
        ) : (
          <>
            <RecentGroup
              label="Today"
              items={groups.today}
              pathname={pathname}
            />
            <RecentGroup
              label="Last 7 days"
              items={groups.week}
              pathname={pathname}
            />
            <RecentGroup
              label="Older"
              items={groups.older}
              pathname={pathname}
            />
          </>
        )}
      </div>

      {/* Footer — settings + help icons + user button */}
      <div className="border-t border-rule px-3 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Settings (coming soon)"
            title="Settings — coming soon"
            className="w-8 h-8 rounded-[3px] flex items-center justify-center text-tag hover:text-accent hover:bg-paper transition-colors"
          >
            <span className="font-mono text-[14px]" aria-hidden>
              ⚙
            </span>
          </button>
          <button
            type="button"
            aria-label="Help (coming soon)"
            title="Help — coming soon"
            className="w-8 h-8 rounded-[3px] flex items-center justify-center text-tag hover:text-accent hover:bg-paper transition-colors"
          >
            <span className="font-mono text-[14px]" aria-hidden>
              ?
            </span>
          </button>
        </div>
        <UserButton
          appearance={{
            elements: {
              avatarBox: 'w-8 h-8 ring-1 ring-rule',
            },
          }}
        />
      </div>
    </aside>
  );
}

function RecentGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: RecentItem[];
  pathname: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag/70 px-3 mb-1.5">
        {label}
      </div>
      <ul>
        {items.map((item) => {
          const active = pathname === item.href;
          const glyph = item.kind === 'draft' ? '✎' : '▸';
          return (
            <li key={`${item.kind}-${item.id}`}>
              <Link
                href={item.href}
                className={`flex items-baseline gap-2.5 px-3 py-1.5 rounded-[3px] transition-colors ${
                  active ? 'bg-paper-2' : 'hover:bg-paper'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                <span
                  className="font-mono text-[10px] text-accent w-3 text-center shrink-0"
                  aria-hidden
                >
                  {glyph}
                </span>
                <span
                  className={`font-serif text-[13px] leading-[1.3] flex-1 truncate ${
                    active ? 'text-accent font-medium' : 'text-ink'
                  }`}
                >
                  {item.title || (
                    <em className="italic text-tag">Untitled</em>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
