# Spec: manager-dashboard-v2 — effectiveness depth + health signals (Q2-C / Q2-D)

## Status: DRAFT

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
   - `cache_hit_ratio` × 0.30
   - `output_to_input_ratio_normalized` × 0.30 (clip to [0, 5], then divide by 5)
   - `correction_density_inverted` × 0.20 (`1 - correction_density`, clip [0, 1])
   - `subagent_usage_normalized` × 0.10 (capped at 0.5 → mapped to 1.0)
   - `manual_rating_normalized` × 0.10 (`(rating + 1) / 2`, NULL → drop weight, redistribute)
   - Output: 0..100 integer. Same redistribution rule as `lib/analytics/scoring.ts` (existing).
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

- [ ] **REQ-3**: GIVEN the same page WHEN it renders THEN it shows **tool mix for team T over 30 days** as a stacked bar chart (Recharts BarChart, stacked) — bars per day, segments per tool category: `Edit / Read / Bash / Agent / Other`. The `Other` bucket aggregates everything not in the first 4. **Data source**: aggregate live from `tool_count_agg` (per-session per-tool counts owned by spec 3) joined with `sessions_agg` for `(team_id, day)` derivation; OR pre-rolled into `team_metrics_daily.tool_mix_json` by the 15-min cron and read by the page. The cron path is preferred for performance; live aggregation is the fallback when the cron has lag. Categories are a fixed 5-element enum.

- [ ] **REQ-4**: GIVEN the same page WHEN it renders THEN it shows **subagent adoption for team T** as `% of sessions in the last 30 days that used at least one subagent (Agent tool with `subagent_type != null`)` and a 30-day trend chart. Includes a copy line: "Subagent usage is a signal of devs adopting parallelism — high here is good."

- [ ] **REQ-5** `[OUT-OF-SCOPE-V1]`: **Tokens per merged-LOC per team** — depends on outcome data (LOC merged from git) flowing through the reporter, which is not in spec 1 v1 scope. Tracked here for traceability; will move to `manager-dashboard-v3-outcomes.md` once both `outcome-integration-git` and the reporter outcome-payload extension ship. **No tasks, no TCs, no UI in this spec.**

- [ ] **REQ-6**: GIVEN the manager has access to `≥ 2` teams WHEN they navigate to `/manager/effectiveness` THEN a **comparison view** at the top of the page renders a Recharts radar chart with 5 axes: `cache_hit_ratio`, `% good sessions`, `subagent_adoption`, `Edit-tool share`, `Read-tool share`. Each axis is normalized to `[0, 1]` against the **min/max of the manager's teams** (REQ trade-off locked: not absolute, not org-wide). One polygon per team, color-coded. Up to 6 teams; if `> 6`, the manager picks via a multi-select.

- [ ] **REQ-7**: GIVEN a manager navigates to `/manager/teams/[id]/effectiveness` WHEN the route loads with `id = T` belonging to that manager THEN it shows the same 4 KPIs as REQ-1..4 **for team T only**, with the 30-day trend per metric. This is the team-scoped deep-dive page.

- [ ] **REQ-8**: GIVEN a non-manager user (regular dev role) hits `/manager/effectiveness` OR `/manager/teams/[id]/effectiveness` OR `/manager/health` WHEN the auth middleware resolves their role THEN they receive HTTP 403 with `{ error: { message: "Manager role required", code: "FORBIDDEN" } }` — no data leak, no partial render.

- [ ] **REQ-9**: GIVEN a manager hits `/manager/teams/[id]/effectiveness` for a team `id` they do NOT manage WHEN auth resolves THEN HTTP 403 with the same error shape (no team enumeration via 404 vs 403 distinction).

### Health signals (Q2-D)

- [ ] **REQ-10**: GIVEN a manager navigates to `/manager/health` WHEN the page renders THEN it shows a list of **"check-in opportunity" cards** for devs in the manager's teams whose **30d spend** exceeds **(team mean + 3σ)** OR week-over-week spend increase **>= 50%**. Each card shows: dev display name, team, the trigger ("30d spend 3.2σ above team avg" OR "spend up 67% WoW"), and a primary CTA "Open conversation guide" (links to a `/manager/check-in/[devId]?reason=cost-investigation` flow that pre-fills the drilldown audit reason).

- [ ] **REQ-11**: The exact UI copy for the check-in opportunity card MUST be (verbatim, locked here):
   - Heading (no exclamation, no alarm tone): `"Check-in opportunity"`
   - Body: `"{displayName} on team {teamName} — {trigger description}. This may be worth a 1:1 conversation about workflow, training, or scope. It's not a flag."`
   - Primary CTA label: `"Open conversation guide"`
   - Secondary CTA label: `"Dismiss for 7 days"` (writes a row to `manager_dismissed_anomalies` with `dismissed_until = now + 7d`).
   - **Forbidden tone words in this card**: `"alert"`, `"warning"`, `"flag"`, `"violation"`, `"breach"`. Lint rule TBD; for now, code review enforces.

- [ ] **REQ-12**: GIVEN the same `/manager/health` page WHEN it renders THEN it shows **drop-off cards** for devs whose week-over-week active-days OR session-count dropped >= 50% AND who were active in the prior week. Card uses the same supportive tone as REQ-11:
   - Heading: `"May need support"`
   - Body: `"{displayName} on team {teamName} — usage down {pct}% week-over-week. Consider checking in about training, blockers, or scope changes."`
   - CTAs: `"Open conversation guide"` and `"Dismiss for 7 days"`.

- [ ] **REQ-13**: GIVEN `/manager/health` renders for a manager whose teams have **knowledge-sharing opportunities** WHEN the rollup detects a team using a tool/agent **>= 2× the median across the manager's teams** AND **>= 4× the lowest team** (both gates) WHEN the page renders THEN a "Knowledge-sharing opportunity" section lists: `"Team {top} uses {feature} {ratio}× more than {bottom}. Consider sharing patterns."` Examples: subagents, specific agent types (`code-reviewer`, `Explore`), tool categories.

- [ ] **REQ-14**: GIVEN the manager navigates to **any individual dev drilldown** route (`/manager/check-in/[devId]?reason=...` OR `/manager/devs/[devId]`) WHEN the route loads WITHOUT a valid `reason` query param matching the closed enum `{ training-check, quota-investigation, cost-investigation, other }` (case-sensitive) THEN HTTP 400 `{ error: { message: "Reason tag required", code: "REASON_REQUIRED" } }`. With `reason=other`, the request body MUST include `reasonText` (string, 10..500 chars) — Zod-validated; missing/short → 400.

- [ ] **REQ-15**: GIVEN the manager hits a dev-drilldown route with a valid `reason` AND optional `reasonText` WHEN auth + reason validation pass AND the dev is in one of the manager's teams THEN a row is upserted into `manager_drilldown_audit` with: `org_id, manager_user_id, target_user_id, reason, reason_text (nullable), viewed_on (date, server-side date in UTC), viewed_at (timestamptz, server time), source_route, ip_address (truncated /24 IPv4 or /48 IPv6, nullable, purged via cron after 30d — same policy as spec 3 REQ-27)` BEFORE any dev data is rendered. **Idempotency**: a `UNIQUE (manager_user_id, target_user_id, viewed_on, reason)` constraint dedupes same-day repeats — `ON CONFLICT DO UPDATE SET viewed_at = excluded.viewed_at`. Refreshing the page or the manager re-opening the link the same day **does not** create a new audit row nor trigger another notification (REQ-16). The insert is in the same DB transaction as the data fetch — if the audit upsert fails, the whole request 500s and **no data is shown**. **Why upsert instead of POST-only**: GET pages with audit are CSRF-vulnerable (a malicious link could trigger phantom audits); idempotency on `(manager, target, day, reason)` neutralizes that — same link clicked any number of times same-day = single audit, single notification. A new audit row only on a new day OR a new reason tag, both intentional manager actions.

- [ ] **REQ-16**: GIVEN a drilldown audit upsert resulted in a **new row inserted** (not an ON CONFLICT no-op same-day refresh) AND the org has `drilldown_notification_enabled = true` (default true) WHEN the request completes successfully THEN a notification is enqueued for the **target dev** through the same notification channel spec 1 uses. The route uses `INSERT ... ON CONFLICT ... RETURNING xmax` (or `RETURNING (xmax = 0) AS inserted`) to detect "was this a real insert or an ON CONFLICT update". Only `inserted = true` triggers notification — refreshes are silent. Notification body: `"Your manager {managerName} viewed your usage on {viewedOn} for reason: {reasonHumanReadable}{reasonTextSuffixIfProvided}."` — verbatim, locked. Enqueueing happens **after** the response is sent (don't block manager UX on notification deliverability). Dropped notifications retry via spec 1's backoff. **Note on channel**: spec 1 didn't lock a notification channel; this spec depends on it. Open Question #2 surfaces this.

- [ ] **REQ-17**: GIVEN a dev (any role) navigates to `/me/visibility` WHEN the page renders THEN it shows: (a) the **same aggregated KPIs** their manager sees about them (cache_hit_ratio, % good sessions, subagent adoption, tool mix — last 30d), and (b) a **chronological log** of every drilldown row in `manager_drilldown_audit` where `target_user_id = self`, columns: `viewed_at, manager_display_name, reason, reason_text` (newest first, paginated 25/page). No row is hidden from the dev — even if the org later toggles `drilldown_notification_enabled = false`, the audit log on `/me/visibility` continues showing past views.

- [ ] **REQ-18**: GIVEN ANY query that returns dev-level data within a team for a manager WHEN it executes THEN the result MUST be ordered alphabetically by `users.display_name ASC` — never sorted by spend/tokens/sessions/any usage metric. Documented at the query layer with a comment + a unit test that asserts ordering. (Anti-surveillance principle 3.)

- [ ] **REQ-19**: GIVEN the manager-side queries on `team_metrics_daily` and `manager_drilldown_audit` WHEN they execute THEN they MUST go through prepared statements with parameter binding (Postgres `pg` library `client.query(text, values)` form) — never template-string concatenation of org_id / team_id / user_id values. (Spec 1 sets the pattern; this spec inherits.)

### Data infrastructure

- [ ] **REQ-20**: GIVEN spec 1's Postgres schema is in place WHEN this spec's migrations run THEN the following **new tables** are created (DDL spelled out in Design):
   - `team_metrics_daily` — rollups; one row per (org, team, day, metric_set).
   - `manager_drilldown_audit` — append-only audit; never deleted.
   - `manager_dismissed_anomalies` — per (org, manager, target_dev, anomaly_type), with `dismissed_until` timestamptz.
   - `org_settings` — extended (or created if not present) with `drilldown_notification_enabled boolean default true`.

- [ ] **REQ-21**: GIVEN `team_metrics_daily` is empty WHEN the **15-minute aggregation cron** runs THEN it backfills the last 90 days on first run, computing rollups **directly from spec 3's `sessions_agg` and `tool_count_agg`** via SQL: `GROUP BY users.team_id, date_trunc('day', sessions_agg.started_at)` joined to `users` for team resolution and to `tool_count_agg` for the tool_mix JSON. No intermediate per-day per-user rollup table is needed — `sessions_agg` is already the per-session aggregate. Idempotent: `INSERT ... ON CONFLICT (org_id, team_id, day, metric_set) DO UPDATE`. Subsequent runs only refresh the last 2 days (handles late-arriving reporter pushes).

- [ ] **REQ-22**: GIVEN the **nightly anomaly cron** runs at 02:00 org-local THEN for each team in each org, it computes z-scores for each (dev, 30d_spend) using the **team's last 30 days** as the reference distribution and writes flagged rows to a new `manager_anomalies` table (or a `kind` column in the dismissed table — see Design). Idempotent on (date, team, dev, anomaly_kind).

- [ ] **REQ-23**: GIVEN any of the new cron jobs fail (DB unavailable, query timeout) WHEN they retry THEN they retry with exponential backoff (1m → 5m → 30m → fail-and-alert via org ops channel). The `cron_runs` table (created here OR reused from spec 1) records every run with `started_at, finished_at, status, error_message`.

- [ ] **REQ-24**: All new manager-v2 queries live in `apps/server/lib/queries/manager-v2.ts` (spec 1 has `manager.ts` for v1 — they coexist; v2 does not modify v1 file unless necessary, and if it does, the modification is additive only). Queries follow spec 1's `PreparedSet`/WeakMap pattern.

## Test Plan

### Unit Tests — composite scoring, anomaly thresholds, normalization

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | `computeCompositeScore({ cacheHit: 0.5, outputInput: 2.0, correctionDensity: 0.1, subagentUsage: 0.3, manualRating: 0.5 })` | integer 0..100 matching the locked formula |
| TC-U-02 | REQ-2 | edge | All component metrics at perfect maxes | exactly 100 |
| TC-U-03 | REQ-2 | edge | All component metrics at 0 / negative | exactly 0 (clip) |
| TC-U-04 | REQ-2 | edge | `manualRating: null` | weight redistributed across other 4 components, output still 0..100 |
| TC-U-05 | REQ-2 | edge | All metrics null | returns null (no signal) |
| TC-U-06 | REQ-2 | boundary | composite exactly 60 | counted as "good" |
| TC-U-07 | REQ-2 | boundary | composite 59 with rating 0 | counted as "good" (rating override) |
| TC-U-08 | REQ-2 | boundary | composite 59, rating -1 | NOT good |
| TC-U-09 | REQ-10 | business | `detectSpike({ thirtyDaySpend: 100, teamMean: 50, teamStdDev: 10 })` | flagged: 5σ above mean |
| TC-U-10 | REQ-10 | business | `detectSpike({ thirtyDaySpend: 75, teamMean: 50, teamStdDev: 10 })` | NOT flagged: 2.5σ |
| TC-U-11 | REQ-10 | business | `detectWowSpike({ thisWeek: 150, lastWeek: 100 })` | flagged: +50% |
| TC-U-12 | REQ-10 | boundary | `detectWowSpike({ thisWeek: 149.99, lastWeek: 100 })` | NOT flagged: 49.99% |
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
| TC-I-12 | REQ-4 | happy | `getTeamSubagentAdoption(db, ...)` | Pct of sessions w/ `subagent_count > 0` correct |
| TC-I-13 | REQ-6 | business | `getRadarComparison(db, { teamIds })` returns normalized 0..1 axes | min→0, max→1, intermediate proportional |
| TC-I-14 | REQ-7 | happy | `/manager/teams/[id]/effectiveness` GET as authorized manager | 200 + page renders 4 KPI cards (HTML grep) |
| TC-I-15 | REQ-8 | security | Same route as non-manager | 403 + error shape `{error:{message,code:"FORBIDDEN"}}` |
| TC-I-16 | REQ-9 | security | Manager hits `/manager/teams/[other-team-id]/effectiveness` | 403 (not 404) |
| TC-I-17 | REQ-10 | happy | `getCheckInOpportunities(db, { managerId })` | Returns devs flagged by spike OR WoW; ordered alphabetically (REQ-18) |
| TC-I-18 | REQ-12 | happy | `getDropOffCandidates(db, { managerId })` | Returns devs w/ >50% WoW drop AND active prior week |
| TC-I-19 | REQ-13 | happy | `getKnowledgeSharingOpportunities(db, { managerId })` | Returns rows where top team is >=2× median AND >=4× bottom |
| TC-I-20 | REQ-14 | validation | `POST /manager/check-in/[devId]` with no `reason` | 400 `{code:"REASON_REQUIRED"}` |
| TC-I-21 | REQ-14 | validation | Drilldown route with `reason=banana` | 400 |
| TC-I-22 | REQ-14 | validation | `reason=other` without `reasonText` | 400 |
| TC-I-23 | REQ-14 | validation | `reason=other` with `reasonText` of length 9 | 400 |
| TC-I-24 | REQ-14 | validation | `reason=other` with `reasonText` of length 10 | 200 |
| TC-I-25 | REQ-14 | validation | `reasonText` of length 501 | 400 |
| TC-I-26 | REQ-15 | business, security | Valid drilldown by manager A on dev D in team T | Row written to `manager_drilldown_audit` with all expected fields BEFORE response sent; data rendered |
| TC-I-27 | REQ-15 | infra, security | Drilldown where audit insert fails (forced via SQL trigger or constraint violation) | 500; NO dev data leaked in response body |
| TC-I-28 | REQ-15 | security | Drilldown by manager A on dev D where D is NOT in any of A's teams | 403, NO audit row written, NO data |
| TC-I-29 | REQ-16 | business | Drilldown when `drilldown_notification_enabled=true` | Notification enqueued for target dev (assert via mock channel) |
| TC-I-30 | REQ-16 | business | Drilldown when `drilldown_notification_enabled=false` | NO notification enqueued; audit row STILL written |
| TC-I-31 | REQ-17 | happy | `GET /me/visibility` for dev with 3 historical drilldown rows | Page shows aggregated KPIs + audit table with 3 rows newest-first |
| TC-I-32 | REQ-17 | edge | `GET /me/visibility` for dev with no drilldowns | Page renders KPIs + empty audit log w/ "No views recorded" copy |
| TC-I-33 | REQ-18 | security | `getTeamMembersForManager` returns members in alphabetical order | Ordered by `display_name ASC`; assertion fails if any spend-based ordering sneaks in |
| TC-I-34 | REQ-19 | security | All manager-v2 queries inspected for prepared-statement usage (lint or test) | No template-literal SQL in `manager-v2.ts` |
| TC-I-35 | REQ-11 | security | Audit content of check-in card HTML for forbidden tone words | None of `alert/warning/flag/violation/breach` present in card |

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

**Composite score divergence from local `lib/analytics/scoring.ts`** (deliberate, NOT accidental duplication).

| Component | Local `scoring.ts` weight | This spec weight | Why different |
| --- | --- | --- | --- |
| Cache hit ratio | 10% | **30%** | At org scope, cache discipline is a strong leverage signal across many devs/sessions; at personal scope it's a side metric next to user judgment. |
| Output/input ratio | 10% | **30%** | Same logic — agg-level token efficiency is a primary signal of team usage maturity. |
| Correction density (inverted) | 20% | 20% | Same — universal signal of rework. |
| Subagent usage | — | 10% | New at org scope: parallelism adoption is a leading indicator we can't surface at single-session level. |
| Manual rating | **30%** | 10% | Personal: the user's own thumbs-up/down dominates. Manager view: rating density is too sparse and self-selecting at agg level — fewer ratings ≠ worse work. |
| Accept rate | 15% | — | Drop at org scope: noisy signal once aggregated; users have very different accept-rejection styles. |
| Tool error rate | 15% | — | Drop at org scope: dominated by infra/Bash failures unrelated to user effectiveness. |

**Locked**: org-scope formula is a different score, not the local one re-aggregated. Two separate helpers (`apps/server/lib/analytics/composite-score.ts` for org; existing `lib/analytics/scoring.ts` for personal). The Test Plan covers each separately. **Rationale documented inline in the new file's JSDoc** so a future dev doesn't "fix" the divergence by mistake.

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

### DDL — exact schema

```sql
-- team_metrics_daily: rollups for effectiveness UI
CREATE TABLE team_metrics_daily (
  org_id          uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id            uuid          NOT NULL REFERENCES teams(id)   ON DELETE CASCADE,
  day                date          NOT NULL,
  metric_set         text          NOT NULL CHECK (metric_set IN ('effectiveness','tool_mix','subagent','health')),
  cache_hit_ratio_avg     numeric(5,4),  -- 0..1, 4 decimals
  good_session_pct        numeric(5,2),  -- 0..100
  subagent_adoption_pct   numeric(5,2),
  total_sessions          integer NOT NULL DEFAULT 0,
  total_devs              integer NOT NULL DEFAULT 0,
  tool_mix_json           jsonb,         -- { Edit:int, Read:int, Bash:int, Agent:int, Other:int }
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, day, metric_set)
);
CREATE INDEX idx_tmd_team_day ON team_metrics_daily (team_id, day DESC);

-- manager_drilldown_audit: append-only audit, idempotent same-day
CREATE TABLE manager_drilldown_audit (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id),
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  reason             text          NOT NULL CHECK (reason IN ('training-check','quota-investigation','cost-investigation','other')),
  reason_text        text,
  source_route       text          NOT NULL,
  -- IP policy aligned with spec 3 REQ-27: truncated on insert (/24 IPv4 or /48 IPv6),
  -- nulled by the daily cleanup cron after 30 days. Stored as text (truncated CIDR string)
  -- not `inet` to make the truncation step explicit and avoid accidental full-IP storage.
  ip_address_trunc   text,
  viewed_on          date          NOT NULL,
  viewed_at          timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (manager_user_id, target_user_id, viewed_on, reason)
);
CREATE INDEX idx_mda_target_viewed   ON manager_drilldown_audit (target_user_id, viewed_at DESC);
CREATE INDEX idx_mda_manager_viewed  ON manager_drilldown_audit (manager_user_id, viewed_at DESC);
-- RLS: append-only on (id, viewed_at). UPDATE allowed ONLY on (viewed_at, ip_address_trunc) — needed
-- for ON CONFLICT same-day refresh and for the IP-purge cron. NEVER UPDATE on
-- (manager_user_id, target_user_id, reason, reason_text, viewed_on, source_route). Enforced via column
-- privilege grants. DELETE is NEVER granted.

-- manager_anomalies: nightly cron output
CREATE TABLE manager_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id          uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id            uuid          NOT NULL REFERENCES teams(id),
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  kind               text          NOT NULL CHECK (kind IN ('spend-spike-30d','spend-spike-wow','dropoff-wow')),
  detected_on        date          NOT NULL,
  context_json       jsonb,        -- { sigma:5.2, mean:..., teamStdDev:..., wowDelta:0.67 }
  created_at         timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (org_id, team_id, target_user_id, kind, detected_on)
);

-- manager_dismissed_anomalies: 7-day dismissals
CREATE TABLE manager_dismissed_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id          uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id),
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  kind               text          NOT NULL,
  dismissed_until    timestamptz   NOT NULL,
  dismissed_at       timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (org_id, manager_user_id, target_user_id, kind)
);

-- org_settings: extension (assumes spec 1 created this; if not, this CREATE TABLE runs)
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS drilldown_notification_enabled boolean NOT NULL DEFAULT true;
```

### Files to Create

- `apps/server/lib/analytics/composite-score.ts` + `.test.ts` — `computeCompositeScore`, "good session" classifier
- `apps/server/lib/analytics/anomaly-detection.ts` + `.test.ts` — `detectSpike`, `detectWowSpike`, `detectDropOff`, `detectKnowledgeSharingOpportunity`
- `apps/server/lib/analytics/radar-normalize.ts` + `.test.ts` — `normalizeRadarMetrics`
- `apps/server/lib/analytics/tool-mix.ts` + `.test.ts` — `bucketizeToolMix` (5-element enum)
- `apps/server/lib/queries/manager-v2.ts` + `.test.ts` — team-aggregated queries (REQ-1..7, REQ-10, REQ-12, REQ-13)
- `apps/server/lib/queries/manager-drilldown.ts` + `.test.ts` — dev-level queries gated by `audit: AuditContext` parameter (REQ-15)
- `apps/server/lib/audit/drilldown-audit.ts` + `.test.ts` — `writeAudit(tx, AuditContext)`, runs in same tx as data fetch
- `apps/server/lib/zod/manager-v2-schemas.ts` + `.test.ts` — reason tag enum, reason text bounds
- `apps/server/migrations/00X_manager_v2.sql` — DDL above
- `apps/server/lib/cron/manager-v2/aggregate-team-metrics.ts` + `.test.ts` — pure logic invoked by the route handler
- `apps/server/lib/cron/manager-v2/detect-anomalies.ts` + `.test.ts` — pure logic invoked by the route handler
- `apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts` — POST endpoint, validates `x-internal-cron-secret` header, calls the lib function, returns JSON status
- `apps/server/app/api/internal/cron/detect-anomalies/route.ts` — same pattern
- `apps/server/lib/cron/auth.ts` + `.test.ts` — `assertInternalCronAuth(req)` helper (header check + timing-safe-equal)
- `apps/server/lib/cron/cleanup-audit-ips.ts` + `.test.ts` — daily cleanup job (called by a third internal cron endpoint) that NULLs `manager_drilldown_audit.ip_address_trunc` for rows where `viewed_at < now - 30d`
- `apps/server/app/manager/effectiveness/page.tsx`
- `apps/server/app/manager/teams/[id]/effectiveness/page.tsx`
- `apps/server/app/manager/health/page.tsx`
- `apps/server/app/manager/check-in/[devId]/page.tsx` (drilldown landing — required `reason` query)
- `apps/server/app/manager/devs/[devId]/page.tsx` (full drilldown — required `reason`)
- `apps/server/app/me/visibility/page.tsx`
- `apps/server/app/api/manager/dismiss-anomaly/route.ts` (POST, writes `manager_dismissed_anomalies`)
- `apps/server/components/manager/effectiveness-kpi-row.tsx`
- `apps/server/components/manager/tool-mix-chart.tsx`
- `apps/server/components/manager/subagent-trend-chart.tsx`
- `apps/server/components/manager/radar-comparison.tsx`
- `apps/server/components/manager/check-in-card.tsx`
- `apps/server/components/manager/dropoff-card.tsx`
- `apps/server/components/manager/knowledge-sharing-card.tsx`
- `apps/server/components/me/audit-log-table.tsx`
- `apps/server/tests/e2e/manager-effectiveness.spec.ts`
- `apps/server/tests/e2e/manager-health.spec.ts`
- `apps/server/tests/e2e/me-visibility.spec.ts`
- `apps/server/tests/e2e/manager-drilldown.spec.ts`

### Files to Modify (additive only)

- `apps/server/lib/auth/middleware.ts` — extend role check to recognize `manager` for the new routes (if spec 1 didn't add it). Additive.
- `apps/server/lib/notifications/templates.ts` — register `MANAGER_DRILLDOWN_VIEW` template. Additive.
- `apps/server/app/layout.tsx` — add nav links to manager routes if spec 1's shell didn't already. Additive.

### Dependencies

No new packages — Postgres + `pg` (spec 1) + Recharts (already in TokenFx; mirror in `apps/server/`) + Zod + Vitest + Playwright. Verify Recharts API surface via Context7 for `RadarChart` before TASK-RADAR.

## Tasks

- [ ] **TASK-MIGRATIONS**: Create `apps/server/migrations/00X_manager_v2.sql` with full DDL from Design. Add migration runner entry. Idempotent via `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. RLS: grant only INSERT + SELECT on `manager_drilldown_audit` (no UPDATE/DELETE).
  - files: apps/server/migrations/00X_manager_v2.sql, apps/server/migrations/index.ts (additive)
  - tests: TC-I-01, TC-I-02

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

- [ ] **TASK-CRON-AUTH**: `apps/server/lib/cron/auth.ts` — `assertInternalCronAuth(req)` reads `x-internal-cron-secret` header, timing-safe-compares to `process.env.INTERNAL_CRON_SECRET`. Throws 401 on mismatch.
  - files: apps/server/lib/cron/auth.ts, apps/server/lib/cron/auth.test.ts
  - tests: — (covered indirectly by TC-I integration tests on each cron route)

- [ ] **TASK-CRON-AGG**: 15-min aggregation cron — pure logic in `apps/server/lib/cron/manager-v2/aggregate-team-metrics.ts` that GROUP BYs `sessions_agg`/`tool_count_agg` into `team_metrics_daily` (last 2 days; 90 on first run); idempotent via `ON CONFLICT DO UPDATE`. Uses `cron_runs` for status. POST route at `apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts` calls it after `assertInternalCronAuth`.
  - files: apps/server/lib/cron/manager-v2/aggregate-team-metrics.ts, apps/server/lib/cron/manager-v2/aggregate-team-metrics.test.ts, apps/server/app/api/internal/cron/aggregate-team-metrics/route.ts
  - depends: TASK-QUERIES-V2, TASK-CRON-AUTH
  - tests: TC-I-03, TC-I-04, TC-I-07

- [ ] **TASK-CRON-ANOM**: Nightly anomaly cron — pure logic in `apps/server/lib/cron/manager-v2/detect-anomalies.ts`, z-scores per team (skip teams with `< 5 active devs in last 30d`), write to `manager_anomalies`. POST route at `apps/server/app/api/internal/cron/detect-anomalies/route.ts`.
  - files: apps/server/lib/cron/manager-v2/detect-anomalies.ts, apps/server/lib/cron/manager-v2/detect-anomalies.test.ts, apps/server/app/api/internal/cron/detect-anomalies/route.ts
  - depends: TASK-QUERIES-V2, TASK-ANOMALY, TASK-CRON-AUTH
  - tests: TC-I-05, TC-I-06

- [ ] **TASK-CRON-CLEANUP**: Daily IP-cleanup cron — `apps/server/lib/cron/cleanup-audit-ips.ts` zeros `manager_drilldown_audit.ip_address_trunc` for rows older than 30d. POST route at `apps/server/app/api/internal/cron/cleanup-audit-ips/route.ts`.
  - files: apps/server/lib/cron/cleanup-audit-ips.ts, apps/server/lib/cron/cleanup-audit-ips.test.ts, apps/server/app/api/internal/cron/cleanup-audit-ips/route.ts
  - depends: TASK-MIGRATIONS, TASK-CRON-AUTH
  - tests: — (covered manually in Validation Criteria; SQL assertion that old rows have NULL ip)

- [ ] **TASK-EFFECTIVENESS-PAGE**: `/manager/effectiveness` page (KPI row + trend charts + tool-mix stacked bar + subagent trend + radar comparison). Auth gate (REQ-8).
  - files: apps/server/app/manager/effectiveness/page.tsx, apps/server/components/manager/effectiveness-kpi-row.tsx, apps/server/components/manager/tool-mix-chart.tsx, apps/server/components/manager/subagent-trend-chart.tsx, apps/server/components/manager/radar-comparison.tsx
  - depends: TASK-QUERIES-V2
  - tests: TC-I-14, TC-I-15

- [ ] **TASK-TEAM-EFFECTIVENESS-PAGE**: `/manager/teams/[id]/effectiveness` (team-scoped deep dive). Auth + team-membership gate (REQ-9).
  - files: apps/server/app/manager/teams/[id]/effectiveness/page.tsx
  - depends: TASK-QUERIES-V2, TASK-EFFECTIVENESS-PAGE
  - tests: TC-I-14, TC-I-16

- [ ] **TASK-HEALTH-PAGE**: `/manager/health` page with check-in cards + drop-off cards + knowledge-sharing section. Verbatim copy from REQ-11/REQ-12. CTA wires to drilldown route with pre-filled reason.
  - files: apps/server/app/manager/health/page.tsx, apps/server/components/manager/check-in-card.tsx, apps/server/components/manager/dropoff-card.tsx, apps/server/components/manager/knowledge-sharing-card.tsx
  - depends: TASK-QUERIES-V2
  - tests: TC-I-35

- [ ] **TASK-DRILLDOWN-PAGE**: `/manager/check-in/[devId]` and `/manager/devs/[devId]` — both require `reason` query param (Zod-validated), call `writeAudit` in tx with data fetch. Auth + team membership + reason gates.
  - files: apps/server/app/manager/check-in/[devId]/page.tsx, apps/server/app/manager/devs/[devId]/page.tsx
  - depends: TASK-AUDIT-LIB, TASK-QUERIES-DRILLDOWN, TASK-ZOD
  - tests: TC-I-20, TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25

- [ ] **TASK-NOTIFICATION**: Register `MANAGER_DRILLDOWN_VIEW` template in spec 1's notification system; enqueue from drilldown route handler post-response. Honors `org_settings.drilldown_notification_enabled`.
  - files: apps/server/lib/notifications/templates.ts (additive), apps/server/lib/notifications/manager-drilldown.ts, apps/server/lib/notifications/manager-drilldown.test.ts
  - depends: TASK-DRILLDOWN-PAGE
  - tests: TC-I-29, TC-I-30

- [ ] **TASK-DISMISS-ROUTE**: `POST /api/manager/dismiss-anomaly` writes `manager_dismissed_anomalies` row with `dismissed_until = now() + 7d`. Auth gated. Idempotent (UPDATE on conflict).
  - files: apps/server/app/api/manager/dismiss-anomaly/route.ts, apps/server/app/api/manager/dismiss-anomaly/route.test.ts
  - depends: TASK-MIGRATIONS
  - tests: TC-I-15 (auth shape verification reused)

- [ ] **TASK-VISIBILITY-PAGE**: `/me/visibility` page — aggregated KPIs for self + paginated audit log. Server Component.
  - files: apps/server/app/me/visibility/page.tsx, apps/server/components/me/audit-log-table.tsx, apps/server/lib/queries/me-visibility.ts, apps/server/lib/queries/me-visibility.test.ts
  - depends: TASK-MIGRATIONS, TASK-QUERIES-V2
  - tests: TC-I-31, TC-I-32

- [ ] **TASK-SMOKE**: Playwright E2E tests for all manager-v2 flows + dev visibility flow. Seed via dedicated `apps/server/scripts/seed-manager-v2.ts` (reuses spec 1's seed primitives where possible).
  - files: apps/server/tests/e2e/manager-effectiveness.spec.ts, apps/server/tests/e2e/manager-health.spec.ts, apps/server/tests/e2e/manager-drilldown.spec.ts, apps/server/tests/e2e/me-visibility.spec.ts, apps/server/scripts/seed-manager-v2.ts
  - depends: TASK-EFFECTIVENESS-PAGE, TASK-TEAM-EFFECTIVENESS-PAGE, TASK-HEALTH-PAGE, TASK-DRILLDOWN-PAGE, TASK-NOTIFICATION, TASK-VISIBILITY-PAGE, TASK-DISMISS-ROUTE
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07, TC-E2E-08, TC-E2E-09, TC-E2E-10, TC-E2E-11, TC-E2E-12

## Parallel Batches

```text
Batch 1: [TASK-MIGRATIONS]                                                — foundation: schema + RLS
Batch 2: [TASK-COMPOSITE, TASK-ANOMALY, TASK-RADAR-NORM, TASK-TOOLMIX,
          TASK-ZOD, TASK-AUDIT-LIB]                                       — 6 agents in parallel (disjoint files; AUDIT-LIB depends on MIGRATIONS only)
Batch 3: [TASK-QUERIES-V2, TASK-QUERIES-DRILLDOWN, TASK-DISMISS-ROUTE]    — parallel (disjoint query files; DISMISS-ROUTE only needs migrations)
Batch 4: [TASK-CRON-AGG, TASK-CRON-ANOM, TASK-EFFECTIVENESS-PAGE,
          TASK-HEALTH-PAGE, TASK-DRILLDOWN-PAGE, TASK-VISIBILITY-PAGE]    — 6 agents in parallel (disjoint files)
Batch 5: [TASK-TEAM-EFFECTIVENESS-PAGE, TASK-NOTIFICATION]                — sequential after Batch 4
Batch 6: [TASK-SMOKE]                                                     — final E2E
```

File overlap analysis:

- All `apps/server/lib/analytics/*` files are exclusive per task.
- `apps/server/lib/queries/manager-v2.ts` exclusive to TASK-QUERIES-V2; `manager-drilldown.ts` exclusive to TASK-QUERIES-DRILLDOWN.
- `apps/server/migrations/00X_manager_v2.sql` exclusive to TASK-MIGRATIONS.
- `apps/server/migrations/index.ts` is shared-additive with spec 1's last migration registration — **classified shared-additive, sequential application**.
- `apps/server/lib/notifications/templates.ts` is shared-additive with spec 1 (template registry append). TASK-NOTIFICATION applies its registration in Batch 5.
- `apps/server/app/layout.tsx` shared-additive with spec 1's nav (nav-link append). TASK-EFFECTIVENESS-PAGE handles the nav-link addition (within same file via additive append).
- All `app/manager/**/page.tsx` files exclusive per task.
- All `components/manager/*.tsx` files exclusive per task.

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

- **Q1 [LOCKED 2026-04-28]**: Manager scope = **org-wide (Opção A)** — manager sees all teams in their `org_id`. No `team_memberships` / `manager_assignments` tables. Mantém spec 3 inalterado. (Resolves B1 part 1.)
- **Q2 [LOCKED 2026-04-28]**: Daily rollups = **direct from `sessions_agg` + `tool_count_agg`** via SQL GROUP BY. No intermediate per-day tables. (Resolves B1 part 2.)
- **Q3 [LOCKED 2026-04-28]**: Drilldown audit = **idempotent on `(manager, target, viewed_on, reason)` via UNIQUE + ON CONFLICT** instead of POST-only Server Action. Same-day refresh = no new row, no new notification. Solves CSRF + duplication concerns at lower refactor cost. (Resolves B2.)
- **Q4 [LOCKED 2026-04-28]**: IP address policy = **truncated /24 IPv4 or /48 IPv6 on insert + null after 30d via cleanup cron** — same as spec 3 REQ-27. Column type `text` (truncated CIDR), not `inet`. (Resolves M1.)
- **Q5 [LOCKED 2026-04-28]**: Composite score divergence from local `scoring.ts` is **deliberate** — separate helpers, separate weights, justified inline in code + Design table. (Resolves M2.)
- **Q6 [LOCKED 2026-04-28]**: "Good session" threshold = **60 default, env-tunable via `MANAGER_GOOD_SESSION_THRESHOLD`**. (Resolves M3.)
- **Q7 [LOCKED 2026-04-28]**: Cron framework = **protected HTTP endpoints + external scheduler** (`POST /api/internal/cron/*` with `x-internal-cron-secret` header). Portable, serverless-friendly, no in-process scheduler. (Resolves M4.)
- **Q8 (still open)**: REQ-5 (`tokens-per-merged-LOC`) scope-out for v1. DRAFT keeps option (2) — drop here, track in `manager-dashboard-v3-outcomes.md` later. Confirm or push back to `outcome-integration-git` + reporter to add outcome data to the payload.
- **Q9 (still open)**: Notification channel — spec 3 didn't pick (email/Slack/in-app). TASK-NOTIFICATION needs a concrete channel before implementation; likely follow-up to spec 3 once first user surfaces.
- **Q10 (still open)**: Org-local timezone for nightly cron at 02:00 — spec 3 has no `orgs.timezone` field. **Default to UTC** until orgs.timezone is added; revisit when first multi-region org appears.
- **Q11 (still open)**: Anomaly z-score guard for small teams — skip detection when team has `< 5 active devs in last 30d` (std dev unstable). DRAFT enforces this in TASK-CRON-ANOM via early-return. Confirm.
- **Q12 (still open)**: `/me/visibility` for managers viewing their own audit history — same route, same code, no special-casing. Confirm.
- **Q13 (still open)**: Comparison radar with only 1 team — hide entirely (DRAFT default). Confirm.
- **Q14 (still open)**: Forbidden tone-word enforcement — code review only, OR CI grep step? DRAFT keeps code review for v1; CI grep is a 5-line follow-up if drift happens.

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
