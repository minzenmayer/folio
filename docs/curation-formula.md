# Curation Formula — Sprint 15 Wave 2

This document describes the hybrid LLM + deterministic framework used to
extract and rank ideas from first-party content (newsletter issues and
Obsidian vault notes).

---

## 1. What is an "idea"?

For our purposes an **idea** is the smallest self-contained unit of insight:
a claim that is (a) non-obvious, (b) attributable to a specific source, and
(c) testable or at least falsifiable in principle.

Examples of ideas:
- "Founder-market fit matters more than product-market fit at the pre-seed stage."
- "The 'founder vault' note graph shows unusually high betweenness centrality
  on the node 'Leverage'."
- "Sub-$5M ARR SaaS companies that ship a self-serve trial convert at 2× the
  rate of those that don't."

---

## 2. Extraction pipeline

```
raw text
  └─ extractIdeas(body, context)
       ├─ [LLM] Claude Haiku → RawIdea[]
       │     title, claim, evidence?, links?
       └─ [deterministic] calibrate signals
             depthScore   (word-count proxy + evidence bonus)
             breadthScore (link density + MOC bonus)
```

### 2.1 LLM pass (Claude Haiku)

- Input truncated to 4 000 words to keep costs predictable.
- System prompt instructs the model to return at most 12 non-obvious ideas,
  ordered by importance, and to never invent claims not present in the source.
- Structured output via `generateObject` + Zod schema avoids free-form JSON
  parsing bugs.

### 2.2 Deterministic calibration

| Signal | Formula | Ceiling |
|---|---|---|
| `depthScore` | `min(words/600, 1) + 0.15 × hasEvidence` | 1.0 |
| `breadthScore` | `min(links / (words/50), 1) + 0.15 × isMOC` | 1.0 |

Word-count ceiling: ideas whose `claim` is fewer than 6 words have both
signals halved (likely an artefact rather than a real idea).

---

## 3. Obsidian conventions assumed by the formula

The formula works best when the vault follows these conventions:

| Convention | Effect |
|---|---|
| Frontmatter `type: MOC` | +0.15 breadth bonus |
| Wikilinks `[[note name]]` | Counted in `links[]` for breadth |
| Inline `#tags` | Stored in `obsidian_notes.tags`; available for future tag-boost |
| Fenced code blocks | Excluded from tag / inline-link extraction |

---

## 4. DB shape (`extracted_ideas`)

```sql
extracted_ideas
  id             UUID  PK
  issue_id       UUID  FK → newsletter_issues   -- XOR
  note_id        TEXT  FK → obsidian_notes      -- XOR
  title          TEXT
  claim          TEXT
  evidence       TEXT?
  depth_score    REAL?
  breadth_score  REAL?
  outbound_links TEXT[]
  source_ref     TEXT?
  embedding      vector(1536)
  extracted_at   TIMESTAMPTZ
```

The `XOR` check constraint `(issue_id IS NOT NULL)::INT + (note_id IS NOT NULL)::INT = 1`
enforces exactly one source FK per row.

---

## 5. Known gap — founder vault not yet observed

The curation formula is calibrated on *generic* markdown prose.  The founder
vault (the primary Obsidian source) has **not yet been ingested** — we don't
know its tag density, link graph shape, or average note length.

A `profileVault(repoFull)` helper is reserved for Wave 3; it will:
1. Run a one-pass stat sweep (word counts, link density per-note).
2. Persist a `vault_profiles` row with p50/p95 percentiles.
3. Feed those percentiles into `calibrateDepth` and `calibrateBreadth` so
   scores are relative to *this* vault rather than a universal baseline.

Until `profileVault` runs, treat absolute score values as indicative only.

---

## 6. Wave 3 handoff

Wave 3 (retrieval ranking + synthesis prompt rewrite) will:

- Read `depth_score` and `breadth_score` off `extracted_ideas`.
- Boost cosine-similar chunks whose parent idea has high depth (deep dives)
  *or* high breadth (MOC-style connective tissue).
- Rewrite the synthesis prompt to explicitly cite the top-ranked idea titles
  so the LLM response is grounded in the founder's own framing.
