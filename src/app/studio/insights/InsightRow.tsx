// Thoughtbed · InsightRow — single triage row for the Insights queue.
// (Direction B, 2026-05-04)
//
// Renders the title + claim + evidence + source attribution we already
// had, plus per-row action buttons that go through the server actions
// in ./actions.ts. We keep the client surface tiny — three buttons,
// one transition, no local optimistic-UI tracking. Next's revalidatePath
// in each action repaints the parent layout so we read the new state
// from props rather than mirror it here.

'use client';

import Link from 'next/link';
import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  promoteInsight,
  dismissInsight,
  snoozeInsight,
  restoreInsight,
} from './actions';

type Row = {
  id: string;
  title: string;
  claim: string;
  evidence: string | null;
  depthSignal: number;
  breadthSignal: number;
  sourceKind: string;
  triageStatus: string;
  snoozeUntil: Date | string | null;
  newsletterTitle: string | null;
  newsletterUrl: string | null;
  obsidianTitle: string | null;
  obsidianPath: string | null;
  linkedinUrl: string | null;
  linkedinAuthor: string | null;
};

type View = 'pending' | 'promoted' | 'dismissed' | 'all';

export function InsightRow({ row, view }: { row: Row; view: View }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    router.refresh();
  }

  function fire(
    fn: typeof promoteInsight | typeof dismissInsight | typeof snoozeInsight | typeof restoreInsight
  ) {
    setError(null);
    startTransition(async () => {
      const res = await fn({ id: row.id });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      refresh();
    });
  }

  const sourceLabel =
    row.sourceKind === 'newsletter_issue'
      ? row.newsletterTitle
        ? `your newsletter · ${row.newsletterTitle}`
        : 'your newsletter'
      : row.sourceKind === 'obsidian_note'
        ? row.obsidianTitle
          ? `vault · ${row.obsidianTitle}`
          : 'vault'
        : row.sourceKind === 'linkedin_post'
          ? `your LinkedIn`
          : 'source';

  const sourceHref =
    row.sourceKind === 'newsletter_issue' && row.newsletterUrl
      ? row.newsletterUrl
      : row.sourceKind === 'linkedin_post' && row.linkedinUrl
        ? row.linkedinUrl
        : null;

  const isPending = row.triageStatus === 'pending';
  const isPromoted = row.triageStatus === 'promoted';
  const isDismissed = row.triageStatus === 'dismissed';
  const isSnoozed = row.triageStatus === 'snoozed';

  // Snoozed-but-ripe rows surface in the 'pending' view alongside truly
  // pending. Tag them so the user knows they were previously deferred.
  const snoozedAndRipe =
    isSnoozed &&
    row.snoozeUntil != null &&
    new Date(row.snoozeUntil).getTime() <= Date.now();

  return (
    <li className="py-6 px-6">
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h3 className="font-serif font-medium text-[20px] tracking-tight text-ink leading-tight">
          {row.title}
        </h3>
        <SignalBars depth={row.depthSignal} breadth={row.breadthSignal} />
        {/* State badges — only render when not the default */}
        {isPromoted && (
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-bg bg-ink rounded-full px-2 py-0.5">
            promoted
          </span>
        )}
        {isDismissed && (
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-2 py-0.5">
            dismissed
          </span>
        )}
        {isSnoozed && !snoozedAndRipe && (
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-2 py-0.5">
            snoozed
          </span>
        )}
        {snoozedAndRipe && (
          <span
            className="font-mono text-[9px] tracking-[0.22em] uppercase text-accent bg-paper-2 border border-rule rounded-full px-2 py-0.5"
            title="Snooze ended — back in your queue"
          >
            ripe
          </span>
        )}
      </div>

      <p className="font-sans text-[14.5px] leading-[1.6] text-ink-soft mb-3">
        {row.claim}
      </p>

      {row.evidence ? (
        <p className="font-sans text-[13px] leading-[1.55] text-tag italic mb-4">
          {row.evidence.length > 240
            ? row.evidence.slice(0, 240) + '…'
            : row.evidence}
        </p>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        {/* Action buttons — what's available depends on state */}
        {(isPending || isSnoozed) && (
          <>
            <button
              type="button"
              onClick={() => fire(promoteInsight)}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40"
              title="Move into the Garden as a seed Idea"
            >
              ↑ Promote
            </button>
            <button
              type="button"
              onClick={() => fire(snoozeInsight)}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-soft px-3 py-1.5 border border-rule text-ink-soft hover:text-ink hover:border-ink transition-colors disabled:opacity-40"
              title="Hide for 30 days, then resurface"
            >
              ⏱ Snooze
            </button>
            <button
              type="button"
              onClick={() => fire(dismissInsight)}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-soft px-3 py-1.5 text-tag hover:text-ink transition-colors disabled:opacity-40"
              title="Hide forever"
            >
              × Dismiss
            </button>
          </>
        )}

        {(isPromoted || isDismissed) && (
          <button
            type="button"
            onClick={() => fire(restoreInsight)}
            disabled={pending}
            className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-soft px-3 py-1.5 border border-rule text-tag hover:text-ink hover:border-ink transition-colors disabled:opacity-40"
            title="Send back to the pending queue"
          >
            Restore
          </button>
        )}

        <span className="ml-auto font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
          from{' '}
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-accent transition-colors"
            >
              {sourceLabel}
            </a>
          ) : (
            <span>{sourceLabel}</span>
          )}
        </span>
      </div>

      {error && (
        <p className="font-sans text-[12px] text-accent mt-2">{error}</p>
      )}
    </li>
  );
}

function SignalBars({ depth, breadth }: { depth: number; breadth: number }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`depth ${depth.toFixed(2)} · breadth ${breadth.toFixed(2)}`}
    >
      <span className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.16em] uppercase text-tag">
        <span>D</span>
        <span className="relative inline-block w-12 h-[3px] bg-rule rounded-full overflow-hidden">
          <span
            className="absolute inset-y-0 left-0 bg-ink"
            style={{ width: `${Math.round(depth * 100)}%` }}
          />
        </span>
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.16em] uppercase text-tag">
        <span>B</span>
        <span className="relative inline-block w-12 h-[3px] bg-rule rounded-full overflow-hidden">
          <span
            className="absolute inset-y-0 left-0 bg-ink"
            style={{ width: `${Math.round(breadth * 100)}%` }}
          />
        </span>
      </span>
    </span>
  );
}
