// Thoughtbed · Beehiiv API client (Sprint 13).
//
// Typed wrapper around the bits of the Beehiiv v2 API the connector cares
// about: list publications, list posts (with expanded HTML), get a single
// post. Auth is bearer-token (the user's workspace API key). No OAuth.
//
// API surface used:
//   GET    /v2/publications                                  — resolve publicationId
//   GET    /v2/publications/{pubId}/posts?expand=...&page=N  — paginated archive
//   GET    /v2/publications/{pubId}/posts/{postId}           — single post refresh
//   POST   /v2/publications/{pubId}/webhooks                 — Sprint 15 Wave 1: subscribe
//   DELETE /v2/publications/{pubId}/webhooks/{whId}          — Sprint 15 Wave 1: unsubscribe
//
// Rate limit: 180 req/min per organization. We don't actively throttle
// here — the founder's archive is small enough to never approach that —
// but we do honour `RateLimit-Remaining` by sleeping when it dips, and
// retry once on 429 with exponential backoff.
//
// Errors raise `BeehiivError` with a status code and the upstream message
// so server actions can map to user-friendly states (auth_failed,
// rate_limited, error).

const BASE = 'https://api.beehiiv.com/v2';

const RATE_LIMIT_COOLDOWN_THRESHOLD = 10; // sleep when this few left
const MAX_429_RETRIES = 2;

export class BeehiivError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = 'beehiiv_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'BeehiivError';
  }
}

// ─── shapes (subset; keep narrow on purpose) ───────────────────────

export type BeehiivPublication = {
  id: string;
  name: string;
  description?: string | null;
  url?: string | null;
  organization_name?: string | null;
};

// Beehiiv's PostExpandField values we care about.
export type PostExpand =
  | 'stats'
  | 'free_web_content'
  | 'free_email_content'
  | 'free_rss_content'
  | 'premium_web_content'
  | 'premium_email_content';

export type BeehiivPost = {
  id: string;
  title: string;
  subtitle?: string | null;
  slug?: string | null;
  web_url?: string | null;
  audience?: 'free' | 'premium' | 'all' | null;
  // Beehiiv: 'draft' | 'confirmed' | 'archived'
  status?: string | null;
  publish_date?: number | null; // Unix epoch seconds
  displayed_date?: number | null;
  // NOTE: As of the Wave 1 spike against the live API, Beehiiv does NOT
  // return `status_changed_at` on the posts list response. Our upsert
  // logic falls back to "always re-write" when it's null, so syncs do
  // a bit of extra embedding work — fine at our archive size. Kept in
  // the type for future-proofing in case Beehiiv re-adds it.
  status_changed_at?: number | null;
  created?: number | null;
  thumbnail_url?: string | null;
  content_tags?: string[] | null;
  authors?: string[] | null;
  // Present when expand includes the matching content field.
  content?: {
    free?: {
      web?: string;
      email?: string;
      rss?: string;
    };
    premium?: {
      web?: string;
      email?: string;
    };
  };
};

type ListPostsParams = {
  publicationId: string;
  page?: number;
  limit?: number;
  expand?: PostExpand[];
  status?: 'draft' | 'confirmed' | 'archived' | 'all';
  platform?: 'web' | 'email' | 'both' | 'all';
  orderBy?: 'created' | 'publish_date' | 'displayed_date';
  direction?: 'asc' | 'desc';
};

// ─── core fetch wrapper ────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function maybeCooldown(headers: Headers) {
  const remainingHeader = headers.get('ratelimit-remaining');
  const resetHeader = headers.get('ratelimit-reset');
  if (!remainingHeader || !resetHeader) return;
  const remaining = Number(remainingHeader);
  const resetEpoch = Number(resetHeader);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetEpoch)) return;
  if (remaining > RATE_LIMIT_COOLDOWN_THRESHOLD) return;
  const waitMs = Math.max(0, resetEpoch * 1000 - Date.now());
  if (waitMs > 0 && waitMs < 65_000) await sleep(waitMs);
}

type CallOpts = {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | string[] | number | undefined>;
  body?: unknown;
};

async function callBeehiiv<T>(
  apiKey: string,
  path: string,
  opts: CallOpts = {},
  attempt = 0
): Promise<T> {
  const { method = 'GET', query, body } = opts;
  const url = new URL(BASE + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // Beehiiv expects repeated `key[]=v1&key[]=v2` form for arrays.
        const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
        for (const v of value) url.searchParams.append(arrayKey, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Beehiiv responses are user-scoped; never want a stale cached page.
    cache: 'no-store',
  });

  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    await sleep(backoff);
    return callBeehiiv<T>(apiKey, path, opts, attempt + 1);
  }

  // 204 No Content (DELETE) — nothing to parse.
  if (res.status === 204) {
    await maybeCooldown(res.headers);
    return undefined as T;
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // surface raw text if not JSON
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }
    const code =
      res.status === 401 || res.status === 403
        ? 'auth_failed'
        : res.status === 429
          ? 'rate_limited'
          : 'beehiiv_error';
    const message =
      typeof body === 'object' && body && 'errors' in body
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (body as any).errors?.[0]?.message ?? `Beehiiv ${res.status}`
        : `Beehiiv ${res.status}`;
    throw new BeehiivError(message, res.status, code);
  }

  await maybeCooldown(res.headers);

  return (await res.json()) as T;
}

// ─── endpoints ──────────────────────────────────────────

/** Resolve which publication(s) the API key has access to. */
export async function listPublications(
  apiKey: string
): Promise<BeehiivPublication[]> {
  const res = await callBeehiiv<{ data: BeehiivPublication[] }>(
    apiKey,
    '/publications',
    { query: { limit: 100 } }
  );
  return res.data ?? [];
}

/**
 * One page of posts. Caller pages through with `page=1..N` until an
 * empty `data` array signals end of archive.
 */
export async function listPosts(
  apiKey: string,
  params: ListPostsParams
): Promise<BeehiivPost[]> {
  const res = await callBeehiiv<{ data: BeehiivPost[] }>(
    apiKey,
    `/publications/${params.publicationId}/posts`,
    {
      query: {
        page: params.page ?? 1,
        limit: params.limit ?? 50,
        expand: params.expand?.length ? params.expand : undefined,
        status: params.status ?? 'confirmed',
        platform: params.platform ?? 'both',
        order_by: params.orderBy ?? 'publish_date',
        direction: params.direction ?? 'desc',
      },
    }
  );
  return res.data ?? [];
}

/**
 * Walk the full archive, page by page, stopping when a page is shorter
 * than `limit` (last page reached). Used by the manual sync action.
 */
export async function listAllPosts(
  apiKey: string,
  params: Omit<ListPostsParams, 'page'>
): Promise<BeehiivPost[]> {
  const limit = params.limit ?? 50;
  const out: BeehiivPost[] = [];
  for (let page = 1; page < 1000; page++) {
    const batch = await listPosts(apiKey, { ...params, page, limit });
    out.push(...batch);
    if (batch.length < limit) break;
  }
  return out;
}

/** Re-fetch a single post (used by the webhook handler in Sprint 15). */
export async function getPost(
  apiKey: string,
  publicationId: string,
  postId: string,
  expand: PostExpand[] = ['free_web_content']
): Promise<BeehiivPost> {
  const res = await callBeehiiv<{ data: BeehiivPost }>(
    apiKey,
    `/publications/${publicationId}/posts/${postId}`,
    { query: { expand } }
  );
  return res.data;
}

// ─── webhooks (Sprint 15 Wave 1) ──────────────────────────

/**
 * Beehiiv webhook event types we care about. Beehiiv exposes more (e.g.
 * subscription.created) but Sprint 15 Wave 1 only subscribes to post.sent
 * — the moment a published issue lands. Subscriptions / opens / clicks
 * are out of scope for the Bed.
 */
export type BeehiivWebhookEvent = 'post.sent';

export type BeehiivWebhook = {
  id: string;
  url: string;
  event_types: BeehiivWebhookEvent[];
  description?: string | null;
  /**
   * Returned ONLY on creation. We mirror it to
   * connector_accounts.metadata.webhookSecret immediately and never round-
   * trip it through Beehiiv again — they wouldn't return it on subsequent
   * GETs even if we asked.
   */
  signing_secret?: string;
  status?: string;
};

/**
 * Subscribe to events for a publication. We keep the request body
 * minimal and let Beehiiv pick a signing secret — that secret comes
 * back on this single response and is the only thing we ever store.
 */
export async function createWebhook(
  apiKey: string,
  publicationId: string,
  body: {
    url: string;
    event_types: BeehiivWebhookEvent[];
    description?: string;
  }
): Promise<BeehiivWebhook> {
  const res = await callBeehiiv<{ data: BeehiivWebhook }>(
    apiKey,
    `/publications/${publicationId}/webhooks`,
    { method: 'POST', body }
  );
  return res.data;
}

/**
 * Idempotent revoke. 404 from Beehiiv (already deleted) is mapped to a
 * silent success so a half-failed Disconnect can be retried cleanly.
 */
export async function deleteWebhook(
  apiKey: string,
  publicationId: string,
  webhookId: string
): Promise<void> {
  try {
    await callBeehiiv<void>(
      apiKey,
      `/publications/${publicationId}/webhooks/${webhookId}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (err instanceof BeehiivError && err.status === 404) return;
    throw err;
  }
}
