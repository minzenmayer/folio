// Thoughtbed · Obsidian-via-GitHub vault client (Sprint 15 Wave 2).
//
// Obsidian has no hosted API. The integration model picks (A) Git-backed
// vault: the user pushes their vault to a GitHub repo, we pull the .md
// files via the GitHub REST API on a daily cron + a push webhook (through
// the Wave-1 dispatcher).
//
// API surface used:
//   GET    /repos/{o}/{r}                                        — branch resolution
//   GET    /repos/{o}/{r}/git/trees/{branch}?recursive=1         — full vault tree
//   GET    /repos/{o}/{r}/git/blobs/{sha}                        — fetch one file
//   POST   /repos/{o}/{r}/hooks                                  — provision push webhook
//   DELETE /repos/{o}/{r}/hooks/{id}                             — revoke push webhook
//
// Auth: a read-only Personal Access Token (PAT) with `repo:read` scope on
// the vault repo. The connect action validates the PAT by hitting the
// repo metadata endpoint before we accept it; we never store plaintext
// (encryption goes through src/lib/crypto.ts).
//
// Errors raise `GitHubError` with a status code so server actions can
// map cleanly to user-facing reasons (auth_failed / not_found / rate_limited /
// error). We deliberately don't pull `@octokit` — the surface is small
// enough that fetch + fetch keeps the dependency footprint lean.

const BASE = 'https://api.github.com';

const RATE_LIMIT_COOLDOWN_THRESHOLD = 50; // sleep when this few left in the bucket
const MAX_429_RETRIES = 2;

export class GitHubError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = 'github_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'GitHubError';
  }
}

// ─── shapes (subset; keep narrow on purpose) ───────────────

export type GitHubRepoMeta = {
  full_name: string;
  default_branch: string;
  private: boolean;
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
};

export type GitTreeEntry = {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url?: string;
};

export type GitTree = {
  sha: string;
  tree: GitTreeEntry[];
  truncated: boolean;
};

export type GitBlob = {
  sha: string;
  size: number;
  encoding: 'base64' | 'utf-8';
  content: string;
};

export type GitHubHook = {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url?: string;
    content_type?: string;
    secret?: string;
    insecure_ssl?: string;
  };
};

// ─── URL parsing ───────────────────────────────────────

/**
 * Accept the common shapes a user might paste:
 *
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/main
 *   git@github.com:owner/repo.git
 *   owner/repo
 *
 * Returns { owner, repo } or null when nothing matches. Caller surfaces
 * the failure to the user — the connect form should reject early.
 */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // SSH: git@github.com:owner/repo(.git)
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  // HTTPS: https://github.com/owner/repo[/...]
  const https = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/
  );
  if (https) return { owner: https[1], repo: https[2] };

  // Bare: owner/repo
  const bare = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (bare) return { owner: bare[1], repo: bare[2] };

  return null;
}

// ─── core fetch wrapper ────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function maybeCooldown(headers: Headers) {
  const remainingHeader = headers.get('x-ratelimit-remaining');
  const resetHeader = headers.get('x-ratelimit-reset');
  if (!remainingHeader || !resetHeader) return;
  const remaining = Number(remainingHeader);
  const resetEpoch = Number(resetHeader);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetEpoch)) return;
  if (remaining > RATE_LIMIT_COOLDOWN_THRESHOLD) return;
  const waitMs = Math.max(0, resetEpoch * 1000 - Date.now());
  // Cap the wait — GitHub resets are 1h windows, we don't actually want to
  // hold a request for that long; better to surface a rate_limited error
  // and let the cron retry on its next tick.
  if (waitMs > 0 && waitMs < 30_000) await sleep(waitMs);
}

type CallOpts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
};

async function callGitHub<T>(
  pat: string,
  path: string,
  opts: CallOpts = {},
  attempt = 0
): Promise<T> {
  const { method = 'GET', body } = opts;
  const url = path.startsWith('http') ? path : BASE + path;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'thoughtbed-connector/1.0',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if ((res.status === 429 || res.status === 403) && attempt < MAX_429_RETRIES) {
    // GitHub uses 403 with Retry-After or x-ratelimit-remaining=0 for
    // secondary rate limits; treat both as transient.
    const retryAfter = Number(res.headers.get('retry-after') ?? '0');
    const backoff =
      retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    if (res.status === 403) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1');
      if (remaining > 0) {
        // Real 403 (permission), not rate limit — fall through to error.
      } else {
        await sleep(backoff);
        return callGitHub<T>(pat, path, opts, attempt + 1);
      }
    } else {
      await sleep(backoff);
      return callGitHub<T>(pat, path, opts, attempt + 1);
    }
  }

  if (res.status === 204) {
    await maybeCooldown(res.headers);
    return undefined as T;
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }
    const code =
      res.status === 401
        ? 'auth_failed'
        : res.status === 403
          ? 'forbidden'
          : res.status === 404
            ? 'not_found'
            : res.status === 429
              ? 'rate_limited'
              : 'github_error';
    const message =
      typeof body === 'object' && body && 'message' in body
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (body as any).message ?? `GitHub ${res.status}`
        : `GitHub ${res.status}`;
    throw new GitHubError(message, res.status, code);
  }

  await maybeCooldown(res.headers);
  return (await res.json()) as T;
}

// ─── endpoints ─────────────────────────────────────────

/** Fetch repo metadata. Used to validate a freshly-pasted PAT + repo url. */
export async function getRepo(
  pat: string,
  owner: string,
  repo: string
): Promise<GitHubRepoMeta> {
  return callGitHub<GitHubRepoMeta>(pat, `/repos/${owner}/${repo}`);
}

/**
 * Recursive tree at a branch tip. The recursive=1 option returns every
 * blob under the tree; for vaults of more than ~100k entries GitHub will
 * mark the response truncated=true, in which case the caller should
 * fall back to per-folder traversal. We don't expect to hit that.
 */
export async function getBranchTree(
  pat: string,
  owner: string,
  repo: string,
  branch: string
): Promise<GitTree> {
  return callGitHub<GitTree>(
    pat,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
}

/**
 * Single file content as base64. Caller decodes — we don't expand here so
 * binary blobs stay opaque.
 */
export async function getBlob(
  pat: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitBlob> {
  return callGitHub<GitBlob>(pat, `/repos/${owner}/${repo}/git/blobs/${sha}`);
}

/**
 * Fetch a file by path at a specific ref (commit / branch). Returns
 * decoded UTF-8 content. Used by webhook handling so we don't have to
 * walk the tree just to get one changed file.
 */
export async function getFileAtRef(
  pat: string,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<{ content: string; sha: string }> {
  type ContentResponse = {
    content?: string;
    encoding?: string;
    sha: string;
    type: string;
  };
  const res = await callGitHub<ContentResponse>(
    pat,
    `/repos/${owner}/${repo}/contents/${encodePathForUrl(path)}?ref=${encodeURIComponent(ref)}`
  );
  if (res.type !== 'file' || !res.content) {
    throw new GitHubError(`Not a file: ${path}`, 404, 'not_found');
  }
  const decoded =
    res.encoding === 'base64'
      ? Buffer.from(res.content, 'base64').toString('utf8')
      : res.content;
  return { content: decoded, sha: res.sha };
}

/**
 * Encode a slash-separated path for GitHub's contents endpoint. Each
 * segment must be percent-encoded individually so directory separators
 * stay intact.
 */
function encodePathForUrl(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ─── webhooks ──────────────────────────────────────────

/**
 * Subscribe to push events. We pass a `secret` we generate ourselves so
 * X-Hub-Signature-256 verification on the receiving end uses a key we
 * control (mirrors Beehiiv's pattern). GitHub stores the secret server-
 * side and never returns it on subsequent reads.
 */
export async function createPushHook(
  pat: string,
  owner: string,
  repo: string,
  body: { url: string; secret: string }
): Promise<GitHubHook> {
  return callGitHub<GitHubHook>(
    pat,
    `/repos/${owner}/${repo}/hooks`,
    {
      method: 'POST',
      body: {
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url: body.url,
          content_type: 'json',
          secret: body.secret,
          insecure_ssl: '0',
        },
      },
    }
  );
}

/** Idempotent revoke. 404 is mapped to silent success. */
export async function deleteHook(
  pat: string,
  owner: string,
  repo: string,
  hookId: string | number
): Promise<void> {
  try {
    await callGitHub<void>(pat, `/repos/${owner}/${repo}/hooks/${hookId}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return;
    throw err;
  }
}

// ─── helpers consumed by the sync engine ──────────────

/**
 * Decode a blob's base64 payload as UTF-8. Returns null when the encoding
 * is unexpected (the engine treats null as "skip this file").
 */
export function decodeBlobUtf8(blob: GitBlob): string | null {
  if (blob.encoding === 'base64') {
    try {
      return Buffer.from(blob.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (blob.encoding === 'utf-8') {
    return blob.content;
  }
  return null;
}

/**
 * Test whether a tree entry is a Markdown file under the size cap. We
 * skip files larger than 1 MB (Obsidian notes shouldn't approach that;
 * a runaway file is more likely a paste mistake than real content).
 */
export function isVaultMarkdown(entry: GitTreeEntry, maxBytes = 1_048_576): boolean {
  if (entry.type !== 'blob') return false;
  if (!/\.md$/i.test(entry.path)) return false;
  if (typeof entry.size === 'number' && entry.size > maxBytes) return false;
  // skip hidden / .obsidian / .git internals
  const segments = entry.path.split('/');
  if (segments.some((s) => s.startsWith('.'))) return false;
  return true;
}
