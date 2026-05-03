# Sprint 15 Wave 3 — Assistant synthesis quality

> **Source:** original Sprint 15 planning doc (Notion, internal).
> **Wave owner:** Payton Minzenmayer
> **Target merge:** end of Sprint 15 (two-week sprint; Wave 3 is the final wave)

---

## Goal

Improve the quality of Claude's synthesised responses in the Folio chat
interface. Users have reported that the assistant sometimes:
1. States facts not present in the retrieved context (hallucination).
2. Does not cite which connector or data-point it drew from.
3. Gives confident answers when the underlying data is stale or low-confidence.

---

## Acceptance criteria

### AC-1 — Confidence score in normalised schema

- Add a `confidenceScore: number` field (0–1, inclusive) to the `NormalisedAsset`
  Zod schema in `lib/schema.ts`.
- Each connector must populate `confidenceScore` when it creates a
  `NormalisedAsset`. Suggested defaults per connector:
  - Plaid: `0.95` (bank data is authoritative)
  - Polygon: `0.90`
  - CoinGecko: `0.85`
  - Zillow stub: `0.40` (it's mock data)
  - CSV: `0.70` (user-supplied; could be stale)
- The field must be persisted to the `assets` table in Supabase
  (add a migration).

### AC-2 — Confidence badge in chat UI

- In `components/ChatMessage.tsx` (or wherever assistant messages are rendered),
  add a small badge showing the **minimum** `confidenceScore` across all assets
  cited in the response.
- Colour coding:
  - ≥ 0.85 → green (`bg-green-100 text-green-800`)
  - 0.60–0.84 → yellow (`bg-yellow-100 text-yellow-800`)
  - < 0.60 → red (`bg-red-100 text-red-800`)
- The badge should only appear when the response cites at least one asset.

### AC-3 — Reduced hallucination via system-prompt hardening

- Update the system prompt in `app/api/chat/route.ts` to explicitly instruct
  Claude:
  - Only assert facts that appear verbatim in the retrieved context.
  - When uncertain, say "I don't have reliable data on this."
  - Always name the source connector for any cited figure.
- Add a Vitest test that mocks the Anthropic SDK and asserts the system prompt
  contains the three required instructions.

### AC-4 — Stale-data warning

- If any cited asset has a `lastSyncedAt` older than 24 hours, append a
  `⚠️ Some data may be stale` warning below the assistant message.
- `lastSyncedAt` is already on the `NormalisedAsset` schema; no schema change
  needed.

---

## Out of scope for Wave 3

- Zillow real-data integration (Sprint 16).
- Multi-tenant RLS hardening (Sprint 16, issue #52).
- Renaming `lib/openai.ts` (issue #47, dedicated PR).

---

## File touch-list (expected)

| File | Change |
|------|--------|
| `lib/schema.ts` | Add `confidenceScore` field |
| `connectors/plaid.ts` | Populate `confidenceScore` |
| `connectors/polygon.ts` | Populate `confidenceScore` |
| `connectors/coingecko.ts` | Populate `confidenceScore` |
| `connectors/zillow.ts` | Populate `confidenceScore` (stub value) |
| `connectors/csv.ts` | Populate `confidenceScore` |
| `supabase/migrations/` | Add `confidence_score` column to `assets` |
| `components/ChatMessage.tsx` | Add confidence badge + stale warning |
| `app/api/chat/route.ts` | Harden system prompt |
| `*.test.ts` (new/updated) | Unit tests for all of the above |

---

## Definition of done

- [ ] All four ACs above are met.
- [ ] `pnpm test` passes (no regressions).
- [ ] `pnpm tsc --noEmit` exits 0.
- [ ] `pnpm lint` exits 0.
- [ ] PR is reviewed and merged to `main`.
- [ ] `docs/HANDOFF.md` is updated with a `## Last session` block summarising
  what shipped.
