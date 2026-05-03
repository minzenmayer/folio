# Curation formula

> The unit of meaning the Bed retrieves and reflects against is **the
> Idea** — title + claim + evidence, plus signals (depth, breadth) that
> weight retrieval. This document captures how `extractIdeas()` decides
> what's an Idea, what isn't, and how it scores depth + breadth.

## Status (Sprint 15 Wave 2 — partially observed)

> **Slice observed:** The `minzenmayer/heybubble` repo on GitHub is a
> partial slice of the founder's local Obsidian vault — it contains the
> heybubble project's planning docs (`00-vision`, `01-teardown`,
> `02-build-plan`, `03-kickoff`, `STATUS.md`, plus a `docs/plans/` dated
> design doc) and references the rest of the vault via relative paths.
> Six markdown files. Enough to nail down frontmatter conventions, voice
> patterns, link patterns, and folder taxonomy.
>
> **Still local:** The full vault root (`Payton-Vault/`) and most of its
> contents — `01-Projects/Thoughtbed/`, `04-Thoughtbed/growing/`, and the
> rest. Once that's pushed somewhere reachable, refresh this document.
>
> The framework below reflects observed patterns. Calibration constants
> in `src/lib/extract-ideas.ts:calibrateSignals` are tuned against them.

---

## What an Idea is

An Idea is a **claim plus its evidence**, durable enough to recur across
the user's writing. Examples drawn from observed slice:

- ✅ *"Tight scope is the feature"* — recurring in `02-build-plan.md`
  ("the tight scope is the feature") and the v0 ground rules (Mac-only,
  one capture mode, no wake word). Same claim restated across notes.
- ✅ *"Wispr Flow positioned against typing, not Siri"* — discussed in
  `01-wispr-flow-teardown.md`, then translated into HeyBubble's own
  positioning ("don't position against Mem or Obsidian. Position against
  *forgetting*"). One idea, two contexts.
- ✅ *"Build for me first; ship when I can't stop using it"* — sustained
  across `00-vision`, `02-build-plan`, and `03-kickoff` ground rules.
- ❌ *"Tauri vs. Electron"* — a stack decision, not a recurring claim.
- ❌ *"My favorite cafés in Austin"* — a topic, not a claim.

The extraction prompt in `src/lib/extract-ideas.ts` calls this out:
**"better one or two strong ideas than five thin ones."** That bias
keeps the garden a curated layer, not a noise floor.

---

## Signals

Every extracted Idea carries two 0..1 floats:

### `depth_signal` — how thoroughly *this source* explores the idea

| Score | Meaning                                                                    |
|-------|----------------------------------------------------------------------------|
| 0.1   | Mentioned in passing, single sentence, no development                      |
| 0.3   | A paragraph or two; named but not yet argued                               |
| 0.5   | Developed across a few paragraphs with at least one example                |
| 0.7   | Sustained across multiple sections; multiple examples or a worked argument |
| 0.9   | The source is mostly about this idea; recursive, builds on itself          |

**Calibration ceilings + lifts** (enforced in
`src/lib/extract-ideas.ts:calibrateSignals`):

- Word count < 200 → depth caps at 0.45.
- Word count < 500 → depth caps at 0.7.
- Word count < 900 → depth caps at 0.85.
- Frontmatter `status: approved` or `status: evergreen` → depth lifted
  to ≥ 0.6 (the founder has finalized this).
- Frontmatter `status: exploring` → depth capped at 0.7 (the source is
  signalling "I haven't fully worked this out").

These ceilings were loosened from the v0 default (250/600/—) because
observed notes pack claims densely with bullet-driven evidence and
"Why it worked:" sub-arguments — a 600-word note here can genuinely be
0.8 depth.

### `breadth_signal` — how broadly applicable the idea is

| Score | Meaning                                                              |
|-------|----------------------------------------------------------------------|
| 0.1   | Single-domain detail; only useful in one specific context            |
| 0.3   | Applies to a couple of adjacent contexts in the user's domain        |
| 0.5   | Applies across a few related domains                                 |
| 0.7   | A cross-cutting principle that recurs in distinct domains            |
| 0.9   | A universal-feeling principle the user keeps returning to            |

**Calibration ceilings + lifts:**

- 0 outbound links AND 0 tags → breadth caps at 0.6.
- Top-level folder matches `01-Projects` → breadth caps at 0.75
  (project-scoped by definition).
- Top-level folder matches `02-Areas` or `03-Resources` → breadth lifted
  to ≥ 0.55 (these folders are cross-cutting by PARA convention).
- 2+ "**Lesson:**" / "**Why it worked:**" / "**For X:**" bold labels in
  body → breadth lifted to ≥ 0.6. 4+ → ≥ 0.75.
- 2+ wikilinks inside a "## Related Files" section → breadth ≥ 0.55.
  3+ → ≥ 0.7.
- Frontmatter `type: MOC` → breadth lifted to ≥ 0.75 (kept as a fallback
  for notes that use this convention; not observed in the heybubble
  slice but common in other Obsidian users' vaults).

Hard ceiling: breadth and depth both clamp at 0.95 after lifts. No idea
is "always applicable."

---

## Observed Obsidian conventions (heybubble slice)

### Frontmatter keys

The slice uses these keys (frequency in 6-doc sample shown):

| Key            | Frequency     | Notes                                                                                |
|----------------|---------------|--------------------------------------------------------------------------------------|
| `tags`         | 4 / 4 with FM | Inline array. Always 3–4 tags, kebab-case for compound concepts.                     |
| `created`      | 4 / 4 with FM | ISO date (`2026-04-14`). Always present.                                             |
| `status`       | 2 / 4 with FM | Values seen: `exploring`, `drafted`. Implied: `approved`, `evergreen`.               |
| `mode`         | 1 / 4         | Saw `solo-project`. Likely a project-shape tag.                                      |
| `source`       | 1 / 4         | Free-form text describing where the note's research came from.                       |
| `purpose`      | 1 / 4         | Free-form, says what the note is for (e.g. paste-into-Claude prompt).                |
| `previous-name`| 1 / 4         | One-off — note on a renamed project, leaves a breadcrumb.                            |

**Notably absent in the slice** (vs. common Obsidian conventions):

- `type:` — not used. The v0 default formula's `type: MOC` heuristic
  doesn't fire on these notes; we keep it as a fallback for unobserved
  vault portions but don't rely on it.
- `aliases:` — not used.
- An explicit `links:` frontmatter key — links live in body / "Related
  Files" section instead.

### Status taxonomy

Observed values: `exploring`, `drafted`. Implied progression (similar
to lifecycle vocabulary the founder uses elsewhere): `exploring →
drafted → approved → evergreen` (or some subset). Distinct from the
existing schema's `seed | forming | shaping | ready | circulated |
dormant` — the vault uses a simpler 3–4 step progression.

The calibration uses `approved`/`evergreen` as a depth lift,
`exploring` as a depth ceiling.

### Folder taxonomy (PARA-numbered)

Inferred from relative wikilinks like
`[[../../04-Thoughtbed/growing/...]]` and
`[[../Thoughtbed/thoughtbed-product-session-april-8]]`, plus the
explicit path reference `/Payton-Vault/01-Projects/Thoughtbed/...`:

```
Payton-Vault/                   ← vault root
├── 01-Projects/                ← active work, project-scoped
│   ├── heybubble/              ← this slice (published as a repo)
│   │   ├── 00-heybubble-vision.md
│   │   ├── 01-wispr-flow-teardown.md
│   │   ├── 02-build-plan.md
│   │   ├── 03-kickoff-prompt.md
│   │   └── STATUS.md
│   └── Thoughtbed/
│       └── thoughtbed-product-session-april-8.md
├── 02-Areas/                   ← (presumed)
├── 03-Resources/               ← (presumed)
└── 04-Thoughtbed/              ← (top-level, possibly archived
    └── growing/                  or grown-out-of-Projects)
        └── thoughtbed-product-vision-3features.md
```

Top-level folders use a **PARA-style numeric prefix** (`01-`, `02-`,
`03-`, `04-`). Interpretation in the calibration:

- `01-Projects/` → project-scoped, breadth ≤ 0.75
- `02-Areas/` and `03-Resources/` → cross-cutting, breadth floor 0.55

Project subfolders nest one level deep (`01-Projects/heybubble/`,
`01-Projects/Thoughtbed/`).

### Filename conventions

- Kebab-case throughout. Spaces avoided.
- Numeric sequence prefix on intra-project notes: `00-vision`,
  `01-teardown`, `02-build-plan`, `03-kickoff`. The number signals
  reading order within a project.
- Date prefix for dated working docs: `2026-04-14-week2-maturation-engine-design.md`
  (in `docs/plans/`).
- Title in body H1 always present and authoritative — `resolveTitle()`'s
  H1 fallback handles these correctly.

### Wikilinks

- `[[note-name]]` (plain).
- `[[../sibling-folder/note-name]]` (relative, common).
- `[[../../04-Thoughtbed/growing/note-name]]` (deeper relative paths
  occur when crossing top-level folders).
- Image embeds `![[image.png]]` not observed in the slice.

### "Related Files" section

A consistent end-of-note pattern:

```markdown
---

## Related Files

- [[01-wispr-flow-teardown]] — Go-to-market playbook to borrow from
- [[02-build-plan]] — Systematic build process, MVP scope
- [[../Thoughtbed/thoughtbed-product-session-april-8]] — Full architecture thinking
```

Headed `## Related Files` (consistent capitalization), bullet list of
wikilinks with optional dash-prefixed annotations. Used as the explicit
"this idea connects to these notes" enumeration. Treated as a strong
breadth signal in calibration (see ceilings above).

### Voice patterns observed

**Bold-label cross-cutting markers** — recur across multiple notes:

- `**Lesson:**` (e.g. `01-wispr-flow-teardown.md`)
- `**Why it worked:**` (4× in `01-wispr-flow-teardown.md` alone, used
  as a comparative-analysis breath mark)
- `**For HeyBubble:**` / `**For X:**` (translates a lesson into the
  founder's own context — same idea, applied)
- `**Borrow heavily:**` / `**Don't borrow:**` (decision frames)

These mark moments where the founder is doing comparative analysis or
cross-context translation. **2+ in a source → breadth lift.** This is
the most reliable observed breadth signal after explicit `Related
Files` enumeration.

**Other voice features (informational, not yet a calibration signal):**

- Short, declarative sentences. Em-dashes (`—`) used liberally.
- Italic taglines under H1: `*Solo project. Built first for me, then
  shipped to others if it works.*`
- Heading hierarchy strict: `# H1` (single), `## H2` (sections),
  `### H3` (subsections), `**bold:**` for inline labels.
- `---` horizontal rules between major sections.
- Numbered lists for ordered steps; bulleted lists with bold labels for
  parallel claims.

### Dataview queries

Not observed in the slice. The `STATUS.md` pattern (running log with
"Current state / Next up / History" headings) substitutes for what
dataview queries might surface elsewhere. We don't run any
dataview-aware logic.

---

## Runtime profiling (the gap)

The slice gives us frontmatter shapes, voice patterns, folder taxonomy,
and link conventions for the heybubble project. **It does NOT give us
the broader vault statistics:**

- Distribution of frontmatter keys across all notes (which fields are
  ubiquitous vs. project-specific?)
- True folder histogram (how much lives in `01-Projects/` vs.
  `02-Areas/` vs. elsewhere?)
- Tag taxonomy at scale (top-N tags + co-occurrence beyond
  heybubble-specific tags)
- Note-length distribution (the slice is 6 docs, all 1.5K–10K bytes —
  not enough to set ceilings against)

When the full vault is connected, a one-time `profileVault()` step
should capture these and stash findings on
`connector_accounts.metadata.vaultProfile`. This document should be
updated at that point with the profile-driven adjustments.

This profiling pass is **not** shipped in Wave 2. Wave 2 ships:

- The framework + the Obsidian connector.
- A prompt + calibration tuned against the heybubble slice.
- The retroactive newsletter backfill so the founder can see Ideas
  flowing immediately.

It does **not** ship:

- A `profileVault()` runtime that reads + summarizes the full vault.
- Per-account vault overrides on the prompt or calibration constants.
- Cross-source idea identity (one Idea linking N sources).

These are the natural next steps once the broader vault is reachable.

---

## Updating the formula

When you tune:

1. Edit the **prompt** in `src/lib/extract-ideas.ts:buildPrompt` for
   wording / depth-and-breadth interpretation.
2. Edit the **structure block** in `:buildStructureBlock` for what gets
   surfaced to the LLM as deterministic context. (The bold-label and
   Related-Files counts are surfaced as of this revision.)
3. Edit the **calibration** in `:calibrateSignals` for clamps and lifts.
4. Edit *this document* to keep the cuts visible to future contributors.
5. Click **Extract ideas** on `/studio` to re-run extraction across
   existing sources (idempotent per source — already-extracted sources
   are skipped; delete `extracted_ideas` rows for a forced re-extract).

Wave 3 (Assistant synthesis quality) will read `depth_signal` and
`breadth_signal` from `extracted_ideas` to boost retrieval before the
LLM sees raw chunks. Anything you change here directly tunes that ranking.
