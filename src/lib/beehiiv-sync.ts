/**
 * src/lib/beehiiv-sync.ts
 *
 * Thin orchestration layer used by the Beehiiv cron route and the
 * manual "sync now" server action.  Delegates all real work to
 * src/lib/connectors/beehiiv.ts.
 *
 * Wave 2: No functional changes to this file.  upsertIssue now
 * calls extractIdeas inline, so syncs automatically populate
 * extracted_ideas without any changes here.
 */

import { db }              from '@/db';
import { userConnectors }  from '@/db/schema';
import { eq }              from 'drizzle-orm';
import {
  beehiivConnector,
  upsertIssue,
  type BeehiivCredentials,
} from './connectors/beehiiv';

export type { BeehiivCredentials };

// ── syncBeehiiv ───────────────────────────────────────────────────────────────

/**
 * Runs a full Beehiiv sync for every active Beehiiv connector row.
 * Called by the cron route at 08:00 UTC.
 */
export async function syncBeehiiv(): Promise<{
  ok: boolean;
  results: Record<string, unknown>;
}> {
  const rows = await db
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.connectorId, 'beehiiv'));

  const results: Record<string, unknown> = {};

  for (const row of rows) {
    const creds = row.credentials as BeehiivCredentials;
    try {
      const result = await beehiivConnector.sync(creds);
      results[creds.publicationId] = result;
    } catch (err) {
      results[creds.publicationId ?? row.id] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: true, results };
}

// ── Re-export upsertIssue for consumers that need a single-issue write ────────
export { upsertIssue };
