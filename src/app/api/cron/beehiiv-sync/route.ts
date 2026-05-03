// Thoughtbed · /api/cron/beehiiv-sync (Sprint 13 Wave 2)
//
// Vercel Cron hits this route once a day (08:00 UTC, see vercel.json).
// We iterate every connected Beehiiv connector account, decrypt its
// API key, and run the same sync engine the user's "Sync now" button
// drives. Per-account failures are caught + recorded on the account
// row so one user's expired key doesn't kill the run for others.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the
// CRON_SECRET env var is set on the project. Anything else returns 401.
// In dev, run via:
//   curl -H "Authorization: Bearer <local CRON_SECRET>" \
//        http://localhost:3000/api/cron/beehiiv-sync
//
// Why iterate here vs. fan out: at the founder's scale (1 user, 1
// publication, ~5 issues) a single function invocation comfortably runs
// in <5s. If multi-user growth pushes us past Vercel's function timeout,
// promote to a queue (QStash / SQS) and have the cron just enqueue.

import { eq, and, isNotNull } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import { decryptSecret } from '@/lib/crypto';
import { runSync } from '@/lib/beehiiv-sync';

// Force-dynamic so Next doesn't try to cache this route. The cron
// invocation should always hit the runtime.
export const dynamic = 'force-dynamic';
// runtime: 'nodejs' (default) — we need node:crypto inside decryptSecret.
export const runtime = 'nodejs';

type AccountReport = {
  accountId: string;
  userId: string;
  status: 'ok' | 'error' | 'skipped';
  fetched?: number;
  touched?: number;
  reason?: string;
};

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export async function GET(req: Request) {
  // ─── auth ──────────────────────────────────────────────
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Refuse in production rather than silently allow anonymous syncs.
    console.error('[cron] CRON_SECRET is not set — cron disabled.');
    return unauthorized();
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${expected}`) {
    return unauthorized();
  }

  const startedAt = Date.now();

  // ─── load every connected Beehiiv account ──────────────────────────
  const accounts = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.provider, 'beehiiv'),
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

    const meta = (account.metadata ?? {}) as { publicationId?: string };
    if (!meta.publicationId) {
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'skipped',
        reason: 'missing publicationId in metadata',
      });
      continue;
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(account.encryptedSecret);
    } catch (err) {
      console.warn('[cron] decrypt failed', account.id, err);
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'error',
        reason: 'decrypt_failed',
      });
      continue;
    }

    try {
      const { fetched, touched } = await runSync(
        account.userId,
        account.id,
        apiKey,
        meta.publicationId
      );
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'ok',
        fetched,
        touched,
      });
    } catch (err) {
      // runSync already wrote last_sync_status='error'/'auth_failed' on
      // the account row before throwing — we just collect the per-account
      // outcome for the response.
      const message = err instanceof Error ? err.message : 'unknown';
      console.warn('[cron] runSync failed', account.id, message);
      reports.push({
        accountId: account.id,
        userId: account.userId,
        status: 'error',
        reason: message.slice(0, 200),
      });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = {
    ok: true as const,
    ranAt: new Date(startedAt).toISOString(),
    elapsedMs,
    accounts: reports.length,
    succeeded: reports.filter((r) => r.status === 'ok').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
    failed: reports.filter((r) => r.status === 'error').length,
    reports,
  };

  return Response.json(summary);
}
