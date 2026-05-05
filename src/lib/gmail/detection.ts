// Thoughtbed · Newsletter detection ladder (Phase 13, 2026-05-04)
//
// classify(parsed, opts?) → { isNewsletter, kind } using a priority ladder.
// First hit wins. We deliberately under-ingest in v1: a false positive
// pollutes the corpus more than a false negative because the user has to
// actively dismiss it. Triage absorbs the rest of the noise.
//
// Phase 14a (2026-05-04) added the sender-rule short-circuit. The sync
// engine looks up checkSenderRule(userId, fromAddress) before it parses
// the message and passes the result here as opts.preCheckedRule:
//   · 'block'  → classify() returns { isNewsletter: false, kind: null }.
//                The message never lands in gmail_messages.
//   · 'allow'  → classify() returns { isNewsletter: true, kind: 'allowlisted' }.
//                The sync engine inserts as status='promoted' + embeds + extracts
//                in the same write.
//   · null     → fall through to the regular detection ladder below.
//
// Order of the regular ladder matters:
//   1. Sender domain matches a known newsletter platform → strongest.
//   2. Sender's local-part looks listy AND the message has a List-Unsubscribe
//      header → strong (RFC 8058 / RFC 2369 both signal mailing lists).
//   3. List-Unsubscribe header alone → strong but a bit noisier.
//   4. Subject keyword tiebreaker — never enough on its own; promotes a
//      List-Unsubscribe-only hit's confidence but doesn't trigger ingest
//      by itself in v1. (Per Payton: under-ingest, triage covers gaps.)

import type { ParsedGmailMessage } from '@/lib/gmail/api';
import type { SenderRuleResult } from '@/lib/gmail/sender-rules';

// ─── kinds ──────────────────────────────────────────────

export type NewsletterDetectionKind =
  | 'detected_substack'
  | 'detected_beehiiv'
  | 'detected_mailchimp'
  | 'detected_convertkit'
  | 'detected_ghost'
  | 'detected_buttondown'
  | 'list_unsubscribe'
  | 'subject_keyword'
  // Phase 14a (2026-05-04): the message hit a user-defined allowlist rule.
  // Bypasses the regular ladder entirely; the sync engine treats it as
  // promoted-on-ingest.
  | 'allowlisted';

export type DetectionResult =
  | { isNewsletter: true; kind: NewsletterDetectionKind }
  | { isNewsletter: false; kind: null };

// ─── platform table ─────────────────────────────────────

/**
 * Map of (substring of from-address domain or local-part) → detection
 * kind. Covers the major newsletter platforms. Subdomains count: a
 * sender like `noreply@send.lennysnewsletter.com` from Substack still
 * matches `substack.com` if the sending domain is theirs, but most
 * platforms send via their own domain (substack.com, mail.beehiiv.com,
 * etc.).
 *
 * We match against the full from-address and the domain portion both —
 * a sender like `bounce+foo@bounce.beehiiv.com` matches via domain.
 */
const PLATFORM_MATCHES: Array<{
  needle: string;
  kind: NewsletterDetectionKind;
}> = [
  { needle: 'substack.com', kind: 'detected_substack' },
  { needle: 'beehiiv.com', kind: 'detected_beehiiv' },
  { needle: 'mailchimp.com', kind: 'detected_mailchimp' },
  { needle: 'mail.mailchimp.com', kind: 'detected_mailchimp' },
  { needle: 'mailchi.mp', kind: 'detected_mailchimp' },
  { needle: 'convertkit.com', kind: 'detected_convertkit' },
  { needle: 'convertkit-mail2.com', kind: 'detected_convertkit' },
  { needle: 'ck.page', kind: 'detected_convertkit' },
  { needle: 'kit.com', kind: 'detected_convertkit' },
  { needle: 'ghost.org', kind: 'detected_ghost' },
  { needle: 'ghost.io', kind: 'detected_ghost' },
  { needle: 'buttondown.email', kind: 'detected_buttondown' },
  { needle: 'buttondown.com', kind: 'detected_buttondown' },
];

/**
 * Local-part fragments that suggest the sender is automated/list-based.
 * Used as a softener: combined with a List-Unsubscribe header, this is
 * enough to flag. Alone, never enough.
 */
const LISTY_LOCAL_FRAGMENTS = [
  'noreply',
  'no-reply',
  'donotreply',
  'newsletter',
  'list',
  'updates',
  'digest',
  'mailer',
  'notifications',
];

/** Subject keywords that hint at newsletter content. Tiebreaker only. */
const SUBJECT_KEYWORDS = [
  'newsletter',
  'issue ',
  'issue #',
  'weekly digest',
  'daily digest',
  'this week',
  'monthly roundup',
];

// ─── classify ───────────────────────────────────────────

/**
 * Classify a parsed Gmail message. Optionally short-circuit on a
 * pre-checked sender rule (Phase 14a) — when supplied, the rule wins
 * over the regular detection ladder.
 */
export function classify(
  msg: ParsedGmailMessage,
  opts?: { preCheckedRule?: SenderRuleResult }
): DetectionResult {
  // Phase 14a sender-rule short-circuit. A 'block' result aborts ingest
  // entirely; 'allow' surfaces as the 'allowlisted' detection kind so
  // downstream (the sync engine) can pick it up and auto-promote.
  if (opts?.preCheckedRule === 'block') {
    return { isNewsletter: false, kind: null };
  }
  if (opts?.preCheckedRule === 'allow') {
    return { isNewsletter: true, kind: 'allowlisted' };
  }

  const fromAddr = (msg.fromAddress ?? '').toLowerCase();
  const fromDomain = fromAddr.includes('@') ? fromAddr.split('@')[1] : '';
  const localPart = fromAddr.includes('@') ? fromAddr.split('@')[0] : '';
  const subject = (msg.subject ?? '').toLowerCase();
  const listUnsubscribe = (msg.headers['list-unsubscribe'] ?? '').trim();
  const listId = (msg.headers['list-id'] ?? '').trim();
  const precedence = (msg.headers['precedence'] ?? '').trim().toLowerCase();

  // ─── 1. Platform sender domain ───────────────────────
  for (const { needle, kind } of PLATFORM_MATCHES) {
    if (fromDomain.includes(needle) || fromAddr.endsWith(`@${needle}`)) {
      return { isNewsletter: true, kind };
    }
  }

  // ─── 2/3. List-Unsubscribe / List-Id / bulk precedence ───
  // Per RFC 8058 these headers are the canonical mailing-list signal.
  // 'precedence: bulk|list' is older but still seen (Mailman, etc.).
  const hasListSignal =
    listUnsubscribe.length > 0 ||
    listId.length > 0 ||
    precedence === 'bulk' ||
    precedence === 'list';

  if (hasListSignal) {
    // We don't currently care which signal — collapse all to one kind.
    // The detection_kind audit on the row records 'list_unsubscribe'
    // even when the trigger was List-Id; we can split later if it
    // matters for false-positive analysis.
    return { isNewsletter: true, kind: 'list_unsubscribe' };
  }

  // ─── 4. Listy local-part by itself: not enough.
  // Subject keyword by itself: not enough either. Both together: still
  // a soft signal but not enough in v1. Per Payton's under-ingest call,
  // we drop these on the floor — triage layer can be tuned later.
  const hasListyLocal = LISTY_LOCAL_FRAGMENTS.some((f) =>
    localPart.includes(f)
  );
  const hasSubjectKeyword = SUBJECT_KEYWORDS.some((kw) => subject.includes(kw));

  // Reserved for later: if we want to widen the funnel without rewriting,
  // flip this branch to return { isNewsletter: true, kind: 'subject_keyword' }
  // when both soft signals fire.
  void hasListyLocal;
  void hasSubjectKeyword;

  return { isNewsletter: false, kind: null };
}
