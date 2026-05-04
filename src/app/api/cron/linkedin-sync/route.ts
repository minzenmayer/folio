// Thoughtbed · /api/cron/linkedin-sync (Phase 12, 2026-05-04)
//
// Daily backstop for the LinkedIn connector. Vercel Cron hits this at
// 09:00 UTC (see vercel.json). For each connected LinkedIn account we
// do two things in order:
//
//   1. pollAndFinalize() — drain any in-flight Apify run from yesterday.
//      Most days this is a no-op (the previous run usually finished
//      within minutes). When it isn't, we ingest the dataset now so the
//      account isn't stuck in "in progress" forever.
//
//   2. startSync() — kick a fresh Apify run for today. The next cron
//      hit (or a manual poll from the UI) drains it.
//
// Same auth pattern as the Beehiiv / Obsidian crons: Bearer
// CRON_SECRET. Anything else 401s.

import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import {
  startSync,
  pollAndFinalize,
  type LinkedinAccountMetadata,
} from '@/lib/linkedin-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AccountReport = {
  accountId: string;
  userId: string;
  poll: 'idle' | 'pending' | 'ok' | 'error' | 'skipped';
  pollDetail?: string;
  startedRunId?: string;
  startError?: string;
};

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron:linkedin] CRON_SECRET is not set — cron disabled.');
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
        eq(connectorAccounts.provider, 'linkedin'),
        eq(connectorAccounts.status, 'connected')
      )
    );

  const reports: AccountReport[] = [];

  for (const account of accounts) {
    const meta = (account.metadata ?? {}) as LinkedinAccountMetadata;
    if (!meta.profileUrl) {
      reports.push({
        accountId: account.id,
        userId: account.userId,
        poll: 'skipped',
        pollDetail: 'missing profileUrl in metadata',
      });
      continue;
    }

    // Step 1: drain any previous run.
    let pollKind: AccountReport['poll'] = 'skipped';
    let pollDetail: string | undefined;
    try {
      const result = await pollAndFinalize(account.userId, account.id);
      pollKind = result.kind === 'ok' ? 'ok' : result.kind;
      if (result.kind === 'ok') {
        pollDetail = `${result.touched}/${result.fetched} ingested`;
      } else if (result.kind === 'error') {
        pollDetail = result.reason;
      } else if (result.kind === 'pending') {
        pollDetail = `still running since ${result.startedAt}`;
      } else {
        pollDetail = result.message;
      }
    } catch (err) {
      pollKind = 'error';
      pollDetail = (err as Error).message?.slice(0, 200);
    }

    // Step 2: start a fresh run (unless one is still pending — startSync
    // returns the existing runId in that case, no duplicate billing).
    let startedRunId: string | undefined;
    let startError: string | undefined;
    try {
      const out = await startSync(account.userId, account.id, meta.profileUrl);
      startedRunId = out.runId;
    } catch (err) {
      startError = (err as Error).message?.slice(0, 200);
    }

    reports.push({
      accountId: account.id,
      userId: account.userId,
      poll: pollKind,
      pollDetail,
      startedRunId,
      startError,
    });
  }

  return Response.json({
    ok: true,
    ranAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    accounts: reports.length,
    reports,
  });
}
