# Claude Code · Kickoff prompt for Folio

> **Paste the prompt below into a fresh Claude Code session** after opening the
> `folio` repo. Replace the bracketed placeholders before sending.

---

## Kickoff prompt (copy from the horizontal rule to the end)

---

You are working on **Folio**, a multi-connector financial data normalisation and
conversation layer built on Next.js 14 + Supabase + Anthropic Claude.

**Your task for this session:** [DESCRIBE THE SPECIFIC TASK OR WAVE HERE]

**Context files to read first (in order):**
1. `docs/HANDOFF.md` — project overview, repo map, conventions, known issues
2. `docs/WAVE-3-BRIEF.md` — current sprint brief (or whichever wave is active)
3. `docs/CONNECTORS.md` — connector contracts and status
4. `docs/ENVIRONMENT.md` — env vars and secrets layout

**Hard rules for this session:**
- Do not modify any connector that is marked ✅ live unless the task explicitly
  requires it.
- Do not commit secrets or API keys. `.env.local` is gitignored; keep it that way.
- All new logic must have Vitest unit tests co-located as `*.test.ts`.
- Run `pnpm tsc --noEmit` and `pnpm lint` before declaring a task done.
- Do not rename `lib/openai.ts` — that rename is tracked in issue #47 and will
  be done in a dedicated PR to avoid merge conflicts.

**Definition of done for this session:**
- [ ] The specific task described above is complete.
- [ ] `pnpm test` passes with no new failures.
- [ ] `pnpm tsc --noEmit` exits 0.
- [ ] `pnpm lint` exits 0.
- [ ] A short summary of what changed is appended to `docs/HANDOFF.md` under a
  new `## Last session` section (replace any previous `## Last session` block).

**Current branch:** [INSERT BRANCH NAME]
**Last known good commit:** [INSERT SHA]

Start by reading the four context files listed above, then confirm your
understanding of the task before writing any code.
