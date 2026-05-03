// Thoughtbed · Studio layout
//
// Sprint 11 replaced the studio top nav with a Ghostbase-style left
// sidebar. The layout is now: <Sidebar /> on the left, <main> for the
// route's content on the right. Auth is enforced by middleware; the
// auth() check below is defensive and surfaces redirects synchronously
// before any heavy await (per the gotchas doc).
//
// Recent drafts + ideas are fetched here, in the layout, so the sidebar
// is always populated by the time the route's page renders. The data
// crosses the server → client boundary as plain strings (ISO dates) to
// keep RSC serialization happy.

import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { eq, desc } from 'drizzle-orm';
import { db, drafts, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { Sidebar, type RecentItem } from './Sidebar';

const RECENT_PER_KIND = 15;
const RECENT_TOTAL = 20;

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defensive auth: middleware already redirects unauthed users to
  // /sign-in. This second check is the explicit-auth-then-await pattern
  // we use everywhere a redirect must fire before RSC streaming begins.
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const user = await requireUser();
  const clerk = await currentUser();
  const firstName =
    clerk?.firstName || user.name?.split(' ')[0] || 'Your';

  // Pull recent drafts + ideas in parallel. Each capped at RECENT_PER_KIND
  // so the merged + truncated list still leaves room for the other kind
  // even if one side dominates.
  const [draftRows, ideaRows] = await Promise.all([
    db
      .select({
        id: drafts.id,
        title: drafts.title,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(eq(drafts.userId, user.id))
      .orderBy(desc(drafts.updatedAt))
      .limit(RECENT_PER_KIND),
    db
      .select({
        id: ideas.id,
        title: ideas.title,
        lastVisitedAt: ideas.lastVisitedAt,
        updatedAt: ideas.updatedAt,
      })
      .from(ideas)
      .where(eq(ideas.userId, user.id))
      .orderBy(desc(ideas.lastVisitedAt))
      .limit(RECENT_PER_KIND),
  ]);

  const items: RecentItem[] = [
    ...draftRows.map((d): RecentItem => ({
      kind: 'draft',
      id: d.id,
      title: d.title,
      href: `/studio/page/${d.id}`,
      iso: toIso(d.updatedAt),
    })),
    ...ideaRows.map((i): RecentItem => ({
      kind: 'idea',
      id: i.id,
      title: i.title,
      href: `/studio/ideas/${i.id}`,
      // Prefer lastVisitedAt for ideas — it tracks engagement; fall back
      // to updatedAt and finally epoch-zero if both are null.
      iso: toIso(i.lastVisitedAt ?? i.updatedAt),
    })),
  ];

  items.sort(
    (a, b) => new Date(b.iso).getTime() - new Date(a.iso).getTime()
  );
  const recents = items.slice(0, RECENT_TOTAL);

  return (
    <div className="min-h-screen flex bg-bg">
      <Sidebar firstName={firstName} recents={recents} />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}

/** Date | string | null → ISO string (epoch-zero fallback for null). */
function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString();
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
