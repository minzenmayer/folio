# Claude Code · Kickoff prompt for Folio

> **Paste the prompt below into a fresh Claude Code session pointed at
> this repo.** It bootstraps context without requiring you to re-read
> the full handoff.

---

## The prompt (copy everything below)

```
You are picking up the Folio project (codename Thoughtbed in code,
pivoting to HeyBubble per recent vault notes). Repo: minzenmayer/folio.
Main is at 76ee5874 (Sprint 15 Wave 2.1 shipped). Production at
folio-payton-minzenmayers-projects.vercel.app.

Read these files first, in this order, before doing anything else:

1. docs/HANDOFF.md — full project state + what's blocking production
2. docs/WAVE-3-BRIEF.md — the next wave's spec (this is what we're
   building)
3. docs/curation-formula.md — how extractIdeas() scores Ideas
4. docs/CONNECTORS.md — connector wiring details
5. docs/ENVIRONMENT.md — env vars and where credentials live
6. drizzle/0006_wave2.sql — the Wave 2 migration (NOT YET APPLIED to
   production Neon)
7. src/lib/llm.ts — current Reflect prompt (you'll be rewriting it)
8. src/lib/extract-ideas.ts — depth/breadth signals you'll be reading
   from in retrieval ranking
9. src/app/studio/actions.ts — findSimilar (the function you'll be
   adjusting for ranking by Idea signals)

Then confirm you understand:

1. Three layers of Wave 3: pre-embed cleaning → retrieval ranking by
   extracted-Idea signals → synthesis prompt rewrite (no quoting source).
2. Done criteria: open a capture, Reflect returns 3+ ideas with real
   reasoning, no quoted intros, no raw HTML, references both newsletter
   and Obsidian sources.
3. Single-commit-per-wave process. Push to main. Vercel auto-deploys.
4. NEVER delegate multi-file commits to sub-agents. The Sprint 15 Wave 2
   commit was corrupted by a sub-agent that regenerated content from
   memory instead of passing through the prepared payload. Use git
   directly or the GitHub API with verbatim payloads.

Operational TODOs from the previous session that are still pending:

A. Apply drizzle/0006_wave2.sql to the production Neon DB. Without this,
   Obsidian connect + extracted_ideas writes will fail. Idempotent
   migration. Either run `npm run db:push` or paste the SQL into Neon's
   SQL editor.
B. Set APP_URL=https://folio-payton-minzenmayers-projects.vercel.app
   in Vercel → Settings → Environment Variables (production scope).
   Currently falls back to VERCEL_PROJECT_PRODUCTION_URL which works
   but is implicit.
C. (Optional) Push the rest of the Obsidian vault to a private GitHub
   repo so the curation formula can be re-tuned against full-vault
   patterns. Currently tuned against the heybubble slice only.

Brand discipline (non-negotiable):
- Ghostbase aesthetic. Geist/Inter only. No Fraunces.
- Settings is an overlay modal at /studio?settings=connectors, not a
  route.
- Copy: "New post / Sync / Connect". No garden vocabulary in user-
  facing strings.

How we work together:
- Plan before code. Show the plan, wait for confirmation.
- Ship small, working pieces. Every session ends with something I can
  see or run.
- Keep STATUS.md updated at the end of every session (running log:
  Current state / Next up / History).
- Ask questions when you hit a real decision point. Don't ask
  questions answerable by reading the docs above.

After reading the docs, propose your Wave 3 implementation plan and
wait for confirmation before touching the filesystem.
```

---

## What this prompt is doing for you

The prompt loads the same context you'd get from re-reading the entire
handoff, but routes Claude through the docs in dependency order so the
session boots quickly. It also pins the working agreement (plan first,
ship small, single commit per wave, no sub-agent commits) and surfaces
the three operational TODOs that block real-world deployment.

If you've already applied the migration and set `APP_URL`, edit out
those bullets before pasting.

---

## After Claude Code confirms it's ready

Expect Claude Code to propose a Wave 3 implementation plan along these
lines:

1. **Pre-embed cleaning** — extend `src/lib/extract-ideas.ts:stripBoilerplate`
   into a more thorough rule + cache the cleaned text on
   `newsletter_issues.body_text` (re-run on save).
2. **Retrieval ranking** — extend `findSimilar()` in
   `src/app/studio/actions.ts` to JOIN against `extracted_ideas` and
   weight by `depth_signal + breadth_signal`. Filter out raw-chunk hits
   below a signal floor.
3. **Synthesis prompt rewrite** — rewrite `generateReflection` in
   `src/lib/llm.ts` to require the "You explored [X] in [title]. That
   connects to [current capture] because [reasoning]" output shape.
   Source links surface as receipts, not body content.

Review the plan, push back on anything that looks off, then green-light.

---

## If you want to verify state before starting

```bash
# clone fresh (in case your local is stale)
git clone https://github.com/minzenmayer/folio.git
cd folio
git log --oneline -10  # confirm 76ee5874 is HEAD

# verify the workspace builds
npm install --legacy-peer-deps
npm run build

# verify Neon schema state — connect via psql or Drizzle Studio
npm run db:studio  # opens at https://local.drizzle.studio
# look for tables: connector_accounts, newsletter_issues,
# obsidian_notes (NEW — should be missing in prod), extracted_ideas (NEW)
```
