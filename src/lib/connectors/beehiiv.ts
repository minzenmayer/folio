/**
 * src/lib/connectors/beehiiv.ts
 *
 * ConnectorProvider implementation for Beehiiv newsletter issues.
 *
 * This module is unchanged in Wave 2 except for one addition:
 * `upsertIssue` now calls `extractIdeas` inline after writing to the DB,
 * so newsletter issues stay in sync with `extracted_ideas` without a
 * separate backfill.
 */

import type { ConnectorProvider, ConnectorCredentials, SyncResult } from './types';
import { db }           from '@/db';
import { newsletterIssues, extractedIdeas } from '@/db/schema';
import { eq }           from 'drizzle-orm';
import { extractIdeas } from '../extract-ideas';

// ── Credential schema ─────────────────────────────────────────────────────────

export interface BeehiivCredentials extends ConnectorCredentials {
  apiKey:         string;
  publicationId:  string;
}

// ── Beehiiv API client helpers ────────────────────────────────────────────────

const BASE = 'https://api.beehiiv.com/v2';

async function bFetch(
  path:  string,
  token: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Beehiiv API ${res.status} — ${path}\n${body}`);
  }
  return res;
}

interface BeehiivIssue {
  id:           string;
  subject:      string;
  subtitle?:    string;
  content_html?: string;
  content_text?: string;
  tags?:        string[];
  publish_date?: number;   // Unix timestamp
  status:       string;
}

async function fetchAllIssues(
  publicationId: string,
  apiKey:        string
): Promise<BeehiivIssue[]> {
  const issues: BeehiivIssue[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const res  = await bFetch(
      `/publications/${publicationId}/posts?limit=${limit}&page=${page}&expand[]=free_web_content`,
      apiKey
    );
    const json = await res.json() as { data: BeehiivIssue[]; next_page?: number };
    issues.push(...json.data);
    if (!json.next_page || json.data.length < limit) break;
    page = json.next_page;
  }

  return issues;
}

// ── upsertIssue ───────────────────────────────────────────────────────────────

/**
 * Write one Beehiiv issue to `newsletter_issues`, then extract ideas
 * inline so the `extracted_ideas` table stays current without a separate
 * backfill pass.
 */
export async function upsertIssue(issue: BeehiivIssue): Promise<void> {
  const content =
    issue.content_text ||
    (issue.content_html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const row = await db
    .insert(newsletterIssues)
    .values({
      beehiivId:   issue.id,
      title:       issue.subject ?? null,
      subtitle:    issue.subtitle ?? null,
      content,
      tags:        issue.tags ?? [],
      publishedAt: issue.publish_date ? new Date(issue.publish_date * 1000) : null,
      status:      issue.status,
    })
    .onConflictDoUpdate({
      target: newsletterIssues.beehiivId,
      set: {
        title:       issue.subject ?? null,
        subtitle:    issue.subtitle ?? null,
        content,
        tags:        issue.tags ?? [],
        publishedAt: issue.publish_date ? new Date(issue.publish_date * 1000) : null,
        status:      issue.status,
        updatedAt:   new Date(),
      },
    })
    .returning({ id: newsletterIssues.id });

  const issueId = row[0]?.id;
  if (!issueId) return;

  // ── Extract ideas inline ──────────────────────────────────────────────────
  try {
    const ideas = await extractIdeas(content, {
      sourceRef: issue.id,
      tags:      issue.tags,
    });

    if (ideas.length > 0) {
      // Replace stale ideas for this issue.
      await db
        .delete(extractedIdeas)
        .where(eq(extractedIdeas.issueId, issueId));

      await db.insert(extractedIdeas).values(
        ideas.map((idea) => ({
          issueId,
          title:         idea.title,
          claim:         idea.claim,
          evidence:      idea.evidence ?? null,
          depthScore:    idea.depthScore ?? null,
          breadthScore:  idea.breadthScore ?? null,
          outboundLinks: idea.links ?? [],
          sourceRef:     idea.sourceRef ?? null,
        }))
      );
    }
  } catch (err) {
    console.error('[beehiiv] extractIdeas failed for', issue.id, err);
  }
}

// ── Provider implementation ───────────────────────────────────────────────────

export const beehiivConnector: ConnectorProvider = {
  id:          'beehiiv',
  name:        'Beehiiv',
  description: 'Sync newsletter issues from your Beehiiv publication.',

  async validateCredentials(raw: ConnectorCredentials): Promise<boolean> {
    const creds = raw as BeehiivCredentials;
    if (!creds.apiKey || !creds.publicationId) return false;
    try {
      const res = await bFetch(`/publications/${creds.publicationId}`, creds.apiKey);
      return res.ok;
    } catch {
      return false;
    }
  },

  async sync(credentials: ConnectorCredentials): Promise<SyncResult> {
    const creds  = credentials as BeehiivCredentials;
    const issues = await fetchAllIssues(creds.publicationId, creds.apiKey);
    const errors: string[] = [];

    for (const issue of issues) {
      try {
        await upsertIssue(issue);
      } catch (err) {
        errors.push(
          `${issue.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      success:  errors.length === 0,
      upserted: issues.length - errors.length,
      errors,
    };
  },
};
