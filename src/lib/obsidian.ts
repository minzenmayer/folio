/**
 * src/lib/obsidian.ts
 *
 * Read-only GitHub vault client for the Obsidian connector.
 *
 * Responsibilities
 * ────────────────
 * • Fetch the full file tree of a GitHub-backed Obsidian vault.
 * • Download individual blob contents (raw bytes → UTF-8 string).
 * • Verify X-Hub-Signature-256 on incoming webhook payloads.
 * • Normalise GitHub push-event payloads into a typed PushPayload.
 *
 * Auth
 * ────
 * All requests are authenticated with a GitHub Personal Access Token
 * (PAT) supplied as `token`.  The PAT must have at minimum `contents:read`
 * on the vault repository.  Write access is never requested.
 *
 * No external runtime dependencies — only the built-in `crypto` module
 * and native `fetch`.
 */

import { createHmac, timingSafeEqual } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultTreeEntry {
  /** Vault-relative path, e.g. "notes/foo.md" */
  path: string;
  /** Git blob SHA — used as a short-circuit to skip unchanged blobs. */
  sha: string;
  /** Byte size reported by the Git tree. */
  size: number;
}

export interface VaultBlob {
  path: string;
  /** Raw UTF-8 content of the file. */
  content: string;
  sha: string;
}

export interface PushPayload {
  /** Vault repo in "owner/repo" form. */
  repoFull: string;
  /** Branch that received the push. */
  ref: string;
  /** Commits included in the push event. */
  commits: Array<{
    id: string;
    added:    string[];
    modified: string[];
    removed:  string[];
  }>;
  /** Raw GitHub delivery ID for idempotency logging. */
  deliveryId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses a GitHub repository URL into "owner/repo" form.
 * Accepts HTTPS, SSH, and bare "owner/repo" strings.
 *
 * @example
 * parseRepoUrl('https://github.com/acme/vault')  // → 'acme/vault'
 * parseRepoUrl('git@github.com:acme/vault.git')  // → 'acme/vault'
 * parseRepoUrl('acme/vault')                     // → 'acme/vault'
 */
export function parseRepoUrl(url: string): string {
  url = url.trim();

  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/^git@github\.com:([^/]+\/[^/]+?)(\.git)?$/);
  if (ssh) return ssh[1];

  // HTTPS: https://github.com/owner/repo[.git]
  const https = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/?#]+?)(\.git)?(?:[/?#].*)?$/);
  if (https) return https[1];

  // Bare owner/repo[.git]
  const bare = url.match(/^([\w.-]+\/[\w.-]+?)(\.git)?$/);
  if (bare) return bare[1];

  throw new Error(`Cannot parse GitHub repository URL: ${url}`);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept:        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghFetch(
  url: string,
  token: string,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(url, { headers: ghHeaders(token), signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} — ${url}\n${body}`);
  }
  return res;
}

// ── Tree ─────────────────────────────────────────────────────────────────────

/**
 * Returns a flat list of every blob (file) in the repository tree.
 * Uses the recursive Git Trees endpoint — one request for the whole vault.
 *
 * Directories and submodules are filtered out; only `blob` type entries
 * are returned.
 *
 * @param repoFull  "owner/repo"
 * @param ref       Branch/tag/SHA to walk (default: "HEAD")
 * @param token     GitHub PAT with `contents:read`
 */
export async function fetchVaultTree(
  repoFull: string,
  ref: string = 'HEAD',
  token: string,
  signal?: AbortSignal
): Promise<VaultTreeEntry[]> {
  const url =
    `https://api.github.com/repos/${repoFull}/git/trees/${ref}?recursive=1`;
  const res = await ghFetch(url, token, signal);
  const json = await res.json() as {
    tree: Array<{ path: string; type: string; sha: string; size: number }>;
    truncated: boolean;
  };

  if (json.truncated) {
    console.warn(
      `[obsidian] vault tree for ${repoFull} was truncated — very large vault`
    );
  }

  return json.tree
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
}

// ── Blobs ────────────────────────────────────────────────────────────────────

/**
 * Fetches the raw UTF-8 content of a single blob.
 *
 * Uses the raw content media type to avoid the 1 MB base64 limit of
 * the standard Blobs endpoint.
 *
 * @param repoFull  "owner/repo"
 * @param sha       The blob SHA from the tree listing
 * @param token     GitHub PAT
 */
export async function fetchBlob(
  repoFull: string,
  sha: string,
  token: string,
  signal?: AbortSignal
): Promise<string> {
  const url = `https://api.github.com/repos/${repoFull}/git/blobs/${sha}`;
  const res = await fetch(url, {
    headers: {
      ...ghHeaders(token),
      Accept: 'application/vnd.github.raw',
    },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub blob ${res.status} — ${url}\n${body}`);
  }
  return res.text();
}

// ── Webhook verification ──────────────────────────────────────────────────────

/**
 * Verifies a GitHub webhook X-Hub-Signature-256 header.
 *
 * Throws if the signature is missing, malformed, or does not match.
 * Uses `timingSafeEqual` to prevent timing attacks.
 *
 * @param payload     Raw request body as a Buffer or string
 * @param signature   Value of the X-Hub-Signature-256 header
 * @param secret      The webhook secret configured on GitHub
 */
export function verifyWebhookSignature(
  payload: Buffer | string,
  signature: string | null | undefined,
  secret: string
): void {
  if (!signature) {
    throw new Error('Missing X-Hub-Signature-256 header');
  }
  const [algo, hex] = signature.split('=');
  if (algo !== 'sha256' || !hex) {
    throw new Error(`Unexpected signature format: ${signature}`);
  }

  const buf    = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const digest = createHmac('sha256', secret).update(buf).digest();
  const given  = Buffer.from(hex, 'hex');

  if (digest.length !== given.length || !timingSafeEqual(digest, given)) {
    throw new Error('Webhook signature verification failed');
  }
}

// ── Push-event normalisation ──────────────────────────────────────────────────

interface RawGitHubPushEvent {
  repository?: { full_name?: string };
  ref?: string;
  commits?: Array<{
    id?: string;
    added?:    string[];
    modified?: string[];
    removed?:  string[];
  }>;
}

/**
 * Normalises a raw GitHub `push` webhook payload into our typed
 * `PushPayload` shape.  Missing or malformed fields are defaulted
 * rather than throwing, so transient delivery quirks don't break sync.
 *
 * @param raw         Parsed JSON body of the webhook POST
 * @param deliveryId  Value of the X-GitHub-Delivery header
 */
export function normalizePushEvent(
  raw: unknown,
  deliveryId: string
): PushPayload {
  const ev = (raw ?? {}) as RawGitHubPushEvent;
  return {
    repoFull:   ev.repository?.full_name ?? '',
    ref:        ev.ref ?? '',
    deliveryId,
    commits: (ev.commits ?? []).map((c) => ({
      id:       c.id       ?? '',
      added:    c.added    ?? [],
      modified: c.modified ?? [],
      removed:  c.removed  ?? [],
    })),
  };
}
