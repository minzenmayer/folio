# Curation formula

> The unit of meaning the Bed retrieves and reflects against is **the
> Idea** — title + claim + evidence, plus signals (depth, breadth) that
> weight retrieval. This document captures how `extractIdeas()` decides
> what's an Idea, what isn't, and how it scores depth + breadth.

## Status (Sprint 15 Wave 2)

> **The actual founder vault has not been observed yet.** Wave 2 ships
> with a *v0 default* formula based on common Obsidian conventions
> (frontmatter `type`, MOC patterns, dataview queries, wikilink density,
> `#tag` taxonomy) and general source-text heuristics. Once a vault is
> connected — pointing the connector at `https://github.com/{you}/{vault}`
> via `/studio?settings=connectors` — the runtime sees the real frontmatter
> keys, folder structure, and link patterns, and the formula should be
> tuned against them. Update this document as you tune.

The framework below is intentionally additive: rules and signals are
listed, and the LLM extraction prompt + the deterministic calibration in
`src/lib/extract-ideas.ts` reference these rules by name. Refining the
formula is mostly editing prompt copy and adjusting the calibration
floors/ceilings — no schema migrations.

---

## What an Idea is

An Idea is a **claim plus its evidence**, durable enough to recur across
the user's writing. Examples (made up — replace with real founder
examples once we have them):

- ✅ *"Idea density beats word count" — a sustained claim across multiple
  newsletter issues, illustrated with comparisons of long vs. short
  pieces, evidenced by reader-engagement data.*
- ✅ *"Maturity is a state, not a milestone" — the founder's own framing
  for how thinking moves from seed → forming → ready, recurring across
  product copy and personal writing.*
- ❌ *"My favorite cafés in Austin"* — a topic, not a claim.
- ❌ *"AI will change knowledge work"* — too generic; not the user's own
  framing, no evidence specific to them.

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

**Calibration ceilings** (enforced in
`src/lib/extract-ideas.ts:calibrateSignals`):

- Word count < 250 → depth caps at 0.5.
- Word count < 600 → depth caps at 0.75.
- An LLM saying "this 200-word newsletter is 0.9 depth on idea X" gets
  clamped down. The text-volume signal is a sanity check, not a feature.

### `breadth_signal` — how broadly applicable the idea is

| Score | Meaning                                                              |
|-------|----------------------------------------------------------------------|
| 0.1   | Single-domain detail; only useful in one specific context            |
| 0.3   | Applies to a couple of adjacent contexts in the user's domain        |
| 0.5   | Applies across a few related domains                                 |
| 0.7   | A cross-cutting principle that recurs in distinct domains            |
| 0.9   | A universal-feeling principle the user keeps returning to            |

**Calibration ceilings:**

- 0 outbound links AND 0 tags → breadth caps at 0.6. (No evidence of
  cross-pollination *anywhere* in the source = probably single-domain.)
- Frontmatter `type: MOC` → breadth lifted to ≥ 0.7. (Map-of-Content
  notes are explicit cross-cutters by Obsidian convention.)

---

## Default Obsidian conventions the formula assumes

These are *defaults*, drawn from how Obsidian users typically structure
vaults. The runtime should profile the actual vault on connect and
**override** these where it sees something different.

### Frontmatter keys

The default extractor looks at:

- `type:` — `permanent`, `fleeting`, `MOC`, `literature`, `project`, `question`. `MOC` lifts breadth (above). Others are
  surfaced to the LLM as structural context but don't yet flip a
  heuristic.
- `tags:` — array of taxonomies. Merged with inline `#tags` and surfaced.
- `aliases:` — alternate idea titles. Currently surfaced but not yet
  used to dedupe Ideas across notes (TODO: cross-source identity).
- `status:` — `seedling | budding | evergreen`-style maturity. Not yet
  consumed; reserved for a future "evergreen ideas weight more" signal.
- `links:` — explicit outbound link list. Merged with `[[wikilinks]]`
  found in body.

### Folder taxonomy

The default extractor surfaces `path = Areas/Newsletter/Idea Density.md`'s
folder (`Areas/Newsletter`) to the LLM as a structural hint. **It does
NOT yet apply per-folder rules** (e.g. "PARA Areas vs. Resources should
score breadth differently"). The runtime profiler will surface what
folders actually exist; refine the prompt once we know.

### Link patterns

- `[[Note Name]]`, `[[Note Name|alias]]`, `[[Note Name#Heading]]` are all
  treated as the same target (alias + heading stripped).
- `[label](relative/path.md)` Markdown links count as outbound links.
- Image embeds (`![[image.png]]`, `![](image.png)`) don't count.
- Tags use the standard `#PascalCase` / `#kebab-case` form.

### Dataview queries

Dataview blocks (` ```dataview ... ``` `) are stripped from `body_text`
before embedding (they're query DSL, not prose). The default extractor
**does not yet read query strings as a breadth hint** — a note that
queries broadly across the vault is implicitly cross-cutting, but
parsing dataview's mini-language reliably is not on Wave 2's path.
Reserved for a Wave 2.1 if useful.

---

## Runtime profiling (the gap)

When the founder connects their vault, the next sync should run a
one-time profile pass that records:

- Distribution of frontmatter keys (which fields appear on > 30% of notes?)
- Folder histogram (which folders carry > 10% of notes?)
- Link density per note (median outbound links, p90)
- Tag taxonomy (top-N tags + co-occurrence)
- Note-length distribution (so the depth ceilings can adapt — 250-word
  defaults assume newsletter-length sources; an Atlas-of-notes vault
  might want lower)

These findings should be stashed on `connector_accounts.metadata.vaultProfile`
and surfaced as updates to *this document*. The intent is that
`docs/curation-formula.md` is a living artifact — not a one-time spec —
and `extractIdeas()` reads vault-specific tunings from the connector
account when present.

This profiling pass is **not** shipped in Wave 2. Wave 2 ships:
- The framework + the Obsidian connector.
- A v0 prompt that handles common conventions.
- Calibration ceilings that prevent obvious LLM over-claims.
- The retroactive newsletter backfill so the founder can see Ideas
  flowing immediately.

It does **not** ship:
- A `profileVault()` runtime that reads + summarizes the vault.
- Vault-specific overrides on the prompt.
- Cross-source idea identity (one Idea linking N sources).

These are the natural next steps once the founder points us at the vault
and we can observe what's actually there.

---

## Updating the formula

When you tune:

1. Edit the **prompt** in `src/lib/extract-ideas.ts:buildPrompt` for
   wording / depth-and-breadth interpretation.
2. Edit the **structure block** in `:buildStructureBlock` for what gets
   surfaced to the LLM as deterministic context.
3. Edit the **calibration** in `:calibrateSignals` for clamps.
4. Edit *this document* to keep the cuts visible to future contributors.
5. Click **Extract ideas** on `/studio` to re-run extraction across
   existing sources (it's idempotent per source — already-extracted
   sources are skipped; delete `extracted_ideas` rows for a forced
   re-extract).

Wave 3 (Assistant synthesis quality) will read `depth_signal` and
`breadth_signal` from `extracted_ideas` to boost retrieval before the
LLM sees raw chunks. Anything you change here directly tunes that ranking.
