// Thoughtbed · GmailMessageRow (Phase 13, 2026-05-04)
//
// Triage row for a single pending Gmail newsletter. Mirrors InsightRow's
// shape but with gmail-specific metadata: from-line, subject, snippet,
// detection_kind chip. Promote / Dismiss / Snooze 30d call the
// triageGmailMessage server action.
//
// Promote fires the heavier path (embed + extractIdeas); the others are
// pure status flips.

'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { triageGmailMessage } from '../settings/connectors/actions';

const KIND_CHIP: Record<string, string> = {
  detected_substack: 'Substack',
  detected_beehiiv: 'Beehiiv',
  detected_mailchimp: 'Mailchimp',
  detected_convertkit: 'ConvertKit',
  detected_ghost: 'Ghost',
  detected_buttondown: 'Buttondown',
  list_unsubscribe: 'Mailing list',
  subject_keyword: 'Subject match',
};

export type GmailMessageRowProps = {
  row: {
    id: string;
    subject: string | null;
    fromAddress: string | null;
    fromName: string | null;
    snippet: string | null;
    bodyText: string | null;
    newsletterKind: string;
    status: string;
    postedAt: Date | string | null;
  };
};

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function GmailMessageRow({ row }: GmailMessageRowProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function fire(action: 'promote' | 'dismiss' | 'snooze') {
    startTransition(async () => {
      const res = await triageGmailMessage({
        messageId: row.id,
        action,
        ...(action === 'snooze' ? { snoozeDays: 30 } : {}),
      });
      if (!res.ok) {
        // Best-effort surface; the next refresh will show the row's
        // status anyway.
        console.warn('[gmail:triage]', res.message);
      }
      router.refresh();
    });
  }

  const sender = (row.fromName ?? row.fromAddress ?? 'unknown sender').trim();
  const subject = (row.subject ?? '(no subject)').trim();
  const preview = (row.snippet ?? row.bodyText ?? '').trim();
  const previewClipped =
    preview.length > 240 ? preview.slice(0, 237).trimEnd() + '…' : preview;
  const kindChip = KIND_CHIP[row.newsletterKind] ?? row.newsletterKind;

  return (
    <li className="px-5 py-5 sm:px-6 sm:py-6 hover:bg-paper-2/40 transition-colors">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag mb-1.5 flex items-center gap-2 flex-wrap">
            <span>{kindChip}</span>
            <span aria-hidden>·</span>
            <span className="truncate max-w-[40ch]">{sender}</span>
            {row.postedAt && (
              <>
                <span aria-hidden>·</span>
                <span>{fmtDate(row.postedAt)}</span>
              </>
            )}
          </div>
          <h3 className="font-sans text-[16px] font-semibold text-ink leading-snug mb-1.5 break-words">
            {subject}
          </h3>
          {previewClipped && (
            <p className="font-sans text-[13.5px] leading-[1.55] text-ink-soft break-words">
              {previewClipped}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('promote')}
            className="font-mono text-[10px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Promote
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('snooze')}
            className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-soft px-3 py-1.5 border border-rule text-ink-soft hover:border-ink hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Snooze
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('dismiss')}
            className="font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Dismiss
          </button>
        </div>
      </div>
    </li>
  );
}
