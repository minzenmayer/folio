// Thoughtbed · Sidebar
//
// Sprint 14 brand pivot — Ghostbase-shape navigation.
// Phase 11 (2026-05-04): nav rename + subtitles, and the "+ New post"
// CTA now actually creates a draft instead of plain-linking to /studio.
//
// Sections (top → bottom):
//   1. Brand block — Thoughtbed wordmark + "[name]'s Space" workspace label
//   2. + NEW POST — primary CTA. Submits a server-action form that
//      creates an empty draft and redirects into it. Was previously a
//      plain Link to /studio, which no-op'd when you were already on
//      /studio (the reported "doesn't navigate" bug).
//   3. Named nav (Write / Capture / Garden / Insights / Knowledge) with
//      a 12px muted subtitle under each label.
//        - "Inbox" → "Capture" (route /studio/inbox unchanged)
//        - "Library" → "Garden" (route /studio/ideas unchanged — the
//          DB tables, server actions, and call sites all keep their
//          Sprint-3 names; only the surface label moves to garden vocab.)
//   4. Recent — drafts + ideas mixed, grouped by Today / Last 7 days / Older
//   5. Footer — Settings (opens overlay modal) + Help + Clerk UserButton
//
// Settings is a MODAL not a route. The gear icon pushes
// `?settings=connectors` onto the URL; the layout reads that searchParam
// and renders <SettingsModal />. The /studio/settings/connectors route
// still works for direct deep-links (it redirects to /studio with the
// searchParam set).

'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { createDraft } from './page/actions';

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
  subtitle: string;
  href: string;
  matches?: (pathname: string) => boolean;
}> = [
  {
    label: 'Write',
    subtitle: 'draft your next post',
    href: '/studio',
    // "Write" claims the home + every draft route.
    matches: (p) => p === '/studio' || p.startsWith('/studio/page'),
  },
  {
    label: 'Capture',
    subtitle: 'plant a new thought',
    href: '/studio/inbox',
  },
  {
    label: 'Garden',
    subtitle: "ideas you're growing",
    // Phase 14b (2026-05-04): unified Garden absorbs the old Insights
    // surface. Old /studio/ideas + /studio/insights routes 301 here.
    href: '/studio/garden',
    matches: (p) =>
      p.startsWith('/studio/garden') ||
      p.startsWith('/studio/ideas') ||
      p.startsWith('/studio/insights'),
  },
  {
    label: 'Knowledge',
    subtitle: 'where Thoughtbed reads',
    href: '/studio/knowledge',
  },
  {
    // Phase 15a (2026-05-05): Voice insights — user-facing snapshot
    // of how you write right now. Voice ID (the training surface)
    // lives under Settings.
    label: 'Insights',
    subtitle: 'how you write',
    href: '/studio/voice-insights',
  },
];

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

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
    const yesterday: RecentItem[] = [];
    const week: RecentItem[] = [];
    const month: RecentItem[] = [];
    const older: RecentItem[] = [];
    const now = Date.now();
    for (const item of recents) {
      const age = now - new Date(item.iso).getTime();
      if (age < DAY) today.push(item);
      else if (age < 2 * DAY) yesterday.push(item);
      else if (age < WEEK) week.push(item);
      else if (age < MONTH) month.push(item);
      else older.push(item);
    }
    return { today, yesterday, week, month, older };
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
          className="flex items-center gap-2 font-sans text-[18px] font-semibold tracking-tight text-ink hover:text-ink-soft transition-colors group"
          aria-label="Thoughtbed — home"
        >
          <SproutMark />
          <span>Thoughtbed</span>
        </Link>
        <div className="font-sans text-[12px] text-tag mt-1 ml-7 truncate">
          {firstName}'s Space
        </div>
      </div>

      {/* + NEW POST — primary CTA, mono uppercase like Ghostbase NEW CHAT.
          Phase 11: server-action form (was a plain Link to /studio that
          no-op'd when the user was already on /studio). Mirrors the
          DraftsRail "+ New draft" pattern: createDraft() inserts an
          empty draft for the authed user and redirect()s into the
          editor at /studio/page/[id]. */}
      <div className="px-3 pb-3">
        <form action={createDraft}>
          <button
            type="submit"
            className="block w-full text-center font-mono text-[11px] tracking-[0.2em] uppercase font-medium rounded-card border border-rule bg-paper px-3 py-3 text-ink hover:border-ink hover:bg-paper-2 transition-colors"
          >
            + New post
          </button>
        </form>
      </div>

      {/* Nav — Write / Capture / Garden / Insights / Knowledge.
          Two-line pills: label on top, muted subtitle below. */}
      <nav className="px-3 pt-1 pb-3" aria-label="Sections">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-soft px-3 py-2 mb-0.5 font-sans transition-colors ${
                active
                  ? 'bg-paper-2 text-ink'
                  : 'text-ink-soft hover:bg-paper-2 hover:text-ink'
              }`}
            >
              <span
                className={`block text-[14px] leading-[1.25] ${
                  active ? 'font-medium' : ''
                }`}
              >
                {item.label}
              </span>
              <span
                className={`block text-[12px] leading-[1.3] mt-0.5 ${
                  active ? 'text-tag' : 'text-tag/80'
                }`}
              >
                {item.subtitle}
              </span>
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
              label="Yesterday"
              items={groups.yesterday}
              pathname={pathname}
            />
            <RecentGroup
              label="Last 7 days"
              items={groups.week}
              pathname={pathname}
            />
            <RecentGroup
              label="Last 30 days"
              items={groups.month}
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

// ─── Plant sprout mark ─────────────────────────────────
//
// Pixel-art sprout: top-left leaf, smaller mid-right leaf, curved
// stem, dirt patch at the base. Single-color silhouette in
// currentColor on transparent background. Each "pixel" is a 2x2
// unit rect on a 32x32 viewBox for the chunky pixel-art feel.
function SproutMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      fill="currentColor"
      className="shrink-0 text-ink"
    >
      {/* Top-left leaf — chunky lobed paddle, rows 1-6 */}
      <rect x="14" y="2"  width="2"  height="2" />
      <rect x="10" y="4"  width="8"  height="2" />
      <rect x="6"  y="6"  width="14" height="2" />
      <rect x="4"  y="8"  width="14" height="2" />
      <rect x="6"  y="10" width="10" height="2" />
      <rect x="8"  y="12" width="8"  height="2" />

      {/* Right leaf — smaller bump off the upper stem, rows 6-9 */}
      <rect x="22" y="12" width="4"  height="2" />
      <rect x="18" y="14" width="8"  height="2" />
      <rect x="10" y="16" width="14" height="2" />
      <rect x="10" y="18" width="12" height="2" />

      {/* Stem — column down the middle, rows 7-12 */}
      <rect x="10" y="14" width="4"  height="2" />
      <rect x="10" y="20" width="4"  height="2" />
      <rect x="10" y="22" width="4"  height="2" />
      <rect x="10" y="24" width="4"  height="2" />

      {/* Dirt — trapezoidal base, rows 13-15 */}
      <rect x="4"  y="26" width="16" height="2" />
      <rect x="2"  y="28" width="20" height="2" />
      <rect x="6"  y="30" width="14" height="2" />
    </svg>
  );
}
