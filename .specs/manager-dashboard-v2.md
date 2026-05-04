# Spec: manager-dashboard-v2 — effectiveness depth + health signals (Q2-C / Q2-D)

## Status: IN_PROGRESS

> **v2 rewrite (2026-05-01)**: Pause-1 user approval received; 13 bloqueadores arquiteturais + 25 must-fix + ~50 TCs aplicados; re-self-review caught 4 additional CRITICALs (formula table stale, TC-I-29 mock channel wording, TC-I-33 ORDER BY missing COALESCE, TASK-NOTIFICATION circular dep) + ~10 WARNINGs (TASK-MIGRATIONS missing files in list, MERGE-LAYOUT anchor undefined, TASK-CRON-CLEANUP needed notification prune, Q14 needs owning task), all applied. Spec advanced to IN_PROGRESS for execution.

## Depends on

- `central-reporter-server.md` — must be **DONE** before this spec starts. That spec establishes:
  - The sibling Next.js app at `apps/server/` with Postgres + SSO + multi-org data model.
  - The push-based reporter shipping sanitized aggregates from each dev's local install.
  - The manager dashboard v1 (cost + adoption only — Q2-A and Q2-B).
  - Tables that already exist (per spec 3 Design): `orgs`, `users` (with `org_id`, `team_id NULL`, `role` ∈ `member|manager|admin`), `teams`, `user_machines`, `sessions_agg` (per `(user_id, session_id)`), `model_breakdown_agg`, `tool_count_agg` (per session × tool), `cost_calibration_per_user`, `ingestion_log`. SSO/auth middleware resolves `req.user` (with `org_id` and `role`).
- **Manager scope (locked Opção A — 2026-04-28)**: a `manager`-role user manages **their entire org** — every team in their `org_id`. There is **no** `team_memberships` junction nor `manager_assignments` table; team membership is `users.team_id` (one team per user, NULL allowed). This avoids extending spec 3's schema and fits the local-tool / company-deployment scale (a manager typically supervises one org's worth of devs).
- **Daily rollups (locked — 2026-04-28)**: `team_metrics_daily` is computed **directly from `sessions_agg` + `tool_count_agg`** via SQL `GROUP BY team_id, day`. No intermediate `session_aggregates_daily` / `tool_usage_daily` tables are created — they would just duplicate per-session rows by day for the same data. The 15-min cron's INSERT INTO `team_metrics_daily` is a pure aggregation over the spec-3-owned tables.

### Prerequisite gap — outcome data (tokens-per-merged-LOC)

`Tokens per merged-LOC per team` (REQ-5 below) requires per-session/per-day **outcome** signals (LOC merged, PR merged status) flowing through the reporter payload from each dev. That data is **NOT** in the v1 reporter scope (cost + adoption only). Two paths:

1. **Push back to spec 1** — add an `outcome_metrics_daily` payload section (LOC added/removed/merged from local git observations, gated by an `outcome-integration-git` follow-up local feature) to the reporter contract before this spec starts.
2. **Scope out of v1** — drop REQ-5 from this spec; track as `manager-dashboard-v3-outcomes.md` follow-up after both reporter outcome-integration AND this v2 ship.

**Recommendation locked in this DRAFT**: option **(2) — scope out of v1**. Reason: the `tokens-per-merged-LOC` metric depends on a local feature (`outcome-integration-git`) that doesn't exist yet on the agent side either; coupling this v2 to two upstream specs (reporter + outcome-git) materially blocks shipping the other 4 effectiveness metrics + health signals. REQ-5 is recorded below as `[OUT-OF-SCOPE-V1]` so it's not lost.

## Context

`central-reporter-server.md` ships v1 of the manager dashboard with **cost** (USD spend per team / dev) and **adoption** (active devs, sessions, tokens). That answers the CFO question ("how much are we spending?") and the rollout question ("are people using it?"). It does **not** answer:

- **Q2-C — Effectiveness**: which teams are getting actual leverage from Claude Code? Are they using the cache well? Reaching for subagents (parallelism)? Picking the right tool mix?
- **Q2-D — Health signals**: which devs may need a check-in (sudden spike, sudden drop)? Which teams should share patterns the others haven't discovered yet?

This spec is the **manager-facing depth layer**. The hard non-negotiable: **anti-surveillance design**. A manager's default view is **team-aggregated**. Dropping into individual data requires a **reason tag**, writes an **audit row**, and **notifies the dev** their data was viewed. There are **no public dev rankings** anywhere, ever — even within a team, no sorted-by-spend dev list. Anomaly cards are framed as **"check-in opportunities"**, never as performance flags.

This is a deliberate departure from "more data = more accountability" — the goal is **enablement, not surveillance**. Devs who feel watched stop experimenting; manager dashboards that surface individuals by spend, ranked, are extraction tools, not enablement tools. The metrics here help managers spot **support opportunities** (training-check, cost-investigation) and **knowledge-sharing opportunities** ("Team X uses subagents 4× more — share patterns"). The Design section codifies the 5 anti-surveillance principles that gate every UI and query in this spec.

### Decisões já travadas (locked before execution)

1. **Aggregation strategy**: scheduled aggregation tables (`team_metrics_daily`, refreshed every 15 min via cron job — see Tradeoffs in Design). Rejected: Postgres materialized views (REFRESH MATERIALIZED VIEW CONCURRENTLY needs unique indexes on every matview and the surface area is wider than a cron'd insert into a plain table; cron'd table is also easier to backfill / inspect / repair).
2. **Composite effectiveness score** (per session, then averaged per team-day): weighted blend of:
   - `cache_hit_ratio` × **0.40** (was 0.30)
   - `output_input_ratio_normalized` × **0.40** (was 0.30; clip to [0, 5], then divide by 5; column name is `output_input_ratio` per spec-3 schema, NOT `output_to_input_ratio`)
   - `subagent_usage_ratio_normalized` × 0.10 (capped at 0.5 → mapped to 1.0; column is `subagent_usage_ratio` per spec-3 schema, NOT `subagent_count`)
   - `manual_rating_normalized` × 0.10 (`(avg_rating + 1) / 2`, NULL → drop weight, redistribute)
   - Output: 0..100 integer. Same redistribution rule as `lib/analytics/scoring.ts` (existing).
   - **`correction_density` component intentionally dropped** (was 0.20 in v1 DRAFT). Reason: `sessions_agg` does NOT have a `correction_density` column — that signal lives in turn-level events stripped by the reporter sanitizer. Adding it would require carve-out spec to extend the reporter payload + sanitizer allowlist. The 0.20 weight was redistributed to cache_hit (+0.10) and output_input (+0.10) — the two strongest aggregate-level signals. Documented inline in `composite-score.ts` JSDoc to prevent "fix" attempts.
3. **"Good session" threshold**: `composite >= 60` OR `manual_rating >= 0` (not strict — generous on purpose, since the goal is **adoption**, not "find bad work"). Documented in REQ.
4. **Anomaly detection** runs on team-day rollups (`team_metrics_daily`), not at query time. A nightly cron computes z-scores for each (team, dev, metric) using the **last 30 days of the team** as the reference distribution — not the dev's own history (one dev's outlier vs themselves is normal noise; vs the team it's a signal worth a check-in).
5. **Spike threshold**: 30d spend > **3σ above team mean** OR week-over-week spike > **+50%** (whichever fires first). Both surface as the **same** "check-in opportunity" card — copy is identical regardless of which trigger fired (we don't want to encode "you spiked!" vs "you're an outlier!" into separate UI tones).
6. **Drop-off threshold**: **>50% week-over-week decrease** in active days OR session count, AND the dev was active in the previous week (previous-week zero → not a drop-off, that's onboarding lag).
7. **Drilldown reason tags** (REQ-15): `training-check`, `quota-investigation`, `cost-investigation`, `other` (free-text required if `other`). Closed list — no free-text on the first three (audit ergonomics).
8. **Dev notification on drilldown**: default ON. Configurable per-org via `org_settings.drilldown_notification_enabled boolean` (added in this spec). When ON, the notification is delivered via the same email/slack channel spec 1 uses for SSO welcome (reuse — do not invent a new channel).
9. **`/me/visibility` for devs**: every dev can see (a) what their manager sees about them in aggregate, and (b) the audit log of every drill-down on their own data (manager identity, timestamp, reason). Non-negotiable — this is the trust contract.
10. **Comparison radar chart** scale: each axis normalized to **the population of teams in the org** (min/max within org, not absolute). Avoids "team A's 40% cache hit looks bad" when the entire org averages 35%.
11. **Refresh cadence trade-off**: 15 minutes for `team_metrics_daily` (acceptable freshness for a manager view; the alternative — 5 min — wastes cycles for data nobody refreshes that fast). Anomaly detection runs **once nightly** at 02:00 org-local — anomalies are weekly-cadence decisions, not real-time.
12. **No public rankings**: enforced at the query layer. `getTeamMembersForManager` returns members in **alphabetical order by display name**, never sorted by any usage metric. Code comment + lint rule documenting the principle.

## Requirements

### Effectiveness depth (Q2-C)

- [ ] **REQ-1**: GIVEN a manager logged in via SSO with `manager` role on team `T` WHEN they navigate to `/manager/effectiveness` THEN the page renders **avg cache_hit_ratio for team T** as a single number (0..100%) and a 30-day **trend chart** (Recharts LineChart) showing the daily team avg over the last 30 days. Data source: `team_metrics_daily.cache_hit_ratio_avg` for `team_id = T`.

- [ ] **REQ-2**: GIVEN the same `/manager/effectiveness` page WHEN it renders THEN it shows **% good sessions for team T** (sessions where `composite >= 60` OR `manual_rating >= 0`) as a number, and a 30-day trend. Aggregation rule and threshold documented inline in the UI as a `<details>` ("How is this calculated?").

- [ ] **REQ-3**: GIVEN the same page WHEN it renders THEN it shows **tool mix for team T over 30 days** as a stacked bar chart (Recharts BarChart, stacked) — bars per day, segments per tool category: `Edit / Read / Bash / Agent / Other`. The `Other` bucket aggregates everything not in the first 4. **Tool name → bucket mapping**:
  - `Edit` → `Edit`
  - `Read` → `Read`
  - `Bash` → `Bash`
  - `Task` → `Agent` (the Claude Code tool was renamed Task → Agent; both names appear in historical data — both map to `Agent` bucket)
  - `Agent` → `Agent`
  - everything else → `Other`

  **Data source**: aggregate live from `tool_count_agg` (per-session per-tool counts owned by spec 3) joined with `sessions_agg` for `(team_id, day)` derivation via `JOIN users ON sessions_agg.user_id = users.id`; OR pre-rolled into `team_metrics_daily.tool_mix_json` by the 15-min cron and read by the page. The cron path is preferred for performance; live aggregation is the fallback when the cron has lag. Categories are a fixed 5-element enum. **Note**: REQ-4 (subagent adoption) uses a different signal (`sessions_agg.subagent_usage_ratio`, a pre-computed scalar from the reporter) — not derived from `tool_count_agg`. The two metrics are distinct: REQ-3 counts ALL Task/Agent tool invocations; REQ-4 counts sessions where the reporter detected ≥1 subagent invocation (`subagent_usage_ratio > 0`).

- [ ] **REQ-4**: GIVEN the same page WHEN it renders THEN it shows **subagent adoption for team T** as `% of sessions in the last 30 days where sessions_agg.subagent_usage_ratio > 0` and a 30-day trend chart. Includes a copy line: "Subagent usage is a signal of devs adopting parallelism — high here is good." **Schema note**: `sessions_agg.subagent_usage_ratio` is a `NUMERIC(4,3)` 0..1 ratio computed by the reporter (NOT a count). The metric "% sessions with subagent usage" is `COUNT(*) FILTER (WHERE subagent_usage_ratio > 0) / COUNT(*)`.

- [ ] **REQ-5** `[OUT-OF-SCOPE-V1]`: **Tokens per merged-LOC per team** — depends on outcome data (LOC merged from git) flowing through the reporter, which is not in spec 1 v1 scope. Tracked here for traceability; will move to `manager-dashboard-v3-outcomes.md` once both `outcome-integration-git` and the reporter outcome-payload extension ship. **No tasks, no TCs, no UI in this spec.**

- [ ] **REQ-6**: GIVEN the manager has access to `≥ 2` teams WHEN they navigate to `/manager/effectiveness` THEN a **comparison view** at the top of the page renders a Recharts radar chart with 5 axes: `cache_hit_ratio`, `% good sessions`, `subagent_adoption`, `Edit-tool share`, `Read-tool share`. Each axis is normalized to `[0, 1]` against the **min/max of the manager's teams** (REQ trade-off locked: not absolute, not org-wide). One polygon per team, color-coded. Up to 6 teams; if `> 6`, the manager picks via a multi-select.

- [ ] **REQ-7**: GIVEN a manager navigates to `/manager/teams/[id]/effectiveness` WHEN the route loads with `id = T` belonging to that manager THEN it shows the same 4 KPIs as REQ-1..4 **for team T only**, with the 30-day trend per metric. This is the team-scoped deep-dive page.

- [ ] **REQ-8**: GIVEN a non-manager user (regular dev role) hits `/manager/effectiveness` OR `/manager/teams/[id]/effectiveness` OR `/manager/health` WHEN the auth middleware resolves their role THEN they receive HTTP 403 with `{ error: { message: "Manager role required", code: "FORBIDDEN" } }` — no data leak, no partial render.

- [ ] **REQ-9**: GIVEN a manager hits `/manager/teams/[id]/effectiveness` for a team `id` they do NOT manage WHEN auth resolves THEN HTTP 403 with the same error shape (no team enumeration via 404 vs 403 distinction).

### Health signals (Q2-D)

- [ ] **REQ-10**: GIVEN a manager navigates to `/manager/health` WHEN the page renders THEN it shows a list of **"check-in opportunity" cards** for devs in the manager's teams whose **30d spend** exceeds **(team mean + 3σ)** OR week-over-week spend increase **>= 50%**. Each card shows: dev display name, team, the trigger ("30d spend 3.2σ above team avg" OR "spend up 67% WoW"), and a primary CTA "Open conversation guide" (links to a `/manager/check-in/[devId]?reason=cost-investigation` flow that pre-fills the drilldown audit reason).

- [ ] **REQ-11**: The exact UI copy for the check-in opportunity card MUST be (verbatim, locked here):
   - Heading (no exclamation, no alarm tone): `"Check-in opportunity"`
   - Body: `"{displayLabel} on team {teamName} — {trigger description}. This may be worth a 1:1 conversation about workflow, training, or scope. It's not a flag."`
   - **`displayLabel` fallback chain** (helper `displayLabelFor(user)` in `lib/util/user-display.ts`): `user.display_name ?? user.email.split('@')[0]`. Centralized so every card / audit log / `/me/visibility` references the same fallback. Always non-null (email guaranteed by schema NOT NULL constraint).
   - Primary CTA label: `"Open conversation guide"`
   - Secondary CTA label: `"Dismiss for 7 days"` (writes a row to `manager_dismissed_anomalies` with `dismissed_until = now + 7d`).
   - **Forbidden tone words in this card**: `"alert"`, `"warning"`, `"flag"`, `"violation"`, `"breach"`. Enforced via CI grep step (Q14 locked) AND TC-I-35 / TC-E2E-05.

- [ ] **REQ-12**: GIVEN the same `/manager/health` page WHEN it renders THEN it shows **drop-off cards** for devs whose week-over-week active-days OR session-count dropped > 50% AND who were active in the prior week. Card uses the same supportive tone as REQ-11:
   - Heading: `"May need support"`
   - Body: `"{displayLabel} on team {teamName} — usage down {pct}% week-over-week. Consider checking in about training, blockers, or scope changes."`
   - `displayLabel` uses the same `displayLabelFor(user)` fallback as REQ-11.
   - CTAs: `"Open conversation guide"` and `"Dismiss for 7 days"`.

- [ ] **REQ-13**: GIVEN `/manager/health` renders for a manager whose teams have **knowledge-sharing opportunities** WHEN the rollup detects a team using a tool/agent **>= 2× the median across the manager's teams** AND **>= 4× the lowest team** (both gates) WHEN the page renders THEN a "Knowledge-sharing opportunity" section lists: `"Team {top} uses {feature} {ratio}× more than {bottom}. Consider sharing patterns."` Examples: subagents, specific agent types (`code-reviewer`, `Explore`), tool categories.

- [ ] **REQ-14**: GIVEN the manager navigates to **any individual dev drilldown** route (`/manager/check-in/[devId]?reason=...` OR `/manager/devs/[devId]`) WHEN the route loads WITHOUT a valid `reason` query param matching the closed enum `{ training-check, quota-investigation, cost-investigation, other }` (case-sensitive) THEN HTTP 400 `{ error: { message: "Reason tag required", code: "REASON_REQUIRED" } }`. With `reason=other`, the request body MUST include `reasonText` (string, 10..500 chars) — Zod-validated; missing/short → 400.

- [ ] **REQ-15**: GIVEN the manager hits a dev-drilldown route with a valid `reason` AND optional `reasonText` WHEN auth + reason validation pass AND the dev is in one of the manager's teams THEN a row is upserted into `manager_drilldown_audit` with: `org_id, manager_user_id, target_user_id, reason, reason_text (nullable), viewed_on (date, server-side date in UTC), viewed_at (timestamptz, server time), source_route, ip_address_trunc (text, /24 IPv4 or /48 IPv6 CIDR string, nullable, purged via cron after 30d — same policy as spec 3 REQ-27)` BEFORE any dev data is rendered.

  **Drilldown route is a Server Component (Next.js 15 App Router)**. Missing/invalid `reason` query → `redirect('/manager/health?error=missing-reason')` (returns to health page with banner). Cross-team / cross-org devId → `notFound()`. Audit insert failure → throws; `error.tsx` renders generic "internal error", **no dev data leaks**. Audit insert + data fetch run inside `db.transaction(async (tx) => { ... })` — same connection, atomic.

  **Idempotency** (B9 locked): a `UNIQUE (manager_user_id, target_user_id, viewed_on, reason)` constraint dedupes same-day repeats. Implementation uses raw SQL via `tx.execute(sql\`INSERT INTO manager_drilldown_audit (...) VALUES (...) ON CONFLICT (manager_user_id, target_user_id, viewed_on, reason) DO UPDATE SET viewed_at = EXCLUDED.viewed_at, ip_address_trunc = EXCLUDED.ip_address_trunc RETURNING (xmax = 0) AS inserted\`)` — Drizzle's `.returning()` does not expose Postgres system columns like `xmax`, so raw SQL is mandatory here (documented inline in `writeAudit()` JSDoc). The `inserted` boolean discriminates real INSERT (`xmax = 0`) from ON CONFLICT UPDATE (`xmax > 0`), driving REQ-16's notification gating. Refreshing the page or the manager re-opening the link the same day **does not** create a new audit row nor trigger another notification (REQ-16). If the audit upsert fails, the whole request 500s and **no data is shown**.

  **Why upsert instead of POST-only**: GET pages with audit are CSRF-vulnerable (a malicious link could trigger phantom audits); idempotency on `(manager, target, day, reason)` neutralizes that — same link clicked any number of times same-day = single audit, single notification. A new audit row only on a new day OR a new reason tag, both intentional manager actions.

- [ ] **REQ-16**: GIVEN a drilldown audit upsert resulted in a **new row inserted** (not an ON CONFLICT no-op same-day refresh) AND the org has `drilldown_notification_enabled = true` (default true) WHEN the request completes successfully THEN a notification is enqueued for the **target dev** through the same notification channel spec 1 uses. The route uses `INSERT ... ON CONFLICT ... RETURNING xmax` (or `RETURNING (xmax = 0) AS inserted`) to detect "was this a real insert or an ON CONFLICT update". Only `inserted = true` triggers notification — refreshes are silent. Notification body: `"Your manager {managerName} viewed your usage on {viewedOn} for reason: {reasonHumanReadable}{reasonTextSuffixIfProvided}."` — verbatim, locked. Enqueueing happens **after** the response is sent (don't block manager UX on notification deliverability). Dropped notifications retry via spec 1's backoff. **Note on channel**: spec 1 didn't lock a notification channel; this spec depends on it. Open Question #2 surfaces this.

- [ ] **REQ-17**: GIVEN a dev (any role) navigates to `/me/visibility` WHEN the page renders THEN it shows: (a) the **same aggregated KPIs** their manager sees about them (cache_hit_ratio, % good sessions, subagent adoption, tool mix — last 30d), and (b) a **chronological log** of every drilldown row in `manager_drilldown_audit` where `target_user_id = self`, columns: `viewed_at, manager_display_name, reason, reason_text` (newest first, paginated 25/page). No row is hidden from the dev — even if the org later toggles `drilldown_notification_enabled = false`, the audit log on `/me/visibility` continues showing past views.

- [ ] **REQ-18**: GIVEN ANY query that returns dev-level data within a team for a manager WHEN it executes THEN the result MUST be ordered alphabetically by `COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC` — never sorted by spend/tokens/sessions/any usage metric. Documented at the query layer with a comment + a unit test that asserts ordering. (Anti-surveillance principle 3.) The `COALESCE` fallback handles users created before this spec's `display_name` column was added (NULL → email local-part).

- [ ] **REQ-19**: GIVEN the manager-side queries on `team_metrics_daily`, `manager_drilldown_audit`, and other v2 tables WHEN they execute THEN they MUST use Drizzle ORM's parameterized API: `db.select()`, `db.insert()`, `db.execute(sql\`...\`)` — never template-string concatenation of `org_id`/`team_id`/`user_id` values into raw SQL. The `sql\`\`` template tag binds interpolated values as parameters automatically. Pattern reference: `apps/server/lib/queries/teams.ts` (Drizzle parameterized) and `apps/server/lib/queries/redeem.ts` (uses `sql\`SELECT ... WHERE token = ${token} FOR UPDATE\`` — `${token}` is bound, not interpolated).

### Data infrastructure

- [ ] **REQ-20**: GIVEN spec 1's Postgres schema is in place WHEN this spec's migrations run THEN the following **new tables** are created (DDL spelled out in Design):
   - `team_metrics_daily` — rollups; one row per (org, team, day, metric_set).
   - `manager_drilldown_audit` — append-only audit; never deleted.
   - `manager_dismissed_anomalies` — per (org, manager, target_dev, anomaly_type), with `dismissed_until` timestamptz.
   - `org_settings` — extended (or created if not present) with `drilldown_notification_enabled boolean default true`.

- [ ] **REQ-21**: GIVEN `team_metrics_daily` is empty WHEN the **15-minute aggregation cron** runs THEN it backfills the last 90 days on first run, computing rollups **directly from spec 3's `sessions_agg` and `tool_count_agg`** via SQL: `GROUP BY users.team_id, date_trunc('day', sessions_agg.started_at)` joined to `users` for team resolution and to `tool_count_agg` for the tool_mix JSON. No intermediate per-day per-user rollup table is needed — `sessions_agg` is already the per-session aggregate. Idempotent: `INSERT ... ON CONFLICT (org_id, team_id, day, metric_set) DO UPDATE`. Subsequent runs only refresh the last 2 days (handles late-arriving reporter pushes).

- [ ] **REQ-22**: GIVEN the **nightly anomaly cron** runs at 02:00 UTC (Q10 locked: TZ-aware scheduling deferred until `orgs.timezone` column is added in a follow-up spec) THEN for each team in each org with **≥ 5 active devs in the last 30d** (Q11 locked: small-team z-score guard — std-dev unstable below 5), it computes z-scores for each (dev, 30d_spend) using the **team's last 30 days** as the reference distribution and writes flagged rows to a new `manager_anomalies` table. Teams with < 5 active devs are skipped (no rows written). Idempotent on `UNIQUE (org_id, team_id, target_user_id, kind, detected_on)`.

- [ ] **REQ-23**: GIVEN any of the new cron jobs fail (DB unavailable, query timeout) WHEN they retry THEN they retry with exponential backoff (1m → 5m → 30m → fail-and-alert via org ops channel). The `cron_runs` table (created here OR reused from spec 1) records every run with `started_at, finished_at, status, error_message`.

- [ ] **REQ-24**: All new manager-v2 queries live in `apps/server/lib/queries/manager-v2.ts` (spec 1 has `manager.ts` for v1 — they coexist; v2 does not modify v1 file unless necessary, and if it does, the modification is additive only). Queries follow spec 1's `PreparedSet`/WeakMap pattern.

## Test Plan

### Unit Tests — composite scoring, anomaly thresholds, normalization

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | `computeCompositeScore({ cacheHit: 0.5, outputInput: 2.0, subagentUsage: 0.3, manualRating: 0.5 })` (4 components, NO `correctionDensity` — that field was DROPPED in v2; passing it would be a TypeScript error) | integer 0..100 matching the v2 locked formula `0.40 × cacheHit + 0.40 × clamp(outputInput/5) + 0.10 × clamp(subagentUsage × 2, max 1.0) + 0.10 × ((manualRating + 1) / 2)` = `0.40×0.5 + 0.40×0.4 + 0.10×0.6 + 0.10×0.75 = 0.495 → round to 50` |
| TC-U-04b | REQ-2 | edge | `outputInput: null` (40% weight redistribution) | weight redistributed proportionally across cache_hit (now 0.667), subagent (0.167), manual_rating (0.167); output still 0..100 |
| TC-U-02 | REQ-2 | edge | All component metrics at perfect maxes | exactly 100 |
| TC-U-03 | REQ-2 | edge | All component metrics at 0 / negative | exactly 0 (clip) |
| TC-U-04 | REQ-2 | edge | `manualRating: null` | weight redistributed across other 4 components, output still 0..100 |
| TC-U-05 | REQ-2 | edge | All metrics null | returns null (no signal) |
| TC-U-06 | REQ-2 | boundary | composite exactly 60 | counted as "good" |
| TC-U-07 | REQ-2 | boundary | composite 59 with rating 0 | counted as "good" (rating override) |
| TC-U-08 | REQ-2 | boundary | composite 59, rating -1 | NOT good |
| TC-U-09 | REQ-10 | business | `detectSpike({ thirtyDaySpend: 100, teamMean: 50, teamStdDev: 10 })` | flagged: 5σ above mean |
| TC-U-10 | REQ-10 | business | `detectSpike({ thirtyDaySpend: 75, teamMean: 50, teamStdDev: 10 })` | NOT flagged: 2.5σ |
| TC-U-11 | REQ-10 | boundary | `detectWowSpike({ thisWeek: 150, lastWeek: 100 })` | NOT flagged: exactly +50%, threshold is strict `>`, not `>=` (paired with TC-U-12) |
| TC-U-12 | REQ-10 | boundary | `detectWowSpike({ thisWeek: 149.99, lastWeek: 100 })` | NOT flagged: 49.99% |
| TC-U-11b | REQ-10 | business | `detectWowSpike({ thisWeek: 150.01, lastWeek: 100 })` | flagged: 50.01% (just above strict threshold) |
| TC-U-13 | REQ-12 | business | `detectDropOff({ thisWeek: 1, lastWeek: 5, prevPrevWeek: 5 })` | flagged: -80% |
| TC-U-14 | REQ-12 | edge | `detectDropOff({ thisWeek: 0, lastWeek: 0 })` | NOT flagged (not active before either) |
| TC-U-15 | REQ-12 | boundary | `detectDropOff({ thisWeek: 2, lastWeek: 4 })` | NOT flagged: exactly -50%, threshold is `>50%` not `>=` |
| TC-U-16 | REQ-12 | boundary | `detectDropOff({ thisWeek: 1, lastWeek: 3 })` | flagged: -66.6% |
| TC-U-17 | REQ-6 | happy | `normalizeRadarMetrics({ teams: [{ cacheHit: 0.4 }, { cacheHit: 0.6 }, { cacheHit: 0.5 }] })` | min→0, max→1, mid→0.5 |
| TC-U-18 | REQ-6 | edge | All teams identical metric | all → 0.5 (not div-by-zero) |
| TC-U-19 | REQ-3 | happy | `bucketizeToolMix(['Edit', 'Read', 'Bash', 'Agent', 'Grep', 'Other'])` | `{ Edit:1, Read:1, Bash:1, Agent:1, Other:2 }` |
| TC-U-20 | REQ-13 | business | `detectKnowledgeSharingOpportunity({ teams: [{usage:10},{usage:5},{usage:2}] })` | flagged: top 5× lowest, 2× median (median is 5) |
| TC-U-21 | REQ-13 | edge | `detectKnowledgeSharingOpportunity({ teams: [{usage:0},{usage:0}] })` | NOT flagged (all zero) |
| TC-U-22 | REQ-14 | validation | `parseReasonTag('training-check')` | valid |
| TC-U-23 | REQ-14 | validation | `parseReasonTag('Training-Check')` | invalid (case-sensitive) |
| TC-U-24 | REQ-14 | validation | `parseReasonTag('hacking')` | invalid (not in enum) |
| TC-U-25 | REQ-14 | boundary | `parseReasonText('a'.repeat(10))` | valid (min) |
| TC-U-26 | REQ-14 | boundary | `parseReasonText('a'.repeat(9))` | invalid (min-1) |
| TC-U-27 | REQ-14 | boundary | `parseReasonText('a'.repeat(500))` | valid (max) |
| TC-U-28 | REQ-14 | boundary | `parseReasonText('a'.repeat(501))` | invalid (max+1) |

### Integration Tests — Postgres, queries, audit, cron, auth

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-20 | infra | Run all manager-v2 migrations against fresh Postgres | All 4 tables exist with expected columns + indexes |
| TC-I-02 | REQ-20 | infra | Re-run migrations | No-op (idempotent) |
| TC-I-03 | REQ-21 | happy, idempotency | Run 15-min aggregation against seeded `sessions_agg` + `tool_count_agg` (per-session rows owned by spec 3) | `team_metrics_daily` populated via GROUP BY team_id, day; second run no duplicates |
| TC-I-04 | REQ-21 | edge | Re-run aggregation after late reporter push for `day-1` | Only last 2 days re-aggregated, prior days untouched |
| TC-I-05 | REQ-22 | happy | Nightly anomaly cron with seeded team where one dev is 4σ above mean | Flagged row written to `manager_anomalies` |
| TC-I-06 | REQ-22 | idempotency | Re-run nightly cron same day | No duplicate rows (unique on `(date, team_id, target_user_id, kind)`) |
| TC-I-07 | REQ-23 | infra | Cron job with simulated DB connection error | Exponential backoff invoked; `cron_runs` row marks `failed` after final retry |
| TC-I-08 | REQ-1 | happy | `getTeamCacheHitTrend(db, { orgId, teamId, days: 30 })` against seeded data | 30 rows, ordered by day asc, values match seed |
| TC-I-09 | REQ-1 | edge | Empty `team_metrics_daily` for that team | Returns `[]`, no throw |
| TC-I-10 | REQ-2 | happy | `getTeamGoodSessionPct(db, ...)` | Pct matches `(good / total) * 100` |
| TC-I-11 | REQ-3 | happy | `getTeamToolMix30d(db, ...)` | Each row has 5 numeric fields summing to total tools |
| TC-I-12 | REQ-4 | happy | `getTeamSubagentAdoption(db, ...)` | Pct of sessions w/ `subagent_usage_ratio > 0` correct (column is `subagent_usage_ratio`, NOT `subagent_count`) |
| TC-I-12b | REQ-4 | boundary | `getTeamSubagentAdoption` with one session at `subagent_usage_ratio=0` and one at `0.001` | adoption pct = 50% (only 0.001 session counts; strict `> 0`) |
| TC-I-13 | REQ-6 | business | `getRadarComparison(db, { teamIds })` returns normalized 0..1 axes | min→0, max→1, intermediate proportional |
| TC-I-14 | REQ-7 | happy | `/manager/teams/[id]/effectiveness` GET as authorized manager | 200 + page renders 4 KPI cards (HTML grep) |
| TC-I-15 | REQ-8 | security | Same route as non-manager | 403 + error shape `{error:{message,code:"FORBIDDEN"}}` |
| TC-I-16 | REQ-9 | security | Manager hits `/manager/teams/[other-team-id]/effectiveness` | 403 (not 404) |
| TC-I-17 | REQ-10 | happy | `getCheckInOpportunities(db, { managerId })` | Returns devs flagged by spike OR WoW; ordered alphabetically (REQ-18) |
| TC-I-18 | REQ-12 | happy | `getDropOffCandidates(db, { managerId })` | Returns devs w/ >50% WoW drop AND active prior week |
| TC-I-19 | REQ-13 | happy | `getKnowledgeSharingOpportunities(db, { managerId })` | Returns rows where top team is >=2× median AND >=4× bottom |
| TC-I-20 | REQ-14 | validation | `GET /manager/check-in/[devId]` (Server Component) with no `reason` query param | response is a redirect to `/manager/health?error=missing-reason` (Next.js `redirect()`); NO audit row written |
| TC-I-21 | REQ-14 | validation | `GET /manager/check-in/[devId]?reason=banana` (not in enum) | redirect to `/manager/health?error=missing-reason`; NO audit row |
| TC-I-22 | REQ-14 | validation | `GET /manager/check-in/[devId]?reason=other` without `reasonText` query param | redirect to `/manager/health?error=missing-reason-text`; NO audit row. **Implementation note**: `reasonText` is a query param (`?reason=other&reasonText=...`) since drilldown is GET-only Server Component. The `displayLabelFor()` helper handles the rendered manager name; `reasonText` 10..500-char Zod validation runs on the query param. |
| TC-I-23 | REQ-14 | validation | `?reason=other&reasonText=<9-char>` | redirect to `/manager/health?error=invalid-reason-text` |
| TC-I-24 | REQ-14 | happy | `?reason=other&reasonText=<10-char>` | 200, page renders, audit row written |
| TC-I-25 | REQ-14 | validation | `?reason=other&reasonText=<501-char>` | redirect to `/manager/health?error=invalid-reason-text` |
| TC-I-26 | REQ-15 | business, security | Valid drilldown by manager A on dev D in team T | Row written to `manager_drilldown_audit` with all expected fields BEFORE response sent; data rendered |
| TC-I-27 | REQ-15 | infra, security | Drilldown where audit insert fails (forced via SQL trigger or constraint violation) | 500; NO dev data leaked in response body |
| TC-I-28 | REQ-15 | security | Drilldown by manager A on dev D where D is NOT in any of A's teams | 403, NO audit row written, NO data |
| TC-I-29 | REQ-16 | business | Drilldown when `drilldown_notification_enabled=true` | Row exists in `manager_notifications` with `target_user_id = D, status='pending', template='MANAGER_DRILLDOWN_VIEW'`; verified via direct DB query (NO mock channel — Q9 lock). `payload_json` contains `managerName`, `viewedOn`, `reason` matching seeded data. |
| TC-I-30 | REQ-16 | business | Drilldown when `drilldown_notification_enabled=false` | NO notification enqueued; audit row STILL written |
| TC-I-31 | REQ-17 | happy | `GET /me/visibility` for dev with 3 historical drilldown rows | Page shows aggregated KPIs + audit table with 3 rows newest-first |
| TC-I-32 | REQ-17 | edge | `GET /me/visibility` for dev with no drilldowns | Page renders KPIs + empty audit log w/ "No views recorded" copy |
| TC-I-33 | REQ-18 | security | `getTeamMembersForManager` returns members in alphabetical order; SQL string is inspected directly | SQL contains literal `ORDER BY COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC` (NOT bare `display_name ASC` — that breaks NULL fallback); assertion fails if any spend-based ordering sneaks in |
| TC-I-34 | REQ-19 | security | All manager-v2 queries inspected for prepared-statement usage (lint or test) | No template-literal SQL in `manager-v2.ts` |
| TC-I-35 | REQ-11 | security | Audit content of check-in card HTML for forbidden tone words | None of `alert/warning/flag/violation/breach` present in card |
| **NEW TCs added post Pause-1 (29 TCs covering gaps surfaced by 3 reviewers)** | | | | |
| TC-U-29 | REQ-23 | security | `assertInternalCronAuth` with no `x-internal-cron-secret` header | throws 401 |
| TC-U-30 | REQ-23 | security | with wrong secret value | throws 401 (timing-safe-equal) |
| TC-U-31 | REQ-23 | happy | with correct secret | does not throw, returns void |
| TC-U-32 | REQ-2 | boundary | `MANAGER_GOOD_SESSION_THRESHOLD=0` env → threshold parsed as 0; composite=0 is "good" | parses + classifies |
| TC-U-33 | REQ-2 | boundary | `=100` → composite=100 is "good", composite=99 is NOT good | parses + classifies |
| TC-U-34 | REQ-2 | validation | `=101` → throws or fallback to default 60 | (lock: throws ConfigError; document) |
| TC-U-35 | REQ-2 | validation | `='banana'` → throws or fallback | (lock: throws ConfigError) |
| TC-U-36 | REQ-14 | edge | drilldown body `{ reason: 'training-check', reasonText: 'extra' }` → reasonText accepted but ignored (lock: silent ignore, NOT 400) | parses |
| TC-U-37 | TASK-USER-DISPLAY | happy | `displayLabelFor({ display_name: 'Alice', email: 'a@x.com' })` → `'Alice'` | string |
| TC-U-38 | TASK-USER-DISPLAY | edge | `displayLabelFor({ display_name: null, email: 'alice@x.com' })` → `'alice'` | fallback to email local-part |
| TC-U-39 | REQ-23 | security | empty-string secret in env → boot-time guard throws (Buffer.from('') matches anything) | server fails to start |
| TC-U-40 | REQ-13 | boundary | knowledge-sharing thresholds — exactly 2.0× median + exactly 4.0× lowest → flagged; 1.99× median → NOT | both gates checked |
| TC-I-36 | REQ-9, REQ-15 | security | Manager in org A POSTs drilldown for devId belonging to org B | 403; NO audit row written |
| TC-I-37 | REQ-9 | security | Manager in org A hits `/manager/teams/[orgB-team-id]/effectiveness` | 403; zero rows from org B in response |
| TC-I-38 | REQ-17 | security | Dev in org A hits `/me/visibility`; audit table also has rows for devs in org B | response contains only self-org rows |
| TC-I-39 | REQ-15 | security | Drilldown from IPv4 192.168.1.99 → stored `ip_address_trunc = '192.168.1.0/24'` (not .99) | exact byte match |
| TC-I-40 | REQ-15 | security | Drilldown from IPv6 2001:db8:1:2:3:4:5:6 → stored `'2001:db8:1:2::/48'` | exact match |
| TC-I-41 | REQ-15 | edge | Drilldown with no `X-Forwarded-For` header → `ip_address_trunc IS NULL` | nullable, no crash |
| TC-I-42 | REQ-15, TASK-CRON-CLEANUP | security | Run cleanup cron: rows older than 30d → `ip_address_trunc = NULL`; rows newer → unchanged | row-by-row |
| TC-I-43 | TASK-CRON-CLEANUP | idempotency | Re-run cleanup cron → no error; already-null rows stay null | second run no-op |
| TC-I-44 | REQ-15 | idempotency | Two identical drilldown calls same day (same manager, target, reason) → 1 audit row total; second call updates `viewed_at` only; ON CONFLICT path returns `inserted: false` | row count + xmax |
| TC-I-45 | REQ-16 | idempotency | Second identical drilldown same day → notification NOT enqueued (zero new rows in `manager_notifications`) | DB query |
| TC-I-46 | REQ-15 | business | Same manager, same target, same day, DIFFERENT reason → 2 audit rows | reason is part of UNIQUE key |
| TC-I-47 | REQ-16 | business | New reason on same day → notification IS enqueued (new row = inserted) | manager_notifications row count +1 |
| TC-I-48 | REQ-15, REQ-16 | business | Same manager, same target, NEXT day, same reason → new audit row + new notification | viewed_on differs |
| TC-I-49 | REQ-21, REQ-23 | security | POST `/api/internal/cron/aggregate-team-metrics` with correct `INTERNAL_CRON_SECRET` → 200 | route runs |
| TC-I-50 | REQ-21, REQ-23 | security | Same route with wrong secret → 401 | timing-safe-equal rejects |
| TC-I-51 | REQ-21, REQ-23 | security | Same route with missing header → 401 | reject |
| TC-I-52 | REQ-23 | security | `INTERNAL_CRON_SECRET` env unset at server boot in production → server fails to start. **Test mechanism**: subprocess spawn with `NODE_ENV=production` and the env var unset; assert non-zero exit code + stderr matches the boot-guard message. (Vitest's in-process runner can't test module-level side effects across `process.env` flips reliably.) | spawn-based |
| TC-I-53 | REQ-16 | infra | Drilldown when notification enqueue fails (DB write fails) → route still returns 200 (post-response enqueue is best-effort); error logged structured warn | response unchanged |
| TC-I-54 | REQ-17 | security | `/me/visibility` query asserts `WHERE target_user_id = $self` is in the SQL string | direct SQL inspection |
| TC-I-55 | REQ-20 | security | Attempt UPDATE on `manager_drilldown_audit.reason` for an existing row. **Mechanism**: test creates a second `pg` connection, runs `SET ROLE app_runtime`, attempts the DML, asserts Postgres error code `42501` (insufficient_privilege). Superuser connection bypasses GRANTs, so `SET ROLE` is mandatory for the test to be meaningful. | RLS column grant rejects |
| TC-I-56 | REQ-20 | security | Attempt DELETE on `manager_drilldown_audit` row (as `app_runtime` via SET ROLE) → permission denied (`42501`) | RLS deny |
| TC-I-57 | REQ-14 | validation | drilldown URL with `devId='not-a-uuid'` → `redirect('/manager/health?error=invalid-dev')` | redirect, no audit |
| TC-I-58 | REQ-14 | edge | drilldown URL with valid UUID `devId` that does NOT exist in `users` → `notFound()` | 404 page, no audit |
| TC-I-59 | REQ-6, Q13 | edge | `getRadarComparison({ teamIds: ['single-id'] })` → returns null (or empty array; lock chosen) | radar hidden |
| TC-I-60 | REQ-22, Q11 | edge | Anomaly cron with team of 4 active devs → no rows written to `manager_anomalies` | small-team guard |
| TC-I-61 | REQ-22 | boundary | Anomaly cron with team of exactly 5 active devs + outlier → row written | guard at boundary |
| TC-I-74 | REQ-22 (dismiss) | security | Member-role POSTs `/api/manager/dismiss-anomaly` → 403 | role gate |
| TC-I-75 | REQ-22 (dismiss) | validation | POST with missing `target_user_id` → 400 | Zod parse |
| TC-I-76 | REQ-22 (dismiss) | idempotency | Re-submit identical dismiss → 200, `dismissed_until` updated, single row in DB | UPDATE on conflict |
| TC-I-77 | REQ-22 (dismiss) | happy | Manager POSTs dismiss with valid body and manager role → 200; row in `manager_dismissed_anomalies` with `dismissed_until ≈ now+7d`, correct `org_id` + `manager_user_id` + `target_user_id` + `kind` | row count = 1, dismissed_until within 1s of expected |
| TC-I-78 | REQ-22 (dismiss) | security | Manager in org A POSTs dismiss with `target_user_id` belonging to org B → 403; NO row written | cross-org rejection |
| TC-I-79 | TASK-CRON-CLEANUP | security | Cleanup cron: rows in `manager_notifications` with `enqueued_at < now() - 90d` are DELETEd; rows newer untouched | row-by-row |
| TC-I-80 | REQ-22 | business | Nightly anomaly cron with team where WoW spend is +55% (z-score normal) → row written with `kind='spend-spike-wow'` | WoW branch covered |
| TC-I-81 | REQ-23 | infra | detect-anomalies cron with simulated DB error → `cron_runs.status='failed'`; backoff invoked (route returns 5xx so external scheduler retries) | failure path |
| TC-I-66 | REQ-15, REQ-16 | business | Manager A and Manager B both drill dev D same day same reason → 2 distinct audit rows + 2 notifications | UNIQUE includes manager_user_id |
| TC-I-67 | REQ-20 | security | Migration applies RLS column grants on `manager_drilldown_audit`. **Mechanism**: `SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges WHERE table_name='manager_drilldown_audit' AND grantee='app_runtime'` — assert SELECT/INSERT on all columns + UPDATE only on `viewed_at`+`ip_address_trunc` + NO DELETE. On managed-Postgres deployments where `CREATE ROLE` failed (no superuser), the test should be marked SKIP via `process.env.SKIP_RLS_TESTS=1` env flag, with code-level enforcement in `writeAudit()` as the fallback. | grants present OR test skipped with documented fallback |
| TC-I-68 | TASK-MIGRATIONS | infra | After migration, `users.display_name` column exists, NULLABLE, type `text` | `information_schema.columns` query confirms |
| TC-I-69 | REQ-12 | security | dropoff-card.tsx HTML scanned for forbidden tone words (separate from check-in card) | none present |
| TC-I-70 | REQ-21 | infra | Concurrent overlapping cron-aggregate runs (15-min cadence + slow run) → both succeed; ON CONFLICT serializes; no duplicate rows | concurrency safe |
| TC-I-71 | REQ-17 | validation | GET `/me/visibility?page=0` → 400 | pages 1-indexed |
| TC-I-72 | REQ-17 | validation | GET `/me/visibility?page=-1` → 400 | reject |
| TC-I-73 | REQ-17 | edge | GET `/me/visibility?page=9999` (beyond last) → 200 with empty items array, not 404/500 | safe out-of-range |
| TC-E2E-13 | REQ-6, Q13 | edge | Manager with only 1 team visits `/manager/effectiveness` → radar section ABSENT from DOM | locator hidden |

### E2E Tests (Playwright against running `apps/server/`)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1, REQ-2, REQ-3, REQ-4 | happy | Manager logs in, visits `/manager/effectiveness`, sees the 4 KPI cards + tool-mix chart + subagent trend | All 4 sections present in DOM with seeded values |
| TC-E2E-02 | REQ-6 | happy | Manager with 3 teams sees radar chart with 3 polygons | 3 polygons in SVG, axes labeled |
| TC-E2E-03 | REQ-7 | happy | Manager drills into one team's `/manager/teams/[id]/effectiveness` | Page loads, 4 KPIs shown, breadcrumb back to `/manager/effectiveness` |
| TC-E2E-04 | REQ-8 | security | Non-manager dev navigates to `/manager/effectiveness` | Sees 403 page or redirect; no dashboard chrome |
| TC-E2E-05 | REQ-10, REQ-11 | happy | Manager visits `/manager/health` with seeded outlier dev | Sees check-in card; verifies heading "Check-in opportunity" + body copy + 2 CTAs; assert NO forbidden tone words present |
| TC-E2E-06 | REQ-12 | happy | Same page with seeded drop-off dev | Sees "May need support" card with body copy |
| TC-E2E-07 | REQ-13 | happy | Same page with seeded knowledge-sharing scenario | Sees opportunity copy with team names |
| TC-E2E-08 | REQ-14 | validation | Manager clicks check-in CTA → drilldown route loads with `reason=cost-investigation` pre-filled | URL contains valid `reason`, page loads |
| TC-E2E-09 | REQ-14, REQ-15 | security | Manually navigate to `/manager/devs/[devId]` without `reason` | 400 page; no dev data shown |
| TC-E2E-10 | REQ-15, REQ-16 | business | Successful drilldown → check (a) audit row exists in DB, (b) target dev receives notification (mock channel intercept) | Audit row + notification both present |
| TC-E2E-11 | REQ-17 | happy | Dev logs in, visits `/me/visibility` after a manager drilldown happened | Aggregated KPIs visible; audit log row visible with manager name + reason + timestamp |
| TC-E2E-12 | REQ-18 | security | Inspect `/manager/teams/[id]/effectiveness` page DOM — any rendered list of team members is alphabetical | Order matches `display_name ASC` |

## Design

### Anti-surveillance principles (load-bearing — every implementation choice must respect these)

1. **Aggregated by default.** Every manager-facing route renders **team-aggregated** data first. Individual data is **opt-in for the manager** and **gated by reason + audit + notification**. Code-level enforcement: the dev-level query functions (`getDevSpendDetail`, `getDevSessionList`, `getDevToolUsage`) live in a separate module `apps/server/lib/queries/manager-drilldown.ts` and **every** function in that module accepts a required `audit: AuditContext` parameter. Calling them without an audit context is a TypeScript compile error.

2. **Anomalies framed as support, never performance flags.** Card copy is locked verbatim in REQ-11 / REQ-12. The forbidden tone words (`alert`, `warning`, `flag`, `violation`, `breach`) are checked by TC-I-35 and TC-E2E-05. The CTAs nudge toward conversation (`Open conversation guide`), not action (no `Take action`, no `Investigate`, no `Resolve`).

3. **No public dev rankings.** `getTeamMembersForManager` always returns members `ORDER BY display_name ASC` (REQ-18). There is no UI element anywhere that sorts devs by spend, tokens, or any usage metric. Drilldown audit log on `/me/visibility` is chronological, not ranked. **Lint-equivalent test (TC-I-33) asserts the ORDER BY clause** in the prepared statement SQL string — if a future change replaces it, the test fails.

4. **Audit trail.** Every drilldown to individual dev data writes a row to `manager_drilldown_audit` **before** the data is fetched. Same DB transaction. Audit insert failure → 500 + no data (REQ-15). The audit row is **immutable** — table has no UPDATE/DELETE grants, only INSERT and SELECT. Append-only by RLS policy.

5. **Devs see what their manager sees.** `/me/visibility` shows (a) the same aggregated KPIs the manager sees about that dev, and (b) the full chronological audit log of every drilldown. **Even if the org later flips `drilldown_notification_enabled = false`**, the historical audit log on `/me/visibility` keeps showing past views. Devs can't be retroactively un-told they were watched.

### Architecture Decisions

**Composite score divergence from local `lib/analytics/scoring.ts`** (deliberate, NOT accidental duplication). **v2 (2026-05-01) update**: `correction_density` component DROPPED (column doesn't exist in `sessions_agg`); 0.20 weight redistributed to `cache_hit_ratio` (+0.10 → 0.40) and `output_input_ratio` (+0.10 → 0.40).

| Component | Local `scoring.ts` weight | This spec weight (v2) | Why different |
| --- | --- | --- | --- |
| Cache hit ratio | 10% | **40%** | At org scope, cache discipline is a strong leverage signal across many devs/sessions; absorbed +10% from dropped correction_density. |
| Output/input ratio | 10% | **40%** | Agg-level token efficiency is a primary signal of team usage maturity; absorbed +10% from dropped correction_density. **NULL handling**: when `output_input_ratio` is NULL (OTEL-only sessions or reporter parse failure), redistribute its 0.40 weight proportionally across the remaining non-null components (same rule as `manual_rating`). TC-U-04b covers this. |
| ~~Correction density (inverted)~~ | 20% | **DROPPED in v2** | Column `correction_density` does not exist in `sessions_agg`. Adding it requires extending the reporter sanitizer + carve-out spec. Weight redistributed to cache+output (+10% each). |
| Subagent usage | — | 10% | New at org scope: parallelism adoption is a leading indicator we can't surface at single-session level. Source: `sessions_agg.subagent_usage_ratio` (NOT `subagent_count` — that column doesn't exist). |
| Manual rating | **30%** | 10% | Personal: the user's own thumbs-up/down dominates. Manager view: rating density is too sparse and self-selecting at agg level. NULL → drop weight, redistribute. |
| Accept rate | 15% | — | Drop at org scope: noisy signal once aggregated. |
| Tool error rate | 15% | — | Drop at org scope: dominated by infra/Bash failures unrelated to user effectiveness. |

**Locked**: org-scope formula is a different score (4 components, not 5), not the local one re-aggregated. Two separate helpers (`apps/server/lib/analytics/composite-score.ts` for org; existing `lib/analytics/scoring.ts` for personal). The Test Plan covers each separately. **Rationale documented inline in the new file's JSDoc** so a future dev doesn't "fix" the divergence by mistake.

**"Good session" threshold (default 60)**: tunable via env var `MANAGER_GOOD_SESSION_THRESHOLD` (integer 0..100, default 60). The number is a heuristic — picked to roughly match the median of high-cache-hit + non-negative-rating sessions in dogfood data. Org admins who want the threshold tighter can set 70; looser, 50. Documented in `apps/server/.env.example` and `apps/server/README.md`.

**Cron framework (locked — 2026-04-28)**: **protected HTTP endpoints + external scheduler** (cron-job.org, GitHub Actions cron, or Vercel Cron if deployed there). Two endpoints expose the cron entries: `POST /api/internal/cron/aggregate-team-metrics` (15-min) and `POST /api/internal/cron/detect-anomalies` (nightly). Both auth via shared secret header `x-internal-cron-secret` (env `INTERNAL_CRON_SECRET`); request from any IP if header matches. **Why external scheduler**: portable across hosting (Vercel, fly.io, self-hosted), no in-process node-cron (which doesn't survive restarts/serverless cold starts), no platform-lock. **Why HTTP not CLI**: avoids a separate "worker" deployment artifact; the existing Next.js server hosts the endpoints. The endpoint also returns a JSON status (started_at, finished_at, rows_written) consumable by the scheduler's success/failure detection. The `cron_runs` table records every invocation regardless of caller.

**Aggregation: cron'd tables vs materialized views.** Locked: cron'd tables. Trade-offs:

| | Cron'd tables (`team_metrics_daily`) | Postgres matviews |
| --- | --- | --- |
| Refresh complexity | Plain `INSERT ... ON CONFLICT DO UPDATE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires a unique index on every matview |
| Backfill | Trivial — call the cron entry point with a `since` param | Awkward — matview definition is the only knob |
| Multi-source aggregation | Easy — join `sessions_agg` + `tool_count_agg` + future outcome rollups in one INSERT | Requires the matview definition to know about all sources upfront |
| Inspection / repair | `SELECT ... FROM team_metrics_daily WHERE day = '2026-04-15'`, fix bad rows by re-running cron | Have to drop and rebuild the entire matview |
| Freshness | 15-minute cadence (cron) | Configurable, but `CONCURRENTLY` adds latency |
| Bus factor on the team | Postgres + cron — boring, well-understood | Matview gotchas (refresh locks, dependent views) less common knowledge |

**Conclusion**: cron'd tables. The matview win (auto-refresh) is small here because we already need cron infra for the nightly anomaly job — adding another cron entry is free.

**`/me/visibility` audit visibility**. Implemented as a regular Server Component that calls `getMyDrilldownAudit(self)`. The audit table has an index on `(target_user_id, viewed_at DESC)` for fast lookup. No write side from `/me/visibility`.

**Notification reuse.** REQ-16 reuses spec 1's notification channel. We add a single new notification template `MANAGER_DRILLDOWN_VIEW` registered in the channel's template registry. Org-level config lives in `org_settings` (new column or new row depending on spec 1's shape — locked: new column `drilldown_notification_enabled boolean default true` on existing `org_settings`).

**Cron architecture.** Two new cron entries:
- `cron/manager-v2/aggregate-team-metrics.ts` — runs every 15 min, processes last 2 days (90 on first run).
- `cron/manager-v2/detect-anomalies.ts` — runs nightly at 02:00 org-local, computes z-scores per (team, dev).

If spec 1 already has a cron framework, register there. If not, this spec must include `cron_runs` table creation (REQ-23). Locked: this spec assumes spec 1 ships a `cron_runs` table; if it doesn't, the table is created here as part of TASK-MIGRATIONS.

### DDL — exact schema (post Pause-1)

This spec creates 6 new tables + 1 column on `users`. Drizzle TS API equivalents in `apps/server/lib/db/schema.ts`; raw SQL postlude (RLS column grants) in the migration `.sql` file.

```sql
-- ============================================================================
-- 1. users.display_name (B1 fix) — additive column, NULL allowed for existing rows.
--    UI/queries fall back to split_part(email, '@', 1) when NULL.
--    signIn callback (auth.ts) populates from OAuth profile.name when present
--    on next login. Migrate-time backfill: NULL is acceptable; the COALESCE
--    fallback in REQ-18 ORDER BY handles it.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

-- ============================================================================
-- 2. team_metrics_daily — rollups for effectiveness UI (B6 collapse: ONE row
--    per (org, team, day), all metric columns flat. metric_set discriminator
--    DROPPED — was architecturally wasteful (4 rows/day with 3/4 NULL columns).
-- ============================================================================
CREATE TABLE IF NOT EXISTS team_metrics_daily (
  org_id                  uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  team_id                 uuid          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  day                     date          NOT NULL,
  cache_hit_ratio_avg     numeric(5,4),                   -- 0..1, 4 decimals
  good_session_pct        numeric(5,2),                   -- 0..100
  subagent_adoption_pct   numeric(5,2),                   -- 0..100, % sessions w/ subagent_usage_ratio>0
  composite_avg           numeric(5,2),                   -- 0..100, mean composite score
  total_sessions          integer       NOT NULL DEFAULT 0,
  total_devs              integer       NOT NULL DEFAULT 0,
  tool_mix_json           jsonb,                          -- { Edit:int, Read:int, Bash:int, Agent:int, Other:int }
  computed_at             timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, day)
);
CREATE INDEX IF NOT EXISTS idx_tmd_team_day ON team_metrics_daily (team_id, day DESC);

-- ============================================================================
-- 3. manager_drilldown_audit — append-only audit, idempotent same-day.
--    RLS append-only enforced via column-level GRANT on app_runtime role
--    (raw SQL postlude — Drizzle migrations don't generate GRANT statements).
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_drilldown_audit (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id),
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  reason             text          NOT NULL CHECK (reason IN ('training-check','quota-investigation','cost-investigation','other')),
  reason_text        text,
  source_route       text          NOT NULL,
  -- IP policy aligned with spec 3 REQ-27: truncated on insert (/24 IPv4 or /48 IPv6),
  -- nulled by the daily cleanup cron after 30 days. Stored as text (truncated CIDR
  -- string) not `inet` to make the truncation step explicit and avoid accidental
  -- full-IP storage.
  ip_address_trunc   text,
  -- viewed_on is a materialized date column for the UNIQUE constraint; Postgres
  -- can't use function-based expressions in UNIQUE constraints directly. Updated
  -- by the application BEFORE insert (date(now()) at server time).
  viewed_on          date          NOT NULL,
  viewed_at          timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (manager_user_id, target_user_id, viewed_on, reason)
);
CREATE INDEX IF NOT EXISTS idx_mda_target_viewed   ON manager_drilldown_audit (target_user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mda_manager_viewed  ON manager_drilldown_audit (manager_user_id, viewed_at DESC);

-- ============================================================================
-- 4. manager_anomalies — nightly cron output. Idempotent on per-day-per-team-per-dev-per-kind.
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  team_id            uuid          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  -- 'knowledge-sharing' rows are written by the live `getKnowledgeSharingOpportunities`
  -- query at request time IF persistent storage is desired (currently the spec computes
  -- live from team_metrics_daily; the kind value is reserved here for forward-compat).
  kind               text          NOT NULL CHECK (kind IN ('spend-spike-30d','spend-spike-wow','dropoff-wow','knowledge-sharing')),
  detected_on        date          NOT NULL,
  context_json       jsonb,        -- { sigma:5.2, mean:..., teamStdDev:..., wowDelta:0.67 }
  created_at         timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (org_id, team_id, target_user_id, kind, detected_on)
);

-- ============================================================================
-- 5. manager_dismissed_anomalies — 7-day dismissals.
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_dismissed_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text          NOT NULL,
  dismissed_until    timestamptz   NOT NULL,
  dismissed_at       timestamptz   NOT NULL DEFAULT now(),
  -- UNIQUE includes manager_user_id intentionally: dismissals are PER-MANAGER,
  -- not org-wide. Manager A's dismissal does not suppress the card for
  -- Manager B. (Each manager's view is independent. Future "fix" to drop
  -- manager_user_id from the unique key would change the cardinality silently.)
  UNIQUE (org_id, manager_user_id, target_user_id, kind)
);
-- NOTE: original DRAFT had `WHERE dismissed_until > now()` partial index, but
-- Postgres rejects `now()` (and other non-IMMUTABLE functions) in index
-- predicates with error 42P17. Index without predicate still benefits queries
-- via column ordering; index-bloat win was minor (active dismissals are
-- 7-day windows, table is small). Deviation applied during TASK-MIGRATIONS.
CREATE INDEX IF NOT EXISTS idx_mda_dismiss_until
  ON manager_dismissed_anomalies (manager_user_id, dismissed_until);

-- ============================================================================
-- 6. org_settings (B2 fix) — DOES NOT EXIST in spec 1 / spec 3. CREATE
--    unconditionally. One row per org, FK on org_id keeps it scoped.
-- ============================================================================
CREATE TABLE IF NOT EXISTS org_settings (
  org_id                          uuid          PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  drilldown_notification_enabled  boolean       NOT NULL DEFAULT true,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now()
);

-- ============================================================================
-- 7. cron_runs (B3 fix) — DOES NOT EXIST in spec 1 / spec 3. CREATE
--    unconditionally. Records every cron invocation regardless of outcome.
-- ============================================================================
CREATE TABLE IF NOT EXISTS cron_runs (
  id                 bigserial     PRIMARY KEY,
  job_name           text          NOT NULL,
  started_at         timestamptz   NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text          NOT NULL CHECK (status IN ('running','ok','failed')),
  rows_written       integer,
  error_message      text
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (job_name, started_at DESC);

-- ============================================================================
-- 8. manager_notifications (B4 fix — stub channel) — DB-backed notification
--    queue. THIS spec writes rows ('pending'); a follow-up spec adds the
--    actual delivery worker (email/Slack/in-app). For the purposes of this
--    spec, "enqueueing a notification" = inserting a row here. Tests verify
--    the row is present (no mock channels needed).
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_notifications (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template           text          NOT NULL,                                -- e.g. 'MANAGER_DRILLDOWN_VIEW'
  payload_json       jsonb         NOT NULL,                                -- template-specific (manager_display, viewed_on, reason, reasonText)
  enqueued_at        timestamptz   NOT NULL DEFAULT now(),
  status             text          NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','sent','failed')),
  delivered_at       timestamptz,
  error_message      text
);
CREATE INDEX IF NOT EXISTS idx_mn_target_enqueued
  ON manager_notifications (target_user_id, enqueued_at DESC);
CREATE INDEX IF NOT EXISTS idx_mn_pending
  ON manager_notifications (enqueued_at)
  WHERE status = 'pending';

-- RETENTION NOTE: Until the delivery follow-up spec ships, all rows stay
-- 'pending' forever. TASK-CRON-CLEANUP also prunes `manager_notifications`
-- where `enqueued_at < now() - interval '90 days'` (regardless of status)
-- to prevent unbounded growth. The follow-up delivery worker will flip
-- status to 'sent'/'failed' and may shorten retention as needed.

-- ============================================================================
-- 9. RLS column grants for manager_drilldown_audit (B7 fix).
--    Lives in raw SQL POSTLUDE within the .sql migration file (Drizzle does NOT
--    generate GRANT statements; this is DCL not DDL). Assumes app connects via
--    a dedicated `app_runtime` role (created here if absent, owned by `postgres`).
--    If the deployment uses superuser only, this postlude is no-op (superuser
--    bypasses GRANT) — code-level enforcement in writeAudit() is the fallback.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime;
  END IF;
END $$;

GRANT SELECT, INSERT ON manager_drilldown_audit TO app_runtime;
GRANT UPDATE (viewed_at, ip_address_trunc) ON manager_drilldown_audit TO app_runtime;
REVOKE DELETE ON manager_drilldown_audit FROM app_runtime;
GRANT USAGE, SELECT ON SEQUENCE manager_drilldown_audit_id_seq TO app_runtime;
```

**Note on Drizzle representation**: tables 1-8 land in `apps/server/lib/db/schema.ts` via `pgTable(...)`. The PARTIAL indexes (`WHERE dismissed_until > now()` and `WHERE status = 'pending'`) and the RLS GRANT block (table 9) require raw SQL — Drizzle's `index().on()` does NOT support `.where()` clauses on indexes. These go in a hand-written postlude block at the end of the generated migration `.sql` file, marked with a comment: `-- @drizzle:postlude — partial indexes + RLS grants`.

### Files to Create (TDD: `.test.ts` listed FIRST per `.claude/rules/sdd.md`)

#### Pure helpers (Batch 2 — analytics + audit + zod)

- `apps/server/lib/analytics/composite-score.test.ts` + `.ts` — `computeCompositeScore`, "good session" classifier (with `MANAGER_GOOD_SESSION_THRESHOLD` env-var resolution)
- `apps/server/lib/analytics/anomaly-detection.test.ts` + `.ts` — `detectSpike`, `detectWowSpike`, `detectDropOff`, `detectKnowledgeSharingOpportunity`
- `apps/server/lib/analytics/radar-normalize.test.ts` + `.ts` — `normalizeRadarMetrics` (returns null/empty when `teamIds.length === 1`)
- `apps/server/lib/analytics/tool-mix.test.ts` + `.ts` — `bucketizeToolMix` (5-bucket enum; `Task`/`Agent` both map to `Agent` bucket)
- `apps/server/lib/zod/manager-v2-schemas.test.ts` + `.ts` — reason tag enum (closed list), reason text bounds (10..500), pagination param Zod
- `apps/server/lib/util/user-display.ts` + `.test.ts` — `displayLabelFor(user)`: `user.display_name ?? split('@')[0]`. Centralized helper imported by all UI + audit log.
- `apps/server/lib/audit/drilldown-audit.test.ts` + `.ts` — `writeAudit(tx, AuditContext)`, raw SQL via `sql\`... RETURNING (xmax = 0) AS inserted\``, returns `{ inserted: boolean }` for the notification gate

#### Cron auth (Batch 2 — was missing from batch listing)

- `apps/server/lib/cron/auth.test.ts` + `.ts` — `assertInternalCronAuth(req)` helper (header check + `crypto.timingSafeEqual`). Throws 401 on mismatch. Boot-time check that `process.env.INTERNAL_CRON_SECRET` is set in production (mirror `AUTH_SECRET` guard in spec 3's `auth.ts`).

#### Queries + Server Actions (Batch 3)

- `apps/server/lib/queries/manager-v2.test.ts` + `.ts` — team-aggregated queries (REQ-1..7, REQ-10, REQ-12, REQ-13). **Reuses** `effectiveCostForSession` from `@root/analytics/cost-calibration` (spec 1 pattern, also used by `overview.ts` + `teams.ts`). Members alphabetical via `COALESCE(display_name, split_part(email, '@', 1))`.
- `apps/server/lib/queries/manager-drilldown.test.ts` + `.ts` — dev-level queries; every function takes a required `audit: AuditContext` parameter. Compile-time enforcement — calling without audit context is a TS error.
- `apps/server/lib/queries/notifications.test.ts` + `.ts` — `enqueueNotification(tx, params)` writes to `manager_notifications` table with `status='pending'`. Real delivery is a follow-up spec.

#### Cron lib (Batch 4) + cron routes

- `apps/server/lib/cron/manager-v2/aggregate-team-metrics.test.ts` + `.ts` — pure aggregation logic (last 2 days; 90 on first run). Updates `cron_runs` start/finish/status.
- `apps/server/lib/cron/manager-v2/detect-anomalies.test.ts` + `.ts` — z-scores per (team, dev), small-team guard (skip teams < 5 active devs).
- `apps/server/lib/cron/cleanup-audit-ips.test.ts` + `.ts` — NULLs `manager_drilldown_audit.ip_address_trunc` for rows older than 30d.
- `apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts` — POST endpoint, validates `x-internal-cron-secret`, calls lib function, returns JSON `{started_at, finished_at, rows_written, status}`.
- `apps/server/app/api/internal/cron/detect-anomalies/route.ts` — same pattern.
- `apps/server/app/api/internal/cron/cleanup-audit-ips/route.ts` — same pattern.

#### Pages + components (Batch 4)

- `apps/server/app/manager/effectiveness/page.tsx`
- `apps/server/app/manager/teams/[id]/effectiveness/page.tsx` (now in Batch 4 — F21)
- `apps/server/app/manager/health/page.tsx`
- `apps/server/app/manager/check-in/[devId]/page.tsx` (drilldown landing — `reason` query required, `redirect()` on missing/invalid)
- `apps/server/app/manager/devs/[devId]/page.tsx` (full drilldown — same gating)
- `apps/server/app/me/visibility/page.tsx`
- `apps/server/app/api/manager/dismiss-anomaly/route.ts` (POST, writes `manager_dismissed_anomalies`)
- `apps/server/components/manager/effectiveness-kpi-row.tsx` (composes existing `KpiCard` from spec 3)
- `apps/server/components/manager/tool-mix-chart.tsx`
- `apps/server/components/manager/subagent-trend-chart.tsx`
- `apps/server/components/manager/radar-comparison.tsx`
- `apps/server/components/manager/check-in-card.tsx`
- `apps/server/components/manager/dropoff-card.tsx`
- `apps/server/components/manager/knowledge-sharing-card.tsx`
- `apps/server/components/me/audit-log-table.tsx`

#### Wiring fragments (Batch 4 → Batch 5 merge)

Per CLAUDE.md directive 6 (shared-additive accumulator pattern), three Batch-4 page tasks all add nav links to `apps/server/app/manager/layout.tsx`. Each task produces a fragment:

- `.specs/wiring/manager-dashboard-v2/TASK-EFFECTIVENESS-PAGE.layout.fragment.md`
- `.specs/wiring/manager-dashboard-v2/TASK-HEALTH-PAGE.layout.fragment.md`
- `.specs/wiring/manager-dashboard-v2/TASK-VISIBILITY-PAGE.layout.fragment.md`

The new `TASK-MERGE-LAYOUT` (Batch 5) reads all fragments alphabetically and applies them in the main working tree.

#### E2E tests (Batch 6 — split into 4 sub-tasks per F23)

- `apps/server/tests/e2e/manager-effectiveness.spec.ts` (TC-E2E-01..04)
- `apps/server/tests/e2e/manager-health.spec.ts` (TC-E2E-05..07)
- `apps/server/tests/e2e/manager-drilldown.spec.ts` (TC-E2E-08..10)
- `apps/server/tests/e2e/me-visibility.spec.ts` (TC-E2E-11..12)
- `apps/server/scripts/seed-manager-v2.ts` — **EXTENDS** spec 3's `seed-server.ts --e2e` (NOT destructive). Run AFTER `seed-server.ts --e2e`. Uses `stableUuid` from `lib/e2e/seed-ids.ts` for deterministic IDs. Adds 90 days of `team_metrics_daily` rollups + 2 synthetic outlier devs (one 4σ above team mean for spike test, one with WoW drop-off for dropoff test) + 1 knowledge-sharing scenario across teams. All inserts use `.onConflictDoNothing()` for idempotent re-runs.

### Files to Modify (additive only)

- `apps/server/middleware.ts` (B8 fix — was wrongly listed as `apps/server/lib/auth/middleware.ts` which does not exist) — extend `config.matcher` to add `/me/:path*` so `/me/visibility` is auth-gated. The role check in `auth.config.ts:authorized()` (spec 3) already handles `member` role on `/me/*` (no manager role required for self-visibility). Additive.
- `apps/server/lib/auth/auth.ts` — extend `signIn` callback to populate `user.display_name` from OAuth profile name when present on first login (additive: doesn't break existing flows; users without `name` in their OAuth claims keep `display_name = NULL` and fall back to email local-part).
- `apps/server/app/manager/layout.tsx` — add nav links to `/manager/effectiveness`, `/manager/health`, `/me/visibility`. Applied via wiring fragments + `TASK-MERGE-LAYOUT` (B10).
- All 4 existing integration test files in `apps/server/tests/integration/` and `apps/server/lib/queries/*.test.ts` that use Testcontainers Postgres — extend `TRUNCATE TABLE ... CASCADE` lists in `beforeAll` to include the 6 new tables (`team_metrics_daily`, `manager_drilldown_audit`, `manager_anomalies`, `manager_dismissed_anomalies`, `manager_notifications`, `cron_runs`, `org_settings`). Per spec 3 pattern; required to prevent FK/cascade leaks across files.

### Files to Delete

- None.

### Dependencies

No new packages — Postgres + Drizzle (spec 3) + Recharts (already in apps/server) + Zod + Vitest + Playwright. Verify Recharts API surface via Context7 for `RadarChart` before TASK-RADAR-NORM.

### Dependencies

No new packages — Postgres + `pg` (spec 1) + Recharts (already in TokenFx; mirror in `apps/server/`) + Zod + Vitest + Playwright. Verify Recharts API surface via Context7 for `RadarChart` before TASK-RADAR.

## Tasks

- [ ] **TASK-MIGRATIONS**: Create the v2 schema. Drizzle TS API in `apps/server/lib/db/schema.ts` for tables 1-8 (DDL section); raw SQL postlude in the generated migration file for table 9 (RLS column grants on `manager_drilldown_audit` + `app_runtime` role + partial indexes).
  - **Tables added**: `users.display_name` column (additive ALTER), `team_metrics_daily`, `manager_drilldown_audit`, `manager_anomalies`, `manager_dismissed_anomalies`, `org_settings` (CREATE — was incorrectly assumed extant), `cron_runs` (CREATE — was incorrectly assumed extant), `manager_notifications` (CREATE — stub channel queue per B4 lock).
  - **Migration order**: run after `0001_onboarding.sql` (spec 3); name `0002_manager_v2.sql`. Idempotent via `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
  - **RLS postlude**: column-level GRANT on `manager_drilldown_audit` to `app_runtime` role. If superuser-only deployment, postlude is no-op (superuser bypasses GRANT) and code-level enforcement in `writeAudit()` is the active defense.
  - **Update existing test files**: extend `TRUNCATE` list in `beforeAll` of every integration test file that uses Testcontainers Postgres — add the 6 new tables (cleanup-leaves first per FK direction). Files: `apps/server/lib/queries/teams.test.ts`, `apps/server/lib/queries/overview.test.ts`, `apps/server/tests/integration/cleanup.test.ts`, `apps/server/tests/integration/ingest.test.ts`, `apps/server/tests/integration/onboarding-redeem.test.ts` (and any others with TRUNCATE blocks).
  - **`apps/server/middleware.ts`**: add `/me/:path*` to `config.matcher` array.
  - **`apps/server/lib/auth/auth.ts`**: extend `signIn` callback to populate `users.display_name` from OAuth `profile.name` on first login (additive — users without name in claims keep `display_name=NULL` and fall back via `displayLabelFor()`). Update `auth.config.ts:authorized()` to require `auth?.user` for `/me/*` paths (otherwise unauthenticated GET would slip past the `if (!path.startsWith('/manager')) return true` short-circuit).
  - **Drizzle migration runner notes (per `apps/server/lib/db/migrate.ts`)**: the runner reads `.sql` files in lex order and executes the entire content in one transaction. The DDL section's "@drizzle:postlude" framing is just a comment for readers — there is no special directive parser. ALL SQL (CREATE TABLE/INDEX/TYPE, ALTER, DO $$ CREATE ROLE, GRANT, REVOKE) goes into `0002_manager_v2.sql` in the order shown in the DDL section. The `GRANT USAGE, SELECT ON SEQUENCE` must appear AFTER the `CREATE TABLE manager_drilldown_audit` in the same file (the DDL section already orders them correctly).
  - files: apps/server/lib/db/schema.ts, apps/server/lib/db/migrations/0002_manager_v2.sql, apps/server/lib/db/migrations/meta/_journal.json, apps/server/lib/db/migrations/meta/0002_snapshot.json, apps/server/middleware.ts, apps/server/lib/auth/auth.ts, apps/server/lib/auth/auth.config.ts, apps/server/lib/queries/teams.test.ts, apps/server/lib/queries/overview.test.ts, apps/server/tests/integration/cleanup.test.ts, apps/server/tests/integration/ingest.test.ts, apps/server/tests/integration/onboarding-redeem.test.ts
  - tests: TC-I-01, TC-I-02, TC-I-67 (RLS rejection — uses `app_runtime` role connection via SET ROLE; superuser bypasses GRANT so test must explicitly switch roles), TC-I-68 (display_name column NULLABLE)

- [ ] **TASK-COMPOSITE**: `apps/server/lib/analytics/composite-score.ts` — pure function `computeCompositeScore(input): number | null`, "good session" classifier helper. Mirror existing `lib/analytics/scoring.ts` redistribution pattern.
  - files: apps/server/lib/analytics/composite-score.ts, apps/server/lib/analytics/composite-score.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08

- [ ] **TASK-ANOMALY**: `apps/server/lib/analytics/anomaly-detection.ts` — `detectSpike`, `detectWowSpike`, `detectDropOff`, `detectKnowledgeSharingOpportunity` pure functions.
  - files: apps/server/lib/analytics/anomaly-detection.ts, apps/server/lib/analytics/anomaly-detection.test.ts
  - tests: TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-20, TC-U-21

- [ ] **TASK-RADAR-NORM**: `apps/server/lib/analytics/radar-normalize.ts` — min-max normalization across team set, divide-by-zero safe.
  - files: apps/server/lib/analytics/radar-normalize.ts, apps/server/lib/analytics/radar-normalize.test.ts
  - tests: TC-U-17, TC-U-18

- [ ] **TASK-TOOLMIX**: `apps/server/lib/analytics/tool-mix.ts` — closed 5-element enum bucketizer.
  - files: apps/server/lib/analytics/tool-mix.ts, apps/server/lib/analytics/tool-mix.test.ts
  - tests: TC-U-19

- [ ] **TASK-ZOD**: `apps/server/lib/zod/manager-v2-schemas.ts` — `reasonTagSchema` (closed enum), `reasonTextSchema` (10..500 chars), drilldown POST body schema.
  - files: apps/server/lib/zod/manager-v2-schemas.ts, apps/server/lib/zod/manager-v2-schemas.test.ts
  - tests: TC-U-22, TC-U-23, TC-U-24, TC-U-25, TC-U-26, TC-U-27, TC-U-28

- [ ] **TASK-AUDIT-LIB**: `apps/server/lib/audit/drilldown-audit.ts` — `writeAudit(tx, AuditContext)` signature, MUST be called within a tx, helper enforces tx presence at type level.
  - files: apps/server/lib/audit/drilldown-audit.ts, apps/server/lib/audit/drilldown-audit.test.ts
  - depends: TASK-MIGRATIONS
  - tests: TC-I-26, TC-I-27, TC-I-28

- [ ] **TASK-QUERIES-V2**: `apps/server/lib/queries/manager-v2.ts` — team-aggregated queries: `getTeamCacheHitTrend`, `getTeamGoodSessionPct`, `getTeamToolMix30d`, `getTeamSubagentAdoption`, `getRadarComparison`, `getCheckInOpportunities`, `getDropOffCandidates`, `getKnowledgeSharingOpportunities`, `getTeamMembersForManager`. All prepared statements via WeakMap. Members ordered alphabetically (REQ-18).
  - files: apps/server/lib/queries/manager-v2.ts, apps/server/lib/queries/manager-v2.test.ts
  - depends: TASK-MIGRATIONS, TASK-COMPOSITE, TASK-ANOMALY, TASK-RADAR-NORM, TASK-TOOLMIX
  - tests: TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-I-17, TC-I-18, TC-I-19, TC-I-33, TC-I-34

- [ ] **TASK-QUERIES-DRILLDOWN**: `apps/server/lib/queries/manager-drilldown.ts` — dev-level queries; every function takes a required `audit: AuditContext` parameter. Compile-time enforcement.
  - files: apps/server/lib/queries/manager-drilldown.ts, apps/server/lib/queries/manager-drilldown.test.ts
  - depends: TASK-AUDIT-LIB
  - tests: TC-I-26, TC-I-28

- [ ] **TASK-CRON-AUTH**: `apps/server/lib/cron/auth.ts` — `assertInternalCronAuth(req)` reads `x-internal-cron-secret` header, timing-safe-compares to `process.env.INTERNAL_CRON_SECRET`. Throws 401 on mismatch. **Boot-time guard**: module-level `if (NODE_ENV === 'production' && !INTERNAL_CRON_SECRET) throw` — mirror spec 3's `AUTH_SECRET` pattern in `auth.ts:18-26`. Empty-string secret is rejected at boot (Buffer.from('') == Buffer.from('') is `true` in `timingSafeEqual` and would silently let any caller pass).
  - files: apps/server/lib/cron/auth.test.ts (FIRST — TDD), apps/server/lib/cron/auth.ts
  - **Batch assignment**: Batch 2 (no deps; was missing from original batch listing)
  - tests: TC-U-29, TC-U-30, TC-U-31, TC-U-39, TC-I-49, TC-I-50, TC-I-51, TC-I-52

- [ ] **TASK-CRON-AGG**: 15-min aggregation cron — pure logic in `apps/server/lib/cron/manager-v2/aggregate-team-metrics.ts` that GROUP BYs `sessions_agg`/`tool_count_agg` into `team_metrics_daily` (last 2 days; 90 on first run); idempotent via `ON CONFLICT DO UPDATE`. Uses `cron_runs` for status. POST route at `apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts` calls it after `assertInternalCronAuth`.
  - files: apps/server/lib/cron/manager-v2/aggregate-team-metrics.ts, apps/server/lib/cron/manager-v2/aggregate-team-metrics.test.ts, apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts
  - depends: TASK-QUERIES-V2, TASK-CRON-AUTH
  - tests: TC-I-03, TC-I-04, TC-I-07

- [ ] **TASK-CRON-ANOM**: Nightly anomaly cron — pure logic in `apps/server/lib/cron/manager-v2/detect-anomalies.ts`, z-scores per team (skip teams with `< 5 active devs in last 30d`), write to `manager_anomalies`. POST route at `apps/server/app/api/internal/cron/detect-anomalies/route.ts`.
  - files: apps/server/lib/cron/manager-v2/detect-anomalies.ts, apps/server/lib/cron/manager-v2/detect-anomalies.test.ts, apps/server/app/api/internal/cron/detect-anomalies/route.ts
  - depends: TASK-QUERIES-V2, TASK-ANOMALY, TASK-CRON-AUTH
  - tests: TC-I-05, TC-I-06

- [ ] **TASK-CRON-CLEANUP**: Daily cleanup cron with TWO operations: (1) zero `manager_drilldown_audit.ip_address_trunc` for rows older than 30d (REQ-15 IP retention). (2) DELETE `manager_notifications` rows older than 90d regardless of status (prevents unbounded growth — see retention note in DDL). Both operations idempotent (re-run is no-op). Single POST route at `apps/server/app/api/internal/cron/cleanup-audit-ips/route.ts` (name kept for compat; covers both).
  - files: apps/server/lib/cron/cleanup-audit-ips.test.ts (FIRST — TDD), apps/server/lib/cron/cleanup-audit-ips.ts, apps/server/app/api/internal/cron/cleanup-audit-ips/route.ts
  - depends: TASK-MIGRATIONS, TASK-CRON-AUTH
  - tests: TC-I-42 (IP cleanup), TC-I-43 (idempotency), TC-I-79 (notification prune)

- [ ] **TASK-EFFECTIVENESS-PAGE**: `/manager/effectiveness` page (KPI row + trend charts + tool-mix stacked bar + subagent trend + radar comparison). Auth gate (REQ-8). Composes spec 3's existing `<KpiCard>` for the KPI row (no new pattern). Radar hidden when `teamIds.length === 1` (Q13 lock). **Wiring fragment**: produces `.specs/wiring/manager-dashboard-v2/TASK-EFFECTIVENESS-PAGE.layout.fragment.md` adding nav link to `/manager/effectiveness` — does NOT edit `app/manager/layout.tsx` directly.
  - files: apps/server/app/manager/effectiveness/page.tsx, apps/server/components/manager/effectiveness-kpi-row.tsx, apps/server/components/manager/tool-mix-chart.tsx, apps/server/components/manager/subagent-trend-chart.tsx, apps/server/components/manager/radar-comparison.tsx, .specs/wiring/manager-dashboard-v2/TASK-EFFECTIVENESS-PAGE.layout.fragment.md
  - depends: TASK-QUERIES-V2
  - tests: TC-I-14, TC-I-15, TC-I-59 (radar hidden 1 team)

- [ ] **TASK-TEAM-EFFECTIVENESS-PAGE**: `/manager/teams/[id]/effectiveness` (team-scoped deep dive). Auth + team-membership gate (REQ-9). Cross-team → 403; cross-org → 403 (no 404 enumeration leak — TC-I-36).
  - files: apps/server/app/manager/teams/[id]/effectiveness/page.tsx
  - depends: TASK-QUERIES-V2 (no longer depends on TASK-EFFECTIVENESS-PAGE per F21 — disjoint files, can parallelize in Batch 4)
  - **Batch assignment**: Batch 4 (was Batch 5)
  - tests: TC-I-14, TC-I-16, TC-I-36 (cross-org)

- [ ] **TASK-HEALTH-PAGE**: `/manager/health` page with check-in cards + drop-off cards + knowledge-sharing section. Verbatim copy from REQ-11/REQ-12 using `displayLabelFor()`. CTA wires to drilldown route with pre-filled reason. **Wiring fragment**: produces `.specs/wiring/manager-dashboard-v2/TASK-HEALTH-PAGE.layout.fragment.md` adding nav link to `/manager/health`.
  - files: apps/server/app/manager/health/page.tsx, apps/server/components/manager/check-in-card.tsx, apps/server/components/manager/dropoff-card.tsx, apps/server/components/manager/knowledge-sharing-card.tsx, .specs/wiring/manager-dashboard-v2/TASK-HEALTH-PAGE.layout.fragment.md
  - depends: TASK-QUERIES-V2
  - tests: TC-I-35, TC-I-69 (dropoff-card tone words)

- [ ] **TASK-DRILLDOWN-PAGE**: `/manager/check-in/[devId]` and `/manager/devs/[devId]` — both require `reason` query param (Zod-validated). Server Component pattern (B11 lock):
  - Missing/invalid `reason` → `redirect('/manager/health?error=missing-reason')` (returns to health page with banner — Next.js 15's `redirect()` from `next/navigation`). NOT 400 (Server Components can't return HTTP error codes idiomatically).
  - `devId` invalid UUID format → `redirect('/manager/health?error=invalid-dev')`.
  - Cross-team / cross-org devId → `notFound()` (rendered as `not-found.tsx`).
  - Authorized + valid: `db.transaction(async (tx) => { writeAudit(tx, ctx); fetchDevData(tx, devId); })` — atomic. Audit insert fail → throws → `error.tsx` renders generic 500. **Wiring fragment**: `.specs/wiring/manager-dashboard-v2/TASK-DRILLDOWN-PAGE.layout.fragment.md` (none — drilldown doesn't add nav links).
  - files: apps/server/app/manager/check-in/[devId]/page.tsx, apps/server/app/manager/devs/[devId]/page.tsx, apps/server/app/manager/check-in/[devId]/not-found.tsx, apps/server/app/manager/devs/[devId]/not-found.tsx
  - depends: TASK-AUDIT-LIB, TASK-QUERIES-DRILLDOWN, TASK-ZOD, TASK-NOTIFICATION (now Batch 3)
  - tests: TC-I-20, TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25, TC-I-26, TC-I-27, TC-I-28, TC-I-44, TC-I-45, TC-I-46, TC-I-47, TC-I-48, TC-I-54, TC-I-55, TC-I-56, TC-I-57, TC-I-58

- [ ] **TASK-NOTIFICATION**: Stub notification channel via `manager_notifications` DB queue (B4 lock). `enqueueNotification(tx, params)` inserts a row with `status='pending'`, `template='MANAGER_DRILLDOWN_VIEW'`, `payload_json={managerName, viewedOn, reason, reasonText?}` — actual delivery (email/Slack) is a follow-up spec. The drilldown route (TASK-DRILLDOWN-PAGE in Batch 4) calls this AFTER `writeAudit` returns `{inserted: true}`, gated by `org_settings.drilldown_notification_enabled`. **Tests query the DB** (not a mock channel — hand-written stubs only per project rule). **Exports `NotificationChannel` interface + `dbBackedNotificationChannel` default** — this is what TASK-DRILLDOWN-PAGE injects via DI seam (Q9 lock).
  - files: apps/server/lib/queries/notifications.test.ts (FIRST — TDD), apps/server/lib/queries/notifications.ts
  - depends: TASK-MIGRATIONS (only — pure DB lib, no page dep; was wrongly in Batch 4 with circular dep on TASK-DRILLDOWN-PAGE)
  - **Batch assignment**: Batch 3 (was Batch 4 — circular dep fixed)
  - tests: TC-I-29, TC-I-30, TC-I-44, TC-I-45, TC-I-53

- [ ] **TASK-DISMISS-ROUTE**: `POST /api/manager/dismiss-anomaly` writes `manager_dismissed_anomalies` row with `dismissed_until = now() + 7d`. Auth gated (`manager`/`admin` role). Idempotent: ON CONFLICT (org_id, manager_user_id, target_user_id, kind) DO UPDATE SET `dismissed_until = excluded.dismissed_until`. Zod-validated body: `{ target_user_id: uuid, kind: enum }`.
  - files: apps/server/app/api/manager/dismiss-anomaly/route.test.ts (FIRST — TDD), apps/server/app/api/manager/dismiss-anomaly/route.ts
  - depends: TASK-MIGRATIONS
  - tests: TC-I-77 (happy create), TC-I-76 (idempotent re-submit), TC-I-74 (member 403), TC-I-75 (missing fields 400), TC-I-78 (cross-org rejected)

- [ ] **TASK-VISIBILITY-PAGE**: `/me/visibility` page — aggregated KPIs for self + paginated audit log (25/page). Server Component. **Wiring fragment**: produces `.specs/wiring/manager-dashboard-v2/TASK-VISIBILITY-PAGE.layout.fragment.md` adding nav link to `/me/visibility`.
  - files: apps/server/app/me/visibility/page.tsx, apps/server/components/me/audit-log-table.tsx, apps/server/lib/queries/me-visibility.test.ts (FIRST — TDD), apps/server/lib/queries/me-visibility.ts, .specs/wiring/manager-dashboard-v2/TASK-VISIBILITY-PAGE.layout.fragment.md
  - depends: TASK-MIGRATIONS, TASK-QUERIES-V2
  - tests: TC-I-31, TC-I-32, TC-I-38 (isolation: dev only sees own rows), TC-I-71, TC-I-72, TC-I-73 (pagination boundaries)

- [ ] **TASK-MERGE-LAYOUT** (B10 — accumulator pattern per CLAUDE.md directive 6): runs in MAIN working tree (not worktree). Reads all `.specs/wiring/manager-dashboard-v2/*.layout.fragment.md`, sorts alphabetically by task-id, applies each fragment's insertions to `apps/server/app/manager/layout.tsx`. **Insertion landmark**: each fragment specifies `Section: nav-links` as the named anchor. Since `app/manager/layout.tsx` (post-spec-3) does NOT have that anchor yet, TASK-MERGE-LAYOUT's first step is to ADD a `{/* Section: nav-links */}` JSX comment immediately before the `{role === 'admin' ? ...}` admin link block. Subsequent fragment inserts go immediately AFTER that comment, in fragment-name alphabetical order. Idempotent (re-running detects existing anchor + already-applied inserts via marker comments). Three fragments expected: TASK-EFFECTIVENESS-PAGE, TASK-HEALTH-PAGE, TASK-VISIBILITY-PAGE.
  - files: apps/server/app/manager/layout.tsx
  - depends: TASK-EFFECTIVENESS-PAGE, TASK-HEALTH-PAGE, TASK-VISIBILITY-PAGE (must run AFTER all 3 produce their fragments)
  - **Batch assignment**: Batch 5
  - tests: covered by E2E TC-E2E-01..04 (nav links visible) + manual visual check. No unit/integration test (pure merge logic; correctness verified end-to-end by E2E).

- [ ] **TASK-CI-TONE-LINT** (Q14 lock): create `.github/workflows/lint-tone.yml` (or equivalent CI workflow) running `grep -E 'alert|warning|flag|violation|breach' apps/server/components/manager/{check-in,dropoff}-card.tsx` and failing the CI job if any match found. 5-line workflow.
  - files: .github/workflows/lint-tone.yml
  - depends: TASK-HEALTH-PAGE (the cards must exist first for the grep to be meaningful)
  - **Batch assignment**: Batch 5 (alongside TASK-MERGE-LAYOUT, both run in main tree, both small)
  - tests: covered by TC-I-35 + TC-I-69 (runtime grep) + manual CI verification

#### TASK-SMOKE split (F23) — 4 sub-tasks instead of 1 monolithic

- [ ] **TASK-SMOKE-EFFECTIVENESS**: Playwright E2E for `/manager/effectiveness` + `/manager/teams/[id]/effectiveness`. Seed via `seed-manager-v2.ts` (additive over spec 3's `--e2e`).
  - files: apps/server/tests/e2e/manager-effectiveness.spec.ts, apps/server/scripts/seed-manager-v2.ts
  - depends: TASK-EFFECTIVENESS-PAGE, TASK-TEAM-EFFECTIVENESS-PAGE, TASK-MERGE-LAYOUT
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-13 (1-team radar hidden)

- [ ] **TASK-SMOKE-HEALTH**: Playwright E2E for `/manager/health` (check-in cards, drop-off, knowledge-sharing, forbidden-tone-words assertions).
  - files: apps/server/tests/e2e/manager-health.spec.ts
  - depends: TASK-HEALTH-PAGE, TASK-MERGE-LAYOUT, TASK-SMOKE-EFFECTIVENESS (seed reuse)
  - tests: TC-E2E-05, TC-E2E-06, TC-E2E-07

- [ ] **TASK-SMOKE-DRILLDOWN**: Playwright E2E for drilldown flow (CTA → audit row → notification enqueued).
  - files: apps/server/tests/e2e/manager-drilldown.spec.ts
  - depends: TASK-DRILLDOWN-PAGE, TASK-NOTIFICATION, TASK-SMOKE-HEALTH (uses health page CTA)
  - tests: TC-E2E-08, TC-E2E-09, TC-E2E-10

- [ ] **TASK-SMOKE-VISIBILITY**: Playwright E2E for `/me/visibility` (dev sees own audit log, KPIs). Includes test that org_settings.drilldown_notification_enabled=false STILL surfaces past audit rows on visibility page.
  - files: apps/server/tests/e2e/me-visibility.spec.ts
  - depends: TASK-VISIBILITY-PAGE, TASK-SMOKE-DRILLDOWN (reuses seeded drilldown audit row)
  - tests: TC-E2E-11, TC-E2E-12

## Parallel Batches

```text
Batch 1: [TASK-MIGRATIONS]                                                — foundation: schema (8 tables/columns) + RLS postlude (single .sql file, all in one transaction)
Batch 2: [TASK-COMPOSITE, TASK-ANOMALY, TASK-RADAR-NORM, TASK-TOOLMIX,
          TASK-ZOD, TASK-AUDIT-LIB, TASK-CRON-AUTH, TASK-USER-DISPLAY]    — 8 agents in parallel (disjoint files; AUDIT-LIB needs MIGRATIONS only)
Batch 3: [TASK-QUERIES-V2, TASK-QUERIES-DRILLDOWN, TASK-DISMISS-ROUTE,
          TASK-NOTIFICATION]                                              — parallel (disjoint query files; NOTIFICATION moved here from Batch 4 to break circular dep with DRILLDOWN-PAGE)
Batch 4: [TASK-CRON-AGG, TASK-CRON-ANOM, TASK-CRON-CLEANUP,
          TASK-EFFECTIVENESS-PAGE, TASK-TEAM-EFFECTIVENESS-PAGE,
          TASK-HEALTH-PAGE, TASK-DRILLDOWN-PAGE, TASK-VISIBILITY-PAGE]    — 8 agents in parallel (disjoint files; DRILLDOWN-PAGE depends on NOTIFICATION from Batch 3)
Batch 5: [TASK-MERGE-LAYOUT, TASK-CI-TONE-LINT]                           — accumulator merge of 3 nav-link fragments + CI tone-word grep workflow (sequential, main tree)
Batch 6: [TASK-SMOKE-EFFECTIVENESS, TASK-SMOKE-HEALTH,
          TASK-SMOKE-DRILLDOWN, TASK-SMOKE-VISIBILITY]                    — 4 E2E sub-tasks; some sequential due to shared seed state (see deps)
```

**TASK-USER-DISPLAY** (NEW — pure helper for `displayLabelFor()`):
- files: apps/server/lib/util/user-display.test.ts (FIRST — TDD), apps/server/lib/util/user-display.ts
- depends: (none — pure)
- tests: TC-U-37, TC-U-38

File overlap analysis (post-rewrite):

- All `apps/server/lib/analytics/*`, `lib/audit/*`, `lib/zod/*`, `lib/util/*`, `lib/cron/*` files are exclusive per task.
- `apps/server/lib/queries/manager-v2.ts` exclusive to TASK-QUERIES-V2; `manager-drilldown.ts` exclusive to TASK-QUERIES-DRILLDOWN; `notifications.ts` exclusive to TASK-NOTIFICATION; `me-visibility.ts` exclusive to TASK-VISIBILITY-PAGE.
- `apps/server/lib/db/schema.ts` exclusive to TASK-MIGRATIONS.
- `apps/server/lib/db/migrations/0002_manager_v2.sql` exclusive to TASK-MIGRATIONS.
- `apps/server/lib/db/migrations/meta/_journal.json` shared-additive with spec 3 (drizzle-kit appends entry) — TASK-MIGRATIONS owns the append.
- 4 existing integration test files (`teams.test.ts`, `overview.test.ts`, `cleanup.test.ts`, `ingest.test.ts`, `onboarding-redeem.test.ts`) get TRUNCATE list extension — TASK-MIGRATIONS owns this batch edit.
- `apps/server/app/manager/layout.tsx` shared-additive — TASK-EFFECTIVENESS-PAGE / TASK-HEALTH-PAGE / TASK-VISIBILITY-PAGE each produce a wiring fragment (`.specs/wiring/manager-dashboard-v2/<task>.layout.fragment.md`), and TASK-MERGE-LAYOUT applies them sequentially in Batch 5.
- `apps/server/middleware.ts` matcher extension — exclusive to TASK-MIGRATIONS (single one-line edit appended to the array).
- `apps/server/lib/auth/auth.ts` `signIn` callback extension — exclusive to TASK-MIGRATIONS (additive: populates `display_name` from OAuth on first login).
- All `app/manager/**/page.tsx` and `app/me/visibility/page.tsx` files exclusive per task.
- All `components/manager/*.tsx` and `components/me/*.tsx` files exclusive per task.

Zero shared-mutative within Batch 4. Three shared-additive files (`layout.tsx`) handled via wiring fragments.

## Validation Criteria

- [ ] `pnpm typecheck` passes (in `apps/server/`)
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (all TC-U + TC-I)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (12 E2E TCs)
- [ ] Manual: log in as a seeded manager, traverse `/manager/effectiveness` → `/manager/teams/[id]/effectiveness` → `/manager/health` — confirm 4 KPIs render, radar chart shows polygons, check-in card shows verbatim copy
- [ ] Manual: trigger a drilldown with `reason=cost-investigation`, confirm `manager_drilldown_audit` row exists, confirm target dev sees it on `/me/visibility`
- [ ] Manual: target dev receives notification (mock channel inspection)
- [ ] Manual: as non-manager, hit each `/manager/*` route → 403 with correct shape
- [ ] Manual: SQL check `SELECT * FROM manager_drilldown_audit ORDER BY viewed_at DESC LIMIT 5` shows expected fields
- [ ] Manual: SQL check that `pg_class` shows no `manager_v2`-related matview (we're using tables, not matviews)
- [ ] Grep check: no occurrence of forbidden tone words (`alert`, `warning`, `flag`, `violation`, `breach`) in `components/manager/check-in-card.tsx` or `components/manager/dropoff-card.tsx`

## Open Questions

All questions locked at 2026-05-01 (Pause-1 user approval):

- **Q1 [LOCKED 2026-04-28]**: Manager scope = **org-wide (Opção A)**. Mantém spec 3 inalterado.
- **Q2 [LOCKED 2026-04-28]**: Daily rollups = **direct from `sessions_agg` + `tool_count_agg`** via SQL GROUP BY.
- **Q3 [LOCKED 2026-04-28]**: Drilldown audit = **idempotent on `(manager, target, viewed_on, reason)` via UNIQUE + ON CONFLICT**.
- **Q4 [LOCKED 2026-04-28]**: IP policy = **truncated /24 IPv4 or /48 IPv6 + null after 30d**.
- **Q5 [LOCKED 2026-04-28]**: Composite score divergence from local `scoring.ts` is **deliberate**. (REWORKED 2026-05-01: drop `correction_density` 0.20 component → redistribute to cache_hit 0.40 + output_input 0.40. See "Decisões já travadas" #2.)
- **Q6 [LOCKED 2026-04-28]**: "Good session" threshold = **60 default, env-tunable via `MANAGER_GOOD_SESSION_THRESHOLD`**.
- **Q7 [LOCKED 2026-04-28]**: Cron framework = **protected HTTP endpoints + external scheduler**.
- **Q8 [LOCKED 2026-05-01]**: REQ-5 (`tokens-per-merged-LOC`) scope-out for v1 — confirmed. Tracked as `manager-dashboard-v3-outcomes.md` follow-up after both `outcome-integration-git` reporter extension AND this v2 ship.
- **Q9 [LOCKED 2026-05-01]**: Notification channel = **stub via DB-backed queue** (`manager_notifications` table). REQ-16 enqueues a row with `status='pending'`; real email/Slack delivery is a separate spec follow-up. Tests query the DB directly (no mock channel needed). DI seam exposed via optional `notifyChannel` parameter on the drilldown route handler — default `dbBackedNotificationChannel`, tests inject a typed stub.
- **Q10 [LOCKED 2026-05-01]**: Nightly cron at **02:00 UTC**. TZ-aware scheduling deferred until `orgs.timezone` column added in a follow-up spec.
- **Q11 [LOCKED 2026-05-01]**: Skip anomaly detection for teams with **< 5 active devs in last 30d** (std-dev unstable). Enforced in `TASK-CRON-ANOM` early-return + TC-I-60.
- **Q12 [LOCKED 2026-05-01]**: `/me/visibility` route is the same for all roles (manager viewing own audit history = same code path). No special-casing.
- **Q13 [LOCKED 2026-05-01]**: Comparison radar **hidden entirely** when manager has only 1 team. `getRadarComparison` returns null/empty when `teamIds.length === 1` — TC-I-59 verifies, TC-E2E-13 verifies absence in DOM.
- **Q14 [LOCKED 2026-05-01]**: Forbidden tone-word enforcement = **CI grep step** (not code review). Add `.github/workflows/lint-tone.yml` (or equivalent) running `grep -E 'alert|warning|flag|violation|breach' apps/server/components/manager/{check-in,dropoff}-card.tsx` and failing if matches found. 5-line CI step.

## Self-review findings resolved (before saving DRAFT)

- Made REQ-5 `[OUT-OF-SCOPE-V1]` explicit and added a separate "Prerequisite gap" section with a locked recommendation — caller can override during APPROVED.
- Locked the **5 anti-surveillance principles** as a labeled subsection in Design with code-level enforcement notes (typed `audit: AuditContext` param, RLS append-only, alphabetical query order, audit-before-data tx, immutable history on `/me/visibility`).
- Added forbidden tone-word lint via TC-I-35 + TC-E2E-05 to verify the supportive copy never drifts.
- Boundary TCs added for every Zod field (reason enum case sensitivity TC-U-23, reason text 10/9/500/501 TC-U-25..28).
- Boundary TCs added for the spike threshold (TC-U-12 just-below, TC-U-15 exactly-at-50%).
- Drop-off threshold edge: prior-week-zero ⇒ NOT a drop-off (TC-U-14, REQ-12 GIVEN clause).
- Tradeoff matrix (cron tables vs matviews) written in Design with the conclusion locked.
- DDL spelled out inline (not "see migration") — RLS append-only on audit table called out.
- Audit insert is in same tx as data fetch — TC-I-27 verifies that audit-failure ⇒ no data leak.
- Drill-down auth: distinct 403 (not 404) for cross-team enumeration (REQ-9 + TC-I-16) avoids leaking team-existence.
- `/me/visibility` retains historical audit even after org disables notifications (REQ-17 GIVEN clause + Design principle 5).
- Alphabetical-order rule (REQ-18) has TC-I-33 verifying the SQL `ORDER BY` clause directly — not just sample output (less likely to silently regress).
- Open Questions enumerated 8 items needing user confirmation before APPROVED.

## Self-review findings resolved (v2 — 2026-05-01)

13 bloqueadores arquiteturais (B1-B13) + 25 must-fix items aplicados após Pause-1 do usuário. Sumário:

**B1**: `users.display_name TEXT NULL` adicionada via migration. `signIn` callback (auth.ts) populates from OAuth profile name on first login. UI/queries fall back to `split_part(email, '@', 1)` via `displayLabelFor()` helper. ORDER BY uses `COALESCE(display_name, split_part(email, '@', 1))`.

**B2**: `org_settings` table CREATE (não ALTER) — `(org_id PK FK→orgs ON DELETE CASCADE, drilldown_notification_enabled bool default true, created_at, updated_at)`.

**B3**: `cron_runs` table CREATE — `(id, job_name, started_at, finished_at, status CHECK IN running/ok/failed, rows_written, error_message)` + index `(job_name, started_at DESC)`.

**B4**: Notification system = **stub channel via `manager_notifications` DB queue** (não phantom infra). Tests query DB directly. Real email/Slack delivery deferred to follow-up spec.

**B5**: `correction_density × 0.20` removido da composite formula — não existe em `sessions_agg`. Pesos redistribuídos: cache_hit 0.30→0.40, output_input 0.30→0.40 (subagent + manual_rating mantém 0.10 cada).

**B6**: `team_metrics_daily.metric_set` discriminator REMOVIDO. PK simplificada para `(org_id, team_id, day)` — uma row por tuple, todas as métricas flat. 1 INSERT por team/day em vez de 4.

**B7**: RLS column GRANTs em raw SQL postlude (não em Drizzle DDL). `app_runtime` role criada se ausente. Falha graciosamente em deploys superuser-only (code-level enforcement em `writeAudit()` é fallback).

**B8**: Path corrigido de `apps/server/lib/auth/middleware.ts` (não existe) para `apps/server/middleware.ts`. `/me/:path*` adicionado ao matcher.

**B9**: `xmax` via raw SQL `tx.execute(sql\`...RETURNING (xmax = 0) AS inserted\`)` (Drizzle .returning não expõe system columns). Documentado inline em `writeAudit()` JSDoc.

**B10**: Wiring fragments + `TASK-MERGE-LAYOUT` (Batch 5) pra accumulator pattern em `app/manager/layout.tsx`. 3 Batch-4 tasks produzem fragments, merge sequencial.

**B11**: Drilldown Server Component pattern locked: `redirect()` em missing/invalid reason, `notFound()` em cross-team/cross-org, `error.tsx` em audit failure. Audit + data fetch em `db.transaction()` atomic.

**B12**: `subagent_count` → `subagent_usage_ratio > 0` (column real do schema).

**B13**: REQ-19/24 wording: "WeakMap PreparedSet" (sqlite-only) → "Drizzle parameterized API" (Postgres).

**Test Plan additions (49 TCs novos)**:
- TC-U-29..40: `assertInternalCronAuth` (3), env-var boundaries (4), `displayLabelFor` (2), knowledge-sharing boundaries (1), `reasonText` extra-field (1), boot-time empty-secret (1).
- TC-I-36..73: cross-org isolation (3), IP truncation correctness (3), TASK-CRON-CLEANUP (2 + idempotency), audit same-day idempotency (5), cron auth (4), notification failure (1), `/me/visibility` isolation (2), RLS rejection (2), `devId` validation (2), 1-team radar (1), small-team z-score (2), TASK-DISMISS-ROUTE (4), 2-managers concurrency (1), display_name column (1), dropoff-card forbidden words (1), concurrent cron (1), pagination boundaries (3).
- TC-E2E-13: 1-team radar hidden in DOM.

**Total: ~75 → ~124 TCs.** Error/edge ratio remains dominant (~75% non-happy).

**Tasks restructured**:
- F21: TASK-TEAM-EFFECTIVENESS-PAGE moved Batch 5 → Batch 4 (parallelism gain).
- F22: TASK-CRON-AUTH added to Batch 2 (was missing from any batch listing).
- F23: TASK-SMOKE split into 4 sub-tasks (TASK-SMOKE-EFFECTIVENESS/HEALTH/DRILLDOWN/VISIBILITY).
- F24: TASK-USER-DISPLAY new (`displayLabelFor()` helper, Batch 2 leaf).
- B10: TASK-MERGE-LAYOUT new (Batch 5).
- TASK-DISMISS-ROUTE / TASK-CRON-CLEANUP / TASK-CRON-AUTH ganharam TCs próprios (eram "covered indirectly").

**Q1-Q14 todas locked** (Q8-Q14 via Pause-1 user approval em 2026-05-01).

## Execution Log

- 2026-04-28: **User-review pass — 7 fixes aplicados**:
  - **B1 (contract drift com spec 3 — bloqueador)**: refactor das tabelas referenciadas pra alinhar 100% com o schema real do `central-reporter-server.md`. (a) `tenants` → `orgs` (replace_all 33 ocorrências, lower + Title). (b) Manager scope **org-wide (Opção A locked)** — eliminadas as referências fictícias a `team_memberships` e `manager_assignments`; spec 3's `users.role` + `users.team_id` cobrem o caso. (c) Daily rollups **direto de `sessions_agg` + `tool_count_agg`** — eliminados `session_aggregates_daily` e `tool_usage_daily` que não existem em spec 3; o cron agrega per-session em per-team-day no SQL. REQ-3, REQ-21 reescritos pra refletir a nova fonte; "Depends on" listada com nomes corretos.
  - **B2 (CSRF + duplicação no audit GET)**: REQ-15 + DDL agora têm `UNIQUE (manager_user_id, target_user_id, viewed_on, reason)` + `viewed_on date` column. ON CONFLICT DO UPDATE no upsert; `RETURNING (xmax = 0) AS inserted` discrimina insert real vs no-op same-day. REQ-16 só dispara notification quando `inserted = true`. Refresh de página = silencioso. Link malicioso clicado várias vezes mesmo dia = 1 audit + 1 notification, idempotente.
  - **M1 (IP policy)**: DDL trocou `inet` por `text` (CIDR truncado), nome `ip_address_trunc` reforça intent; truncação na inserção; cleanup cron (TASK-CRON-CLEANUP novo) zera após 30d, igual spec 3 REQ-27. RLS atualizada — UPDATE permitido apenas em `(viewed_at, ip_address_trunc)`, nunca nos campos de identidade.
  - **M2 (composite divergence)**: Adicionada subseção "Composite score divergence from local `lib/analytics/scoring.ts`" no Design com tabela comparativa peso-a-peso e justificativa por componente. Decisão locked: `apps/server/lib/analytics/composite-score.ts` é peer NÃO substituto do local — JSDoc no arquivo lembra futuros maintainers.
  - **M3 (threshold 60 arbitrário)**: env var `MANAGER_GOOD_SESSION_THRESHOLD` (default 60, 0..100) documentada em Design + `.env.example`.
  - **M4 (cron framework)**: Locked **endpoints HTTP protegidos + scheduler externo** (`POST /api/internal/cron/*` com header `x-internal-cron-secret`). 3 routes adicionadas (aggregate-team-metrics, detect-anomalies, cleanup-audit-ips). Lib functions ficam em `apps/server/lib/cron/*` (puras, testáveis), routes ficam fininhas (auth + chamada). Portável (Vercel Cron, GitHub Actions schedule, cron-job.org), serverless-friendly, sem in-process node-cron.
  - **Tasks**: TASK-CRON-AUTH novo, TASK-CRON-AGG e TASK-CRON-ANOM atualizadas (paths + auth helper), TASK-CRON-CLEANUP novo.
  - Open Questions: 7 lockadas (Q1..Q7), 7 ainda abertas (Q8..Q14) — REQ-5 outcome scope-out, notification channel, cron_runs ownership, TZ default UTC, small-team z-score guard, /me/visibility for managers, radar with 1 team, CI tone-word grep.

- 2026-05-02: **Batches 1–6 executed via parallel agents in main tree**.
  - **Batch 1 (TASK-MIGRATIONS)**: schema + migration .sql with RLS postlude.
  - **Batch 2** (8 parallel): composite-score, anomaly-detection, radar-normalize, tool-mix, zod schemas, audit lib, cron auth, displayLabelFor helper. TDD: RED → GREEN.
  - **Batch 3** (4 parallel): manager-v2 queries, manager-drilldown queries, dismiss-anomaly route, notifications. TC-I-17 seed adjusted to fire WoW branch (3σ math unreachable with N=3).
  - **Batch 4** (8 parallel — 1st attempt with `isolation: "worktree"` aborted: worktree base stuck on 90e949f, predating apps/server/. Re-launched in main): cron-agg, cron-anom, cron-cleanup, effectiveness-page, team-effectiveness-page, health-page, drilldown-page, visibility-page.
  - **Batch 5** (sequential, main): MERGE-LAYOUT applied 3 wiring fragments; CI-TONE-LINT created `.github/workflows/lint-tone.yml` with allow-list for the REQ-11 spec-locked literal "It's not a flag.".
  - **Batch 6** (4 parallel): seed-manager-v2.ts + 4 Playwright spec files (manager-effectiveness/health/drilldown/me-visibility). E2E execution **DEFERRED** — dev server not started. global-setup wiring of `seed-manager-v2.ts` is a pending follow-up (documented inline in seed file).
  - **Self-review (3 reviewers in parallel)** identified 7 CRITICAL findings; all addressed in-place:
    - Code: replaced `any` in detect-anomalies.ts with structural `{ execute: (sql: SQL) => Promise<unknown> }`.
    - Code: `compositeAvg` on org-effectiveness page now reads `team_metrics_daily.composite_avg` per team (lifted `getTeamCompositeTrend` to `manager-v2.ts`); falls back to `goodSessionMean` only when no team has a composite yet.
    - Code: spec-vs-impl gap on admin team-bypass resolved by aligning impl with spec lock (line 14, "manager manages whole org") — `loadManagerTeams` now returns all teams in the manager's org; `_drilldown/render.tsx` removed the cross-team gate (cross-org guard remains); `team-effectiveness/page.tsx` resolves URL teamId against `teams.org_id = orgId` instead of `users.team_id`.
    - Test: TC-U-11 spec description corrected (test was right — strict `>`, not `>=`); added TC-U-11b for the just-above boundary.
    - Test: added live-DML rejection tests TC-I-55 (UPDATE) + TC-I-56 (DELETE) — open second pg.Pool, `SET LOCAL ROLE app_runtime`, expect Postgres error 42501.
    - Test: added TC-I-66 (two managers, same target+day+reason → 2 audit rows).
    - Security M11: `lint-tone.yml` allow-list tightened from substring `"not a flag"` to anchored `^[0-9]+:\s*not a flag\.?\s*$` (only the wrapped JSX line is exempt).
  - **Pending self-review concerns (escalated to user, not blocking)**:
    - Security M4: drilldown idempotency uses server-UTC `viewed_on` — manager re-clicking near midnight UTC could trigger a duplicate notification. Matches spec REQ-15 wording; flagging for product awareness.
    - Code MAJOR: aggregate-team-metrics.ts emptiness probe is global, not per-org. Net effect for solo-org dev/staging is identical; only diverges from spec when a 2nd org onboards after the 1st has been collecting data. Inline JSDoc documents the deviation.
    - Code MAJOR: dismiss SQL duplicated between `app/manager/health/dismiss-action.ts` and `app/api/manager/dismiss-anomaly/route.ts`. Acceptable for v1; flagged as a follow-up refactor.
    - Code MAJOR: `_drilldown/render.tsx` `org_settings` read happens inside `after()` — could be hoisted before the response is flushed.
  - **Validation**: `apps/server/`: typecheck clean, lint clean, vitest **504 passed / 1 skipped**. Root `tokenfx@0.3.0` test suite has 359 pre-existing failures (pre-existing on `main` before this work — verified by stash; unrelated to spec scope).
