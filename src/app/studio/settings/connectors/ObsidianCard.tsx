'use client';

/**
 * src/app/studio/settings/connectors/ObsidianCard.tsx
 *
 * UI card for the Obsidian-via-GitHub connector.
 *
 * States
 * ──────
 * • Not connected  — shows connection form (repoUrl, token, optional branch
 *                    + webhook secret).
 * • Connected      — shows vault path, last sync time, Sync Now + Disconnect
 *                    buttons.
 *
 * Actions are server actions imported from ./actions:
 *   connectObsidian, syncObsidian, disconnectObsidian
 */

import { useState, useTransition } from 'react';
import { Button }   from '@/components/ui/button';
import { Input }    from '@/components/ui/input';
import { Label }    from '@/components/ui/label';
import { Badge }    from '@/components/ui/badge';
import {
  connectObsidian,
  syncObsidian,
  disconnectObsidian,
} from './actions';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ObsidianCardProps {
  /** Resolved at page-render time from the DB. Null if not connected. */
  connector: {
    id:        string;
    repoUrl:   string;
    branch?:   string | null;
    syncedAt?: Date | null;
  } | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ObsidianCard({ connector }: ObsidianCardProps) {
  const [pending, startTransition] = useTransition();

  // Form state
  const [repoUrl,       setRepoUrl]       = useState('');
  const [branch,        setBranch]        = useState('');
  const [githubToken,   setGithubToken]   = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Feedback
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    msg:  string;
  } | null>(null);

  // ── Connect ────────────────────────────────────────────────────────────────
  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const result = await connectObsidian({
        repoUrl,
        branch:        branch || undefined,
        githubToken,
        webhookSecret: webhookSecret || undefined,
      });
      if (result.ok) {
        setFeedback({ type: 'success', msg: 'Vault connected!' });
      } else {
        setFeedback({ type: 'error', msg: result.error ?? 'Connection failed' });
      }
    });
  }

  // ── Sync ───────────────────────────────────────────────────────────────────
  function handleSync() {
    setFeedback(null);
    startTransition(async () => {
      const result = await syncObsidian();
      if (result.ok) {
        setFeedback({
          type: 'success',
          msg: `Synced — ${result.upserted} upserted, ${result.deleted} deleted.`,
        });
      } else {
        setFeedback({ type: 'error', msg: result.error ?? 'Sync failed' });
      }
    });
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  function handleDisconnect() {
    setFeedback(null);
    startTransition(async () => {
      const result = await disconnectObsidian();
      if (result.ok) {
        setFeedback({ type: 'success', msg: 'Vault disconnected.' });
      } else {
        setFeedback({ type: 'error', msg: result.error ?? 'Disconnect failed' });
      }
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Obsidian-purple logo placeholder */}
          <span className="text-2xl" aria-hidden>🟣</span>
          <div>
            <h3 className="font-semibold text-base">Obsidian</h3>
            <p className="text-sm text-muted-foreground">
              Sync your GitHub-backed Obsidian vault
            </p>
          </div>
        </div>
        <Badge variant={connector ? 'default' : 'secondary'}>
          {connector ? 'Connected' : 'Not connected'}
        </Badge>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`rounded-md px-4 py-2 text-sm ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      {connector ? (
        /* ── Connected state ── */
        <div className="space-y-3">
          <div className="text-sm">
            <span className="font-medium">Vault:</span>{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              {connector.repoUrl}
            </code>
          </div>
          {connector.branch && (
            <div className="text-sm">
              <span className="font-medium">Branch:</span>{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {connector.branch}
              </code>
            </div>
          )}
          {connector.syncedAt && (
            <div className="text-sm text-muted-foreground">
              Last synced:{' '}
              {new Date(connector.syncedAt).toLocaleString()}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleSync}
              disabled={pending}
            >
              {pending ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDisconnect}
              disabled={pending}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        /* ── Not-connected state: connection form ── */
        <form onSubmit={handleConnect} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="obs-repo">Vault repository URL</Label>
            <Input
              id="obs-repo"
              placeholder="https://github.com/you/vault or git@github.com:you/vault.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="obs-branch">
              Branch <span className="text-muted-foreground">(optional, default: main)</span>
            </Label>
            <Input
              id="obs-branch"
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="obs-token">GitHub personal access token</Label>
            <Input
              id="obs-token"
              type="password"
              placeholder="ghp_…"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Needs <code>contents:read</code> on the vault repo.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="obs-webhook">
              Webhook secret <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="obs-webhook"
              type="password"
              placeholder="super-secret"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Set the same secret in your GitHub repo → Settings → Webhooks.
            </p>
          </div>

          <Button type="submit" disabled={pending}>
            {pending ? 'Connecting…' : 'Connect vault'}
          </Button>
        </form>
      )}
    </div>
  );
}
