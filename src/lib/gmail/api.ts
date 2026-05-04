// Thoughtbed · Gmail API client (Phase 13, 2026-05-04)
//
// Thin wrapper over Gmail REST. We deliberately don't pull in googleapis
// — that package brings in google-auth-library + a 6MB dep tree we don't
// need for read-only message fetch. Three primitives:
//
//   · getOrRefreshAccessToken(account)
//     Decrypt the secret, mint a fresh access token if the cached one is
//     stale, write the refreshed secret back. Returns a usable access
//     token for the next call.
//
//   · listMessageIds({ accessToken, query, pageToken })
//     users.messages.list — used for the initial backfill pass. We pass
//     a Gmail search query (e.g. category:promotions OR in:inbox) and
//     paginate.
//
//   · listHistory({ accessToken, startHistoryId, pageToken })
//     users.history.list — used for incremental sync. Returns added /
//     removed / labelChanged events since the last sync's historyId.
//
//   · getMessage({ accessToken, messageId })
//     users.messages.get — full payload incl. headers, body parts.
//
//   · parseGmailMessage(raw) — pure: pulls headers, extracts
//     plaintext + HTML, returns a normalized shape.

import { eq } from 'drizzle-orm';
import { db, connectorAccounts, type ConnectorAccount } from '@/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import {
  refreshAccessToken,
  computeAccessTokenExpiry,
  accessTokenIsStale,
  GmailOAuthError,
  type GmailOAuthSecret,
} from '@/lib/gmail/oauth';

// ─── error type ─────────────────────────────────────────

export class GmailApiError extends Error {
  status: number;
  detail?: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
    this.detail = detail;
  }
}

// ─── secret helpers ─────────────────────────────────────

function loadSecret(account: ConnectorAccount): GmailOAuthSecret {
  if (!account.encryptedSecret) {
    throw new GmailApiError('Connector has no stored OAuth secret.', 410);
  }
  let plaintext: string;
  try {
    plaintext = decryptSecret(account.encryptedSecret);
  } catch (err) {
    throw new GmailApiError(
      `Failed to decrypt OAuth secret: ${(err as Error).message}`,
      500
    );
  }
  let parsed: GmailOAuthSecret;
  try {
    parsed = JSON.parse(plaintext) as GmailOAuthSecret;
  } catch {
    throw new GmailApiError('Stored OAuth secret is malformed.', 500);
  }
  if (!parsed.refreshToken) {
    throw new GmailApiError('Stored OAuth secret is missing refreshToken.', 500);
  }
  return parsed;
}

async function persistSecret(
  accountId: string,
  secret: GmailOAuthSecret
): Promise<void> {
  const encrypted = encryptSecret(JSON.stringify(secret));
  await db
    .update(connectorAccounts)
    .set({ encryptedSecret: encrypted, updatedAt: new Date() })
    .where(eq(connectorAccounts.id, accountId));
}

/**
 * Returns a usable access token. Refreshes via Google's /token endpoint
 * if the cached token is within the leeway window of expiring. The new
 * token is written back to the encrypted secret so subsequent requests
 * pick it up without another refresh.
 *
 * Note: Google does NOT issue a new refresh_token on refresh. We keep
 * using the original.
 */
export async function getOrRefreshAccessToken(
  account: ConnectorAccount
): Promise<string> {
  const secret = loadSecret(account);

  if (
    secret.accessToken &&
    secret.accessTokenExpiresAt &&
    !accessTokenIsStale(secret.accessTokenExpiresAt)
  ) {
    return secret.accessToken;
  }

  let tokens;
  try {
    tokens = await refreshAccessToken({ refreshToken: secret.refreshToken });
  } catch (err) {
    if (err instanceof GmailOAuthError) {
      // 400 invalid_grant means the refresh token was revoked (user
      // disconnected at myaccount.google.com or rotated). Surface this
      // as auth_failed so the cron loop can mark the account.
      if (err.status === 400 || err.status === 401) {
        throw new GmailApiError(
          'Refresh token rejected by Google (invalid_grant). User may need to reconnect.',
          401,
          err.detail
        );
      }
      throw new GmailApiError(err.message, err.status, err.detail);
    }
    throw err;
  }

  const next: GmailOAuthSecret = {
    refreshToken: secret.refreshToken,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: computeAccessTokenExpiry(tokens.expires_in),
  };
  await persistSecret(account.id, next);
  return next.accessToken;
}

// ─── HTTP plumbing ──────────────────────────────────────

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailFetch<T>(
  path: string,
  opts: { accessToken: string; query?: Record<string, string | undefined> }
): Promise<T> {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new GmailApiError(
      `Gmail API ${path} returned ${res.status}`,
      res.status,
      detail
    );
  }
  return (await res.json()) as T;
}

// ─── messages.list ──────────────────────────────────────

export type GmailListMessagesResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

/**
 * users.messages.list. q is a Gmail search query — we pass scope-narrowing
 * filters here (e.g. `category:promotions OR list:*`) to keep the result
 * set close to actual newsletters before classification runs.
 */
export async function listMessageIds(input: {
  accessToken: string;
  query?: string;
  pageToken?: string;
  maxResults?: number;
}): Promise<GmailListMessagesResponse> {
  return gmailFetch<GmailListMessagesResponse>('/messages', {
    accessToken: input.accessToken,
    query: {
      q: input.query,
      pageToken: input.pageToken,
      maxResults: input.maxResults ? String(input.maxResults) : '100',
    },
  });
}

// ─── messages.get ───────────────────────────────────────

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: {
    size?: number;
    data?: string;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
};

export type GmailRawMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  raw?: string;
};

export async function getMessage(input: {
  accessToken: string;
  messageId: string;
  format?: 'full' | 'metadata' | 'minimal';
}): Promise<GmailRawMessage> {
  return gmailFetch<GmailRawMessage>(`/messages/${input.messageId}`, {
    accessToken: input.accessToken,
    query: { format: input.format ?? 'full' },
  });
}

// ─── history.list ───────────────────────────────────────

export type GmailHistoryAdded = {
  message: { id: string; threadId: string };
};
export type GmailHistoryRecord = {
  id: string;
  messages?: { id: string; threadId: string }[];
  messagesAdded?: GmailHistoryAdded[];
  // labelsAdded / labelsRemoved / messagesDeleted exist; we only care
  // about messagesAdded for v1.
};

export type GmailHistoryResponse = {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

/**
 * users.history.list — returns diff of mailbox changes since
 * startHistoryId. Cheaper than re-listing on every cron pass.
 *
 * Caveats:
 *   · Gmail trims history older than ~30 days. If startHistoryId is
 *     too old, Google returns 404 and we fall back to a full re-list.
 *   · historyTypes=messageAdded keeps the response focused on new
 *     messages; we don't currently care about label-change history.
 */
export async function listHistory(input: {
  accessToken: string;
  startHistoryId: string;
  pageToken?: string;
  maxResults?: number;
}): Promise<GmailHistoryResponse> {
  return gmailFetch<GmailHistoryResponse>('/history', {
    accessToken: input.accessToken,
    query: {
      startHistoryId: input.startHistoryId,
      pageToken: input.pageToken,
      historyTypes: 'messageAdded',
      maxResults: input.maxResults ? String(input.maxResults) : '500',
    },
  });
}

// ─── parsing ────────────────────────────────────────────

export type ParsedGmailMessage = {
  externalId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, string>;
  internalDateMs: number;
};

/** Decode base64url (Gmail's body encoding) into a Buffer. */
function decodeBase64Url(input: string): Buffer {
  // Gmail uses URL-safe base64 without padding.
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

/**
 * Walk a message's payload tree and return the first text/plain and
 * text/html bodies we encounter. Multi-part messages typically have a
 * top-level multipart/alternative with both — we want both.
 */
function extractBodies(payload: GmailMessagePart | undefined): {
  text: string | null;
  html: string | null;
} {
  if (!payload) return { text: null, html: null };

  let text: string | null = null;
  let html: string | null = null;

  function walk(part: GmailMessagePart): void {
    const mime = (part.mimeType ?? '').toLowerCase();
    const data = part.body?.data;
    if (data && mime === 'text/plain' && text === null) {
      text = decodeBase64Url(data).toString('utf8');
    } else if (data && mime === 'text/html' && html === null) {
      html = decodeBase64Url(data).toString('utf8');
    }
    if (part.parts) {
      for (const sub of part.parts) walk(sub);
    }
  }
  walk(payload);
  return { text, html };
}

/** Crude HTML → text: strip tags, decode common entities, collapse ws. */
export function htmlToText(html: string): string {
  return html
    // <script>/<style> contents discarded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // <br> and block-level closing tags become newlines so paragraphs survive
    .replace(/<\/?(?:br|p|div|h[1-6]|li|tr)[^>]*>/gi, '\n')
    // strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#x2014;/g, '—')
    .replace(/&#x2013;/g, '–')
    // numeric entities (decimal)
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 10));
      } catch {
        return ' ';
      }
    })
    // collapse runs of whitespace, keep paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * RFC-5322 mailbox parser-lite. Handles "Name <addr@host>", "addr@host",
 * and quoted display names. Returns address+name; falls back to raw on
 * malformed input.
 */
export function parseFromHeader(value: string | undefined): {
  address: string | null;
  name: string | null;
} {
  if (!value) return { address: null, name: null };
  const angle = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    let name = angle[1].trim();
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1);
    }
    return { name: name || null, address: angle[2].trim().toLowerCase() };
  }
  // bare addr
  const trimmed = value.trim();
  if (trimmed.includes('@')) {
    return { name: null, address: trimmed.toLowerCase() };
  }
  return { address: null, name: trimmed || null };
}

/**
 * Pure parser. Pulls headers into a map, extracts plaintext/html,
 * normalizes the From line, and coerces internalDate into an ms-epoch.
 * The truncation cap (16k) is applied here so all downstream consumers
 * see the same bounded size.
 */
export const GMAIL_BODY_TEXT_CAP = 16_000;

export function parseGmailMessage(raw: GmailRawMessage): ParsedGmailMessage {
  const headersList = raw.payload?.headers ?? [];
  const headers: Record<string, string> = {};
  for (const h of headersList) {
    if (h.name) headers[h.name.toLowerCase()] = h.value ?? '';
  }

  const { text, html } = extractBodies(raw.payload);
  const bodyTextRaw = text ?? (html ? htmlToText(html) : '');
  const bodyText = bodyTextRaw.slice(0, GMAIL_BODY_TEXT_CAP);
  const bodyHtml = html ?? null;

  const from = parseFromHeader(headers['from']);
  const subject = headers['subject'] ?? null;

  const internalDateMs = raw.internalDate
    ? parseInt(raw.internalDate, 10)
    : Date.now();

  return {
    externalId: raw.id,
    threadId: raw.threadId,
    fromAddress: from.address,
    fromName: from.name,
    subject,
    snippet: raw.snippet ?? null,
    bodyText,
    bodyHtml,
    headers,
    internalDateMs,
  };
}
