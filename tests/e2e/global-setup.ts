import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { computeCost } from '../../lib/analytics/pricing';

// Inline openDatabase + migrate to avoid import.meta.url (ESM-only) and the
// getDb() singleton side-effect that Playwright's CJS loader can't resolve.
function openDbInline(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function migrateInline(db: DatabaseType): void {
  const schemaPath = path.resolve(__dirname, '../../lib/db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

type SeedTurn = {
  seq: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  userPrompt: string;
  assistantText: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
  subagentType?: string | null;
};

type SeedSession = {
  id: string;
  project: string;
  cwd: string;
  daysAgo: number;
  turns: SeedTurn[];
};

const FIXED_SESSIONS: readonly SeedSession[] = [
  {
    id: 'e2e-1',
    project: 'e2e-project-alpha',
    cwd: '/Users/e2e/alpha',
    daysAgo: 1,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1200,
        output: 400,
        cacheRead: 2000,
        cacheCreation: 100,
        userPrompt:
          'First user prompt for e2e-1 — resolve auth-marker bug in route handler',
        assistantText:
          'First assistant response for e2e-1 — here is the fix for the auth-marker issue',
        toolCalls: [{ name: 'Read', isError: false }],
      },
      {
        seq: 2,
        model: 'claude-sonnet-4-6',
        input: 1500,
        output: 600,
        cacheRead: 3000,
        cacheCreation: 50,
        userPrompt: 'Second user prompt for e2e-1',
        assistantText: 'Second assistant response for e2e-1',
        toolCalls: [],
      },
    ],
  },
  {
    id: 'e2e-2',
    project: 'e2e-project-beta',
    cwd: '/Users/e2e/beta',
    daysAgo: 5,
    turns: [
      {
        seq: 1,
        model: 'claude-opus-4-7',
        input: 2500,
        output: 800,
        cacheRead: 4000,
        cacheCreation: 200,
        userPrompt: 'First user prompt for e2e-2',
        assistantText: 'First assistant response for e2e-2',
        toolCalls: [],
      },
      {
        seq: 2,
        model: 'claude-opus-4-7',
        input: 3000,
        output: 900,
        cacheRead: 4500,
        cacheCreation: 150,
        userPrompt: 'Second user prompt for e2e-2',
        assistantText: 'Second assistant response for e2e-2',
        toolCalls: [],
      },
    ],
  },
  {
    id: 'e2e-3',
    project: 'e2e-project-gamma',
    cwd: '/Users/e2e/gamma',
    daysAgo: 10,
    turns: [
      {
        seq: 1,
        model: 'claude-haiku-4-5',
        input: 800,
        output: 200,
        cacheRead: 1000,
        cacheCreation: 20,
        userPrompt: 'First user prompt for e2e-3',
        assistantText: 'First assistant response for e2e-3',
        toolCalls: [],
      },
      {
        seq: 2,
        model: 'claude-haiku-4-5',
        input: 1000,
        output: 300,
        cacheRead: 1500,
        cacheCreation: 40,
        userPrompt: 'Second user prompt for e2e-3',
        assistantText: 'Second assistant response for e2e-3',
        toolCalls: [],
      },
    ],
  },
  {
    id: 'e2e-today',
    project: 'e2e-project-today',
    cwd: '/Users/e2e/today',
    daysAgo: 0,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 500,
        output: 150,
        cacheRead: 800,
        cacheCreation: 30,
        userPrompt: 'User prompt for today session',
        assistantText: 'Assistant response for today session',
        toolCalls: [],
      },
    ],
  },
  {
    id: 'e2e-subagent',
    project: 'e2e-project-subagents',
    cwd: '/Users/e2e/subagent',
    daysAgo: 2,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1000,
        output: 300,
        cacheRead: 2000,
        cacheCreation: 50,
        userPrompt: 'Kick off exploration',
        assistantText: 'I will delegate to Explore',
        // An `Agent` tool_call is what `getSubagentUsage` aggregates on (REQ-5
        // of token-accounting-parity spec). Seed keeps 1+ Agent call so the
        // "Delegação a subagents" card deterministically renders in E2E.
        toolCalls: [{ name: 'Agent', isError: false }],
        subagentType: 'Explore',
      },
      {
        seq: 2,
        model: 'claude-sonnet-4-6',
        input: 800,
        output: 200,
        cacheRead: 1500,
        cacheCreation: 40,
        userPrompt: 'Now review',
        assistantText: 'Delegating to code-reviewer',
        toolCalls: [{ name: 'Agent', isError: false }],
        subagentType: 'code-reviewer',
      },
      {
        seq: 3,
        model: 'claude-sonnet-4-6',
        input: 500,
        output: 150,
        cacheRead: 800,
        cacheCreation: 30,
        userPrompt: 'Summarize',
        assistantText: 'Main agent summary',
        toolCalls: [],
        subagentType: null,
      },
    ],
  },
  {
    // Populates /effectiveness → "Tendência de erro por ferramenta".
    // Needs ≥2 tools with ≥5 calls each in the 30-day window so buildTrend
    // (MIN_CALLS_PER_BUCKET=5) emits non-null rates for each and the chart
    // actually renders. 15 Bash calls (2 errors) + 8 Read calls (0 errors).
    id: 'e2e-tool-trend',
    project: 'e2e-project-tool-trend',
    cwd: '/Users/e2e/tool-trend',
    daysAgo: 3,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1500,
        output: 400,
        cacheRead: 2500,
        cacheCreation: 80,
        userPrompt: 'Many Bash calls',
        assistantText: 'Running a bunch of Bash',
        toolCalls: Array.from({ length: 15 }, (_, i) => ({
          name: 'Bash',
          isError: i < 2,
        })),
        subagentType: null,
      },
      {
        seq: 2,
        model: 'claude-sonnet-4-6',
        input: 600,
        output: 200,
        cacheRead: 1000,
        cacheCreation: 40,
        userPrompt: 'Some Read calls',
        assistantText: 'Reading files',
        toolCalls: Array.from({ length: 8 }, () => ({
          name: 'Read',
          isError: false,
        })),
        subagentType: null,
      },
    ],
  },
  // Pagination fillers — TASK-6 of sessions-pagination spec.
  // Forces total sessions >= 26 so /sessions surfaces Prev/Next controls
  // (TC-E2E-01, TC-E2E-02, TC-E2E-04, TC-E2E-05). Spread across 7 days in
  // weeks 2-3 ago to avoid saturating any single calendar day (prevents
  // collisions with date-filter heatmap cells).
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `e2e-page-${String(i + 1).padStart(2, '0')}`,
    project: 'e2e-project-pagination',
    cwd: '/Users/e2e/pagination',
    daysAgo: 14 + (i % 7),
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheCreation: 0,
        userPrompt: `Pagination filler prompt ${i + 1}`,
        assistantText: `Pagination filler response ${i + 1}`,
        toolCalls: [],
        subagentType: null,
      },
    ],
  })),
  // Dayfull fillers — supports TC-E2E-06 (date filter + offset preservation).
  // All 30 sessions share daysAgo=10 so a single calendar day carries >=26
  // sessions, forcing pagination inside a date-filtered view.
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `e2e-dayfull-${String(i + 1).padStart(2, '0')}`,
    project: 'e2e-project-dayfull',
    cwd: '/Users/e2e/dayfull',
    daysAgo: 10,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheCreation: 0,
        userPrompt: `Dayfull filler prompt ${i + 1}`,
        assistantText: `Dayfull filler response ${i + 1}`,
        toolCalls: [],
        subagentType: null,
      },
    ],
  })),
  // outcome-integration-git spec — TASK-SMOKE seeds (TC-E2E-01..05).
  // Three sessions with deterministic ids covering the three rendering
  // branches of <SessionOutcomePanel> + <OutcomesCard>:
  //   - e2e-outcome-with-data → status='evaluated', commit_count=2,
  //     loc_added=120, loc_removed=15 (drives TC-E2E-01 + the populated
  //     OutcomesCard branch in TC-E2E-04)
  //   - e2e-outcome-cwd-missing → status='cwd-missing', metrics=0
  //     (drives TC-E2E-02)
  //   - e2e-outcome-not-evaluated → no session_outcomes row
  //     (drives TC-E2E-03; the helper for-loop below skips inserting an
  //     outcome row for this id)
  {
    id: 'e2e-outcome-with-data',
    project: 'e2e-project-outcome-data',
    cwd: '/Users/e2e/outcome-data',
    daysAgo: 1,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 800,
        output: 250,
        cacheRead: 1500,
        cacheCreation: 60,
        userPrompt: 'Outcome data session prompt',
        assistantText: 'Shipped 120 LOC, 2 commits',
        toolCalls: [],
        subagentType: null,
      },
    ],
  },
  {
    id: 'e2e-outcome-cwd-missing',
    project: 'e2e-project-outcome-cwd-missing',
    cwd: '/Users/e2e/outcome-cwd-missing-does-not-exist',
    daysAgo: 1,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 600,
        output: 200,
        cacheRead: 1000,
        cacheCreation: 40,
        userPrompt: 'cwd-missing prompt',
        assistantText: 'cwd was deleted before evaluation',
        toolCalls: [],
        subagentType: null,
      },
    ],
  },
  {
    id: 'e2e-outcome-not-evaluated',
    project: 'e2e-project-outcome-pending',
    cwd: '/Users/e2e/outcome-pending',
    daysAgo: 1,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 500,
        output: 150,
        cacheRead: 800,
        cacheCreation: 30,
        userPrompt: 'pending prompt',
        assistantText: 'no outcome row yet',
        toolCalls: [],
        subagentType: null,
      },
    ],
  },
];

// effectiveness-personal-v2 spec — TASK-SMOKE seeds (TC-E2E-01..07).
//
// Adds six sessions prefixed `e2e-eff-v2-` to /effectiveness so that:
//   - ≥4 sessões com ratings  → scatter renders ≥3 `<circle>` (TC-E2E-03)
//   - ≥5 sessões com Edit/Write → funnel produces a non-empty Stage 2
//     (TC-E2E-04) and the 5-session minimum from `MIN_FUNNEL_SESSIONS` is
//     comfortably exceeded (REQ-21).
//   - ≥1 sessão com row em `compaction_events` → REQ-12/REQ-15 evidence
//     (TC-E2E-01 indirectly via aggregates).
//   - varied effectiveness scores spread across days → bipolar heatmap
//     palette (TC-E2E-05). Costs/cache/error mixes are tuned so the
//     scoring heuristic produces both low (rose) and high (emerald) days.
//   - daysAgo ∈ [0, 25] so every seed is inside the 30-day analytics
//     window queried by `/effectiveness`.
//
// Existing seeds (e2e-1, e2e-today, e2e-subagent, e2e-tool-trend, pagination
// fillers, outcome seeds) are preserved as-is. The new sessions deliberately
// use different project ids to avoid collisions with prior fixtures.
const EFFECTIVENESS_V2_SEEDS: readonly SeedSession[] = [
  {
    // Compaction-bearing session. Edit + good cache + low error → high score.
    id: 'e2e-eff-v2-compact',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 2,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1000,
        output: 400,
        cacheRead: 8000,
        cacheCreation: 100,
        userPrompt: 'plan the refactor',
        assistantText: 'reading then editing',
        toolCalls: [
          { name: 'Read', isError: false },
          { name: 'Read', isError: false },
        ],
      },
      {
        seq: 2,
        model: 'claude-sonnet-4-6',
        input: 1200,
        output: 600,
        cacheRead: 9000,
        cacheCreation: 50,
        userPrompt: 'apply edit',
        assistantText: 'edit applied',
        toolCalls: [
          { name: 'Edit', isError: false },
          { name: 'Edit', isError: false },
          { name: 'Read', isError: false },
        ],
      },
    ],
  },
  {
    // High-effectiveness session — drives an emerald cell in the heatmap.
    id: 'e2e-eff-v2-high',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 5,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 800,
        output: 300,
        cacheRead: 7000,
        cacheCreation: 80,
        userPrompt: 'green path',
        assistantText: 'all good',
        toolCalls: [
          { name: 'Read', isError: false },
          { name: 'Edit', isError: false },
          { name: 'Write', isError: false },
        ],
      },
    ],
  },
  {
    // Low-effectiveness session — high error rate, low cache → rose cell.
    id: 'e2e-eff-v2-low',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 8,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 5000,
        output: 200,
        cacheRead: 100,
        cacheCreation: 50,
        userPrompt: 'flailing',
        assistantText: 'errors everywhere',
        toolCalls: [
          { name: 'Bash', isError: true },
          { name: 'Bash', isError: true },
          { name: 'Bash', isError: true },
          { name: 'Bash', isError: true },
          { name: 'Edit', isError: true },
          { name: 'Read', isError: false },
        ],
      },
    ],
  },
  {
    // Mid-effectiveness — ensures we have ≥5 Edit-bearing sessions.
    id: 'e2e-eff-v2-mid-a',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 12,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1500,
        output: 500,
        cacheRead: 3000,
        cacheCreation: 100,
        userPrompt: 'mid run a',
        assistantText: 'ok',
        toolCalls: [
          { name: 'Read', isError: false },
          { name: 'MultiEdit', isError: false },
        ],
      },
    ],
  },
  {
    id: 'e2e-eff-v2-mid-b',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 15,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1200,
        output: 400,
        cacheRead: 2500,
        cacheCreation: 80,
        userPrompt: 'mid run b',
        assistantText: 'ok',
        toolCalls: [
          { name: 'Read', isError: false },
          { name: 'Edit', isError: false },
        ],
      },
    ],
  },
  {
    // 5th Edit-bearing session — guarantees the funnel's Started stage ≥ 5
    // and `WithEdit` stage ≥ 5 inside the e2e-eff-v2 group alone, even
    // before counting Edit-bearing sessions from earlier seeds.
    id: 'e2e-eff-v2-mid-c',
    project: 'e2e-project-eff-v2',
    cwd: '/Users/e2e/eff-v2',
    daysAgo: 20,
    turns: [
      {
        seq: 1,
        model: 'claude-sonnet-4-6',
        input: 1000,
        output: 350,
        cacheRead: 2000,
        cacheCreation: 60,
        userPrompt: 'mid run c',
        assistantText: 'ok',
        toolCalls: [
          { name: 'Write', isError: false },
        ],
      },
    ],
  },
];

// Ratings to seed AFTER turns are inserted (turn ids are deterministic:
// `${session.id}-t${seq}`). 4 distinct sessions get rated → scatter has
// ≥4 points (REQ-16 + TC-E2E-03). Ratings spread −1 / 0 / +1 vary the y
// axis so the regression line is non-degenerate.
const EFFECTIVENESS_V2_RATINGS: ReadonlyArray<{
  turnId: string;
  rating: -1 | 0 | 1;
}> = [
  { turnId: 'e2e-eff-v2-compact-t1', rating: 1 },
  { turnId: 'e2e-eff-v2-high-t1', rating: 1 },
  { turnId: 'e2e-eff-v2-low-t1', rating: -1 },
  { turnId: 'e2e-eff-v2-mid-a-t1', rating: 0 },
  { turnId: 'e2e-eff-v2-mid-b-t1', rating: 1 },
];

// Compaction events: 2 rows on the `e2e-eff-v2-compact` session covering
// REQ-12 (count > 0) and REQ-15 (`sessionsWithCompaction` > 0). PK is
// `(session_id, source_file, sequence_in_file)` so distinct
// `sequence_in_file` is the only requirement.
const EFFECTIVENESS_V2_COMPACTION: ReadonlyArray<{
  sessionId: string;
  sourceFile: string;
  sequenceInFile: number;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
}> = [
  {
    sessionId: 'e2e-eff-v2-compact',
    sourceFile: 'e2e://e2e-eff-v2-compact',
    sequenceInFile: 0,
    trigger: 'auto',
    preTokens: 18000,
    postTokens: 4000,
  },
  {
    sessionId: 'e2e-eff-v2-compact',
    sourceFile: 'e2e://e2e-eff-v2-compact',
    sequenceInFile: 1,
    trigger: 'manual',
    preTokens: 22000,
    postTokens: 5000,
  },
];

// Outcome rows seeded after the sessions are inserted. Keyed by session id.
// `null` means "intentionally no row" (TC-E2E-03).
type OutcomeSeed = {
  commitCount: number;
  locAdded: number;
  locRemoved: number;
  filesChanged: number;
  revertsWithin7d: number;
  mergedPrCount: number | null;
  status: 'evaluated' | 'cwd-missing' | 'not-a-git-repo' | 'no-user-email';
};

const OUTCOME_SEEDS: ReadonlyArray<{ sessionId: string; outcome: OutcomeSeed }> = [
  {
    sessionId: 'e2e-outcome-with-data',
    outcome: {
      commitCount: 2,
      locAdded: 120,
      locRemoved: 15,
      filesChanged: 3,
      revertsWithin7d: 1,
      mergedPrCount: null,
      status: 'evaluated',
    },
  },
  {
    sessionId: 'e2e-outcome-cwd-missing',
    outcome: {
      commitCount: 0,
      locAdded: 0,
      locRemoved: 0,
      filesChanged: 0,
      revertsWithin7d: 0,
      mergedPrCount: null,
      status: 'cwd-missing',
    },
  },
  // 'e2e-outcome-not-evaluated' deliberately absent — TC-E2E-03 asserts the
  // null-row branch of <SessionOutcomePanel>.
];

const DAY_MS = 86_400_000;

export default async function globalSetup(): Promise<void> {
  await seedE2EDatabase();
}

export async function seedE2EDatabase(): Promise<void> {
  const dbPath = path.resolve(__dirname, '../../data/e2e-test.db');
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(walPath)) fs.rmSync(walPath);
  if (fs.existsSync(shmPath)) fs.rmSync(shmPath);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openDbInline(dbPath);
  migrateInline(db);

  const insertSession = db.prepare(
    `INSERT INTO sessions (
       id, slug, cwd, project, git_branch, cc_version,
       started_at, ended_at,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, total_cost_usd_otel, turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (
       @id, @slug, @cwd, @project, @git_branch, @cc_version,
       @started_at, @ended_at,
       @total_input_tokens, @total_output_tokens,
       @total_cache_read_tokens, @total_cache_creation_tokens,
       @total_cost_usd, @total_cost_usd_otel, @turn_count, @tool_call_count,
       @source_file, @ingested_at
     )`
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (
       id, session_id, parent_uuid, sequence, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json,
       subagent_type
     ) VALUES (
       @id, @session_id, @parent_uuid, @sequence, @timestamp, @model,
       @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
       @cost_usd, @stop_reason, @user_prompt, @assistant_text, @tool_uses_json,
       @subagent_type
     )`
  );
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
     VALUES (@id, @turn_id, @tool_name, @input_json, @result_json, @result_is_error)`
  );
  const insertOutcome = db.prepare(
    `INSERT INTO session_outcomes (
       session_id, commit_count, loc_added, loc_removed, files_changed,
       reverts_within_7d, merged_pr_count, status, last_evaluated_at
     ) VALUES (
       @session_id, @commit_count, @loc_added, @loc_removed, @files_changed,
       @reverts_within_7d, @merged_pr_count, @status, @last_evaluated_at
     )`
  );
  // Ratings + compaction events drive the /effectiveness scatter and
  // sessionsWithCompaction aggregate respectively (effectiveness-personal-v2
  // TASK-SMOKE).
  const insertRating = db.prepare(
    `INSERT INTO ratings (turn_id, rating, note, rated_at)
     VALUES (@turn_id, @rating, @note, @rated_at)`
  );
  const insertCompactionEvent = db.prepare(
    `INSERT INTO compaction_events (
       session_id, source_file, sequence_in_file, trigger,
       pre_tokens, post_tokens, ts
     ) VALUES (
       @session_id, @source_file, @sequence_in_file, @trigger,
       @pre_tokens, @post_tokens, @ts
     )`
  );

  const now = Date.now();
  const allSessions: readonly SeedSession[] = [
    ...FIXED_SESSIONS,
    ...EFFECTIVENESS_V2_SEEDS,
  ];

  const tx = db.transaction(() => {
    for (const s of allSessions) {
      const startedAt = now - s.daysAgo * DAY_MS;
      const endedAt = startedAt + 30 * 60_000;

      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalCost = 0;
      let toolCallCount = 0;

      for (const t of s.turns) {
        totalInput += t.input;
        totalOutput += t.output;
        totalCacheRead += t.cacheRead;
        totalCacheCreation += t.cacheCreation;
        totalCost += computeCost({
          model: t.model,
          inputTokens: t.input,
          outputTokens: t.output,
          cacheReadTokens: t.cacheRead,
          cacheCreationTokens: t.cacheCreation,
        });
        toolCallCount += t.toolCalls.length;
      }

      // Give e2e-today an OTEL-authoritative cost so the badge shows up in
      // the E2E assertions. Value deliberately differs from the computed
      // local cost (~30% higher) so divergence display can be asserted too.
      const localCost = Math.round(totalCost * 1e6) / 1e6;
      const otelCost = s.id === 'e2e-today' ? localCost * 1.3 : null;
      insertSession.run({
        id: s.id,
        slug: null,
        cwd: s.cwd,
        project: s.project,
        git_branch: 'main',
        cc_version: '2.0.0',
        started_at: startedAt,
        ended_at: endedAt,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_cache_read_tokens: totalCacheRead,
        total_cache_creation_tokens: totalCacheCreation,
        total_cost_usd: localCost,
        total_cost_usd_otel: otelCost,
        turn_count: s.turns.length,
        tool_call_count: toolCallCount,
        source_file: `e2e://${s.id}`,
        ingested_at: now,
      });

      for (const t of s.turns) {
        const turnId = `${s.id}-t${t.seq}`;
        const turnCost = computeCost({
          model: t.model,
          inputTokens: t.input,
          outputTokens: t.output,
          cacheReadTokens: t.cacheRead,
          cacheCreationTokens: t.cacheCreation,
        });
        insertTurn.run({
          id: turnId,
          session_id: s.id,
          parent_uuid: null,
          sequence: t.seq,
          timestamp: startedAt + (t.seq - 1) * 60_000,
          model: t.model,
          input_tokens: t.input,
          output_tokens: t.output,
          cache_read_tokens: t.cacheRead,
          cache_creation_tokens: t.cacheCreation,
          cost_usd: turnCost,
          stop_reason: 'end_turn',
          user_prompt: t.userPrompt,
          assistant_text: t.assistantText,
          tool_uses_json: JSON.stringify(
            t.toolCalls.map((tc, idx) => ({ id: `${turnId}-tc${idx}`, name: tc.name }))
          ),
          subagent_type: t.subagentType ?? null,
        });
        t.toolCalls.forEach((tc, idx) => {
          insertToolCall.run({
            id: `${turnId}-tc${idx}`,
            turn_id: turnId,
            tool_name: tc.name,
            input_json: '{"seeded":true}',
            result_json: tc.isError ? '"error"' : '"ok"',
            result_is_error: tc.isError ? 1 : 0,
          });
        });
      }
    }

    // outcome-integration-git seeds — insert outcome rows for the two
    // sessions that exercise the populated + cwd-missing branches. The third
    // session ('e2e-outcome-not-evaluated') is intentionally NOT in
    // OUTCOME_SEEDS so its detail page falls into the "Outcome not yet
    // evaluated" branch.
    for (const seed of OUTCOME_SEEDS) {
      insertOutcome.run({
        session_id: seed.sessionId,
        commit_count: seed.outcome.commitCount,
        loc_added: seed.outcome.locAdded,
        loc_removed: seed.outcome.locRemoved,
        files_changed: seed.outcome.filesChanged,
        reverts_within_7d: seed.outcome.revertsWithin7d,
        merged_pr_count: seed.outcome.mergedPrCount,
        status: seed.outcome.status,
        last_evaluated_at: now,
      });
    }

    // effectiveness-personal-v2 — TASK-SMOKE seeds.
    for (const r of EFFECTIVENESS_V2_RATINGS) {
      insertRating.run({
        turn_id: r.turnId,
        rating: r.rating,
        note: null,
        rated_at: now,
      });
    }
    for (const c of EFFECTIVENESS_V2_COMPACTION) {
      insertCompactionEvent.run({
        session_id: c.sessionId,
        source_file: c.sourceFile,
        sequence_in_file: c.sequenceInFile,
        trigger: c.trigger,
        pre_tokens: c.preTokens,
        post_tokens: c.postTokens,
        ts: now,
      });
    }

    // Populate cost_calibration so the UI renders the "calibrated" badge for
    // sessions without OTEL. Derived from the e2e-today session which has
    // both otel + local; ratio ~= 1.3 (seed sets otel = 1.3 * local).
    const otelRow = db
      .prepare(
        "SELECT total_cost_usd, total_cost_usd_otel FROM sessions WHERE id = 'e2e-today'",
      )
      .get() as
      | { total_cost_usd: number; total_cost_usd_otel: number | null }
      | undefined;
    if (otelRow && otelRow.total_cost_usd_otel !== null && otelRow.total_cost_usd > 0) {
      const rate = otelRow.total_cost_usd_otel / otelRow.total_cost_usd;
      db.prepare(
        `INSERT INTO cost_calibration
          (family, effective_rate, sample_session_count, sum_otel_cost, sum_local_cost, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(family) DO UPDATE SET
           effective_rate = excluded.effective_rate,
           sample_session_count = excluded.sample_session_count,
           sum_otel_cost = excluded.sum_otel_cost,
           sum_local_cost = excluded.sum_local_cost,
           last_updated_at = excluded.last_updated_at`,
      ).run(
        'global',
        rate,
        1,
        otelRow.total_cost_usd_otel,
        otelRow.total_cost_usd,
        now,
      );
    }
  });
  tx();

  db.close();
}

// When invoked directly (`pnpm tsx tests/e2e/global-setup.ts`), seed the DB
// and exit. The Playwright webServer command chains this before starting
// `next dev`, because Playwright's `globalSetup` hook races the `webServer`
// (next dev boots and opens the DB before globalSetup finishes), leaving
// the dev server holding an FD on the pre-seed inode that globalSetup
// later deletes. Chaining via webServer command closes that race.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('global-setup.ts');
if (invokedDirectly) {
  seedE2EDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[global-setup] failed:', err);
      process.exit(1);
    });
}
