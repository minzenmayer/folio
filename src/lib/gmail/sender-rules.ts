// Thoughtbed · Gmail sender rules — runtime evaluation (Phase 14a, 2026-05-04)
//
// Companion to gmail_sender_rules. The detection ladder calls
// checkSenderRule() before parseGmailMessage so we can:
//   · drop blocked senders before we pay for parsing,
//   · short-circuit allowlisted senders into status='promoted' on insert.
//
// Lookup precedence: per-address rule beats per-domain rule. Within the
// same target, an explicit rule wins (we only ever store one rule per
// (user, target, action) tuple — the unique constraint enforces that).
//
// All inputs are lowercased before comparing — the table stores the
// canonical lowercase form (server actions normalize on insert).

import { eq, and, or, sql } from 'drizzle-orm';
import { db, gmailSenderRules } from '@/db';

export type SenderRuleAction = 'allow' | 'block';

export type SenderRuleResult = SenderRuleAction | null;

/**
 * Look up the strongest-applicable rule for (userId, fromAddress).
 * Per-address wins over per-domain. Returns null if no rule matches.
 *
 * Tolerant of malformed input — fromAddress missing or without @ → null.
 */
export async function checkSenderRule(
  userId: string,
  fromAddress: string | null | undefined
): Promise<SenderRuleResult> {
  const addr = (fromAddress ?? '').trim().toLowerCase();
  if (!addr || !addr.includes('@')) return null;
  const domain = addr.split('@')[1] ?? '';
  if (!domain) return null;

  // Single round-trip — fetch rules for this address OR domain. Then pick
  // the strongest-applicable in JS so we don't burn two queries.
  const rows = await db
    .select({
      action: gmailSenderRules.action,
      senderAddress: gmailSenderRules.senderAddress,
      senderDomain: gmailSenderRules.senderDomain,
    })
    .from(gmailSenderRules)
    .where(
      and(
        eq(gmailSenderRules.userId, userId),
        or(
          eq(gmailSenderRules.senderAddress, addr),
          eq(gmailSenderRules.senderDomain, domain)
        )
      )
    );

  if (rows.length === 0) return null;

  // Prefer per-address rule when present.
  const addrHit = rows.find((r) => r.senderAddress === addr);
  if (addrHit) return addrHit.action as SenderRuleAction;
  const domainHit = rows.find((r) => r.senderDomain === domain);
  return (domainHit?.action ?? null) as SenderRuleResult;
}

/**
 * Count how many gmail_messages this user has triaged into a given
 * status from the same sender_domain in the last `windowDays` days,
 * AND verify no rule already exists for that domain. Used by the
 * triage action to surface auto-suggestions.
 *
 * Returns null if no suggestion should fire (count too low, rule
 * already exists, no domain). Otherwise returns the count.
 */
export async function getDomainTriageStreakIfNoRule(input: {
  userId: string;
  fromAddress: string | null | undefined;
  triagedStatus: 'dismissed' | 'promoted';
  windowDays?: number;
  threshold?: number;
}): Promise<{ domain: string; count: number } | null> {
  const addr = (input.fromAddress ?? '').trim().toLowerCase();
  if (!addr || !addr.includes('@')) return null;
  const domain = addr.split('@')[1] ?? '';
  if (!domain) return null;

  // Bail early if a rule already exists for this domain in either action.
  // The user has already made a decision — no need to re-suggest.
  const existing = await db
    .select({ id: gmailSenderRules.id })
    .from(gmailSenderRules)
    .where(
      and(
        eq(gmailSenderRules.userId, input.userId),
        eq(gmailSenderRules.senderDomain, domain)
      )
    )
    .limit(1);
  if (existing.length > 0) return null;

  const windowDays = input.windowDays ?? 30;
  const threshold = input.threshold ?? 3;

  // Lazy-import gmailMessages to keep this module light.
  const { gmailMessages } = await import('@/db');

  // The streak is per-domain across distinct gmail_messages rows. We
  // pattern-match the from_address tail because we don't store a
  // separate domain column on gmail_messages.
  const [{ n = 0 } = {}] = (await db
    .select({
      n: sql<number>`count(*)::int`,
    })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.userId, input.userId),
        eq(gmailMessages.status, input.triagedStatus),
        // ILIKE on '%@nba.com' catches the domain regardless of casing
        // and ignores the local-part variation.
        sql`lower(${gmailMessages.fromAddress}) LIKE ${'%@' + domain}`,
        // Window: last `windowDays` days of triage activity. Use the
        // status timestamp matching the action.
        input.triagedStatus === 'dismissed'
          ? sql`${gmailMessages.dismissedAt} >= now() - (${windowDays} || ' days')::interval`
          : sql`${gmailMessages.promotedAt} >= now() - (${windowDays} || ' days')::interval`
      )
    )) as Array<{ n: number | null }>;

  const count = Number(n ?? 0);
  if (count < threshold) return null;
  return { domain, count };
}
