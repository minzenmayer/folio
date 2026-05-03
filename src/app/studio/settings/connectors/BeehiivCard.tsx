// Thoughtbed · BeehiivCard (Sprint 13 Wave 1, Sprint 14 brand pivot)
//
// Stateful client card for the Beehiiv connector. Three states drive the
// rendered shape:
//
//   1. disconnected — show Connect button + collapsed API key form
//   2. connected     — show pub name + issue count + last-sync line +
//                      Sync now / Disconnect
//   3. error         — show last_sync_error + Reconnect button
//
// All state transitions go through the server actions in ./actions.ts;
// the card is a thin glass between the user and those actions. After
// each action we let Next's revalidatePath refresh the parent layout
// rather than tracking optimistic state here.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectBeehiiv,
  syncBeehiiv,
  disconnectBeehiiv,
  type BeehiivStatus,
} from './actions';

type Snapshot = BeehiivStatus;

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

export function BeehiivCard({ initialStatus }: { initialStatus: Snapshot }) {
  const router = useRouter();
  const [status] = useState<Snapshot>(initialStatus);
  const [showForm, setShowForm] = useState(!status.connected);
  const [apiKey, setApiKey] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function refresh() {
    router.refresh();
  }

  function runConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) return;
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await connectBeehiiv({ apiKey: trimmed });
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setActionMessage(res.message ?? 'Connected.');
      setApiKey('');
      setShowForm(false);
      refresh();
    });
  }

  function runSync() {
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await syncBeehiiv();
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setActionMessage(res.message ?? 'Synced.');
      refresh();
    });
  }

  function runDisconnect() {
    if (
      !window.confirm(
        'Disconnect Beehiiv? Your API key will be removed. Past issues stay in your space.'
      )
    ) {
      return;
    }
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await disconnectBeehiiv();
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setActionMessage('Disconnected.');
      setShowForm(true);
      refresh();
    });
  }

  // ─── header (shared across states) ────────────────────────────
  const showError =
    status.connected && status.account.lastSyncStatus === 'auth_failed';

  return (
    <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
          aria-hidden
        >
          BH
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight truncate">
            Beehiiv
          </h3>
          {status.connected && status.account.publicationName && (
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag truncate">
              {status.account.publicationName}
            </div>
          )}
        </div>
        <span
          className={`font-mono text-[9px] tracking-[0.22em] uppercase rounded-full px-2.5 py-1 ${
            !status.connected
              ? 'text-tag bg-paper-2'
              : showError
                ? 'text-ink bg-accent-soft'
                : 'text-bg bg-accent-2'
          }`}
        >
          {!status.connected
            ? 'idle'
            : showError
              ? 'error'
              : 'connected'}
        </span>
      </div>

      <p className="font-sans text-[13.5px] leading-[1.55] text-ink-soft">
        Sync your published newsletter issues. Voice training data in your
        own approved words.
      </p>

      {/* Connected state — issue count + last sync */}
      {status.connected && !showForm && (
        <div className="font-mono text-[11px] text-tag tracking-[0.04em] mt-1">
          {status.account.issueCount}{' '}
          {status.account.issueCount === 1 ? 'issue' : 'issues'} synced
          {' · '}
          last sync {SOFT_TIMEAGO(status.account.lastSyncAt)}
        </div>
      )}

      {/* Error display — sync error message */}
      {status.connected &&
        status.account.lastSyncError &&
        status.account.lastSyncStatus !== 'ok' && (
          <p className="font-sans text-[12.5px] text-ink leading-[1.5]">
            {status.account.lastSyncError}
          </p>
        )}

      {/* Inline result/error banner from latest action */}
      {actionMessage && !actionError && (
        <p className="font-sans text-[12.5px] text-accent-2 leading-[1.5]">
          {actionMessage}
        </p>
      )}
      {actionError && (
        <p className="font-sans text-[12.5px] text-ink leading-[1.5]">
          {actionError}
        </p>
      )}

      {/* Disconnected — Connect form, collapsed by default until clicked */}
      {!status.connected && (
        <div className="mt-auto pt-2">
          {!showForm ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors"
            >
              Connect
            </button>
          ) : (
            <ConnectForm
              apiKey={apiKey}
              setApiKey={setApiKey}
              pending={pending}
              onSubmit={runConnect}
              onCancel={() => {
                setShowForm(false);
                setActionError(null);
              }}
            />
          )}
        </div>
      )}

      {/* Connected — Sync now + Disconnect (or Reconnect when showing form) */}
      {status.connected && !showForm && (
        <div className="mt-auto pt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runSync}
            disabled={pending}
            className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            disabled={pending}
            className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-3 py-2 border border-rule text-ink-soft hover:border-ink hover:text-ink hover:bg-paper-2 transition-colors disabled:opacity-50"
          >
            Reconnect
          </button>
          <button
            type="button"
            onClick={runDisconnect}
            disabled={pending}
            className="ml-auto font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      )}

      {/* Connected → showing form means Reconnect with new key */}
      {status.connected && showForm && (
        <div className="mt-auto pt-2">
          <ConnectForm
            apiKey={apiKey}
            setApiKey={setApiKey}
            pending={pending}
            onSubmit={runConnect}
            onCancel={() => {
              setShowForm(false);
              setActionError(null);
            }}
          />
        </div>
      )}
    </li>
  );
}

function ConnectForm({
  apiKey,
  setApiKey,
  pending,
  onSubmit,
  onCancel,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  pending: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label
        htmlFor="beehiiv-api-key"
        className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium"
      >
        Beehiiv API key
      </label>
      <p className="font-sans text-[12px] text-tag leading-[1.5]">
        Generate one in Beehiiv → Settings → Integrations → API. Only the
        key is stored, encrypted at rest.
      </p>
      <input
        id="beehiiv-api-key"
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="Bh_…"
        className="bg-paper-2 border border-rule rounded-soft px-3 py-2 font-mono text-[13px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || apiKey.trim().length === 0}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Connecting…' : 'Connect & sync'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="font-sans text-[12px] text-tag hover:text-ink transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
