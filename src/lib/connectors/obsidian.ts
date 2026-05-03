// Thoughtbed · Obsidian (Git-backed) connector provider (Sprint 15 Wave 2)
//
// Implements the ConnectorProvider contract for the Obsidian-via-GitHub
// integration model:
//
//   verify(req)
//     1. Extract ?account=<id> from the dispatcher URL — set when we
//        provisioned the GitHub webhook.
//     2. Look up the connector_accounts row (must be provider='obsidian'
//        and status='connected').
//     3. HMAC verify the raw body against metadata.webhookSecret using
//        GitHub's X-Hub-Signature-256 header.
//     4. Parse the JSON body for normalize() / handle().
//
//   normalize(payload)
//     GitHub push events → ConnectorEvent { kind: 'vault.push', ... }.
//     Other events (ping, etc.) fall through to null. We verify it's a
//     push event by sniffing the payload shape rather than the
//     X-GitHub-Event header — the header isn't passed through verify()
//     and we don't want to leak request shape to the contract.
//
//   handle(ctx, event)
//     Diff the push payload, fetch the changed files at the push's head
//     commit, upsert via the same path the cron uses, delete vanished
//     paths. Idempotent.
//
//   provisionWebhook / revokeWebhook
//     Generate a 32-byte secret per account, register a `push` webhook
//     on the user's vault repo, store the secret on
//     connector_accounts.metadata. Same pattern as the Beehiiv provider.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import {
  GitHubError,
  createPushHook,
  deleteHook,
  parseRepoUrl,
} from '@/lib/obsidian';
import {
  diffPushPayload,
  upsertNoteByPath,
  deleteNoteByPath,
} from '@/lib/obsidian-sync';
import type {
  ConnectorEvent,
  ConnectorHandleCtx,
  ConnectorProvider,
  ProvisionWebhookOpts,
  ProvisionedWebhook,
  RevokeWebhookOpts,
  VerifyResult,
  WebhookMetadata,
} from './types';

const PROVIDER = 'obsidian';

// GitHub uses this single signature header. Beehiiv accepts a few
// variants; Obsidian (GitHub) is well-defined so we only check the one.
const SIGNATURE_HEADERS = ['x-hub-signature-256'] as const;

// Per-account metadata shape. Repo identity is stable across reconnects;
// the webhook id + secret rotate.
type ObsidianMetadata = WebhookMetadata & {
  owner?: string;
  repo?: string;
  branch?: string;
  repoUrl?: string;
};

// ─── verify ────────────────────────────────────────────

async function verify(req: Request): Promise<VerifyResult> {
  const url = new URL(req.url);
  const accountId = url.searchParams.get('account');
  if (!accountId) {
    return {
      ok: false,
      status: 400,
      message: 'Missing ?account parameter on webhook URL.',
    };
  }

  const [account] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.id, accountId),
        eq(connectorAccounts.provider, PROVIDER)
      )
    )
    .limit(1);

  if (!account) {
    return { ok: false, status: 404, message: 'Unknown account.' };
  }
  if (account.status !== 'connected') {
    return {
      ok: false,
      status: 410,
      message: 'Account is no longer connected.',
    };
  }

  const meta = (account.metadata ?? {}) as ObsidianMetadata;
  const secret = meta.webhookSecret;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      message: 'Account is missing a webhook secret.',
    };
  }

  const rawBody = await req.text();

  const signature = readSignature(req.headers);
  if (!signature) {
    return {
      ok: false,
      status: 401,
      message: 'Missing webhook signature.',
    };
  }
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    return {
      ok: false,
      status: 401,
      message: 'Invalid webhook signature.',
    };
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return {
      ok: false,
      status: 400,
      message: 'Webhook body is not valid JSON.',
    };
  }

  return { ok: true, account, payload };
}

function readSignature(headers: Headers): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const v = headers.get(name);
    if (v && v.length > 0) return v;
  }
  return null;
}

/**
 * GitHub's signature is `sha256=<hex>` over the raw body using the
 * configured webhook secret. Constant-time comparison via
 * crypto.timingSafeEqual.
 */
function verifyGitHubSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const trimmed = signature.trim();
  const hex = trimmed.startsWith('sha256=')
    ? trimmed.slice('sha256='.length)
    : trimmed;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== hex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}

// ─── normalize ─────────────────────────────────────────

type GitHubPushPayload = {
  ref?: string;
  after?: string;
  // GitHub also sends a `zen` field on `ping` events — we use this to
  // discriminate push from ping.
  zen?: string;
  commits?: unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository?: { default_branch?: string; full_name?: string } & Record<string, any>;
};

function normalize(payload: unknown): ConnectorEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as GitHubPushPayload;

  // Ping events: signed the same way as push, but no commits. Return null
  // so the dispatcher 200's and GitHub marks the test delivery as "OK".
  if (p.zen) return null;

  // Real push event: must have ref + commits.
  if (typeof p.ref !== 'string' || !Array.isArray(p.commits)) {
    return null;
  }

  // externalId = the commit SHA at the head of the push, used for
  // observability + as the ref we fetch files at.
  const externalId =
    typeof p.after === 'string' && p.after.length > 0 ? p.after : p.ref;

  return { kind: 'vault.push', externalId, payload };
}

// ─── handle ────────────────────────────────────────────

async function handle(
  ctx: ConnectorHandleCtx,
  event: ConnectorEvent
): Promise<void> {
  if (event.kind !== 'vault.push') return;
  if (!ctx.apiKey) {
    return;
  }

  const meta = (ctx.account.metadata ?? {}) as ObsidianMetadata;
  if (!meta.owner || !meta.repo) {
    console.warn(
      '[obsidian:handle] account is missing owner/repo in metadata',
      ctx.account.id
    );
    return;
  }

  // Only react to pushes on the configured branch (Obsidian users can
  // have a `develop` or `mobile` branch they don't expect to sync).
  const expectedRef = `refs/heads/${meta.branch ?? 'main'}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (event.payload as any)?.ref;
  if (typeof ref === 'string' && ref !== expectedRef) {
    return;
  }

  const ctxParts = {
    pat: ctx.apiKey,
    owner: meta.owner,
    repo: meta.repo,
    branch: meta.branch ?? 'main',
  };

  const delta = diffPushPayload(event.payload);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headSha = (event.payload as any)?.after ?? meta.branch ?? 'main';

  for (const path of delta.upserts) {
    try {
      await upsertNoteByPath(
        ctx.account.userId,
        ctx.account.id,
        ctxParts,
        path,
        headSha
      );
    } catch (err) {
      console.warn('[obsidian:handle] upsertNoteByPath failed', path, err);
    }
  }

  for (const path of delta.removes) {
    try {
      await deleteNoteByPath(ctx.account.userId, ctx.account.id, path);
    } catch (err) {
      console.warn('[obsidian:handle] deleteNoteByPath failed', path, err);
    }
  }

  await db
    .update(connectorAccounts)
    .set({
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      lastSyncCount: delta.upserts.length,
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(connectorAccounts.id, ctx.account.id));
}

// ─── lifecycle ─────────────────────────────────────────

async function provisionWebhook(
  opts: ProvisionWebhookOpts
): Promise<ProvisionedWebhook> {
  const meta = (opts.account.metadata ?? {}) as ObsidianMetadata;
  if (!meta.owner || !meta.repo) {
    throw new Error(
      '[obsidian:provision] account is missing owner/repo in metadata'
    );
  }

  // Generate a per-account 32-byte secret. We send it to GitHub on
  // creation; GitHub stores it server-side and uses it for the
  // X-Hub-Signature-256 header on every subsequent delivery.
  const secret = randomBytes(32).toString('hex');

  const hook = await createPushHook(opts.apiKey, meta.owner, meta.repo, {
    url: opts.callbackUrl,
    secret,
  });

  return {
    webhookId: String(hook.id),
    webhookSecret: secret,
  };
}

async function revokeWebhook(opts: RevokeWebhookOpts): Promise<void> {
  const meta = (opts.account.metadata ?? {}) as ObsidianMetadata;
  if (!meta.owner || !meta.repo) {
    return;
  }
  try {
    await deleteHook(opts.apiKey, meta.owner, meta.repo, opts.webhookId);
  } catch (err) {
    if (err instanceof GitHubError && err.code === 'auth_failed') {
      console.warn(
        '[obsidian:revoke] auth_failed — webhook left orphaned upstream'
      );
      return;
    }
    throw err;
  }
}

// ─── exports ───────────────────────────────────────────

export const obsidianConnector: ConnectorProvider = {
  name: PROVIDER,
  verify,
  normalize,
  handle,
  provisionWebhook,
  revokeWebhook,
};

// Helper re-exports so the connect server action stays neighborly.
export { parseRepoUrl };
