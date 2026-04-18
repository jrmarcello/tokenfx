import { openDatabase } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { computeCost } from '@/lib/analytics/pricing';
import { log } from '@/lib/logger';

const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;
const PROJECTS = ['dashboard', 'cli-tool', 'api-service', 'docs-site'] as const;
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Glob'] as const;

const DAY_MS = 86_400_000;
const SESSION_COUNT = 10;

// Deterministic LCG so repeated runs produce identical data.
let seed = 42;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const randInt = (min: number, max: number): number =>
  Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

type TurnPlan = {
  turnId: string;
  seq: number;
  timestamp: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number;
  prompt: string;
  assistantText: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
};

function main(): number {
  try {
    const dbPath = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
    const db = openDatabase(dbPath);
    migrate(db);

    // Idempotent cleanup. ratings/tool_calls/turns cascade via FK, but clear
    // explicitly to be safe against older DBs that may predate FK enforcement.
    db.prepare('DELETE FROM ratings').run();
    db.prepare('DELETE FROM tool_calls').run();
    db.prepare('DELETE FROM turns').run();
    db.prepare("DELETE FROM sessions WHERE id LIKE 'seed-%'").run();

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
         cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
       ) VALUES (
         @id, @session_id, @parent_uuid, @sequence, @timestamp, @model,
         @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
         @cost_usd, @stop_reason, @user_prompt, @assistant_text, @tool_uses_json
       )`
    );
    const insertToolCall = db.prepare(
      `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
       VALUES (@id, @turn_id, @tool_name, @input_json, @result_json, @result_is_error)`
    );
    const insertRating = db.prepare(
      `INSERT INTO ratings (turn_id, rating, note, rated_at) VALUES (@turn_id, @rating, @note, @rated_at)`
    );

    const now = Date.now();
    let totalSessions = 0;
    let totalTurns = 0;
    let totalToolCalls = 0;
    let totalRatings = 0;

    for (let i = 0; i < SESSION_COUNT; i++) {
      const sessionId = `seed-${String(i + 1).padStart(3, '0')}`;
      const project = PROJECTS[i % PROJECTS.length] as string;
      const model = MODELS[i % MODELS.length] as string;
      const dayOffset = Math.floor((i * 29) / (SESSION_COUNT - 1)); // 0..29 spread
      const startedAt = now - dayOffset * DAY_MS - randInt(0, 6) * 3_600_000;
      const durationMin = randInt(15, 90);
      const endedAt = startedAt + durationMin * 60_000;
      const turnCount = randInt(3, 12);

      const hasTools = rand() < 0.4;
      const hasRating = rand() < 0.3;
      const hasCorrection = rand() < 0.2;
      const correctionTurn = hasCorrection ? Math.floor(turnCount / 2) : -1;

      const turns: TurnPlan[] = [];
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalCost = 0;
      let sessionToolCallCount = 0;

      for (let j = 0; j < turnCount; j++) {
        const input = randInt(500, 4_000);
        const output = randInt(100, 1_500);
        const cacheRead = randInt(200, 8_000);
        const cacheCreation = randInt(0, 500);
        const cost = computeCost({
          model,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
        });

        const prompt =
          j === correctionTurn
            ? 'não, corrige — this is wrong, please fix'
            : `Task step ${j + 1} for ${project}`;
        const assistantText = `Working on ${project} (turn ${j + 1})...`;

        const toolCalls: Array<{ name: string; isError: boolean }> = [];
        if (hasTools) {
          const n = randInt(1, 3);
          for (let k = 0; k < n; k++) {
            toolCalls.push({
              name: pick(TOOLS),
              isError: rand() < 0.1,
            });
          }
          sessionToolCallCount += toolCalls.length;
        }

        turns.push({
          turnId: `${sessionId}-t${j}`,
          seq: j + 1,
          timestamp: startedAt + Math.floor(((endedAt - startedAt) * j) / turnCount),
          model,
          input,
          output,
          cacheRead,
          cacheCreation,
          cost,
          prompt,
          assistantText,
          toolCalls,
        });

        totalInput += input;
        totalOutput += output;
        totalCacheRead += cacheRead;
        totalCacheCreation += cacheCreation;
        totalCost += cost;
      }

      const runTx = db.transaction(() => {
        insertSession.run({
          id: sessionId,
          slug: null,
          cwd: `/Users/seed/${project}`,
          project,
          git_branch: 'main',
          cc_version: '2.0.0',
          started_at: startedAt,
          ended_at: endedAt,
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_cache_read_tokens: totalCacheRead,
          total_cache_creation_tokens: totalCacheCreation,
          total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
          turn_count: turnCount,
          tool_call_count: sessionToolCallCount,
          source_file: `seed://${sessionId}`,
          ingested_at: now,
        });

        for (const t of turns) {
          insertTurn.run({
            id: t.turnId,
            session_id: sessionId,
            parent_uuid: null,
            sequence: t.seq,
            timestamp: t.timestamp,
            model: t.model,
            input_tokens: t.input,
            output_tokens: t.output,
            cache_read_tokens: t.cacheRead,
            cache_creation_tokens: t.cacheCreation,
            cost_usd: t.cost,
            stop_reason: 'end_turn',
            user_prompt: t.prompt,
            assistant_text: t.assistantText,
            tool_uses_json: JSON.stringify(
              t.toolCalls.map((tc, idx) => ({
                id: `${t.turnId}-tc${idx}`,
                name: tc.name,
              }))
            ),
          });

          t.toolCalls.forEach((tc, idx) => {
            insertToolCall.run({
              id: `${t.turnId}-tc${idx}`,
              turn_id: t.turnId,
              tool_name: tc.name,
              input_json: '{"seeded":true}',
              result_json: tc.isError ? '"error"' : '"ok"',
              result_is_error: tc.isError ? 1 : 0,
            });
            totalToolCalls += 1;
          });
        }

        if (hasRating && turns.length > 0) {
          const target = turns[randInt(0, turns.length - 1)] as TurnPlan;
          const ratingValue = pick([-1, 0, 1] as const);
          insertRating.run({
            turn_id: target.turnId,
            rating: ratingValue,
            note: null,
            rated_at: now,
          });
          totalRatings += 1;
        }
      });
      runTx();

      totalSessions += 1;
      totalTurns += turnCount;
    }

    db.close();

    log.info(
      `seed-dev: wrote ${totalSessions} sessions, ${totalTurns} turns, ${totalToolCalls} tool_calls, ${totalRatings} ratings (db=${dbPath})`
    );
    return 0;
  } catch (err) {
    log.error('seed-dev failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exit(main());
