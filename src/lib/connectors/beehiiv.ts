// Thoughtbed · Beehiiv connector provider (Sprint 15 Wave 1)
//
// Implements the ConnectorProvider contract for Beehiiv:
//
//   verify(req)
//     1. Extract ?account=<id> from the dispatcher's URL — set when we
//        provisioned the webhook; identifies which connector_accounts
//        row this delivery belongs to.
//     2. Look up the account (must exist, must be 'connected', must be
//        provider='beehiiv').
//     3. HMAC-SHA256 verify the raw body against
//        metadata.webhookSecret (returned by Beehiiv on creation, mirrored
//        into our row by provisionWebhook below).
//     4. Parse the JSON body for downstream normalization.
//
//   normalize(payload)
//     Beehiiv post.sent → ConnectorEvent { kind: 'post.sent', externalId,
//     payload }. Other Beehiiv events fall through to null (we 200, they
//     stop retrying).
//
//   handle(ctx, event)
//     Re-fetch the post from Beehiiv to get fully-expanded HTML (the
//     webhook delivers a slim payload), then call the same upsertIssue
//     the cron uses. Idempotent on (user_id, external_id).
//
//   provisionWebhook(opts) / revokeWebhook(opts)
//     Lifecycle helpers used by the connect/disconnect server actions.
//     Both return cleanly so a flaky webhook API doesn't unwind a working
//     connection — the cron stays as backstop.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import {
  createWebhook,
  deleteWebhook,
  getPost,
  BeehiivError,
  type BeehiivWebhookEvent,
} from '@/lib/beehiiv';
// Sprint 15 Wave 2: upsertIssue now also handles extractIdeas internally
// (best-effort), so cron + push + UI all keep extracted_ideas aligned
// without each call site re-implementing the post-upsert extraction.
import { upsertIssue } from '@/lib/beehiiv-sync';
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

const PROVIDER = 'beehiiv';
const WEBHOOK_EVENTS: BeehiivWebhookEvent[] = ['post.sent'];

/**
 * Headers Beehiiv (or any reasonable shim) might use for the signature.
 * Try in order — first one present wins. Keeps verify() resilient if the
 * upstream renames their header without breaking our code.
 */
const SIGNATURE_HEADERS = [
  'beehiiv-signature',
  'x-beehiiv-signature',
  'x-webhook-signature',
  'x-hub-signature-256',
] as const;

// ─── verify ────────────────────────────────────────────

async function verify(req: Request): Promise<VerifyResult> {
  // ─── 1. Locate account ──────────────────────────────────
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
    // Account was disconnected but Beehiiv hasn't stopped delivering yet —
    // 410 Gone tells well-behaved senders to delete the subscription.
    return {
      ok: false,
      status: 410,
      message: 'Account is no longer connected.',
    };
  }

  const meta = (account.metadata ?? {}) as WebhookMetadata;
  const secret = meta.webhookSecret;
  if (!secret) {
    // Account row exists but never finished provisioning — refuse loudly.
    return {
      ok: false,
      status: 500,
      message: 'Account is missing a webhook secret.',
    };
  }

  // ─── 2. Read raw body for HMAC + parse ────────────────────────
  const rawBody = await req.text();

  // ─── 3. Verify signature ────────────────────────────────────
  const signature = readSignature(req.headers);
  if (!signature) {
    return {
      ok: false,
      status: 401,
      message: 'Missing webhook signature.',
    };
  }
  if (!verifyHmac(rawBody, signature, secret)) {
    return {
      ok: false,
      status: 401,
      message: 'Invalid webhook signature.',
    };
  }

  // ─── 4. Parse JSON ─────────────────────────────────────────
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

/** Pull the first non-empty signature header value, lowercased lookup. */
function readSignature(headers: Headers): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const v = headers.get(name);
    if (v && v.length > 0) return v;
  }
  return null;
}

/**
 * Constant-time HMAC-SHA256 verification.
 *
 * Accepts either:
 *   · raw hex digest                                 (most webhook senders)
 *   · "sha256=<hex>"                                 (GitHub-style)
 *   · "t=<ts>,v1=<hex>"                              (Stripe-style)
 *
 * For Stripe-style we sign `${ts}.${rawBody}` instead of just `rawBody`.
 * Beehiiv's exact format isn't pinned in our codebase yet — accepting all
 * three keeps Wave 1 robust without needing a follow-up patch when their
 * header convention surfaces.
 */
function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  const trimmed = signature.trim();

  // Stripe-style: "t=...,v1=..." — sign timestamp + "." + body
  if (trimmed.includes(',') && trimmed.includes('=')) {
    const parts = Object.fromEntries(
      trimmed.split(',').map((p) => {
        const [k, ...rest] = p.split('=');
        return [k.trim(), rest.join('=').trim()];
      })
    );
    const ts = parts['t'];
    const sig = parts['v1'] ?? parts['v0'];
    if (ts && sig) {
      const expected = createHmac('sha256', secret)
        .update(`${ts}.${rawBody}`)
        .digest('hex');
      return safeEqualHex(expected, sig);
    }
  }

  // GitHub-style: "sha256=..."
  const hex = trimmed.startsWith('sha256=')
    ? trimmed.slice('sha256='.length)
    : trimmed;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(expected, hex);
}

function safeEqualHex(a: string, b: string): boolean {
  // Length difference alone is enough to fail; timingSafeEqual requires
  // equal-length buffers, so we short-circuit before constructing them.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// ─── normalize ─────────────────────────────────────────

/**
 * Beehiiv's webhook payload (subset). Their docs sometimes nest the post
 * under `data` and sometimes flatten it; we accept both shapes.
 */
type BeehiivWebhookPayload = {
  type?: string; // 'post.sent' | …
  event?: string; // alt name some senders use
  data?: Record<string, unknown> & { id?: string; post_id?: string };
  post?: { id?: string };
  post_id?: string;
};

function normalize(payload: unknown): ConnectorEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as BeehiivWebhookPayload;

  const kind = p.type ?? p.event;
  if (kind !== 'post.sent') return null;

  // Beehiiv post ids look like 'post_…'; extract whichever shape the
  // payload uses. This stays loose on purpose — handle() re-fetches via
  // getPost so we just need an id, not a full post object here.
  const externalId =
    (typeof p.data?.id === 'string' && p.data.id) ||
    (typeof p.data?.post_id === 'string' && p.data.post_id) ||
    (typeof p.post?.id === 'string' && p.post.id) ||
    (typeof p.post_id === 'string' && p.post_id) ||
    null;

  if (!externalId) return null;

  return { kind: 'post.sent', externalId, payload };
}

// ─── handle ────────────────────────────────────────────

async function handle(
  ctx: ConnectorHandleCtx,
  event: ConnectorEvent
): Promise<void> {
  if (event.kind !== 'post.sent') return;
  if (!ctx.apiKey) {
    // Disconnected but a delivery still landed — verify() should have
    // 410'd already, so this is belt-and-suspenders.
    return;
  }

  const meta = (ctx.account.metadata ?? {}) as WebhookMetadata & {
    publicationId?: string;
  };
  if (!meta.publicationId) {
    console.warn(
      '[beehiiv:handle] account is missing publicationId in metadata',
      ctx.account.id
    );
    return;
  }

  // Re-fetch the post fresh — webhook payloads don't include the
  // expanded `free_web_content` HTML we embed against. getPost() returns
  // BeehiivError on auth/network problems; let it bubble to the dispatcher
  // so it logs (and Beehiiv retries).
  const post = await getPost(ctx.apiKey, meta.publicationId, event.externalId);

  await upsertIssue(
    ctx.account.userId,
    ctx.account.id,
    meta.publicationId,
    post
  );
  // upsertIssue triggers extractIdeas internally on real writes — see
  // src/lib/beehiiv-sync.ts. No need to re-invoke here.
}

// ─── lifecycle ─────────────────────────────────────────

async function provisionWebhook(
  opts: ProvisionWebhookOpts
): Promise<ProvisionedWebhook> {
  const meta = (opts.account.metadata ?? {}) as WebhookMetadata & {
    publicationId?: string;
  };
  if (!meta.publicationId) {
    throw new Error(
      '[beehiiv:provision] account is missing publicationId in metadata'
    );
  }

  const created = await createWebhook(opts.apiKey, meta.publicationId, {
    url: opts.callbackUrl,
    event_types: WEBHOOK_EVENTS,
    description: 'Thoughtbed real-time post sync',
  });

  if (!created.signing_secret) {
    // If Beehiiv didn't return a secret we can't verify deliveries —
    // back out by deleting the just-created webhook.
    try {
      await deleteWebhook(opts.apiKey, meta.publicationId, created.id);
    } catch {
      /* best-effort */
    }
    throw new Error(
      '[beehiiv:provision] Beehiiv did not return a signing secret.'
    );
  }

  return {
    webhookId: created.id,
    webhookSecret: created.signing_secret,
  };
}

async function revokeWebhook(opts: RevokeWebhookOpts): Promise<void> {
  const meta = (opts.account.metadata ?? {}) as WebhookMetadata & {
    publicationId?: string;
  };
  if (!meta.publicationId) {
    // Nothing we can address upstream; treat as already gone.
    return;
  }

  try {
    await deleteWebhook(opts.apiKey, meta.publicationId, opts.webhookId);
  } catch (err) {
    if (err instanceof BeehiivError && err.code === 'auth_failed') {
      // The user's key is already invalid — Beehiiv won't accept the
      // delete. The webhook itself will start failing its own deliveries
      // with 401 from us and Beehiiv will eventually disable it.
      console.warn(
        '[beehiiv:revoke] auth_failed — webhook left orphaned upstream'
      );
      return;
    }
    throw err;
  }
}

// ─── exports ───────────────────────────────────────────

export const beehiivConnector: ConnectorProvider = {
  name: PROVIDER,
  verify,
  normalize,
  handle,
  provisionWebhook,
  revokeWebhook,
};
