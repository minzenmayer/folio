// Thoughtbed · ObsidianCard (Sprint 15 Wave 2)
//
// Twin of BeehiivCard for the Obsidian-via-GitHub connector. The connect
// form takes a repo URL + a read-only GitHub PAT (and an optional branch
// override). All state transitions go through the server actions in
// ./actions.ts; revalidatePath refreshes the parent layout afterward.
//
// Brand discipline: same monochrome system-sans, same "Connect / Sync /
// Disconnect" copy. The card is read-only between actions — we don't
// optimistically guess at GitHub's response.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectObsidian,
  syncObsidian,
  disconnectObsidian,
  type ObsidianStatus,
} from './actions';

type Snapshot = ObsidianStatus;

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

export function ObsidianCard({ initialStatus }: { initialStatus: Snapshot }) {
  const router = useRouter();
  const [status] = useState<Snapshot>(initialStatus);
  const [showForm, setShowForm] = useState(!status.connected);
  const [repoUrl, setRepoUrl] = useState(
    status.connected ? status.account.repoUrl ?? '' : ''
  );
  const [pat, setPat] = useState('');
  const [branch, setBranch] = useState(
    status.connected ? status.account.branch ?? '' : ''
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function refresh() {
    router.refresh();
  }

  function runConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmedRepo = repoUrl.trim();
    const trimmedPat = pat.trim();
    if (trimmedRepo.length === 0 || trimmedPat.length === 0) return;
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await connectObsidian({
        repoUrl: trimmedRepo,
        pat: trimmedPat,
        branch: branch.trim() || undefined,
      });
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setActionMessage(res.message ?? 'Connected.');
      setPat('');
      setShowForm(false);
      refresh();
    });
  }

  function runSync() {
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await syncObsidian();
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
        'Disconnect Obsidian? Your GitHub token will be removed. Past notes stay in your space.'
      )
    ) {
      return;
    }
    setActionError(null);
    setActionMessage(null);
    startTransition(async () => {
      const res = await disconnectObsidian();
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setActionMessage('Disconnected.');
      setShowForm(true);
      refresh();
    });
  }

  const showError =
    status.connected &&
    (status.account.lastSyncStatus === 'auth_failed' ||
      status.account.lastSyncStatus === 'forbidden');

  return (
    <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
          aria-hidden
        >
          OB
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight truncate">
            Obsidian
          </h3>
          {status.connected && status.account.owner && status.account.repo && (
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag truncate">
              {status.account.owner}/{status.account.repo}
              {status.account.branch && status.account.branch !== 'main' && (
                <span> · {status.account.branch}</span>
              )}
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
          {!status.connected ? 'idle' : showError ? 'error' : 'connected'}
        </span>
      </div>

      <p className="font-sans text-[13.5px] leading-[1.55] text-ink-soft">
        Sync your Markdown vault from a Git repo. Each note becomes
        retrievable; ideas extract automatically.
      </p>

      {/* Connected state — note count + last sync */}
      {status.connected && !showForm && (
        <div className="font-mono text-[11px] text-tag tracking-[0.04em] mt-1">
          {status.account.noteCount}{' '}
          {status.account.noteCount === 1 ? 'note' : 'notes'} synced
          {' · '}
          last sync {SOFT_TIMEAGO(status.account.lastSyncAt)}
        </div>
      )}

      {/* Error display */}
      {status.connected &&
        status.account.lastSyncError &&
        status.account.lastSyncStatus !== 'ok' && (
          <p className="font-sans text-[12.5px] text-ink leading-[1.5]">
            {status.account.lastSyncError}
          </p>
        )}

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

      {/* Disconnected — Connect form */}
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
              repoUrl={repoUrl}
              setRepoUrl={setRepoUrl}
              pat={pat}
              setPat={setPat}
              branch={branch}
              setBranch={setBranch}
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

      {/* Connected — Sync now + Disconnect */}
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

      {/* Connected → showing form means Reconnect */}
      {status.connected && showForm && (
        <div className="mt-auto pt-2">
          <ConnectForm
            repoUrl={repoUrl}
            setRepoUrl={setRepoUrl}
            pat={pat}
            setPat={setPat}
            branch={branch}
            setBranch={setBranch}
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
  repoUrl,
  setRepoUrl,
  pat,
  setPat,
  branch,
  setBranch,
  pending,
  onSubmit,
  onCancel,
}: {
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  pat: string;
  setPat: (v: string) => void;
  branch: string;
  setBranch: (v: string) => void;
  pending: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label
          htmlFor="obsidian-repo-url"
          className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium block mb-1"
        >
          Vault repo
        </label>
        <input
          id="obsidian-repo-url"
          type="text"
          autoComplete="off"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/you/vault"
          className="w-full bg-paper-2 border border-rule rounded-soft px-3 py-2 font-mono text-[13px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
        />
      </div>

      <div>
        <label
          htmlFor="obsidian-pat"
          className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium block mb-1"
        >
          Read-only access token
        </label>
        <p className="font-sans text-[12px] text-tag leading-[1.5] mb-1">
          GitHub → Settings → Developer settings → Personal access tokens.
          Fine-grained, scope: <span className="font-mono">Contents: read</span>{' '}
          on the vault repo. Only the token is stored, encrypted at rest.
        </p>
        <input
          id="obsidian-pat"
          type="password"
          autoComplete="off"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="github_pat_…"
          className="w-full bg-paper-2 border border-rule rounded-soft px-3 py-2 font-mono text-[13px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
        />
      </div>

      <div>
        <label
          htmlFor="obsidian-branch"
          className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium block mb-1"
        >
          Branch (optional)
        </label>
        <input
          id="obsidian-branch"
          type="text"
          autoComplete="off"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          className="w-full bg-paper-2 border border-rule rounded-soft px-3 py-2 font-mono text-[13px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={
            pending || repoUrl.trim().length === 0 || pat.trim().length === 0
          }
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
