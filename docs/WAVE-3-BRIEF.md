# Sprint 15 Wave 3 — Assistant synthesis quality

> **Source:** original Sprint 15 brief from the start of this project,
> reproduced here verbatim plus implementation hints from what's now in
> place after Waves 1, 2, and 2.1.

---

## The problem

Right now Reflect surfaces raw newsletter chunks — intros ("Hey, this is
Payton, [date]…"), sign-offs, formatting noise. No reasoning, just
paste. The Assistant rail looks like a search engine output, not a
thinking partner.

## The fix, in three layers

### 1. Pre-embed cleaning

Strip boilerplate (intros, sign-offs, "view in browser", footers)
before embedding AND before LLM context. Rule-based regex covers most;
first-ingest LLM pass can mark stubborn ranges and cache cleaned text on
the row.

**Where it lands in code:**

- `src/lib/extract-ideas.ts:stripBoilerplate` already has a v0 set of
  patterns (newsletter intros + sign-offs). Extend, don't replace.
- New: cache cleaned text on `newsletter_issues.body_text` (we currently
  store HTML→text via `htmlToText`, but that doesn't strip boilerplate).
  Add a new column `body_clean` or repurpose `body_text` if we're sure
  no other reader depends on it.
- First-ingest LLM pass: when a fresh issue arrives, after the
  rule-based strip, optionally send the result to Haiku with
  `generateObject` + a schema like `{ removed: [{start, end, reason}] }`
  to mark stubborn ranges. Cache the cleaned text. Skip the LLM call on
  re-syncs (the rule-based + cached strip is good enough).

### 2. Retrieval ranking

Don't rank by raw cosine. Boost matches whose extracted Idea (from
Wave 2) has high depth/breadth signal. Filter low-signal chunks before
the LLM sees them.

**Where it lands in code:**

- `src/app/studio/actions.ts:findSimilar` currently runs
  per-kind ORDER BY `embedding <=> ${query}::vector`. Extend to
  LEFT JOIN against `extracted_ideas` on the source's id and add a
  signal-boosted score:
  ```sql
  ORDER BY (
    -- raw cosine similarity
    (1 - (source.embedding <=> ${query}::vector))
    -- + idea-signal boost
    + COALESCE((
        SELECT MAX(0.3 * ei.depth_signal + 0.2 * ei.breadth_signal)
        FROM extracted_ideas ei
        WHERE ei.<source_id> = source.id
      ), 0)
  ) DESC
  ```
- Add a signal floor in `findSimilar`: skip results where the source
  has no extracted ideas AND the cosine similarity is below a threshold
  (e.g. 0.55). This filters the noise floor.
- Wave 3 retrieval should query the `extracted_ideas` table directly
  too — surface the Idea's `title` + `claim` as the snippet instead of
  the raw source body. The user reads "Idea density beats word count"
  not "Hey it's Payton, this week we're talking about…".

### 3. Synthesis prompt rewrite

The LLM must never quote source text. Output shape:

> "You explored [X] in [issue/note title]. That connects to [current
> capture] because [reasoning]."

Source links sit beside as receipts, not as the body.

**Where it lands in code:**

- `src/lib/llm.ts:generateReflection` is the current implementation.
  The prompt currently says "Quote it where natural" — that has to
  flip to "DO NOT quote source text. Refer to ideas by name."
- New voice mode? Or rewrite the existing modes (`default`,
  `newsletter`, `linkedin`)? Recommend rewriting all three to enforce
  the output shape; the mode-specific tone differences still apply
  (newsletter voice vs. punchier LinkedIn vs. neutral default).
- Pass the LLM **extracted Ideas** rather than raw chunks. The
  `bankBlock` currently feeds in `(kind, title, snippet)` triples;
  change snippet to the Idea's `claim + evidence` instead of the
  source body excerpt.

---

## Done criteria

Open a capture in `/studio`, write a few sentences, the Assistant rail
returns 3+ ideas with:

- ✅ Real reasoning ("This connects to your earlier framing of X
  because…")
- ✅ References to **named ideas**, not raw passages
- ✅ Source links surface as receipts (`[1]`, `[2]`) at the bottom or
  inline, NOT as the body content
- ✅ References both newsletter AND Obsidian sources (presumes Obsidian
  is connected; otherwise just newsletter)
- ❌ No quoted intros ("Hey, this is Payton…")
- ❌ No raw HTML or boilerplate footers leaking through
- ❌ No "I notice" / "It seems like" hedge language

---

## What's already in place that helps

- **`extracted_ideas` table** with `depth_signal`, `breadth_signal`,
  `links`, `source_ref`, embedding. Wave 2 wrote this and Wave 2.1
  tuned the signals. Wave 3's retrieval ranking reads from it.
- **HNSW indexes** on `extracted_ideas.embedding` (and on every
  source table's embedding). pgvector's `<=>` operator.
- **Inline extraction** — `upsertIssue` and `upsertParsedNote` extract
  ideas on every fresh write, so the Idea layer is never stale.
- **Backfill button** on `/studio` (`backfillExtractedIdeas`) — useful
  for catching pre-Wave-2 sources after schema migrations.

---

## Suggested implementation order

1. **Pre-embed cleaning first** — rule-based strip extension. Test by
   re-running the backfill button (which already calls extractIdeas);
   confirm ideas extract from cleaner text, embed → embedding column
   updated.
2. **Retrieval ranking** — modify `findSimilar`'s SQL. Add unit tests
   for the new boost math. UI doesn't need to change yet — the same
   rail just gets better hits.
3. **Synthesis prompt rewrite** — last, because it depends on what the
   retrieval surfaces. Test by capturing a draft that has a clear
   matching Idea in the bank; expect the new "You explored X in Y"
   reasoning shape.

---

## What NOT to do

- **Don't add a new connector.** The provider abstraction is ready for
  one but Wave 3 is about quality, not surface area.
- **Don't change the schema.** `extracted_ideas` has everything Wave 3
  needs. Adding a `body_clean` column for the cleaned text is the only
  schema change worth considering, and it's optional.
- **Don't rewrite the connector contract.** It works. Touch it only
  if Wave 3 reveals a real gap.
- **Don't delegate the commit to a sub-agent.** See HANDOFF.md
  postmortem on the Wave 2 corruption.
