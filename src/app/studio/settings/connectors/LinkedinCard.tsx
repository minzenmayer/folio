// Thoughtbed · LinkedinCard (Phase 12, 2026-05-04)
//
// Stateful client card for the LinkedIn connector. Five visual states:
//
//   1. disconnected         — Connect form (paste profile URL).
//   2. pending (first run)  — "Sync in progress (scraping LinkedIn…)".
//                             Auto-polls every 30s; pollLinkedin server
//                             action drains when SUCCEEDED.
//   3. connected, idle      — profile URL + posts synced + last-sync line
//                             + Sync now / Disconnect.
//   4. connected, syncing   — same as #2 but with a Disconnect-only
//                             escape hatch.
//   5. error                — last_sync_error + Reconnect.
//
// All transitions go through ./actions.ts. We never re-fetch on the
// client; revalidatePath in the action makes the parent layout re-render
// and we read the new status props.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectLinkedin,
  syncLinkedin,
  pollLinkedin,
  disconnectLinkedin,
  type LinkedinStatus,
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

// Apify scrapes for hundreds of posts can take 1-3 minutes. Poll every
// 30s — Apify rate limits are generous for our scale, and the server
// action just hits one Apify endpoint per call.
const POLL_INTERVAL_MS = 30_000;

export function LinkedinCard({ initialStatus }: { initialStatus: LinkedinStatus }) {
  const router = useRouter();
  const [profileUrl, setProfileUrl] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Track which mode we're rendering so the form-toggle UX feels stable.
  const [showForm, setShowForm] = useState(initialStatus.kind === 'disconnected');

  // Auto-polling while a run is in flight.
  const isPending =
    initialStatus.kind === 'connected' && initialStatus.pendingRunId !== null;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isPending) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    // Don't double-up if a transition is already running.
    pollTimerRef.current = setInterval(() => {
      // Best-effort poll. Errors surface in the next refresh.
      pollLinkedin()
        .then(() => router.refresh())
        .catch(() => {
          // Suppress; the user can also click Sync to retry.
        });
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isPending, router]);

  function refresh() {
    router.refresh();
  }

  function runConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = profileUrl.trim();
    if (trimmed.length === 0) return;
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await connectLinkedin({ profileUrl: trimmed });
      if (!res.ok) {
        setActionError(res.message ?? 'Connect failed.');
        return;
      }
      setActionMessage('Connected. Pulling posts now. This can take a few minutes.');
      setProfileUrl('');
      setShowForm(false);
      refresh();
    });
  }

  function runSync() {
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await syncLinkedin();
      if (!res.ok) {
        setActionError(res.message ?? 'Sync failed.');
        return;
      }
      setActionMessage('Sync started. Posts will appear as Apify finishes.');
      refresh();
    });
  }

  function runDisconnect() {
    setActionError(null);
    setActionMessage(null);
    if (
      !window.confirm(
        'Disconnect LinkedIn? Existing posts will stay in your archive; new posts won’t sync until you reconnect.'
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await disconnectLinkedin();
      if (!res.ok) {
        setActionError(res.message ?? 'Disconnect failed.');
        return;
      }
      setActionMessage('Disconnected.');
      setShowForm(true);
      refresh();
    });
  }

  // ─── render ─────────────────────────────────────────────

  if (initialStatus.kind === 'disconnected' || showForm) {
    return (
      <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
            aria-hidden
          >
            in
          </span>
          <div className="flex-1">
            <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
              LinkedIn
            </h3>
            {initialStatus.kind === 'connected' && (
              <p className="font-sans text-[12px] text-tag mt-0.5">
                {initialStatus.profileUrl}
              </p>
            )}
          </div>
        </div>
        <p className="font-sans text-[13px] leading-[1.55] text-ink-soft">
          Your LinkedIn posts. We scrape your public profile via Apify. No LinkedIn login required, no posting on your behalf.
        </p>
        <form onSubmit={runConnect} className="flex flex-col gap-2 mt-1">
          <label className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
            Profile URL
          </label>
          <input
            type="url"
            inputMode="url"
            placeholder="https://www.linkedin.com/in/yourhandle/"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            disabled={pending}
            className="bg-bg border border-rule rounded-soft px-3 py-2 font-mono text-[12px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
            required
          />
          <div className="flex items-center gap-3 mt-1">
            <button
              type="submit"
              disabled={pending || profileUrl.trim().length === 0}
              className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40"
            >
              {pending ? 'Connecting…' : 'Connect'}
            </button>
            {initialStatus.kind === 'connected' && (
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={pending}
                className="font-sans text-[12px] text-tag hover:text-ink transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
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
  return (
    <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
          aria-hidden
        >
          in
        </span>
        <div className="flex-1">
          <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
            LinkedIn
          </h3>
          <p className="font-sans text-[12px] text-tag mt-0.5 truncate">
            {initialStatus.profileUrl}
          </p>
        </div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-bg bg-ink rounded-full px-2.5 py-1">
          connected
        </span>
      </div>

      <div className="font-sans text-[13px] text-ink-soft">
        {initialStatus.postsSynced > 0
          ? `${initialStatus.postsSynced} posts synced`
          : 'No posts synced yet.'}
        {' · last sync '}
        {SOFT_TIMEAGO(initialStatus.lastSyncAt)}
      </div>

      {isPending && (
        <div className="rounded-card bg-paper-2 border border-rule px-3 py-2 font-mono text-[10px] tracking-[0.18em] uppercase text-tag flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
          Sync in progress · {SOFT_TIMEAGO(initialStatus.pendingStartedAt)}
        </div>
      )}

      {initialStatus.lastSyncError && (
        <p className="font-sans text-[12px] text-accent">
          Last sync error: {initialStatus.lastSyncError}
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
        <button
          type="button"
          onClick={() => setShowForm(true)}
          disabled={pending}
          className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 border border-rule text-ink hover:border-ink transition-colors disabled:opacity-40"
        >
          Reconnect
        </button>
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
