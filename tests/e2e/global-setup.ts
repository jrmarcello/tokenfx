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
        toolCalls: [],
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
        toolCalls: [],
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
];

const DAY_MS = 86_400_000;

export default async function globalSetup(): Promise<void> {
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
       total_cost_usd, turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (
       @id, @slug, @cwd, @project, @git_branch, @cc_version,
       @started_at, @ended_at,
       @total_input_tokens, @total_output_tokens,
       @total_cache_read_tokens, @total_cache_creation_tokens,
       @total_cost_usd, @turn_count, @tool_call_count,
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

  const now = Date.now();

  const tx = db.transaction(() => {
    for (const s of FIXED_SESSIONS) {
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
        total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
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
  });
  tx();

  db.close();
}
