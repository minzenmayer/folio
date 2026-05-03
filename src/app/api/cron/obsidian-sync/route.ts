// Thoughtbed · /api/cron/obsidian-sync (Sprint 15 Wave 2)
//
// Daily backstop for the Obsidian-via-GitHub connector. Real-time push
// is the primary path (GitHub push webhook → Wave-1 dispatcher); this
// cron catches:
//   · Pushes that fired before our last deploy and were missed.
//   · Pushes that 5xx'd on our side without GitHub retrying past the cap.
//   · Branch protections / repo settings that disable webhooks for a
//     period without disconnecting the connector.
//
// Mirrors src/app/api/cron/beehiiv-sync — same Bearer-token auth, same
// per-account error isolation. Runs at 08:30 UTC (30 minutes after the
// Beehiiv cron) to spread load across the function pool.

import { eq, and, isNotNull } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import { decryptSecret } from '@/lib/crypto';
import { runSync } from '@/lib/obsidian-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AccountReport = {
  accountId: string;
  userId: string;
  status: 'ok' | 'error' | 'skipped';
  fetched?: number;
  touched?: number;
  removed?: number;
  reason?: string;
};

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron:obsidian] CRON_SECRET is not set — cron disabled.');
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
        eq(connectorAccounts.provider, 'obsidian'),
        eq(connectorAccounts.status, 'connected'),
        isNotNull(connectorAccounts.encryptedSecret)
      )
    );

  const reports: AccountReport[] = [];

  for (const account of accounts) {
    if (!account.encryptedSecret) {
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'skipped',
        reason: 'missing encrypted_secret',
      });
      continue;
    }

    const meta = (account.metadata ?? {}) as {
      owner?: string;
      repo?: string;
      branch?: string;
    };
    if (!meta.owner || !meta.repo) {
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'skipped',
        reason: 'missing owner/repo in metadata',
      });
      continue;
    }

    let pat: string;
    try {
      pat = decryptSecret(account.encryptedSecret);
    } catch (err) {
      console.warn('[cron:obsidian] decrypt failed', account.id, err);
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'error',
        reason: 'decrypt_failed',
      });
      continue;
    }

    try {
      const { fetched, touched, removed } = await runSync(
        account.userId,
        account.id,
        {
          pat,
          owner: meta.owner,
          repo: meta.repo,
          branch: meta.branch ?? 'main',
        }
      );
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'ok',
        fetched,
        touched,
        removed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.warn('[cron:obsidian] runSync failed', account.id, message);
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'error',
        reason: message.slice(0, 200),
      });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return Response.json({
    ok: true as const,
    ranAt: new Date(startedAt).toISOString(),
    elapsedMs,
    accounts: reports.length,
    succeeded: reports.filter((r) => r.status === 'ok').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
    failed: reports.filter((r) => r.status === 'error').length,
    reports,
  });
}
