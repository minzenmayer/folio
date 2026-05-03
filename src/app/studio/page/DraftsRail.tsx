// Folio · DraftsRail
// Server-component left rail for /studio/page and /studio/page/[id].
// Lists the user's drafts ordered by updated_at desc; highlights the active
// one when an `activeId` is passed.
//
// Click → navigates to the editor for that draft.
// "+ New draft" → calls a server action which creates an empty draft and
// redirects into it.

import Link from 'next/link';
import { eq, desc } from 'drizzle-orm';
import { db, drafts } from '@/db';
import type { User } from '@/db';
import { createDraft } from './actions';

function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export async function DraftsRail({
  user,
  activeId,
}: {
  user: User;
  activeId?: string;
}) {
  const rows = await db
    .select({
      id: drafts.id,
      title: drafts.title,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.userId, user.id))
    .orderBy(desc(drafts.updatedAt));

  return (
    <aside
      className="border-r border-rule bg-paper/60 flex flex-col"
      aria-label="Drafts"
    >
      <div className="px-5 pt-6 pb-4 border-b border-rule">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-3">
          ▸ Drafts
        </div>
        <form action={createDraft}>
          <button
            type="submit"
            className="w-full text-left font-sans text-[12px] tracking-[0.06em] uppercase text-ink-soft border border-rule rounded-[3px] px-3 py-2 hover:border-accent hover:text-accent transition-colors"
          >
            + New draft
          </button>
        </form>
      </div>

      <nav
        className="flex-1 overflow-y-auto"
        aria-label="Existing drafts"
      >
        {rows.length === 0 ? (
          <div className="px-5 py-8">
            <p className="font-serif italic text-[14px] text-tag leading-[1.5]">
              No drafts yet. Start one — the surface is yours.
            </p>
          </div>
        ) : (
          <ul>
            {rows.map((d) => {
              const isActive = d.id === activeId;
              return (
                <li key={d.id}>
                  <Link
                    href={`/studio/page/${d.id}`}
                    className={`block px-5 py-4 border-b border-rule transition-colors ${
                      isActive
                        ? 'bg-paper-2'
                        : 'hover:bg-paper'
                    }`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <h3
                      className={`font-serif text-[16px] leading-[1.3] mb-1 ${
                        d.title
                          ? 'text-ink'
                          : 'italic text-tag font-light'
                      } ${isActive ? 'text-accent' : ''}`}
                    >
                      {d.title || 'Untitled'}
                    </h3>
                    <div className="font-mono text-[10px] tracking-[0.04em] text-tag">
                      {timeAgo(d.updatedAt)}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
