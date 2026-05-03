/**
 * src/lib/connectors/registry.ts
 *
 * Central registry of all ConnectorProvider implementations.
 *
 * Adding a new connector
 * ──────────────────────
 * 1. Implement ConnectorProvider in src/lib/connectors/<name>.ts.
 * 2. Import it here and add it to the `providers` array.
 * 3. Add its ID to the connectorIdEnum in src/db/schema.ts.
 * 4. Add a DB migration for any new tables it needs.
 *
 * The registry is consumed by:
 * • src/app/api/cron/beehiiv-sync/route.ts  (and future cron routes)
 * • src/app/api/webhooks/[connector]/route.ts
 * • src/app/studio/settings/connectors/actions.ts
 */

import type { ConnectorProvider } from './types';
import { beehiivConnector }      from './beehiiv';
import { obsidianConnector }     from './obsidian';   // ← Wave 2

/** All registered connector providers, in display order. */
export const providers: ConnectorProvider[] = [
  beehiivConnector,
  obsidianConnector,
];

/**
 * Look up a provider by its stable ID.
 * Returns undefined if the ID is unknown — callers must guard.
 */
export function getProvider(id: string): ConnectorProvider | undefined {
  return providers.find((p) => p.id === id);
}
