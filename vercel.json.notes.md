# Vercel cron toggles — quick reference

Active crons live in `vercel.json` → `crons[]`. Connector syncs only.

## Disabled (re-enable by adding back into crons[])

### garden-digest

```json
{
  "path": "/api/cron/garden-digest",
  "schedule": "0 4 * * *"
}
```

**What it does.** Daily 04:00 UTC pass per user:
1. `applyAutoCooling` — cools ideas based on visit + digest staleness
2. `computeDigest` — picks today's 3 ideas
3. `computeClusters` + `persistClusters` — recomputes idea_clusters
4. `runMaturationPass` — full lift formula over all user ideas
5. `computeNextJuxtaposition` — daily provocation pair
6. `persistDigestRun` + `markSurfaced`

**Compute cost.** Heaviest single cron. The maturation pass alone
loads ideas + extracted_ideas + drafts + idea_edges + idea_clusters
into memory and runs in-memory cosine. For 800+ ideas that's
substantial.

**When to re-enable.**
- After confirming Neon usage on the new tier has headroom (check
  console.neon.tech → folio → Usage). Aim for < 40% of monthly
  compute hours from baseline.
- Before opening signups / waitlist — daily fresh digests are
  user-facing value, you'll want them on for real users.
- If you skip a day, the inline fallback still computes everything
  on the next Garden visit (gated by env var, see below).
