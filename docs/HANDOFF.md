# Folio · Claude Code handoff

> **Last touched:** Sprint 15 Wave 2.1 (commit `76ee5874`, deployed to
> production at `folio-payton-minzenmayers-projects.vercel.app`).
> **Read first** if you're a new Claude Code session: this is the
> single source of truth for project state.

---

## TL;DR

**Folio** (codename Thoughtbed in the codebase, pivoting to HeyBubble per
recent vault notes) is an idea-maturation system. It captures inputs from
multiple connectors, scores them on depth + breadth, and surfaces past
material to the user while they're writing.

**Stack:** Next.js 15.5.7 / React 19 / Clerk auth / Drizzle ORM + Neon HTTP
Postgres / pgvector HNSW indexes / Tailwind 3.4 / AI SDK (Anthropic Haiku
for assistant; OpenAI text-embedding-3-small for embeddings).

**Current state:** Waves 1, 2, and 2.1 of Sprint 15 are shipped on `main`.
Build is green on Vercel. Two operational items still block real-world
use of the new connector layer (see "What blocks production" below).

**What you're picking up:** Wave 3 — assistant synthesis quality
(pre-embed cleaning, retrieval ranking by extracted Idea signals, prompt
rewrite). See `docs/WAVE-3-BRIEF.md`.

---

## Repository state at handoff

| Field                | Value                                                                  |
|----------------------|------------------------------------------------------------------------|
| Repo                 | `github.com/minzenmayer/folio` (private)                               |
| Default branch       | `main`                                                                 |
| Current SHA          | `76ee587498989985658d606cc846fc6bad90dfd1`                             |
| Production URL       | `https://folio-payton-minzenmayers-projects.vercel.app`                |
| Vercel project       | `prj_2nspi4JfHOHdXVXCOWZ5lTIYzWZN` (team `payton-minzenmayers-projects`)|
| Process              | Lean. Single commit per wave. Push to `main`. Vercel auto-deploys.     |
| Brand discipline     | Ghostbase. Geist/Inter only (no Fraunces). Settings = overlay modal.   |
| Copy guardrails      | "New post / Sync / Connect" — never garden vocabulary.                 |

---

## What's been shipped (Sprint 15)

### Wave 1 — Generalized webhook plumbing  (commit `aa1b6147`)

Replaced Beehiiv polling with real-time push, behind a connector
abstraction designed to invite Obsidian / Substack / Ghost via the same
pattern.

- Single dispatcher: `src/app/api/webhooks/[provider]/route.ts`
- Provider contract: `src/lib/connectors/types.ts`
  (`{ verify, normalize, handle, provisionWebhook?, revokeWebhook? }`)
- Registry: `src/lib/connectors/registry.ts`
- Beehiiv impl: `src/lib/connectors/beehiiv.ts` — HMAC-SHA256 verify
  against per-account `metadata.webhookSecret`, accepts multiple
  signature header layouts (raw hex, `sha256=…`, `t=…,v1=…`)
- Lifecycle: provisioned at connect, revoked at disconnect; webhook id
  + secret stored on `connector_accounts.metadata`
- Middleware widened from `/api/webhooks/clerk` to `/api/webhooks/(.*)`
- Daily cron `0 8 * * *` stays as the missed-delivery backstop

### Wave 2 — Obsidian connector + curation formula  (commit `4a9fd8eb` after corruption recovery)

Read carefully — this wave had a recovery story. **The original commit
`4c43dbb` was corrupted** by a sub-agent that regenerated 19 of 20 files
from memory instead of passing through the prepared payload. Build broke
on imports the source-of-truth never had. Recovery via 4 direct fix
commits (`066f8321`, `e2cfeb6a`, `995ea3a4`, `4a9fd8eb`) restored the
intended state. **Lesson for future Claude Code sessions: do not delegate
multi-file commits to sub-agents.** Use direct `git` operations or the
GitHub API with explicit verbatim payloads.

What landed:

- **Obsidian-via-Git connector** (`src/lib/connectors/obsidian.ts`) —
  GitHub push-webhook verify (`X-Hub-Signature-256`), `vault.push`
  events, full vault sync engine in `src/lib/obsidian-sync.ts`,
  vault client in `src/lib/obsidian.ts`.
- **`extractIdeas()` framework** (`src/lib/extract-ideas.ts`) — hybrid
  LLM (Anthropic Haiku via `generateObject` + Zod) + deterministic
  calibration. Produces `Idea = {title, claim, evidence, depth_signal,
  breadth_signal, links, sourceRef}`.
- **New tables**: `obsidian_notes` and `extracted_ideas` (with
  XOR-discriminated polymorphic FK to `newsletter_issues` or
  `obsidian_notes`). Migration: `drizzle/0006_wave2.sql`.
- **Retroactive backfill** — second `BackfillButton` on `/studio` runs
  `extractIdeas()` across already-ingested newsletter issues and
  obsidian notes (idempotent per source).
- **Inline idea extraction** — `upsertIssue` (Beehiiv) and
  `upsertParsedNote` (Obsidian) both call `extractIdeas` on real writes.

### Wave 2.1 — Curation formula tuned against observed vault slice  (commit `76ee5874`)

Observed the `minzenmayer/heybubble` repo as a partial slice of the
founder's local Obsidian vault and tuned the formula against actual
patterns. The full vault root (`Payton-Vault/`) is still local.

- Documented observed conventions in `docs/curation-formula.md`:
  frontmatter keys (`tags`, `created`, `status`, `mode`, `source`,
  `purpose`, `previous-name` — no `type`), status taxonomy (`exploring`
  → `drafted` → `approved`/`evergreen`), PARA-numbered folders
  (`01-Projects/`, etc.), filename conventions, Related Files section,
  bold-label voice convention (`**Lesson:**`, `**Why it worked:**`,
  `**For X:**`).
- Tuned `calibrateSignals()`:
  - Depth ceilings loosened (200/500/900-word thresholds vs.
    v0's 250/600).
  - `status: approved/evergreen` lifts depth ≥ 0.6.
  - `status: exploring` caps depth at 0.7.
  - `01-Projects/` caps breadth at 0.75; `02-Areas/`, `03-Resources/`
    floor breadth at 0.55.
  - 2+ bold-label markers lift breadth ≥ 0.6 (4+ → ≥ 0.75).
  - 2+/3+ "Related Files" wikilinks lift breadth ≥ 0.55 / ≥ 0.7.
  - `type: MOC` kept as fallback for unobserved vault portions.
- LLM prompt updated to mention bold-label and Related-Files conventions
  explicitly so the LLM weights them when proposing initial signals.

---

## What blocks production right now

**🔴 #1 — Apply migration `drizzle/0006_wave2.sql` to Neon production.**

The Wave 2 connector code is deployed but the `obsidian_notes` and
`extracted_ideas` tables don't exist in the production DB yet. Any
attempt to connect Obsidian or run the new backfill will throw on the
first INSERT. The migration is idempotent (`CREATE TABLE IF NOT EXISTS`
+ named indexes) so it's safe to run.

How to apply:

```bash
# Either: push schema via Drizzle (preferred — keeps Drizzle aware)
npm run db:push

# Or: paste drizzle/0006_wave2.sql into Neon's SQL editor and Run
# Production DB connection: console.neon.tech → folio project
```

**🟡 #2 — Set `APP_URL` in Vercel project env.**

Connector providers register webhook URLs at app launch. Without an
explicit `APP_URL`, the code falls back to `VERCEL_PROJECT_PRODUCTION_URL`
which currently resolves to the right place — but that's implicit. Set
`APP_URL=https://folio-payton-minzenmayers-projects.vercel.app` in Vercel
→ Settings → Environment Variables (Production scope) for stability
across future domain changes.

**🟡 #3 — Push the rest of the Obsidian vault to GitHub** (or accept that
the calibration is heybubble-tuned-only).

The connector works. The formula is tuned against 6 markdown files from
the heybubble project slice. The broader vault — `Payton-Vault/01-Projects/Thoughtbed/`,
`04-Thoughtbed/growing/`, `02-Areas/`, `03-Resources/` — is still local.
When the rest is reachable, refresh `docs/curation-formula.md` with
real distributions (frontmatter key frequency, folder histogram, tag
taxonomy) and tighten the calibration.

**🟢 #4 — First Beehiiv `post.sent` delivery will reveal the actual
signature header format.** Code accepts three formats (raw hex, GitHub-
style `sha256=…`, Stripe-style `t=…,v1=…`). If verification fails on
the first delivery, check the inbound `Beehiiv-Signature` header in
Vercel function logs and tighten the regex in
`src/lib/connectors/beehiiv.ts:verifyHmac`.

---

## What's next (Wave 3)

**See `docs/WAVE-3-BRIEF.md` for the full spec.** TL;DR:

> Right now Reflect surfaces raw newsletter chunks — intros, sign-offs,
> formatting noise. No reasoning, just paste. Fix it in three layers:
>
> 1. **Pre-embed cleaning.** Strip boilerplate before embedding AND
>    before LLM context.
> 2. **Retrieval ranking.** Don't rank by raw cosine. Boost matches
>    whose extracted Idea has high depth/breadth signal. Filter
>    low-signal chunks before the LLM sees them.
> 3. **Synthesis prompt rewrite.** The LLM must never quote source text.
>    Output shape: "You explored [X] in [issue/note title]. That
>    connects to [current capture] because [reasoning]." Source links
>    sit beside as receipts, not as the body.
>
> Done = open a capture, Reflect returns 3+ ideas with real reasoning,
> no quoted intros, no raw HTML, references both newsletter + Obsidian
> sources.

---

## How to onboard a fresh Claude Code session

Paste the contents of `docs/CLAUDE-CODE-KICKOFF.md` into a new Claude
Code session pointed at this repo. The kickoff prompt summarizes
project context, reads in the right files automatically, and sets up
the working agreement (plan before code, ship small, keep STATUS.md
updated, etc. — same conventions used in the heybubble project).

---

## Other docs in this folder

- `docs/HANDOFF.md` — this file (master overview)
- `docs/CLAUDE-CODE-KICKOFF.md` — paste this into a new Claude Code session
- `docs/WAVE-3-BRIEF.md` — Wave 3 spec
- `docs/CONNECTORS.md` — connector wiring details (Beehiiv, Obsidian,
  Clerk, future providers)
- `docs/ENVIRONMENT.md` — env var list + where credentials live
  (no secrets in this doc — pointers only)
- `docs/curation-formula.md` — extraction rules (already in repo from
  Wave 2.1; lives in same docs/ folder)

---

## Architectural notes worth carrying forward

**Connector contract** (`src/lib/connectors/types.ts`) is intentionally
minimal: `verify(req) → VerifyResult`, `normalize(payload) →
ConnectorEvent | null`, `handle(ctx, event) → void`, optional
`provisionWebhook` / `revokeWebhook`. Adding a third provider should
be ~200 lines of new code + a one-line registry entry. Don't grow the
contract speculatively.

**`upsertIssue` / `upsertParsedNote` are the canonical write paths** for
their respective sources. Cron, push, manual sync, and idea extraction
all funnel through them. Don't add a fourth code path; extend these.

**Idempotency is upsert-keyed**: `(user_id, external_id)` for
newsletter issues, `(user_id, path)` for Obsidian notes. Re-syncing
the same source from cron or push results in zero duplicate rows.
Test plan: connect, sync, observe N rows; sync again, observe N rows.

**Embedding pipeline is best-effort**: `embedText()` failures are
caught and logged inline; the row writes without `embedding`. Backfill
button on `/studio` sweeps NULLs.

**Idea extraction is best-effort too**: `extractIdeasFromNewsletter`
and `extractIdeasFromObsidian` log + return on Anthropic flake; the
parent sync still completes. The retroactive backfill on `/studio`
catches sources that missed extraction.

**Brand vocabulary** is enforced at the copy level. Code uses
`Thoughtbed` historically; UI should always say "the Bed" or product
names. Settings is `?settings=connectors` not a route. No "garden"
vocabulary in user-facing strings.
