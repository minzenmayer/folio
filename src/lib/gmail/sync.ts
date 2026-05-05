// Thoughtbed · Gmail sync engine (Phase 13, 2026-05-04)
//
// Pulls newsletter messages from a connected Gmail account and persists
// them to gmail_messages with status='pending'. The user triages from
// /studio/insights — promote → embed + extractIdeas, dismiss → audit-only,
// snooze → temp-hide.
//
// Two paths:
//
//   · kickFirstGmailSync({ userId, accountId })
//     Initial backfill. messages.list with a category-narrowing query;
//     messages.get + classify each one; insert detected newsletters as
//     pending. Persists last_sync_at + lastHistoryId on the connector
//     account so the next pass can go incremental. Chunked at 25 messages
//     per call to stay under Vercel Hobby's 10s server-action cap.
//
//   · runIncrementalGmailSync({ userId, accountId })
//     users.history.list since lastHistoryId. If Google says the cursor
//     is too old (404), falls back to a fresh kickFirstGmailSync.
//     Cron path; safe to call repeatedly.
//
// Status semantics on the connector account:
//   metadata.lastHistoryId   — Gmail's mailbox-wide cursor.
//   metadata.syncCompletedAt — when the initial backfill drained.
//   lastSyncAt / lastSyncStatus / lastSyncCount — surfaced in the UI.

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  connectorAccounts,
  gmailMessages,
  type ConnectorAccount,
  type NewGmailMessage,
} from '@/db';
import {
  getOrRefreshAccessToken,
  listMessageIds,
  getMessage,
  parseGmailMessage,
  listHistory,
  GmailApiError,
} from '@/lib/gmail/api';
import { classify } from '@/lib/gmail/detection';
// Phase 14a (2026-05-04): per-(user, sender) allow/block rules. The
// classifyAndPersist hot path consults checkSenderRule before paying for
// parseGmailMessage. Block → drop. Allow → promote-on-ingest (embed +
// extractIdeas in the same write).
import { checkSenderRule } from '@/lib/gmail/sender-rules';

// ─── tunables ───────────────────────────────────────────

/**
 * Per-call ceiling. Initial backfill of a heavy inbox can have thousands
 * of matching messages; we process a chunk per server-action call and
 * persist progress. The cron + manual sync re-run drain the rest.
 */
const SYNC_CHUNK_LIMIT = 25;

/**
 * Max messages we pull from messages.list per page. Gmail caps at 500;
 * we go smaller to spread out request budget.
 */
const LIST_PAGE_SIZE = 100;

/**
 * Gmail search query for newsletter-shaped messages. category:promotions
 * + category:forums catches the bulk of them; we widen with a couple of
 * narrow tag/header filters. Each individual message still goes through
 * classify() — this query is a recall-not-precision filter.
 */
const NEWSLETTER_QUERY =
  'category:promotions OR category:forums OR list:* OR (in:inbox unsubscribe)';

// ─── types ──────────────────────────────────────────────

export type GmailAccountMetadata = {
  googleEmail?: string;
  googleUserId?: string;
  /** Gmail mailbox cursor for users.history.list. Null on first run / reconnect. */
  lastHistoryId?: string | null;
  /** When the initial backfill finished. Null until first complete pass. */
  syncCompletedAt?: string | null;
  /** Pagination cursor across the chunked first-sync. Cleared on completion. */
  pendingPageToken?: string | null;
  /** How many messages have been examined in the current first-sync pass. */
  pendingExamined?: number;
};

export type SyncOutcome = {
  examined: number;
  detected: number;
  inserted: number;
  done: boolean;
  newHistoryId?: string;
  errors: string[];
};

// ─── helpers ────────────────────────────────────────────

function getMeta(account: ConnectorAccount): GmailAccountMetadata {
  return (account.metadata ?? {}) as GmailAccountMetadata;
}

async function writeMeta(
  accountId: string,
  patch: Partial<GmailAccountMetadata>
): Promise<void> {
  // Read-modify-write — small surface, one connector_accounts row per
  // user, no contention.
  const [row] = await db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, accountId))
    .limit(1);
  if (!row) return;
  const merged: GmailAccountMetadata = {
    ...getMeta(row),
    ...patch,
  };
  await db
    .update(connectorAccounts)
    .set({ metadata: merged, updatedAt: new Date() })
    .where(eq(connectorAccounts.id, accountId));
}

async function writeSyncStatus(
  accountId: string,
  patch: {
    status?: string;
    lastSyncStatus?: string;
    lastSyncError?: string | null;
    lastSyncCount?: number;
    bumpLastSyncAt?: boolean;
  }
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status) set.status = patch.status;
  if (patch.lastSyncStatus !== undefined)
    set.lastSyncStatus = patch.lastSyncStatus;
  if (patch.lastSyncError !== undefined) set.lastSyncError = patch.lastSyncError;
  if (patch.lastSyncCount !== undefined) set.lastSyncCount = patch.lastSyncCount;
  if (patch.bumpLastSyncAt) set.lastSyncAt = new Date();
  await db
    .update(connectorAccounts)
    .set(set)
    .where(eq(connectorAccounts.id, accountId));
}

// ─── persistence ────────────────────────────────────────

/**
 * Insert a chunk of detected newsletter messages with status='pending'.
 * Idempotent on (user_id, external_id) — re-runs of the same chunk
 * (e.g. cron retrying after a partial failure) skip duplicates.
 */
async function persistDetected(input: {
  userId: string;
  accountId: string;
  rows: NewGmailMessage[];
}): Promise<number> {
  if (input.rows.length === 0) return 0;
  const result = await db
    .insert(gmailMessages)
    .values(input.rows)
    .onConflictDoNothing({
      target: [gmailMessages.userId, gmailMessages.externalId],
    })
    .returning({ id: gmailMessages.id });
  return result.length;
}

/**
 * Run classification + persist for a list of message ids. Returns
 * counts. Errors per-message are swallowed (logged) so one malformed
 * message doesn't break the chunk.
 *
 * Phase 14a (2026-05-04): the sender-rule precheck runs BEFORE we burn
 * a getMessage round-trip. We need the from-address to evaluate, so we
 * still fetch the message — but if the rule is 'block' the message
 * never enters gmail_messages and never embeds. If the rule is 'allow'
 * the message lands as status='promoted' on insert and we synchronously
 * embed + fire extractIdeasFromGmailMessage in the same pass.
 */
async function classifyAndPersist(input: {
  userId: string;
  accountId: string;
  accessToken: string;
  ids: string[];
}): Promise<{ examined: number; detected: number; inserted: number; errors: string[] }> {
  const errors: string[] = [];
  const pendingRows: NewGmailMessage[] = [];
  const allowlistedRows: NewGmailMessage[] = [];

  for (const id of input.ids) {
    try {
      const raw = await getMessage({
        accessToken: input.accessToken,
        messageId: id,
      });
      const parsed = parseGmailMessage(raw);

      // Phase 14a precheck. We need parsed.fromAddress to evaluate, so
      // the rule check happens AFTER parseGmailMessage. The hot path is
      // still: rule lookup is one short query that hits a partial index.
      const preCheckedRule = await checkSenderRule(
        input.userId,
        parsed.fromAddress
      );
      const det = classify(parsed, { preCheckedRule });
      if (!det.isNewsletter) continue;

      const baseRow: NewGmailMessage = {
        userId: input.userId,
        connectorAccountId: input.accountId,
        externalId: parsed.externalId,
        threadId: parsed.threadId,
        fromAddress: parsed.fromAddress,
        fromName: parsed.fromName,
        subject: parsed.subject,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        bodyClean: parsed.bodyText,
        postedAt: new Date(parsed.internalDateMs),
        newsletterKind: det.kind,
        status: 'pending',
        raw: raw as unknown as Record<string, unknown>,
      };

      if (det.kind === 'allowlisted') {
        // Allowlisted = bypass triage. Embed inline so the message is
        // retrievable in Reflect on the same insert. extractIdeas fires
        // after the row insert below (we need the inserted row's id).
        const text = (parsed.bodyText ?? '').trim();
        let embedding: number[] | undefined;
        if (text.length >= 200) {
          try {
            const { embedText } = await import('@/lib/embed');
            embedding = await embedText(text);
          } catch (err) {
            // Best-effort — promote still proceeds without embedding.
            // The user can manually re-embed via re-promote later.
            console.warn(
              '[gmail:auto-promote] embed failed',
              parsed.externalId,
              err
            );
          }
        }
        allowlistedRows.push({
          ...baseRow,
          status: 'promoted',
          promotedAt: new Date(),
          embedding,
        });
      } else {
        pendingRows.push(baseRow);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`get/${id}: ${msg.slice(0, 120)}`);
    }
  }

  // Persist pending rows first (the bulk path). onConflictDoNothing
  // returns only the rows we actually inserted.
  const insertedPending = await persistDetected({
    userId: input.userId,
    accountId: input.accountId,
    rows: pendingRows,
  });

  // Persist allowlisted rows + capture their ids so we can fire
  // extractIdeas with the correct gmailMessageId. Same idempotency
  // guard — re-runs of the same chunk skip duplicates.
  let insertedAllowlisted = 0;
  const insertedAllowlistedRows: Array<{ id: string; subject: string | null; bodyText: string | null; postedAt: Date | null }> = [];
  if (allowlistedRows.length > 0) {
    const inserted = await db
      .insert(gmailMessages)
      .values(allowlistedRows)
      .onConflictDoNothing({
        target: [gmailMessages.userId, gmailMessages.externalId],
      })
      .returning({
        id: gmailMessages.id,
        subject: gmailMessages.subject,
        bodyText: gmailMessages.bodyText,
        postedAt: gmailMessages.postedAt,
      });
    insertedAllowlisted = inserted.length;
    insertedAllowlistedRows.push(...inserted);
  }

  // Fire extractIdeas for each freshly-inserted allowlisted row.
  // Best-effort — failures here log + continue (the row is already
  // promoted; the user can re-promote later to retry extraction).
  if (insertedAllowlistedRows.length > 0) {
    const { extractIdeasFromGmailMessage } = await import('@/lib/extract-ideas');
    for (const row of insertedAllowlistedRows) {
      const text = (row.bodyText ?? '').trim();
      if (text.length < 200) continue;
      try {
        await extractIdeasFromGmailMessage({
          userId: input.userId,
          messageId: row.id,
          title: row.subject ?? '(no subject)',
          bodyText: text,
          webUrl: null,
          postedAt: row.postedAt?.toISOString() ?? null,
        });
      } catch (err) {
        console.warn('[gmail:auto-promote] extractIdeas failed', row.id, err);
      }
    }
  }

  return {
    examined: input.ids.length,
    detected: pendingRows.length + allowlistedRows.length,
    inserted: insertedPending + insertedAllowlisted,
    errors,
  };
}

// ─── kickFirstGmailSync ─────────────────────────────────

/**
 * Initial backfill — chunked. Each call processes up to SYNC_CHUNK_LIMIT
 * messages and saves a pageToken so the next call resumes. When
 * pageToken is null we mark syncCompletedAt + capture the current
 * historyId for incremental sync.
 *
 * Called from:
 *   · /api/connectors/gmail/callback after the OAuth handoff (one chunk)
 *   · the manual "Sync now" button on the GmailCard
 *   · /api/cron/gmail-sync as a backstop until the first sync completes
 */
export async function kickFirstGmailSync(input: {
  userId: string;
  accountId: string;
}): Promise<SyncOutcome> {
  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.id, input.accountId),
        eq(connectorAccounts.userId, input.userId)
      )
    )
    .limit(1);

  if (!account) {
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: true,
      errors: ['account not found'],
    };
  }

  const meta = getMeta(account);
  const errors: string[] = [];

  let accessToken: string;
  try {
    accessToken = await getOrRefreshAccessToken(account);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncStatus(input.accountId, {
      lastSyncStatus: 'auth_failed',
      lastSyncError: msg.slice(0, 500),
      bumpLastSyncAt: true,
    });
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: false,
      errors: [msg],
    };
  }

  // List one page (capped at SYNC_CHUNK_LIMIT to stay under 10s).
  let listRes;
  try {
    listRes = await listMessageIds({
      accessToken,
      query: NEWSLETTER_QUERY,
      maxResults: SYNC_CHUNK_LIMIT,
      pageToken: meta.pendingPageToken ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncStatus(input.accountId, {
      lastSyncStatus: 'error',
      lastSyncError: msg.slice(0, 500),
      bumpLastSyncAt: true,
    });
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: false,
      errors: [msg],
    };
  }

  const ids = (listRes.messages ?? []).map((m) => m.id);

  const { examined, detected, inserted, errors: classifyErrors } =
    await classifyAndPersist({
      userId: input.userId,
      accountId: input.accountId,
      accessToken,
      ids,
    });
  errors.push(...classifyErrors);

  const nextPageToken = listRes.nextPageToken ?? null;
  const examinedSoFar = (meta.pendingExamined ?? 0) + examined;
  const done = !nextPageToken;

  // On done, capture historyId from the most recent message we saw so
  // future incremental syncs have a starting cursor. messages.list does
  // not return historyIds; we read it from a single messages.get if we
  // didn't see any in this chunk.
  let newHistoryId: string | undefined;
  if (done) {
    if (ids.length > 0) {
      try {
        const latest = await getMessage({
          accessToken,
          messageId: ids[0],
          format: 'minimal',
        });
        newHistoryId = latest.historyId ?? undefined;
      } catch (err) {
        errors.push(
          `historyId fetch: ${(err as Error).message?.slice(0, 120) ?? 'unknown'}`
        );
      }
    }
  }

  await writeMeta(input.accountId, {
    pendingPageToken: nextPageToken,
    pendingExamined: done ? 0 : examinedSoFar,
    syncCompletedAt: done ? new Date().toISOString() : null,
    lastHistoryId: newHistoryId ?? meta.lastHistoryId ?? null,
  });

  await writeSyncStatus(input.accountId, {
    status: 'connected',
    lastSyncStatus: errors.length === 0 ? 'ok' : 'partial',
    lastSyncError: errors.length === 0 ? null : errors.slice(0, 3).join(' | ').slice(0, 500),
    lastSyncCount: examinedSoFar,
    bumpLastSyncAt: true,
  });

  return {
    examined,
    detected,
    inserted,
    done,
    newHistoryId,
    errors,
  };
}

// ─── runIncrementalGmailSync ────────────────────────────

/**
 * Diff-based sync via users.history.list. Cheaper than re-listing every
 * day. Falls back to kickFirstGmailSync if the cursor is too old (Gmail
 * keeps history ~30 days) or missing.
 */
export async function runIncrementalGmailSync(input: {
  userId: string;
  accountId: string;
}): Promise<SyncOutcome> {
  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.id, input.accountId),
        eq(connectorAccounts.userId, input.userId)
      )
    )
    .limit(1);

  if (!account) {
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: true,
      errors: ['account not found'],
    };
  }

  const meta = getMeta(account);

  // No cursor — initial backfill hasn't finished. Defer to first-sync.
  if (!meta.lastHistoryId || !meta.syncCompletedAt) {
    return kickFirstGmailSync(input);
  }

  let accessToken: string;
  try {
    accessToken = await getOrRefreshAccessToken(account);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncStatus(input.accountId, {
      lastSyncStatus: 'auth_failed',
      lastSyncError: msg.slice(0, 500),
      bumpLastSyncAt: true,
    });
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: false,
      errors: [msg],
    };
  }

  // Page through history.list, accumulating new message ids. Bounded
  // by SYNC_CHUNK_LIMIT examined messages to keep within timeout.
  const newIds: string[] = [];
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  let iterations = 0;
  try {
    do {
      const page = await listHistory({
        accessToken,
        startHistoryId: meta.lastHistoryId,
        pageToken,
        maxResults: 100,
      });
      latestHistoryId = page.historyId ?? latestHistoryId;
      for (const rec of page.history ?? []) {
        for (const added of rec.messagesAdded ?? []) {
          if (added.message?.id && !newIds.includes(added.message.id)) {
            newIds.push(added.message.id);
          }
        }
      }
      pageToken = page.nextPageToken;
      iterations += 1;
    } while (pageToken && newIds.length < SYNC_CHUNK_LIMIT && iterations < 5);
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      // History cursor expired (>30 days) — re-bootstrap.
      await writeMeta(input.accountId, { lastHistoryId: null, syncCompletedAt: null });
      return kickFirstGmailSync(input);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncStatus(input.accountId, {
      lastSyncStatus: 'error',
      lastSyncError: msg.slice(0, 500),
      bumpLastSyncAt: true,
    });
    return {
      examined: 0,
      detected: 0,
      inserted: 0,
      done: false,
      errors: [msg],
    };
  }

  const idsToFetch = newIds.slice(0, SYNC_CHUNK_LIMIT);
  const result = await classifyAndPersist({
    userId: input.userId,
    accountId: input.accountId,
    accessToken,
    ids: idsToFetch,
  });

  // Advance the cursor only after successful drain. If history.list
  // returned its own historyId, prefer that; else use the newest
  // message's historyId.
  let nextCursor = latestHistoryId ?? meta.lastHistoryId;
  if (!latestHistoryId && idsToFetch.length > 0) {
    try {
      const latest = await getMessage({
        accessToken,
        messageId: idsToFetch[0],
        format: 'minimal',
      });
      if (latest.historyId) nextCursor = latest.historyId;
    } catch {
      // best-effort
    }
  }

  await writeMeta(input.accountId, { lastHistoryId: nextCursor });
  await writeSyncStatus(input.accountId, {
    status: 'connected',
    lastSyncStatus: result.errors.length === 0 ? 'ok' : 'partial',
    lastSyncError:
      result.errors.length === 0
        ? null
        : result.errors.slice(0, 3).join(' | ').slice(0, 500),
    lastSyncCount: result.examined,
    bumpLastSyncAt: true,
  });

  return {
    examined: result.examined,
    detected: result.detected,
    inserted: result.inserted,
    done: idsToFetch.length === newIds.length,
    newHistoryId: nextCursor,
    errors: result.errors,
  };
}

// ─── counts ─────────────────────────────────────────────

export async function countGmailMessagesByStatus(input: {
  userId: string;
}): Promise<{ pending: number; promoted: number; dismissed: number; snoozed: number; total: number }> {
  const rows = await db
    .select({
      status: gmailMessages.status,
      count: sql<number>`count(*)::int`,
    })
    .from(gmailMessages)
    .where(eq(gmailMessages.userId, input.userId))
    .groupBy(gmailMessages.status);

  const out = { pending: 0, promoted: 0, dismissed: 0, snoozed: 0, total: 0 };
  for (const r of rows) {
    if (r.status === 'pending') out.pending = r.count;
    else if (r.status === 'promoted') out.promoted = r.count;
    else if (r.status === 'dismissed') out.dismissed = r.count;
    else if (r.status === 'snoozed') out.snoozed = r.count;
    out.total += r.count;
  }
  return out;
}
