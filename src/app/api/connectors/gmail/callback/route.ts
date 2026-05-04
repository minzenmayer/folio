// Thoughtbed · /api/connectors/gmail/callback (Phase 13, 2026-05-04)
//
// Step 2 of the OAuth dance. Google redirects the user back here with
// either ?code=… (success) or ?error=… (denied, etc.). We:
//
//   1. Verify the ?state nonce matches the cookie we set in /initiate.
//   2. Exchange ?code for {refresh_token, access_token, …}.
//   3. Fetch userinfo to label the connection with the user's Gmail.
//   4. Encrypt the secret JSON and upsert connector_accounts.
//   5. Kick the first sync (fire-and-forget on Vercel).
//   6. Redirect back to /studio?settings=connectors so the GmailCard
//      re-renders in its new "connected" state.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq, and } from 'drizzle-orm';
import { db, connectorAccounts } from '@/db';
import { requireUser } from '@/lib/auth';
import { encryptSecret } from '@/lib/crypto';
import {
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  computeAccessTokenExpiry,
  GMAIL_OAUTH_PROVIDER,
  GMAIL_OAUTH_STATE_COOKIE,
  GmailOAuthConfigError,
  GmailOAuthError,
  type GmailOAuthSecret,
} from '@/lib/gmail/oauth';
import { kickFirstGmailSync } from '@/lib/gmail/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Where we send the user when something goes wrong. The connectors panel
// surfaces ?gmail_error=… in actionError state so the user knows what
// happened without needing to peek at the URL bar.
function backToConnectors(reason: string, message?: string): NextResponse {
  const url = new URL('/studio', resolveAppOrigin());
  url.searchParams.set('settings', 'connectors');
  url.searchParams.set('gmail_error', reason);
  if (message) url.searchParams.set('gmail_message', message.slice(0, 200));
  return NextResponse.redirect(url, { status: 302 });
}

function backToConnectorsOK(): NextResponse {
  const url = new URL('/studio', resolveAppOrigin());
  url.searchParams.set('settings', 'connectors');
  url.searchParams.set('gmail_connected', '1');
  return NextResponse.redirect(url, { status: 302 });
}

/**
 * Pick a base origin for the UI redirect. We prefer the same logic as
 * resolveAppBaseUrl but inline'd here without importing the registry's
 * extra surface — this route only needs the origin for a Location header.
 */
function resolveAppOrigin(): string {
  const explicit = process.env.APP_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

export async function GET(req: Request) {
  const user = await requireUser();

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  // Always blow the state cookie at the end of the round-trip — pass or fail.
  const jar = await cookies();
  const stateCookie = jar.get(GMAIL_OAUTH_STATE_COOKIE);
  jar.delete(GMAIL_OAUTH_STATE_COOKIE);

  // User denied at Google's consent screen, or some other Google-side error.
  if (errorParam) {
    return backToConnectors('google_denied', errorParam);
  }

  if (!code || !state) {
    return backToConnectors('missing_params', 'Google did not return code/state.');
  }

  // CSRF: state cookie must be present and equal to the URL state. Both
  // were set together in /initiate so any divergence means tampering or
  // a stale/cross-tab attempt.
  if (!stateCookie || stateCookie.value !== state) {
    return backToConnectors('state_mismatch', 'OAuth state cookie did not match.');
  }

  // Sanity: the userId embedded in state must equal the current user's
  // (a different signed-in user shouldn't be able to finish someone
  // else's OAuth round-trip).
  const stateUserId = state.split('.')[1];
  if (!stateUserId || stateUserId !== user.id) {
    return backToConnectors('user_mismatch', 'State userId does not match session.');
  }

  // ─── exchange ─────────────────────────────────────────
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code });
  } catch (err) {
    if (err instanceof GmailOAuthConfigError) {
      return backToConnectors('config_missing', err.message);
    }
    if (err instanceof GmailOAuthError) {
      return backToConnectors('exchange_failed', err.message);
    }
    return backToConnectors(
      'exchange_failed',
      err instanceof Error ? err.message : 'unknown'
    );
  }

  if (!tokens.refresh_token) {
    // Google omits refresh_token on subsequent consents unless we pass
    // prompt=consent — which we do — but if a user manually bypasses
    // re-consent (e.g. cleared at accounts.google.com) we'd land here.
    return backToConnectors(
      'no_refresh_token',
      'Google did not return a refresh token. Revoke at myaccount.google.com/permissions and try again.'
    );
  }

  // ─── identity ─────────────────────────────────────────
  let userinfo;
  try {
    userinfo = await fetchGoogleUserInfo({ accessToken: tokens.access_token });
  } catch (err) {
    if (err instanceof GmailOAuthError) {
      return backToConnectors('userinfo_failed', err.message);
    }
    return backToConnectors('userinfo_failed', 'Could not read Google profile.');
  }

  // ─── persist ──────────────────────────────────────────
  const secret: GmailOAuthSecret = {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: computeAccessTokenExpiry(tokens.expires_in),
  };

  let encrypted: string;
  try {
    encrypted = encryptSecret(JSON.stringify(secret));
  } catch (err) {
    return backToConnectors(
      'encrypt_failed',
      err instanceof Error ? err.message : 'unknown'
    );
  }

  // Look for an existing Gmail row for this user — reconnect path replaces
  // the secret in place rather than creating a duplicate row.
  const [existing] = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, user.id),
        eq(connectorAccounts.provider, GMAIL_OAUTH_PROVIDER)
      )
    )
    .limit(1);

  let accountId: string;
  if (existing) {
    accountId = existing.id;
    const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(connectorAccounts)
      .set({
        encryptedSecret: encrypted,
        status: 'connected',
        metadata: {
          ...prevMeta,
          googleEmail: userinfo.email,
          googleUserId: userinfo.id,
          // Reset the history cursor on reconnect — we'll re-bootstrap from a
          // fresh messages.list pass.
          lastHistoryId: null,
          syncCompletedAt: null,
        },
        lastSyncStatus: null,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorAccounts.id, existing.id));
  } else {
    const [created] = await db
      .insert(connectorAccounts)
      .values({
        userId: user.id,
        provider: GMAIL_OAUTH_PROVIDER,
        status: 'connected',
        encryptedSecret: encrypted,
        metadata: {
          googleEmail: userinfo.email,
          googleUserId: userinfo.id,
          lastHistoryId: null,
          syncCompletedAt: null,
        },
      })
      .returning({ id: connectorAccounts.id });
    accountId = created.id;
  }

  // ─── kick first sync ──────────────────────────────────
  // Fire-and-forget on Vercel — kickFirstGmailSync persists progress on
  // connector_accounts.metadata so the UI can poll. Errors are swallowed
  // here; the next /api/cron/gmail-sync run will retry, and the UI shows
  // last_sync_error if anything went wrong.
  try {
    await kickFirstGmailSync({ userId: user.id, accountId });
  } catch (err) {
    console.warn('[gmail:callback] first sync kick failed', err);
  }

  return backToConnectorsOK();
}
