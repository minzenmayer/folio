// Thoughtbed · Sidebar
//
// Sprint 14 brand pivot — Ghostbase-shape navigation.
//
// Sections (top → bottom):
//   1. Brand block — Thoughtbed wordmark + "[name]'s Space" workspace label
//   2. + NEW POST — primary CTA (mono uppercase, the Ghostbase "NEW CHAT" pattern)
//   3. Named nav (Write / Inbox / Library / Knowledge)
//   4. Recent — drafts + ideas mixed, grouped by Today / Last 7 days / Older
//   5. Footer — Settings (opens overlay modal) + Help + Clerk UserButton
//
// Settings is now a MODAL not a route. The gear icon pushes
// `?settings=connectors` onto the URL; the layout reads that searchParam
// and renders <SettingsModal />. The /studio/settings/connectors route
// still works for direct deep-links (it redirects to /studio with the
// searchParam set).

'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
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
  matches?: (pathname: string) => boolean;
}> = [
  {
    label: 'Write',
    href: '/studio',
    // "Write" claims the home + every draft route.
    matches: (p) => p === '/studio' || p.startsWith('/studio/page'),
  },
  {
    label: 'Inbox',
    href: '/studio/inbox',
  },
  {
    label: 'Library',
    href: '/studio/ideas',
    // The route stays /studio/ideas (DB tables, server actions, etc.
    // unchanged). Sidebar label is "Library" to match Ghostbase.
    matches: (p) => p.startsWith('/studio/ideas'),
  },
  {
    label: 'Knowledge',
    href: '/studio/knowledge',
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
  const searchParams = useSearchParams();
  // Settings is "active" whenever the modal is open (?settings=...), so the
  // gear icon stays highlighted while the user navigates the modal.
  const settingsOpen = (searchParams?.get('settings') ?? null) !== null;

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

  // Build the settings link href so we preserve the user's current path.
  // Clicking the gear shouldn't navigate them away from their draft.
  const settingsHref = `${pathname}?settings=connectors`;

  return (
    <aside
      className="hidden md:flex w-[260px] shrink-0 bg-bg flex-col h-screen sticky top-0"
      aria-label="Thoughtbed navigation"
    >
      {/* Brand block — wordmark + "[name]'s Space" workspace label */}
      <div className="px-5 pt-6 pb-5">
        <Link
          href="/studio"
          className="font-sans text-[18px] font-semibold tracking-tight text-ink hover:text-ink-soft transition-colors block"
          aria-label="Thoughtbed — home"
        >
          Thoughtbed
        </Link>
        <div className="font-sans text-[12px] text-tag mt-1 truncate">
          {firstName}'s Space
        </div>
      </div>

      {/* + NEW POST — primary CTA, mono uppercase like Ghostbase NEW CHAT */}
      <div className="px-3 pb-3">
        <Link
          href="/studio"
          className="block w-full text-center font-mono text-[11px] tracking-[0.2em] uppercase font-medium rounded-card border border-rule bg-paper px-3 py-3 text-ink hover:border-ink hover:bg-paper-2 transition-colors"
        >
          + New post
        </Link>
      </div>

      {/* Nav — Write / Inbox / Library / Knowledge.
          Pure typography pills, no glyphs (Ghostbase). */}
      <nav className="px-3 pt-1 pb-3" aria-label="Sections">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-soft px-3 py-2 mb-0.5 font-sans text-[14px] transition-colors ${
                active
                  ? 'bg-paper-2 text-ink font-medium'
                  : 'text-ink-soft hover:bg-paper-2 hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Recent — drafts + ideas, bucketed by recency */}
      <div className="flex-1 overflow-y-auto px-3 pt-1 pb-3">
        {recents.length === 0 ? (
          <p className="px-3 font-sans text-[12px] text-tag leading-[1.5]">
            Nothing yet. Start a draft or capture something to see it here.
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

      {/* Footer — settings (modal), help, user button */}
      <div className="px-3 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link
            href={settingsHref}
            scroll={false}
            aria-label="Settings"
            title="Settings"
            className={`w-8 h-8 rounded-soft flex items-center justify-center transition-colors ${
              settingsOpen
                ? 'bg-paper-2 text-ink'
                : 'text-tag hover:text-ink hover:bg-paper-2'
            }`}
          >
            <SettingsIcon />
          </Link>
          <button
            type="button"
            aria-label="Help (coming soon)"
            title="Help — coming soon"
            className="w-8 h-8 rounded-soft flex items-center justify-center text-tag hover:text-ink hover:bg-paper-2 transition-colors"
          >
            <HelpIcon />
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
      <div className="font-sans text-[11px] text-tag/80 px-3 mb-1.5">
        {label}
      </div>
      <ul>
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={`${item.kind}-${item.id}`}>
              <Link
                href={item.href}
                className={`block px-3 py-1.5 rounded-soft transition-colors ${
                  active ? 'bg-paper-2' : 'hover:bg-paper-2'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                <span
                  className={`font-sans text-[13px] leading-[1.3] truncate block ${
                    active ? 'text-ink font-medium' : 'text-ink-soft'
                  }`}
                >
                  {item.title || (
                    <span className="italic text-tag">Untitled</span>
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

// ─── inline SVG icons ───────────────────────────────────────────
// Two small icons (settings gear + help question) rendered inline so we
// don't bring in a dep. Sized to match Ghostbase's 16px icon footprint.

function SettingsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
