// Thoughtbed · /api/cron/gmail-sync (Phase 13, 2026-05-04)
//
// Daily backstop for the Gmail OAuth connector. Vercel Cron hits this at
// 09:30 UTC (see vercel.json) — after LinkedIn (09:00) so the daily
// rotation through external syncs is staggered.
//
// For each connected Gmail account we call runIncrementalGmailSync,
// which:
//   · refreshes the access token if stale,
//   · pages users.history.list since lastHistoryId,
//   · classifies + persists detected newsletters as status='pending',
//   · advances lastHistoryId on success.
//
// If the account hasn't finished its initial backfill (no syncCompletedAt),
// runIncrementalGmailSync defers to kickFirstGmailSync, draining one
// chunk per cron pass until done.
//
// Same auth pattern as the Beehiiv / Obsidian / LinkedIn crons: Bearer
// CRON_SECRET. Anything else 401s.

import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import { runIncrementalGmailSync } from '@/lib/gmail/sync';
import { GMAIL_OAUTH_PROVIDER } from '@/lib/gmail/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AccountReport = {
  accountId: string;
  userId: string;
  examined: number;
  detected: number;
  inserted: number;
  done: boolean;
  errors: string[];
};

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron:gmail] CRON_SECRET is not set — cron disabled.');
    return unauthorized();
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${expected}`) {
    return unauthorized();
  }

  const startedAt = Date.now();

  const accounts = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.provider, GMAIL_OAUTH_PROVIDER),
        eq(connectorAccounts.status, 'connected')
      )
    );

  const reports: AccountReport[] = [];

  for (const account of accounts) {
    let report: AccountReport = {
      accountId: account.id,
      userId: account.userId,
      examined: 0,
      detected: 0,
      inserted: 0,
      done: false,
      errors: [],
    };
    try {
      const out = await runIncrementalGmailSync({
        userId: account.userId,
        accountId: account.id,
      });
      report = {
        ...report,
        examined: out.examined,
        detected: out.detected,
        inserted: out.inserted,
        done: out.done,
        errors: out.errors,
      };
    } catch (err) {
      report.errors.push((err as Error).message?.slice(0, 200) ?? 'unknown');
    }
    reports.push(report);
  }

  return Response.json({
    ok: true,
    ranAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    accounts: reports.length,
    reports,
  });
}
