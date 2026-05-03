import { Suspense }         from 'react';
import { auth }             from '@clerk/nextjs/server';
import { redirect }         from 'next/navigation';
import { db }               from '@/db';
import { newsletterIssues, obsidianNotes } from '@/db/schema';
import { sql }              from 'drizzle-orm';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SourceCard {
  id:          string;
  label:       string;
  count:       number;
  status:      'live' | 'soon';
  description: string;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function getSourceCounts(): Promise<{ newsletter: number; obsidian: number }> {
  const [nlRow, obRow] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(newsletterIssues),
    db.select({ count: sql<number>`count(*)` }).from(obsidianNotes),
  ]);
  return {
    newsletter: Number(nlRow[0]?.count ?? 0),
    obsidian:   Number(obRow[0]?.count ?? 0),
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function KnowledgePage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const counts = await getSourceCounts();

  const sources: SourceCard[] = [
    {
      id:          'newsletter',
      label:       'Newsletter',
      count:       counts.newsletter,
      status:      'live',
      description: 'Issues synced from Beehiiv.',
    },
    {
      id:          'obsidian',
      label:       'Obsidian Vault',
      count:       counts.obsidian,
      status:      'live',      // ← flipped from "soon" in Wave 2
      description: 'Notes synced from your GitHub-backed vault.',
    },
  ];

  return (
    <main className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Knowledge</h1>
        <p className="text-muted-foreground mt-1">
          All ingested content, ready for retrieval and synthesis.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sources.map((src) => (
          <div
            key={src.id}
            className="rounded-xl border bg-card p-6 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{src.label}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  src.status === 'live'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                    : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300'
                }`}
              >
                {src.status === 'live' ? 'Live' : 'Coming soon'}
              </span>
            </div>
            <p className="text-3xl font-bold">{src.count.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">{src.description}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
