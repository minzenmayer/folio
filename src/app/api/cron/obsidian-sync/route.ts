/**
 * src/app/api/cron/obsidian-sync/route.ts
 *
 * Daily backstop cron for Obsidian vault synchronisation.
 *
 * Vercel Cron invokes this at 08:30 UTC every day (see vercel.json).
 * It iterates every active Obsidian connector row in `user_connectors`
 * and runs a full `syncVault()` pass, then logs a summary.
 *
 * Security
 * ────────
 * The route is protected by the Vercel-injected `x-vercel-cron` header.
 * Unauthenticated external callers receive 401.
 */

import { NextResponse }        from 'next/server';
import { db }                  from '@/db';
import { userConnectors }      from '@/db/schema';
import { eq }                  from 'drizzle-orm';
import { obsidianConnector }   from '@/lib/connectors/obsidian';
import { syncVault }           from '@/lib/obsidian-sync';
import { parseRepoUrl }        from '@/lib/obsidian';
import type { ObsidianCredentials } from '@/lib/connectors/obsidian';

export const runtime  = 'nodejs';
export const maxDuration = 300; // 5 min Vercel limit for cron

export async function GET(request: Request) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const isCron = request.headers.get('x-vercel-cron') === '1';
  if (!isCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Load active Obsidian connectors ───────────────────────────────────────
  const rows = await db
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.connectorId, 'obsidian'));

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, message: 'No Obsidian connectors configured.' });
  }

  const results: Record<string, unknown> = {};

  for (const row of rows) {
    const creds     = row.credentials as ObsidianCredentials;
    const repoFull  = parseRepoUrl(creds.repoUrl);

    try {
      const result = await syncVault({
        repoFull,
        branch: creds.branch,
        token:  creds.githubToken,
      });
      results[repoFull] = result;
    } catch (err) {
      results[repoFull] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json({ ok: true, results });
}
