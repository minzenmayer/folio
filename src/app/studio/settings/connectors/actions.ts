'use server';

/**
 * src/app/studio/settings/connectors/actions.ts
 *
 * Server actions for the Connectors settings panel.
 *
 * Beehiiv
 * ───────
 *   connectBeehiiv(creds)    validate + persist
 *   syncBeehiiv()            trigger full sync
 *   disconnectBeehiiv()      remove DB row
 *
 * Obsidian (Wave 2)
 * ─────────────────
 *   connectObsidian(creds)   validate + persist
 *   syncObsidian()           trigger full vault sync
 *   disconnectObsidian()     remove DB row
 *
 * All actions require an authenticated session (auth() throws if not).
 */

import { auth }               from '@clerk/nextjs/server';
import { db }                 from '@/db';
import { userConnectors }     from '@/db/schema';
import { eq, and }            from 'drizzle-orm';
import { revalidatePath }     from 'next/cache';
import { beehiivConnector }   from '@/lib/connectors/beehiiv';
import { obsidianConnector }  from '@/lib/connectors/obsidian';
import type { BeehiivCredentials }  from '@/lib/connectors/beehiiv';
import type { ObsidianCredentials } from '@/lib/connectors/obsidian';

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Beehiiv actions
// ─────────────────────────────────────────────────────────────────────────────

export async function connectBeehiiv(input: {
  apiKey:        string;
  publicationId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  const creds: BeehiivCredentials = { apiKey: input.apiKey, publicationId: input.publicationId };

  const valid = await beehiivConnector.validateCredentials(creds);
  if (!valid) return { ok: false, error: 'Invalid Beehiiv credentials' };

  await db
    .insert(userConnectors)
    .values({ userId, connectorId: 'beehiiv', credentials: creds as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [userConnectors.userId, userConnectors.connectorId],
      set: { credentials: creds as Record<string, unknown>, updatedAt: new Date() },
    });

  revalidatePath('/studio/settings');
  return { ok: true };
}

export async function syncBeehiivAction(): Promise<{
  ok: boolean;
  upserted?: number;
  error?: string;
}> {
  const userId = await requireUserId();

  const row = await db
    .select()
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.connectorId, 'beehiiv')
      )
    )
    .limit(1)
    .then((r) => r[0]);

  if (!row) return { ok: false, error: 'Beehiiv not connected' };

  const result = await beehiivConnector.sync(row.credentials as BeehiivCredentials);
  revalidatePath('/studio/settings');
  return { ok: result.success, upserted: result.upserted, error: result.errors?.[0] };
}

export async function disconnectBeehiiv(): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();

  await db
    .delete(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.connectorId, 'beehiiv')
      )
    );

  revalidatePath('/studio/settings');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Obsidian actions  (Wave 2)
// ─────────────────────────────────────────────────────────────────────────────

export async function connectObsidian(input: {
  repoUrl:        string;
  branch?:        string;
  githubToken:    string;
  webhookSecret?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();

  const creds: ObsidianCredentials = {
    repoUrl:       input.repoUrl,
    branch:        input.branch,
    githubToken:   input.githubToken,
    webhookSecret: input.webhookSecret,
  };

  const valid = await obsidianConnector.validateCredentials(creds);
  if (!valid) return { ok: false, error: 'Cannot reach the vault repository with these credentials' };

  await db
    .insert(userConnectors)
    .values({ userId, connectorId: 'obsidian', credentials: creds as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [userConnectors.userId, userConnectors.connectorId],
      set: { credentials: creds as Record<string, unknown>, updatedAt: new Date() },
    });

  revalidatePath('/studio/settings');
  return { ok: true };
}

export async function syncObsidian(): Promise<{
  ok: boolean;
  upserted?: number;
  deleted?:  number;
  error?: string;
}> {
  const userId = await requireUserId();

  const row = await db
    .select()
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.connectorId, 'obsidian')
      )
    )
    .limit(1)
    .then((r) => r[0]);

  if (!row) return { ok: false, error: 'Obsidian not connected' };

  const result = await obsidianConnector.sync(row.credentials as ObsidianCredentials);

  // Update the last-synced timestamp.
  await db
    .update(userConnectors)
    .set({ syncedAt: new Date() })
    .where(eq(userConnectors.id, row.id));

  revalidatePath('/studio/settings');
  return {
    ok:       result.success,
    upserted: result.upserted,
    deleted:  result.deleted,
    error:    result.errors?.[0],
  };
}

export async function disconnectObsidian(): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();

  await db
    .delete(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.connectorId, 'obsidian')
      )
    );

  revalidatePath('/studio/settings');
  return { ok: true };
}
