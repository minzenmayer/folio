// Thoughtbed · /api/connectors/gmail/initiate (Phase 13, 2026-05-04)
//
// Step 1 of the OAuth dance. Auth-gated: requireUser ensures we know
// who's connecting before we send them out to Google. We mint a CSRF
// nonce, drop it in an HttpOnly cookie + the ?state param, then 302 to
// Google's authorize URL.
//
// On callback, /api/connectors/gmail/callback compares the cookie to
// ?state and rejects mismatches.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { requireUser } from '@/lib/auth';
import {
  buildAuthorizeUrl,
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_OAUTH_STATE_TTL_S,
  GmailOAuthConfigError,
} from '@/lib/gmail/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request) {
  // Gate: must be signed in. requireUser redirects to /sign-in if not.
  const user = await requireUser();

  let authorizeUrl: string;
  let state: string;
  try {
    // 32 bytes of randomness, hex-encoded → 64 chars. Combined with the
    // userId so the callback can sanity-check we're handing back to the
    // same user who initiated.
    const nonce = randomBytes(32).toString('hex');
    state = `${nonce}.${user.id}`;
    authorizeUrl = buildAuthorizeUrl({ state });
  } catch (err) {
    if (err instanceof GmailOAuthConfigError) {
      return NextResponse.json(
        {
          ok: false,
          reason: 'config_missing',
          message: err.message,
        },
        { status: 500 }
      );
    }
    throw err;
  }

  // Stash the same nonce in a cookie so the callback can compare. Lax
  // is required for the cookie to ride along with the cross-site
  // redirect from accounts.google.com back to us.
  const jar = await cookies();
  jar.set({
    name: GMAIL_OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: GMAIL_OAUTH_STATE_TTL_S,
  });

  return NextResponse.redirect(authorizeUrl, { status: 302 });
}
