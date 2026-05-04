// Thoughtbed · Apify HTTP client (Phase 12, 2026-05-04)
//
// Thin wrapper over the Apify REST API for the LinkedIn connector.
// Apify's full SDK pulls a lot of weight we don't need — we only call
// three endpoints:
//
//   · POST /v2/acts/{actorId}/runs            — start a run async
//   · GET  /v2/actor-runs/{runId}             — poll status
//   · GET  /v2/datasets/{datasetId}/items     — fetch results
//
// All requests are token-authed via Authorization: Bearer. The token
// comes from APIFY_API_TOKEN (set on Vercel env). At Thoughtbed's
// current single-tenant scale the token is platform-level — when we
// open up to other users we'll move it onto connector_accounts and
// per-user-encrypt it like Beehiiv's API key.
//
// Polling note: Apify runs for harvestapi/linkedin-profile-posts take
// 7s for 5 posts and minutes for hundreds. We never block a server
// action on a full run — the connector starts a run, stores the runId
// in connector_accounts.metadata, and a separate poll-and-finalize
// path drains the dataset when the run completes.

const APIFY_BASE = 'https://api.apify.com/v2';

// LinkedIn Profile Posts Scraper (No Cookies) by HarvestAPI.
// Internal actor id: A3cAPGpwBEG8RJwse. The slug also resolves but the
// id is more stable across actor renames.
export const HARVEST_LINKEDIN_PROFILE_POSTS_ACTOR_ID =
  'harvestapi~linkedin-profile-posts';

export type ApifyRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'
  | 'ABORTING'
  | 'ABORTED';

export type ApifyRun = {
  id: string;
  actId: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  startedAt: string;
  finishedAt: string | null;
  // Money, in USD. Populated as the run progresses.
  usageUsd?: number;
  // Number of items written to the default dataset.
  itemCount?: number;
};

export class ApifyError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApifyError';
  }
}

// ─── token helper ──────────────────────────────────────

/**
 * Resolve the Apify API token from env. Throws a clear ApifyError if
 * it's missing — the connector's connect path catches this and surfaces
 * "set APIFY_API_TOKEN in Vercel" rather than a generic 500.
 */
export function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new ApifyError(
      500,
      'APIFY_API_TOKEN is not set on the server. Add it to the Vercel project env vars and redeploy.'
    );
  }
  return token;
}

// ─── core fetcher ──────────────────────────────────────

async function apifyFetch<T>(
  path: string,
  init: RequestInit = {},
  token = getApifyToken()
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${APIFY_BASE}${path}`, { ...init, headers });
  const text = await res.text();

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      (body as { error?: { message?: string } })?.error?.message ||
      (typeof body === 'string' ? body : `${res.status} ${res.statusText}`);
    throw new ApifyError(res.status, message, body);
  }

  // Apify wraps successful responses as { data: ... } — unwrap.
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

// ─── run lifecycle ─────────────────────────────────────

/**
 * Start an actor run async and return immediately.
 *
 * Caller persists `run.id` (and optionally `run.defaultDatasetId`) on
 * connector_accounts.metadata so a later poll-and-finalize can pick up
 * the results.
 */
export async function startActorRun(
  actorId: string,
  input: Record<string, unknown>,
  options: { token?: string; build?: string } = {}
): Promise<ApifyRun> {
  const params = new URLSearchParams();
  if (options.build) params.set('build', options.build);
  const qs = params.toString();
  return apifyFetch<ApifyRun>(
    `/acts/${encodeURIComponent(actorId)}/runs${qs ? `?${qs}` : ''}`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    options.token
  );
}

/** GET the current state of an in-flight or finished run. */
export async function getActorRun(
  runId: string,
  options: { token?: string } = {}
): Promise<ApifyRun> {
  return apifyFetch<ApifyRun>(
    `/actor-runs/${encodeURIComponent(runId)}`,
    {},
    options.token
  );
}

/** True while Apify is still working on the run. */
export function isRunPending(status: ApifyRunStatus): boolean {
  return (
    status === 'READY' || status === 'RUNNING' || status === 'TIMING-OUT'
  );
}

/** True if the run finished with a usable dataset. */
export function isRunSucceeded(status: ApifyRunStatus): boolean {
  return status === 'SUCCEEDED';
}

// ─── dataset items ─────────────────────────────────────

/**
 * Stream a dataset's items as a flat array. Apify caps a single response
 * at 50,000 items by default, more than enough for any LinkedIn profile.
 */
export async function listDatasetItems<T = unknown>(
  datasetId: string,
  options: { token?: string; limit?: number; offset?: number } = {}
): Promise<T[]> {
  const params = new URLSearchParams({ format: 'json', clean: '1' });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  return apifyFetch<T[]>(
    `/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`,
    {},
    options.token
  );
}

// ─── LinkedIn-specific shape ───────────────────────────

/**
 * Subset of harvestapi/linkedin-profile-posts output we actually consume.
 * The actor returns more fields (postImages, socialContent, contentAttributes,
 * etc.) which we keep only on linkedin_posts.raw for forensic / forward-
 * compat purposes; everything we read on the hot path lives here.
 */
export type HarvestLinkedinPost = {
  type?: string;
  id?: string;
  linkedinUrl?: string;
  content?: string;
  postedAt?: {
    timestamp?: number;
    date?: string;
    postedAgoShort?: string;
    postedAgoText?: string;
  };
  author?: {
    id?: string;
    publicIdentifier?: string;
    name?: string;
    info?: string;
    linkedinUrl?: string;
  };
  postImages?: Array<{ url?: string }>;
  reactions?: { count?: number };
  comments?: { count?: number };
  shares?: { count?: number };
  // Some actor builds use these top-level instead of nested.
  reactionCount?: number;
  commentCount?: number;
  shareCount?: number;
};

/**
 * Convenience: kick off a profile posts scrape and return the runId.
 * Caller polls with getActorRun + drains with listDatasetItems.
 */
export async function startProfilePostsScrape(
  profileUrl: string,
  options: { token?: string; maxItems?: number } = {}
): Promise<ApifyRun> {
  return startActorRun(
    HARVEST_LINKEDIN_PROFILE_POSTS_ACTOR_ID,
    {
      // The actor's input schema accepts `targetUrls` for the harvestapi
      // builds; some forks call the same field `startUrls`. Send both
      // shapes — the unrecognized one is ignored.
      targetUrls: [profileUrl],
      startUrls: [{ url: profileUrl }],
      maxItems: options.maxItems ?? 1000,
      maxPosts: options.maxItems ?? 1000,
    },
    { token: options.token }
  );
}
