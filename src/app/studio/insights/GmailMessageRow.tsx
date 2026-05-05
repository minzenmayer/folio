// Thoughtbed · GmailMessageRow (Phase 13, 2026-05-04 — refreshed Phase 14a)
//
// Triage row for a single pending Gmail newsletter. Mirrors InsightRow's
// shape but with gmail-specific metadata: from-line, subject, snippet,
// detection_kind chip.
//
// Phase 14a (2026-05-04) refresh:
//   · Promote → renamed "Add to garden". Same primary-button styling.
//   · Snooze  → dropped from the primary buttons. Lives in the "..."
//                overflow menu as "Snooze 30d".
//   · Dismiss → renamed "Skip". Stays as the text-link tertiary action.
//   · "..." overflow menu (Phase 14a Feature 1) wires the per-row sender
//                rules: allow this address, block this address, block
//                this domain. Plus the Snooze 30d action.
//   · Post-promote toast surfaces extractedCount when the action returns
//                the new shape ("Added. 3 ideas pulled from this — review
//                them in the Ideas tab.").
//   · Auto-suggested rules banner: when the action result carries a
//                `suggestion`, we render an inline banner under the row
//                with one-click "Add rule" / "Not now".

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  triageGmailMessage,
  addGmailRule,
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
      if (res.suggestion) {
        setSuggestion(res.suggestion);
      }
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
      // Clear any visible suggestion — the user just acted on it (or
      // adopted equivalent wording).
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
        <div className="flex flex-col gap-2 shrink-0 items-end">
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('promote')}
            className="font-mono text-[10px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Add to garden
          </button>
          <div ref={menuWrapRef} className="relative">
            <button
              type="button"
              disabled={pending}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              className="font-mono text-[12px] tracking-[0.04em] rounded-soft px-3 py-1.5 border border-rule text-ink-soft hover:border-ink hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap"
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
                {senderDomain && (
                  <MenuItem
                    onClick={() =>
                      addRule({
                        senderDomain,
                        action: 'block',
                      })
                    }
                    label={`Never show from ${senderDomain}`}
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
          <button
            type="button"
            disabled={pending}
            onClick={() => fire('dismiss')}
            className="font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Skip
          </button>
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
