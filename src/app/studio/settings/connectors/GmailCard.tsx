// Thoughtbed · GmailCard (Phase 13, 2026-05-04)
//
// Mirrors LinkedinCard's five-state pattern for the Gmail OAuth connector.
//
// States:
//   1. disconnected         — Connect button (links to /api/connectors/gmail/initiate
//                             which kicks the OAuth round-trip via 302s).
//   2. connecting           — first sync chunk in flight after callback.
//                             Auto-polls every 30s; stops when syncCompletedAt sets.
//   3. connected, idle      — googleEmail + counts (pending/promoted) + last sync.
//                             Sync now / Disconnect.
//   4. connected, syncing   — same as #2 but surfaced via firstSyncInProgress.
//   5. error                — last_sync_error + Reconnect.
//
// The Connect button is intentionally a plain anchor, not a server
// action: server actions can't directly initiate a 302 redirect to a
// cross-origin URL, so the OAuth round-trip lives on a route handler.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  syncGmail,
  disconnectGmail,
  type GmailStatus,
} from './actions';

const SOFT_TIMEAGO = (iso: string | null): string => {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

// While first-sync chunks are draining we poll syncGmail every 30s. Each
// call processes another chunk + persists progress; the card re-renders
// from the server state and stops polling when syncCompletedAt sets.
const POLL_INTERVAL_MS = 30_000;

export function GmailCard({ initialStatus }: { initialStatus: GmailStatus }) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Auto-poll while first-sync is still chunking through.
  const isPending =
    initialStatus.kind === 'connected' && initialStatus.firstSyncInProgress;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isPending) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    pollTimerRef.current = setInterval(() => {
      // Best-effort. Errors surface on the next refresh.
      syncGmail()
        .then(() => router.refresh())
        .catch(() => {
          /* ignore */
        });
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isPending, router]);

  // Surface ?gmail_error and ?gmail_connected from the OAuth callback.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const err = params.get('gmail_error');
    const ok = params.get('gmail_connected');
    if (err) {
      const detail = params.get('gmail_message');
      setActionError(detail ? `${err}: ${detail}` : err);
      // Clean the URL so a refresh doesn't re-show.
      params.delete('gmail_error');
      params.delete('gmail_message');
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}?${params.toString()}`
      );
    } else if (ok) {
      setActionMessage('Connected. Pulling newsletters now — this can take a few minutes.');
      params.delete('gmail_connected');
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}?${params.toString()}`
      );
    }
  }, []);

  function refresh() {
    router.refresh();
  }

  function runSync() {
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await syncGmail();
      if (!res.ok) {
        setActionError(res.message ?? 'Sync failed.');
        return;
      }
      setActionMessage('Sync started.');
      refresh();
    });
  }

  function runDisconnect() {
    setActionError(null);
    setActionMessage(null);
    if (
      !window.confirm(
        'Disconnect Gmail? Existing messages stay in your triage queue; new newsletters won’t sync until you reconnect.'
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await disconnectGmail();
      if (!res.ok) {
        setActionError(res.message ?? 'Disconnect failed.');
        return;
      }
      setActionMessage('Disconnected.');
      refresh();
    });
  }

  // ─── render ────────────────────────────────────────────

  if (initialStatus.kind === 'disconnected') {
    return (
      <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
            aria-hidden
          >
            ✉
          </span>
          <div className="flex-1">
            <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
              Gmail
            </h3>
            <p className="font-sans text-[12px] text-tag mt-0.5">
              The newsletters you read — triage queue, then Reflect rail.
            </p>
          </div>
        </div>
        <p className="font-sans text-[13px] leading-[1.55] text-ink-soft">
          Connect Gmail (read-only) and Thoughtbed surfaces newsletters you
          subscribe to in a triage queue. Promote the ones you want to keep;
          they become part of your Reflect rail while you write.
        </p>
        <p className="font-mono text-[11px] tracking-[0.04em] text-tag">
          Read-only · Testing mode · only payton.minz@gmail.com
        </p>
        <div className="flex items-center gap-3 mt-1">
          <a
            href="/api/connectors/gmail/initiate"
            className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors no-underline inline-block"
          >
            Connect Gmail
          </a>
        </div>
        {actionError && (
          <p className="font-sans text-[12px] text-accent">{actionError}</p>
        )}
        {actionMessage && (
          <p className="font-sans text-[12px] text-tag">{actionMessage}</p>
        )}
      </li>
    );
  }

  // initialStatus.kind === 'connected' from here on.
  const { counts, googleEmail, lastSyncAt, lastSyncError } = initialStatus;

  return (
    <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
          aria-hidden
        >
          ✉
        </span>
        <div className="flex-1">
          <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
            Gmail
          </h3>
          {googleEmail && (
            <p className="font-sans text-[12px] text-tag mt-0.5 truncate">
              {googleEmail}
            </p>
          )}
        </div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-bg bg-ink rounded-full px-2.5 py-1">
          connected
        </span>
      </div>

      <div className="font-sans text-[13px] text-ink-soft">
        {counts.pending > 0
          ? `${counts.pending} pending in triage`
          : counts.total > 0
          ? `${counts.promoted} promoted · ${counts.total} total`
          : 'No newsletters detected yet.'}
        {' · last sync '}
        {SOFT_TIMEAGO(lastSyncAt)}
      </div>

      {counts.pending > 0 && (
        <a
          href="/studio/insights?tab=gmail"
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium text-ink hover:text-ink-soft transition-colors no-underline w-fit"
        >
          Triage queue →
        </a>
      )}

      {isPending && (
        <div className="rounded-card bg-paper-2 border border-rule px-3 py-2 font-mono text-[10px] tracking-[0.18em] uppercase text-tag flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
          First sync in progress
        </div>
      )}

      {lastSyncError && (
        <p className="font-sans text-[12px] text-accent">
          Last sync error: {lastSyncError}
        </p>
      )}

      <div className="flex items-center gap-3 mt-1">
        <button
          type="button"
          onClick={runSync}
          disabled={pending || isPending}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40"
        >
          {pending ? '…' : isPending ? 'Syncing…' : 'Sync now'}
        </button>
        <a
          href="/api/connectors/gmail/initiate"
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 border border-rule text-ink hover:border-ink transition-colors no-underline inline-block"
        >
          Reconnect
        </a>
        <button
          type="button"
          onClick={runDisconnect}
          disabled={pending}
          className="ml-auto font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-40"
        >
          Disconnect
        </button>
      </div>

      {actionError && (
        <p className="font-sans text-[12px] text-accent">{actionError}</p>
      )}
      {actionMessage && (
        <p className="font-sans text-[12px] text-tag">{actionMessage}</p>
      )}
    </li>
  );
}
