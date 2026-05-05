// Thoughtbed · GmailMessageRow (Phase 13, refreshed Phase 14a)
//
// Phase 14a refresh #2 (2026-05-04): three primary actions stacked, with
// a "..." overflow menu for surgical extras.
//
//   · Promote to Garden — embed + extractIdeas, status='promoted'.
//   · Ignore From Sender — adds a block-domain rule AND cascade-dismisses
//                          every pending/snoozed message from the same
//                          domain. One click clears the queue of repeat
//                          offenders. (Replaces the previous "click block,
//                          then realize the existing pending messages stayed"
//                          dead end.)
//   · Skip This One — dismiss only this message; leaves siblings alone.
//   · "..."           — surgical actions:
//                       Always keep from <addr>     (allow rule, exact match)
//                       Never show from <addr>      (block rule, exact match)
//                       Snooze 30 days              (status='snoozed')
//
// Auto-suggested rules banner stays for the PROMOTE side ("you've added 4
// from this domain — always allow?"). It's gone from the dismiss side
// because Ignore From Sender now does what the suggestion was suggesting,
// in one click, without an extra confirmation step.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  triageGmailMessage,
  addGmailRule,
  ignoreGmailSender,
  type TriageSuggestion,
} from '../settings/connectors/actions';

const KIND_CHIP: Record<string, string> = {
  detected_substack: 'Substack',
  detected_beehiiv: 'Beehiiv',
  detected_mailchimp: 'Mailchimp',
  detected_convertkit: 'ConvertKit',
  detected_ghost: 'Ghost',
  detected_buttondown: 'Buttondown',
  list_unsubscribe: 'Mailing list',
  subject_keyword: 'Subject match',
  allowlisted: 'Allowlisted',
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

function domainOf(addr: string | null): string | null {
  if (!addr || !addr.includes('@')) return null;
  return addr.split('@')[1].toLowerCase().trim() || null;
}

type Toast = { kind: 'info' | 'success' | 'error'; text: string };

export function GmailMessageRow({ row }: GmailMessageRowProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [suggestion, setSuggestion] = useState<TriageSuggestion | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (
        menuWrapRef.current &&
        !menuWrapRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  // Auto-fade toast after 6s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  function fire(action: 'promote' | 'dismiss' | 'snooze') {
    setMenuOpen(false);
    setSuggestionDismissed(false);
    startTransition(async () => {
      const res = await triageGmailMessage({
        messageId: row.id,
        action,
        ...(action === 'snooze' ? { snoozeDays: 30 } : {}),
      });
      if (!res.ok) {
        console.warn('[gmail:triage]', res.message);
        setToast({ kind: 'error', text: res.message });
        router.refresh();
        return;
      }
      // Post-promote toast surfaces extractedCount when present.
      if (action === 'promote') {
        const n = res.extractedCount ?? 0;
        setToast({
          kind: 'success',
          text:
            n > 0
              ? `Added. ${n} idea${n === 1 ? '' : 's'} pulled from this — review them in the Ideas tab.`
              : 'Added to your garden.',
        });
      }
      // Suggestion banner: only render the promote-side suggestion now.
      // The dismiss-side suggestion got replaced by the explicit "Ignore
      // From Sender" primary button.
      if (res.suggestion && res.suggestion.type === 'allow_domain') {
        setSuggestion(res.suggestion);
      }
      router.refresh();
    });
  }

  function ignoreSender() {
    setMenuOpen(false);
    setSuggestionDismissed(false);
    startTransition(async () => {
      const res = await ignoreGmailSender({ messageId: row.id });
      if (!res.ok) {
        setToast({ kind: 'error', text: res.message });
        router.refresh();
        return;
      }
      const n = res.dismissedCount;
      const ruleNote = res.ruleAdded
        ? `Future newsletters from ${res.domain} will be skipped.`
        : `${res.domain} was already on your block list.`;
      setToast({
        kind: 'info',
        text:
          n > 1
            ? `Ignored. Removed ${n} messages from ${res.domain}. ${ruleNote}`
            : `Ignored. ${ruleNote}`,
      });
      router.refresh();
    });
  }

  function addRule(args: {
    senderAddress?: string;
    senderDomain?: string;
    action: 'allow' | 'block';
    reason?: 'manual' | 'auto_suggested';
  }) {
    setMenuOpen(false);
    startTransition(async () => {
      const res = await addGmailRule(args);
      if (!res.ok) {
        setToast({ kind: 'error', text: res.message });
        return;
      }
      setToast({ kind: 'info', text: res.message ?? 'Rule added.' });
      setSuggestion(null);
      router.refresh();
    });
  }

  const sender = (row.fromName ?? row.fromAddress ?? 'unknown sender').trim();
  const subject = (row.subject ?? '(no subject)').trim();
  const preview = (row.snippet ?? row.bodyText ?? '').trim();
  const previewClipped =
    preview.length > 240 ? preview.slice(0, 237).trimEnd() + '…' : preview;
  const kindChip = KIND_CHIP[row.newsletterKind] ?? row.newsletterKind;
  const fromAddrLower = (row.fromAddress ?? '').trim().toLowerCase();
  const senderDomain = domainOf(row.fromAddress);

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
        <div className="flex flex-col gap-2 shrink-0 items-stretch min-w-[160px]">
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('promote')}
            className="font-mono text-[10px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40 whitespace-nowrap text-center"
          >
            Promote to Garden
          </button>
          <button
            type="button"
            disabled={pending || !senderDomain}
            onClick={ignoreSender}
            title={
              senderDomain
                ? `Block ${senderDomain} and clear any other pending messages from it`
                : 'No sender domain to block'
            }
            className="font-mono text-[10px] tracking-[0.18em] uppercase rounded-soft px-3 py-1.5 border border-rule text-ink-soft hover:border-ink hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap text-center"
          >
            Ignore From Sender
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('dismiss')}
            className="font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap text-center"
          >
            Skip This One
          </button>
          <div ref={menuWrapRef} className="relative self-end">
            <button
              type="button"
              disabled={pending}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              className="font-mono text-[14px] tracking-[0.04em] text-tag hover:text-ink transition-colors disabled:opacity-40 px-2 py-0.5"
            >
              ···
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 bg-paper border border-rule rounded-[3px] shadow-lg z-20 min-w-[260px] overflow-hidden"
              >
                {fromAddrLower && (
                  <MenuItem
                    onClick={() =>
                      addRule({
                        senderAddress: fromAddrLower,
                        action: 'allow',
                      })
                    }
                    label={`Always keep from ${fromAddrLower}`}
                  />
                )}
                {fromAddrLower && (
                  <MenuItem
                    onClick={() =>
                      addRule({
                        senderAddress: fromAddrLower,
                        action: 'block',
                      })
                    }
                    label={`Never show from ${fromAddrLower}`}
                  />
                )}
                <MenuDivider />
                <MenuItem
                  onClick={() => fire('snooze')}
                  label="Snooze 30 days"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className={`mt-3 rounded-[3px] border px-3 py-2 font-sans text-[12.5px] leading-[1.5] ${
            toast.kind === 'error'
              ? 'border-accent text-accent'
              : 'border-rule text-ink-soft bg-paper-2/60'
          }`}
        >
          {toast.text}
        </div>
      )}

      {suggestion && !suggestionDismissed && (
        <SuggestionBanner
          suggestion={suggestion}
          pending={pending}
          onAdd={() =>
            addRule({
              senderDomain: suggestion.target,
              action: suggestion.type === 'block_domain' ? 'block' : 'allow',
              reason: 'auto_suggested',
            })
          }
          onDismiss={() => setSuggestionDismissed(true)}
        />
      )}
    </li>
  );
}

function SuggestionBanner({
  suggestion,
  pending,
  onAdd,
  onDismiss,
}: {
  suggestion: TriageSuggestion;
  pending: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const isBlock = suggestion.type === 'block_domain';
  const ask = isBlock
    ? `You've skipped ${suggestion.count} messages from ${suggestion.target}. Stop showing future newsletters from this domain?`
    : `You've added ${suggestion.count} messages from ${suggestion.target} to your garden. Always keep newsletters from this domain?`;
  const cta = isBlock ? 'Block this domain' : 'Allow this domain';
  return (
    <div
      role="region"
      aria-label="Sender rule suggestion"
      className="mt-3 rounded-[3px] border border-ink/40 bg-paper-2/40 px-3 py-2.5 flex items-start gap-3 flex-wrap"
    >
      <p className="font-sans text-[12.5px] leading-[1.5] text-ink-soft flex-1 min-w-[200px]">
        {ask}
      </p>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onAdd}
          disabled={pending}
          className="font-mono text-[10px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {cta}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={pending}
          className="font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="block w-full text-left px-4 py-2 font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:bg-paper-2 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="border-t border-rule" aria-hidden="true" />;
}
