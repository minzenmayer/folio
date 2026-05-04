// Thoughtbed · Gmail OAuth (Phase 13, 2026-05-04)
//
// Pure OAuth glue: build the Google authorize URL, exchange a code for
// tokens, refresh an access token, fetch userinfo. No DB, no crypto, no
// Next.js — just HTTP + URL building. The connector layer in api.ts
// composes these with the encrypted-secret store.
//
// Mode: Testing (External). Refresh tokens last forever in Testing mode
// for whitelisted test users; refresh on demand whenever an access token
// is within 60s of expiry.

import { resolveAppBaseUrl } from '@/lib/connectors/registry';

// ─── constants ──────────────────────────────────────────

export const GMAIL_OAUTH_PROVIDER = 'gmail';

export const GMAIL_OAUTH_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_OAUTH_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * Scopes we request. gmail.readonly is the Restricted scope — Testing
 * mode bypasses Google verification for whitelisted test users. Identity
 * scopes (openid + email + profile) let us label the connection with the
 * user's Google email without a separate API call.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
  'profile',
] as const;

/**
 * Cookie that carries the CSRF state across the round-trip to Google.
 * We compare against ?state in the callback. HttpOnly+Secure+Lax —
 * Lax is required so the cookie survives the top-level redirect from
 * accounts.google.com back to our callback.
 */
export const GMAIL_OAUTH_STATE_COOKIE = 'gmail_oauth_state';

/** State cookie + Google auth code handoff window. 10 min is plenty. */
export const GMAIL_OAUTH_STATE_TTL_S = 600;

/**
 * Refresh an access token this many seconds before it actually expires.
 * Avoids handing back a token that'll 401 by the time the caller uses it.
 */
export const GMAIL_OAUTH_REFRESH_LEEWAY_S = 60;

// ─── types ──────────────────────────────────────────────

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: 'Bearer';
  id_token?: string;
  refresh_token?: string;
};

export type GoogleUserInfo = {
  id: string;
  email: string;
  verified_email?: boolean;
  name?: string;
  picture?: string;
};

/**
 * What we actually persist (encrypted) on connector_accounts.encryptedSecret.
 * accessToken is cached so we don't round-trip /token on every Gmail call;
 * accessTokenExpiresAt is an ms-epoch timestamp.
 */
export type GmailOAuthSecret = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
};

// ─── env ────────────────────────────────────────────────

export class GmailOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailOAuthConfigError';
  }
}

export function getGmailOAuthClientCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GmailOAuthConfigError(
      'GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET are not set. Configure the Gmail OAuth client in Google Cloud Console (project: thoughtbed-gmail) and set both in Vercel env.'
    );
  }
  return { clientId, clientSecret };
}

/**
 * The redirect URI we register with Google. Must match EXACTLY what's
 * configured on the OAuth client. Both production (https://thoughtbed.com)
 * and localhost should be registered there.
 */
export function gmailRedirectUri(): string {
  return `${resolveAppBaseUrl()}/api/connectors/gmail/callback`;
}

// ─── authorize URL ──────────────────────────────────────

/**
 * Build the Google authorize URL the user gets redirected to. We always
 * pass access_type=offline + prompt=consent so that re-consent yields a
 * fresh refresh_token (without prompt=consent, Google may omit
 * refresh_token on subsequent consents and we'd be stuck with no way to
 * refresh).
 */
export function buildAuthorizeUrl(input: { state: string }): string {
  const { clientId } = getGmailOAuthClientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  });
  return `${GMAIL_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// ─── code exchange ──────────────────────────────────────

export class GmailOAuthError extends Error {
  status: number;
  detail?: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'GmailOAuthError';
    this.status = status;
    this.detail = detail;
  }
}

async function postTokenRequest(
  body: URLSearchParams
): Promise<GoogleTokenResponse> {
  const res = await fetch(GMAIL_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new GmailOAuthError(
      `Google token endpoint returned ${res.status}`,
      res.status,
      detail
    );
  }
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Exchange a one-time auth code for {access_token, refresh_token, …}.
 * The first time a test user grants consent, refresh_token IS returned;
 * with prompt=consent every subsequent run also returns one.
 */
export async function exchangeCodeForTokens(input: {
  code: string;
}): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getGmailOAuthClientCredentials();
  const body = new URLSearchParams({
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: gmailRedirectUri(),
    grant_type: 'authorization_code',
  });
  return postTokenRequest(body);
}

/**
 * Mint a fresh access token from a stored refresh token. Google does not
 * return a new refresh_token on refresh — caller keeps using the
 * original.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getGmailOAuthClientCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  return postTokenRequest(body);
}

// ─── userinfo ────────────────────────────────────────────

export async function fetchGoogleUserInfo(input: {
  accessToken: string;
}): Promise<GoogleUserInfo> {
  const res = await fetch(GMAIL_OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new GmailOAuthError(
      `Google userinfo endpoint returned ${res.status}`,
      res.status,
      detail
    );
  }
  return (await res.json()) as GoogleUserInfo;
}

// ─── helpers ────────────────────────────────────────────

/**
 * Compute a wall-clock expiry for a token from Google's expires_in
 * (seconds). Subtract the leeway so we refresh just before actual expiry.
 */
export function computeAccessTokenExpiry(expiresInSec: number): number {
  return Date.now() + (expiresInSec - GMAIL_OAUTH_REFRESH_LEEWAY_S) * 1000;
}

/** Is this token within the leeway window of expiring? */
export function accessTokenIsStale(expiresAtMs: number): boolean {
  return Date.now() >= expiresAtMs;
}
