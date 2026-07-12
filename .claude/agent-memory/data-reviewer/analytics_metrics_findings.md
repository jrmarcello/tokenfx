---
name: analytics_metrics_findings
description: Open analytics/metrics correctness defects found in lib/analytics + lib/queries + lib/ingest during 2026-07-11 review — cache-hit-ratio formula drift, README score-weight mismatch, silent zero-cost for unknown model families, session-scoring sampling bias
metadata:
  type: project
---

Findings from a full analytics/metrics correctness pass (2026-07-11). Cross-check
each is still true before re-reporting — code may have moved on.

## MUST FIX

1. **Cache-hit-ratio formula drift between overview KPI and everywhere else.**
   `lib/queries/overview.ts:119` (`cacheRatioSince`) computes
   `cache_read / (input + cache_read)` — the OLD formula. `lib/db/schema.sql:156-157`
   (`session_effectiveness` view, used by `effectiveness.ts`/`effectiveness-v2.ts`)
   was deliberately changed to `cache_read / (input + cache_read + cache_creation)`
   per an explicit in-file comment explaining the old formula "over-reports cache
   effectiveness on sessions that spend most tokens priming a new cache." The
   overview.ts query was never updated to match. Net effect: the "Cache Hit Rate"
   KPI card on `/` shows a different (inflated) number than the same concept
   computed on `/effectiveness` and in the composite score. Fix: change line 119
   to add `+ total_cache_creation_tokens` to the denominator, matching the view.

2. **README describes three mutually-inconsistent scoring formulas, none matching
   the actual code** (`lib/analytics/scoring.ts:effectivenessScore`).
   - README line 24: "quatro sinais" (4 signals) — omits toolErrorRate and acceptRate entirely.
   - README lines 121-128: table claims weights output/input=40%, cacheHit=20%,
     avgRating=30%, (1-correctionDensity)=10% — 4 signals, wrong weights.
   - README lines 312-320: table claims 5 signals (still omits acceptRate) with
     avgRating=30%, correctionDensity=20%, outputInputRatio=20%, toolErrorRate=15%,
     cacheHit=15%.
   - Actual code: 6 signals — avgRating=30%, correctionDensity=20%, acceptRate=15%,
     toolErrorRate=15%, cacheHitRatio=10%, outputInputRatio=10%.
   This is a "correct code, misleading docs" defect — anyone presenting this
   dashboard's methodology to a manager off the README would misstate it. Needs a
   single source of truth (ideally README table generated/tested against the
   weights in scoring.ts, or at minimum manually reconciled).

## SHOULD FIX

3. **Silent zero-cost for unrecognized model families.** `lib/analytics/pricing.ts`
   `getPricing()` family-prefix fallback (`FAMILY_PATTERN = /^claude-(opus|sonnet|haiku)\b/`)
   only covers three known families. A genuinely new model name that doesn't start
   with `claude-opus/sonnet/haiku` (hypothetical codenames like `claude-fable-5` or
   `claude-mythos`) returns `null` → `computeCost` returns `0` with **no warning
   logged anywhere** (`lib/ingest/writer.ts:216` calls `computeCost` directly, no
   null-check on `getPricing`). This is exactly the bug class the family-fallback
   was built to prevent (comment at pricing.ts:84 references a prior incident:
   "22k+ claude-opus-4-6 turns recorded at zero cost"), but the fix only guards
   naming *within* the three known prefixes — a new fourth family reintroduces the
   same failure mode silently. The only existing safety net is the blanket
   `PRICING_LAST_UPDATED` staleness warning (90-day threshold, checked once at
   `pnpm ingest` CLI level) — that doesn't catch a same-day new model release with
   a novel family name. Suggest: log a warn (with model string + turn/session id)
   every time `getPricing` returns null, so the failure is visible in ingest output
   instead of silently zeroing cost.

4. **`getSessionScores` (`lib/queries/effectiveness.ts:44,316`) caps at
   `MAX_SCORED_SESSIONS = 50`, and the source query orders by cost DESC.** So
   `avgScore`, the score-bucket distribution, and `getTopSessionsByScore` are
   always computed over the **top-50-most-expensive** sessions in the window, not
   all sessions in the window. For windows with >50 sessions this silently biases
   every score-derived metric toward expensive sessions, with no UI indication of
   the cap. Fine for typical personal-tool volume but worth flagging since None of
   the KPI cards disclose the sampling.

5. **`correctionDensity` null-contract violated at the one production call site.**
   `scoring.ts` documents `correctionDensity: null` as meaning "session had zero
   turns (nothing to score against)" and 6-signal redistribution treats `null` as
   "exclude this signal." But `lib/queries/effectiveness.ts:339-340` computes
   `turns.length > 0 ? penalties.size / turns.length : 0` — passing `0` (not
   `null`) when a session has zero fetched turns. A `0` correctionDensity
   contributes to the weighted score as "perfectly clean" (weight 0.2, value 1),
   inflating the score for sessions with no turn data instead of excluding the
   signal. Narrow edge case (only triggers when `turnsForSessions` returns nothing
   for a scored session id) but violates the documented contract.

## NICE TO HAVE

6. `PRICING_LAST_UPDATED = 2026-04-18` is 84 days old as of 2026-07-11 (threshold
   90) — not yet stale, but due for a manual audit soon given Anthropic's
   mid-2026 model cadence (sonnet-5 family-fallback pricing is unverified against
   real sonnet-5 list price, since the table only has explicit entries through
   sonnet-4-6/opus-4-7/haiku-4-5).

## Verified correct / not a defect

- Subagent JSONL double-counting: already fixed, see `.specs/fix-ingest-skip-subagent-jsonls.md`
  (DONE) — `/subagents/` path filter in `lib/fs-paths.ts:147`, confirmed present.
- `reconcile.ts` rollups derive session totals from `SUM(turns.*)` post-write —
  re-ingest is idempotent by construction (turns/tool_calls keyed by UUID from
  JSONL, ON CONFLICT DO UPDATE), no double counting from re-running ingest.
- `today` window uses JS `Date` local-time start-of-day (`overview.ts:189`)
  consistent with SQL `strftime(..., 'localtime')` elsewhere — fine for a
  single-process local tool.

See also [[project_schema_overview]] for the schema/index/PRAGMA-level findings
from the same codebase (missing `turns.timestamp` index, etc.) — those are
still open as of this review too.
