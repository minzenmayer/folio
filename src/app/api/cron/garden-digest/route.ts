// Thoughtbed · /api/cron/garden-digest (Phase 14b, 2026-05-04)
//
// Daily compute of the Garden's surface for each user:
//   1. apply auto-cooling (3 unacted digest surfaces → cool, 30+ days
//      no visit → cool — both gated by pinned_until)
//   2. compute today's digest (5 highest-ripeness claimed ideas)
//   3. compute today's juxtaposition (3 heuristics, scored, pick top)
//   4. cache in garden_digest_runs (one row per (user, date))
//   5. bump digest_surface_count on the picked ideas
//
// Schedule: 04:00 UTC daily — see vercel.json.
//
// Auth: Bearer CRON_SECRET, same pattern as the other crons.

import { db, users } from '@/db';
import { applyAutoCooling, computeDigest, persistDigestRun, markSurfaced } from '@/lib/garden/digest';
import { computeNextJuxtaposition } from '@/lib/garden/juxtaposition';
import { computeClusters, persistClusters } from '@/lib/garden/clusters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type UserReport = {
  userId: string;
  cooledByVisit: number;
  cooledByDigest: number;
  digestPicks: number;
  clusterCount: number;
  juxtapositionId: string | null;
  errors: string[];
};

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron:garden-digest] CRON_SECRET is not set — cron disabled.');
    return unauthorized();
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${expected}`) {
    return unauthorized();
  }

  const startedAt = Date.now();
  const allUsers = await db.select({ id: users.id }).from(users);

  const reports: UserReport[] = [];

  for (const user of allUsers) {
    const report: UserReport = {
      userId: user.id,
      cooledByVisit: 0,
      cooledByDigest: 0,
      digestPicks: 0,
      clusterCount: 0,
      juxtapositionId: null,
      errors: [],
    };
    try {
      // 1. auto-cool sweep (must run BEFORE picking the digest)
      const cooled = await applyAutoCooling(user.id);
      report.cooledByVisit = cooled.cooledByVisit;
      report.cooledByDigest = cooled.cooledByDigest;

      // 2. digest pick
      const picks = await computeDigest(user.id);
      report.digestPicks = picks.length;

      // 2.5 (Phase 17, 2026-05-05). Cluster compute. Greedy O(N²)
      // over candidates with embeddings; in practice ~860 ideas
      // resolves in well under the cron's per-user budget.
      try {
        const clusters = await computeClusters(user.id);
        const persisted = await persistClusters(user.id, new Date(), clusters);
        report.clusterCount = persisted;
      } catch (err) {
        report.errors.push(`clusters: ${(err as Error).message}`);
      }

      // 3. juxtaposition compute
      let jxId: string | null = null;
      try {
        jxId = await computeNextJuxtaposition(user.id);
        report.juxtapositionId = jxId;
      } catch (err) {
        report.errors.push(`juxtaposition: ${(err as Error).message}`);
      }

      // 4. + 5. persist + mark surfaced (only if there's something to persist)
      if (picks.length > 0) {
        await persistDigestRun(user.id, picks, jxId);
        await markSurfaced(user.id, picks);
      }
    } catch (err) {
      report.errors.push(`fatal: ${(err as Error).message}`);
    }
    reports.push(report);
  }

  return Response.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    users: reports.length,
    reports,
  });
}
