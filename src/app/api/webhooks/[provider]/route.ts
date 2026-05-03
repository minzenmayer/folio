// Thoughtbed · Single webhook dispatcher (Sprint 15 Wave 1)
//
// One route handles every connector's real-time push:
//
//   POST /api/webhooks/beehiiv?account=<accountId>     ← Wave 1
//   POST /api/webhooks/obsidian?account=<accountId>    ← Wave 2 (GitHub push)
//   POST /api/webhooks/substack?account=<accountId>    ← future
//
// The dispatcher itself stays dumb on purpose — every provider-specific
// concern (signature header layout, payload shape, what to upsert) lives
// behind the ConnectorProvider contract in src/lib/connectors/types.ts.
//
// Flow per delivery:
//   1. Look up provider by name (404 if unknown).
//   2. provider.verify(req) → loads account, verifies HMAC, parses body.
//   3. provider.normalize(payload) → ConnectorEvent or null.
//      null = "we don't care about this event" → 200 (stop retries).
//   4. Decrypt the account's API key once, hand to provider.handle(ctx, event).
//   5. handle() routes through the same upsert the cron uses
//      (e.g. upsertIssue for beehiiv) — same idempotency, no divergence.
//
// Auth is delegated to the provider, not the dispatcher: each connector
// uses a per-account secret stored in metadata.webhookSecret. Middleware
// marks /api/webhooks/(.*) public so Clerk's session check stays out of
// the way (see src/middleware.ts).

import { getConnector, decryptAccountKey } from '@/lib/connectors/registry';

// node:crypto via decryptSecret → must run on Node, not Edge.
export const runtime = 'nodejs';
// Webhooks must always hit the runtime; Next must not cache.
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ provider: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  const { provider: providerName } = await ctx.params;
  const provider = getConnector(providerName);

  if (!provider) {
    return new Response(`Unknown provider: ${providerName}`, { status: 404 });
  }

  // ─── verify ──────────────────────────────────────────────────────
  const verifyResult = await provider.verify(req);
  if (!verifyResult.ok) {
    // Log 4xx-and-up at warn so a misconfigured webhook is visible in
    // logs without burying genuine 200s in noise.
    console.warn(
      `[webhook:${provider.name}] verify failed`,
      verifyResult.status,
      verifyResult.message
    );
    return new Response(verifyResult.message, { status: verifyResult.status });
  }

  // ─── normalize ───────────────────────────────────────────────────
  let event;
  try {
    event = provider.normalize(verifyResult.payload);
  } catch (err) {
    console.warn(`[webhook:${provider.name}] normalize threw`, err);
    return new Response('Bad payload', { status: 400 });
  }

  if (!event) {
    // Provider says "not an event we care about" — 200 so the upstream
    // checks the box and stops retrying. Common for noisy event firehoses.
    return Response.json({ ok: true, ignored: true });
  }

  // ─── handle ──────────────────────────────────────────────────────
  // Decrypt the API key once here so providers don't all re-implement
  // the crypto-handling boilerplate. handle() may need to call back to
  // the upstream API (re-fetch fresh content).
  const apiKey = decryptAccountKey(verifyResult.account);

  try {
    await provider.handle(
      { account: verifyResult.account, apiKey },
      event
    );
    return Response.json({ ok: true, event: event.kind });
  } catch (err) {
    console.error(`[webhook:${provider.name}] handle failed`, err);
    // 500 → upstream retries. The cron backstop also catches anything
    // that ends up permanently un-deliverable.
    return new Response('Handler error', { status: 500 });
  }
}
