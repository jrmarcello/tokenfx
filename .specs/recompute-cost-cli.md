# Spec: recompute-cost-cli

## Status: DONE

## Context

Estender o existing `scripts/recompute-costs.ts` (já 208 LOC, 3 modes funcionais: default = recompute `turns.cost_usd` from current pricing table + reconcile `sessions.total_cost_usd`; `--prefer-otel` = populate OTEL cost; `--recalibrate` = refresh calibration) com 3 ergonomias que faltam: filtros por escopo, dry-run preview, e registro em `package.json`.

**Por que estender vs rewrite**: o módulo existente tem integration tests passing (`tests/integration/recompute-costs.test.ts`) e cobre o core flow corretamente. Os 3 modes são battle-tested em prod (Fase 0 v2 followups + cost-calibration ship). Rewrite seria theatrical — mesmo end-state com risco de regressão nos modes existentes. Aditivos preservam confiança.

### Prior art e constraints

- **Default mode** (`recomputeTurnsDefault` em `scripts/recompute-costs.ts:64-113`): SELECT em TODAS as turns, recomputa via `computeCost()` do `lib/analytics/pricing.ts`, UPDATE quando `|new - old| > 5e-7` (epsilon float-safe). Idempotente. Chama `reconcileAllSessions(db)` no fim pra propagar pro `sessions.total_cost_usd`.
- **`--prefer-otel` mode**: idempotente, seletivo (só atualiza onde stored ≠ OTEL). NÃO toca `turns`.
- **`--recalibrate` mode**: chama `recomputeCostCalibration(db)`. NÃO toca `turns` nem `sessions.total_cost_usd`.
- **`sessions.total_cost_usd_otel`** é authoritative quando set — NUNCA tocado pelo default mode.
- **`reconcileAllSessions`** em `lib/ingest/reconcile.ts:146-152` faz `db.exec(...)` global (sem parâmetros, sem WHERE). **NÃO aceita scope** (confirmado via leitura do código). Precisa de variant filtrada.
- **`RecomputeSummary` existente** (preservar — quebrar contracts é regressão):

  ```ts
  type RecomputeSummary =
    | { mode: 'default'; total: number; updated: number; unchanged: number;
        zeroedBefore: number; zeroedAfter: number }
    | { mode: 'prefer-otel'; totalOtelSessions: number;
        updatedOtelCosts: number; unchangedOtelCosts: number }
    | { mode: 'recalibrate'; familiesWritten: number; skippedOutOfBounds: number };
  ```

- **Schema relevante**: `sessions.id` (TEXT PK), `sessions.started_at` (INTEGER ms epoch), `turns.session_id` (TEXT FK), `turns.cost_usd` (REAL). Index em `(session_id, sequence)` já garante per-session reads rápidos.
- **Existing tests** em `tests/integration/recompute-costs.test.ts`: 4 tests (default-recompute, prefer-otel-populates, prefer-otel-idempotent, prefer-otel-null-preservation). Comments referenciam labels `// TC-I-11..14` (internal numeração do arquivo — NÃO confundir com IDs desta spec).
- **CLI scripts pattern**: `scripts/ingest.ts`, `scripts/watch.ts`, `scripts/seed-dev.ts` — todos `tsx` direto, registrados em `package.json` como `"<name>": "tsx scripts/<file>.ts"`. Convenção `pnpm <name>`.
- **Logger**: `lib/logger.ts` é wrapper level-filtered console (não Pino). `log.info('recompute-costs', summary)` aceita variadic args; primeiro arg é message, demais são serializados via `console.info`.

### Decisões já travadas

- **Estender, não rewrite**: confirmado com usuário (response: "qualidade acima de tempo/custo" → Option 1).
- **Filtros mutuamente exclusivos** no modo default: `--all` OR `--since YYYY-MM-DD` OR `--session <ID>`. Exatamente um obrigatório no default mode. Sem nenhum: imprime usage + exit 1.
- **Backward compat / breaking change**: `tsx scripts/recompute-costs.ts` sem flags HOJE recomputa tudo. Pós-spec exige explicit `--all`. **Breaking change** — documentado em commit message + USAGE. Safer default que destructive default.
- **Package.json entry**: registrar APENAS `"recompute-cost": "tsx scripts/recompute-costs.ts"` (singular, nome alinhado com spec). NÃO registrar alias `"recompute-costs"` plural. Usuários invocando `tsx scripts/recompute-costs.ts` direto continuam funcionando (path inalterado).
- **`--session <ID>` e `--since <DATE>` aplicam apenas no default mode**: combinar com `--prefer-otel` ou `--recalibrate` → erro com hint. Razão: esses modes operam em OTEL/calibration data global, não em scope de sessions.
- **`--dry-run`**: aplicável em qualquer mode. Usa **subclass de Error** (não sentinel string) pra rollback determinístico (security/test review fix M6).
- **`reconcileAllSessions` extension**: cria nova função em `lib/ingest/reconcile.ts`:

  ```ts
  export const reconcileSessionsByIds = (
    db: DB,
    sessionIds: readonly string[],
  ): void;
  ```

  Itera `ROLLUP_ONE_SQL` (já existente) per ID. Reutiliza prepared statement. Sem novo SQL.
- **Summary shape extension**: preserva fields existentes (`zeroedBefore`/`zeroedAfter` em default; OTEL fields em `--prefer-otel`); adiciona OPCIONALMENTE `scope?: Scope` em `default` mode + `dryRun: boolean` em todos os modes:

  ```ts
  type RecomputeSummary =
    | { mode: 'default'; scope: Scope; dryRun: boolean;
        total: number; updated: number; unchanged: number;
        zeroedBefore: number; zeroedAfter: number }
    | { mode: 'prefer-otel'; dryRun: boolean;
        totalOtelSessions: number; updatedOtelCosts: number; unchangedOtelCosts: number }
    | { mode: 'recalibrate'; dryRun: boolean;
        familiesWritten: number; skippedOutOfBounds: number };
  ```

- **`Scope` type**: `{ kind: 'all' } | { kind: 'since'; sinceMs: number } | { kind: 'session'; id: string }`.
- **`--session` empty/whitespace**: empty string → `{ mode: 'error', reason: 'invalid-session' }`. Whitespace-only → ditto (trim then check). Sem soft-fail; erro explícito.
- **Leap year date validation**: regex `^\d{4}-\d{2}-\d{2}$` SOMENTE não é suficiente — `2025-02-29` passa regex mas V8 `Date.UTC(2025, 1, 29)` retorna ms válido (auto-rolls para `2025-03-01`). Validação adicional: round-trip check — `new Date(sinceMs).toISOString().slice(0, 10) === input`. Rejeita `2025-02-29`; aceita `2024-02-29`.
- **Unknown session ID** (existente em DB): `--session XXX` onde ID não existe → soft fail (reports "session not found"; exit 0). Re-run safety.
- **Logger output contract** (REQ-9): quando `dryRun: true`, summary log inclui prefix `[dry-run]` na message string. Permite grep simples + UX claro.
- **Manager DB safety**: NÃO há `--force` flag — `scripts/recompute-costs.ts` usa `getDb()` que respeita `DASHBOARD_DB_PATH`. Apps/server tem schema Postgres diferente e nem importa este script. Cross-pollution arquiteturalmente impossível.

## Requirements

- [ ] REQ-1: GIVEN `pnpm recompute-cost` sem args, WHEN executa, THEN imprime usage helper + exit 1.
- [ ] REQ-2: GIVEN `pnpm recompute-cost --all`, WHEN executa, THEN recomputa `turns.cost_usd` para TODAS as turns + reconcilia `sessions.total_cost_usd` (mesmo comportamento do default-mode atual sem flags). Idempotente. Preserva `total_cost_usd_otel`.
- [ ] REQ-3: GIVEN `pnpm recompute-cost --since YYYY-MM-DD`, WHEN executa AND date é parseable como UTC calendar date round-trip, THEN recomputa apenas turns de sessions WHERE `sessions.started_at >= sinceMs`. Reconcilia apenas essas sessions via `reconcileSessionsByIds`. Preserva `total_cost_usd_otel`.
- [ ] REQ-4: GIVEN `--since DATE` com date malformed (regex fail, calendar-invalid like `2025-02-29` non-leap, vazio), WHEN executa, THEN imprime erro descritivo + usage + exit 1.
- [ ] REQ-5: GIVEN `pnpm recompute-cost --session ID`, WHEN executa AND ID existe, THEN recomputa apenas as turns daquela session + reconcilia via `reconcileSessionsByIds([id])`. Reporta `total: N` (turns inspecionadas), `updated: M`, `unchanged: N-M`. Preserva `total_cost_usd_otel`.
- [ ] REQ-6: GIVEN `--session ID-NOT-IN-DB`, WHEN executa, THEN reporta "session ID not found; 0 affected" + exit 0 (idempotente — re-run safety).
- [ ] REQ-7: GIVEN dois ou mais filtros simultâneos (e.g., `--all --since 2026-04-01`, `--all --session X`, `--since DATE --session X`), WHEN executa, THEN imprime erro "filtros são mutuamente exclusivos" + usage + exit 1.
- [ ] REQ-8: GIVEN `--dry-run` adicionado a qualquer filtro válido (`--all`, `--since DATE`, `--session ID`, `--prefer-otel`, `--recalibrate`), WHEN executa, THEN NÃO faz UPDATEs persistentes (logic envolvida em transaction com explicit ROLLBACK via `DryRunRollback` subclass). Reporta o que SERIA atualizado nos counters.
- [ ] REQ-9: GIVEN `--dry-run` com qualquer mode, WHEN reporta summary via `log.info`, THEN a message string inclui prefix `[dry-run]` AND o summary object tem `dryRun: true`. Observable contract.
- [ ] REQ-10: GIVEN `--session ID` combinado com `--prefer-otel` OU `--recalibrate`, WHEN executa, THEN imprime erro "filtro --session só funciona com modo default" + usage + exit 1.
- [ ] REQ-11: GIVEN `--since DATE` combinado com `--prefer-otel` OU `--recalibrate`, WHEN executa, THEN imprime erro "filtro --since só funciona com modo default" + usage + exit 1.
- [ ] REQ-12: GIVEN qualquer execução em qualquer scope (`--all`, `--since DATE`, `--session ID`), WHEN `sessions.total_cost_usd_otel` está set non-NULL pré-run, THEN o valor permanece intocado pós-run. Em `--dry-run` mode também.
- [ ] REQ-13: GIVEN `package.json` scripts block, WHEN spec é commitada, THEN contém entry `"recompute-cost": "tsx scripts/recompute-costs.ts"` (singular). Sem alias retrocompat.
- [ ] REQ-14: GIVEN os 4 tests existentes em `tests/integration/recompute-costs.test.ts`, WHEN spec é shipped, THEN os 3 que testam `--prefer-otel`/OTEL paths continuam passing inalterados; o test que assertava default-mode-sem-flags é atualizado pra usar `--all` explicitamente (1 linha de mudança em test setup).
- [ ] REQ-15: GIVEN o helper `reconcileSessionsByIds(db, ids)` é exportado de `lib/ingest/reconcile.ts`, WHEN chamado com array de IDs válidos, THEN cada session listada tem seu rollup atualizado via existing `ROLLUP_ONE_SQL`. WHEN chamado com array vazio `[]`, THEN é no-op (não throw). Sessions fora da lista permanecem intocadas.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | edge | `parseArgs([])` (no flags) | returns `{ mode: 'error', reason: 'no-filter' }` |
| TC-U-02 | REQ-2 | happy | `parseArgs(['--all'])` | returns `{ mode: 'default', scope: { kind: 'all' }, dryRun: false }` |
| TC-U-03 | REQ-3 | happy | `parseArgs(['--since', '2026-04-01'])` | returns `{ mode: 'default', scope: { kind: 'since', sinceMs: Date.UTC(2026, 3, 1) }, dryRun: false }` |
| TC-U-04 | REQ-4 | validation | `parseArgs(['--since', '2026-13-99'])` (invalid month/day) | returns `{ mode: 'error', reason: 'invalid-date' }` |
| TC-U-05 | REQ-4 | validation | `parseArgs(['--since', 'not-a-date'])` | returns `{ mode: 'error', reason: 'invalid-date' }` |
| TC-U-06 | REQ-4 | validation | `parseArgs(['--since', ''])` (empty) | returns `{ mode: 'error', reason: 'invalid-date' }` |
| TC-U-07 | REQ-4 | validation | `parseArgs(['--since', '2026-2-1'])` (single-digit month/day — regex `\d{2}` rejeita) | returns `{ mode: 'error', reason: 'invalid-date' }` |
| TC-U-08 | REQ-5 | happy | `parseArgs(['--session', 'abc123'])` | returns `{ mode: 'default', scope: { kind: 'session', id: 'abc123' }, dryRun: false }` |
| TC-U-09 | REQ-7 | edge | `parseArgs(['--all', '--since', '2026-04-01'])` | returns `{ mode: 'error', reason: 'mutually-exclusive' }` |
| TC-U-10 | REQ-7 | edge | `parseArgs(['--all', '--session', 'X'])` | returns `{ mode: 'error', reason: 'mutually-exclusive' }` |
| TC-U-11 | REQ-7 | edge | `parseArgs(['--since', '2026-04-01', '--session', 'X'])` | returns `{ mode: 'error', reason: 'mutually-exclusive' }` |
| TC-U-12 | REQ-8 | happy | `parseArgs(['--all', '--dry-run'])` | returns `{ mode: 'default', scope: { kind: 'all' }, dryRun: true }` |
| TC-U-13 | REQ-8 | happy | `parseArgs(['--prefer-otel', '--dry-run'])` | returns `{ mode: 'prefer-otel', dryRun: true }` |
| TC-U-14 | REQ-8 | happy | `parseArgs(['--recalibrate', '--dry-run'])` | returns `{ mode: 'recalibrate', dryRun: true }` |
| TC-U-15 | REQ-10 | edge | `parseArgs(['--session', 'X', '--prefer-otel'])` | returns `{ mode: 'error', reason: 'incompatible-mode' }` |
| TC-U-16 | REQ-11 | edge | `parseArgs(['--since', '2026-04-01', '--prefer-otel'])` | returns `{ mode: 'error', reason: 'incompatible-mode' }` |
| TC-U-17 | REQ-3 | edge | `--since 2026-04-01` boundary check on sinceMs | `sinceMs === Date.UTC(2026, 3, 1)` exact ms |
| TC-U-18 | REQ-4 | validation | `parseArgs(['--since', '2024-02-29'])` (leap year valid) | returns `{ mode: 'default', scope: { kind: 'since', sinceMs: Date.UTC(2024, 1, 29) }, ... }` |
| TC-U-19 | REQ-4 | validation | `parseArgs(['--since', '2025-02-29'])` (non-leap, V8 silently rolls to Mar 1 — round-trip catches) | returns `{ mode: 'error', reason: 'invalid-date' }` |
| TC-U-20 | REQ-5 | validation | `parseArgs(['--session', ''])` (empty ID) | returns `{ mode: 'error', reason: 'invalid-session' }` |
| TC-U-21 | REQ-5 | validation | `parseArgs(['--session', '   '])` (whitespace-only) | returns `{ mode: 'error', reason: 'invalid-session' }` |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | DB com 3 sessions, 9 turns; mock `computeCost` retorna 2× original; `recomputeCosts({ scope: { kind: 'all' }, dryRun: false })` | turns.cost_usd dobrado em todos 9; sessions.total_cost_usd reconciliado via `reconcileSessionsByIds`; summary `{ mode: 'default', scope: { kind: 'all' }, dryRun: false, total: 9, updated: 9, unchanged: 0, zeroedBefore: 0, zeroedAfter: 0 }` |
| TC-I-02 | REQ-2 | idempotency | TC-I-01 + segundo run com mesmo state (pricing inalterado) | `summary.updated === 0`, `unchanged === 9` |
| TC-I-03 | REQ-3 | happy | 3 sessions A(started 2026-03-15), B(2026-04-01), C(2026-04-15); `--since 2026-04-01` + mock 2× pricing | apenas B + C turns dobradas; A intocada (turns.cost_usd preserved); reconcile chamado SOMENTE com IDs de B + C |
| TC-I-04 | REQ-3 | edge | `--since 2099-12-31` (futura) em DB com sessions | `summary.total === 0`, `updated === 0`, no crash |
| TC-I-05 | REQ-5 | happy | 3 sessions, `--session B.id` + mock 2× pricing | apenas B.turns recomputadas; A, C intocadas; summary `{ scope: { kind: 'session', id: B.id }, total: B.turns.length, updated: B.turns.length, ... }` |
| TC-I-06 | REQ-6 | edge | `--session does-not-exist` em DB com sessions | reports "session not found"; exit code 0; nothing written |
| TC-I-07 | REQ-8 | happy | TC-I-01 setup (3 sessions, 9 turns, 2× pricing mock) + `dryRun: true` | turns.cost_usd PERMANECEM old values; summary `{ dryRun: true, updated: 9, ... }` (would-update count); 0 ROW writes verified via `SELECT SUM(cost_usd) FROM turns` antes/depois unchanged |
| TC-I-08 | REQ-8 | idempotency | TC-I-07 segundo run com pricing igual ao stored | `summary.updated === 0`, dryRun ainda preservou estado |
| TC-I-09 | REQ-12 | regression | DB com session.total_cost_usd_otel set, run `--all` | total_cost_usd_otel inalterado pré/pós |
| TC-I-10 | REQ-12 | regression | DB com session.total_cost_usd_otel set, run `--all --dry-run` | total_cost_usd_otel inalterado |
| TC-I-11 | REQ-12 | regression | `--since DATE` + OTEL set em session no scope | total_cost_usd_otel inalterado pós-run |
| TC-I-12 | REQ-12 | regression | `--session ID` + OTEL set | total_cost_usd_otel inalterado |
| TC-I-13 | REQ-9 | infra | TC-I-07 setup + spy/intercept em `log.info` | spy.calls[0] message string contém `[dry-run]` AND summary object tem `dryRun: true` |
| TC-I-14 | REQ-2 | regression | Existing TC `recomputes turns.cost_usd and leaves total_cost_usd_otel untouched when flag absent` em `tests/integration/recompute-costs.test.ts` migrado pra usar `--all` explícito | passes |
| TC-I-15 | REQ-2 | regression | Existing TC `populates total_cost_usd_otel from scrapes and does not recompute turns when flag set` | passes unchanged |
| TC-I-16 | REQ-2 | regression | Existing TC `is idempotent — running --prefer-otel twice yields zero updates on the second run` | passes unchanged |
| TC-I-17 | REQ-2 | regression | Existing TC `leaves total_cost_usd_otel as NULL for sessions without any OTEL cost scrape` | passes unchanged |
| TC-I-18 | REQ-13 | infra | Read `package.json`; parse JSON (assert no throw); inspect `.scripts` | contains `"recompute-cost": "tsx scripts/recompute-costs.ts"` |
| TC-I-19 | REQ-1 | infra | Spawn `tsx scripts/recompute-costs.ts` (no args) via `child_process.spawnSync` | exitCode === 1; stdout/stderr contém `usage` |
| TC-I-20 | REQ-8 | edge | TC-I-07 + `PRAGMA integrity_check` pós-dry-run | retorna `'ok'` (no partial-page artifacts) |
| TC-I-21 | REQ-15 | happy | `reconcileSessionsByIds(db, [s1.id, s2.id])` em DB com 3 sessions | s1, s2 têm rollups atualizados; s3 intocada |
| TC-I-22 | REQ-15 | edge | `reconcileSessionsByIds(db, [])` | no-op, no throw |
| TC-I-23 | REQ-15 | edge | `reconcileSessionsByIds(db, ['nonexistent-id'])` | no-op, no throw (UPDATE WHERE id = ? com 0 rows affected) |
| TC-I-24 | REQ-2 | edge | DB sem turns; `recomputeCosts({ scope: { kind: 'all' }, dryRun: false })` | summary `{ total: 0, updated: 0, unchanged: 0 }`; no crash |
| TC-I-25 | REQ-3 | edge | `--since` at exact session boundary: session with `started_at === Date.UTC(2026, 3, 1)` AND `--since 2026-04-01` | session INCLUDED (>= comparison) |

## Design

### Architecture Decisions

**Estratégia**: refactor minimal de `scripts/recompute-costs.ts` — `parseArgs` rewrite (tagged union ParsedArgs), scope-filtered SELECT em `recomputeTurnsDefault`, `DryRunRollback` subclass para deterministic rollback, summary shape extension (preserva fields existentes). Nova função `reconcileSessionsByIds` em `lib/ingest/reconcile.ts`.

**Sub-design 1 — Args parsing**:

```ts
type Scope =
  | { kind: 'all' }
  | { kind: 'since'; sinceMs: number }
  | { kind: 'session'; id: string };

type ErrorReason =
  | 'no-filter'           // REQ-1
  | 'invalid-date'        // REQ-4
  | 'invalid-session'     // REQ-5 (empty/whitespace)
  | 'mutually-exclusive'  // REQ-7
  | 'incompatible-mode';  // REQ-10, REQ-11

type ParsedArgs =
  | { mode: 'default'; scope: Scope; dryRun: boolean }
  | { mode: 'prefer-otel'; dryRun: boolean }
  | { mode: 'recalibrate'; dryRun: boolean }
  | { mode: 'error'; reason: ErrorReason; detail?: string };
```

Date validation:

1. Regex `^\d{4}-\d{2}-\d{2}$` (rejeita single-digit, malformed).
2. Parse: `const ms = Date.UTC(yyyy, mm-1, dd)`.
3. **Round-trip check**: `new Date(ms).toISOString().slice(0, 10) === input` — rejeita `2025-02-29` (V8 rola para `2025-03-01`).

Session ID validation: trim then check length > 0.

**Sub-design 2 — Filtered turns SELECT** (em `recomputeTurnsDefault`):

3 prepared statements at module scope (cached, reused across calls):

```ts
// At module top
const turnsSelectAll = db.prepare(`SELECT t.id, ...cols FROM turns t`);
const turnsSelectSince = db.prepare(
  `SELECT t.id, ...cols FROM turns t
   JOIN sessions s ON s.id = t.session_id WHERE s.started_at >= ?`,
);
const turnsSelectBySession = db.prepare(
  `SELECT t.id, ...cols FROM turns t WHERE t.session_id = ?`,
);
```

Dispatch:

```ts
const rows = scope.kind === 'all' ? turnsSelectAll.all() as TurnRow[]
  : scope.kind === 'since' ? turnsSelectSince.all(scope.sinceMs) as TurnRow[]
  : turnsSelectBySession.all(scope.id) as TurnRow[];
```

Note: scripts são ephemeral processes, mas module-level prepare é convention do projeto e barato — manter o pattern. Caching via WeakMap-by-DB se a função for usada como library.

**Sub-design 3 — `reconcileSessionsByIds`**:

```ts
// lib/ingest/reconcile.ts
const ROLLUP_ONE_SQL = `
  UPDATE sessions SET total_cost_usd = (
    SELECT ROUND(COALESCE(SUM(cost_usd), 0) * 1e6) / 1e6
    FROM turns WHERE session_id = sessions.id
  )
  WHERE id = ?
`;

let rollupOneStmt: WeakMap<DB, Statement> | null = null;

export const reconcileSessionsByIds = (
  db: DB,
  sessionIds: readonly string[],
): void => {
  if (sessionIds.length === 0) return;
  // Reuse prepared statement per-DB
  const stmt = db.prepare(ROLLUP_ONE_SQL);
  const tx = db.transaction(() => {
    for (const id of sessionIds) stmt.run(id);
  });
  tx();
};
```

Sessions in input list have their `total_cost_usd` recomputed from their turns. Sessions NOT in list remain untouched. `total_cost_usd_otel` is never referenced.

**Sub-design 4 — Dry-run via subclass error**:

```ts
class DryRunRollback extends Error {
  constructor() { super('dry-run rollback'); this.name = 'DryRunRollback'; }
}

const executeWithDryRun = <T>(
  db: DB,
  dryRun: boolean,
  fn: () => T,
): T => {
  let result: T;
  const tx = db.transaction(() => {
    result = fn();
    if (dryRun) throw new DryRunRollback();
  });
  try {
    tx();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
    // Expected: dry-run rollback. `result` is set; transaction rolled back.
  }
  return result!;
};
```

Subclass `instanceof` check: impossible to collide with production errors. Greppable. Type-safe.

**Sub-design 5 — Summary log prefix**:

```ts
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === 'error') {
    log.error('recompute-costs', { error: parsed.reason });
    printUsage();
    process.exit(1);
  }
  const summary = recomputeCosts(parsed);
  const messagePrefix = parsed.dryRun ? '[dry-run] ' : '';
  log.info(`${messagePrefix}recompute-costs`, summary);
}
```

REQ-9 contract: when `dryRun: true`, the log message string includes `[dry-run]` prefix AND the summary object has `dryRun: true`. Both observable.

**Sub-design 6 — Existing test compat**:

Existing `tests/integration/recompute-costs.test.ts` has 4 tests. After spec:

- 1 test (default-mode) needs explicit `{ scope: { kind: 'all' } }` argument (REQ-14, REQ-2). One-line change in setup.
- 3 tests (prefer-otel + recalibrate) unchanged — they pass `{ preferOtel: true }` etc directly.

The internal `// TC-I-NN` comments in that file refer to its own numbering scheme and NOT to this spec's TC-IDs (TC-I-14..17 here are mappings of those existing tests).

### Files to Create

(nenhum — pure refactor + test additions)

### Files to Modify

- `scripts/recompute-costs.ts` — `parseArgs` rewrite, scope-filtered SELECTs at module scope, `DryRunRollback` subclass + `executeWithDryRun` wrapper, `recomputeCosts({ scope, dryRun })` signature, summary log prefix.
- `lib/ingest/reconcile.ts` — add `reconcileSessionsByIds(db, ids: readonly string[]): void` export.
- `tests/integration/recompute-costs.test.ts` — 1-line update to existing default-mode test; add ~13 new TCs (TC-I-01..13, TC-I-19..23 + TC-I-20/24/25).
- `tests/unit/recompute-costs-args.test.ts` (NEW) — TC-U-01..21 (arg parser unit tests, no DB).
- `package.json` — add `"recompute-cost": "tsx scripts/recompute-costs.ts"` no scripts block.

### Dependencies

Nenhuma dep externa nova. Reusa `zod` (já no projeto) opcionalmente pra date validation OR pure JS regex+round-trip (lock decision: pure JS — uma dep menos pra um regex trivial).

## Tasks

- [x] TASK-1: Adicionar `reconcileSessionsByIds` em `lib/ingest/reconcile.ts`.
  - files: `lib/ingest/reconcile.ts`, `lib/ingest/reconcile.test.ts` (if exists; else add)
  - tests: TC-I-21, TC-I-22, TC-I-23

- [x] TASK-IMPL: Refatorar `scripts/recompute-costs.ts` (parseArgs + scope SELECT + DryRunRollback + log prefix). Single task pra evitar 4 batches sequenciais em mesmo arquivo (collapse SHOULD-FIX do code-reviewer).
  - files: `scripts/recompute-costs.ts`, `tests/integration/recompute-costs.test.ts`, `tests/unit/recompute-costs-args.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-17, TC-I-19, TC-I-20, TC-I-24, TC-I-25
  - depends: TASK-1

- [x] TASK-PKG: Adicionar entry em `package.json` scripts.
  - files: `package.json`
  - tests: TC-I-18

## Parallel Batches

```text
Batch 1: [TASK-1]                          — reconcileSessionsByIds (no deps)
Batch 2: [TASK-IMPL, TASK-PKG]             — parallel: TASK-IMPL (depends TASK-1) toca scripts/+tests/;
                                              TASK-PKG (no deps) toca package.json; arquivos exclusivos.
```

**Shared-file analysis**:

- `lib/ingest/reconcile.ts` exclusive em TASK-1.
- `scripts/recompute-costs.ts` + `tests/integration/recompute-costs.test.ts` + `tests/unit/recompute-costs-args.test.ts` exclusive em TASK-IMPL.
- `package.json` exclusive em TASK-PKG.
- TASK-PKG não depende de TASK-1 nem TASK-IMPL (independent edit). Pode rodar em Batch 2 paralelo com TASK-IMPL via worktree OU inline (decisão na execução).

## Validation Criteria

- [ ] `pnpm typecheck` (root) passa
- [ ] `pnpm lint` (root) passa
- [ ] `pnpm test --run` (root) passa — adds ~46 novos TCs sobre baseline 1067; expected ~1113 passing
- [ ] **Anti-regression** `tests/integration/recompute-costs.test.ts` existing 4 TCs (3 sem mudança, 1 com `--all` flag explícito) continuam passing
- [ ] `pnpm recompute-cost` sem args imprime usage + exit code 1 (subprocess test verify)
- [ ] `pnpm recompute-cost --all --dry-run` em DB seed-dev: imprime `[dry-run]` prefix + count, NÃO modifica turns
- [ ] `pnpm recompute-cost --all` em DB seed-dev: modifica turns iff pricing changed (verify via SELECT SUM antes/depois)
- [ ] **Live validation**: seed DB com `pnpm seed-dev`; capture `SELECT SUM(cost_usd) FROM turns` initial; run `pnpm recompute-cost --all`; SUM idêntico (pricing inalterado entre runs = zero-update); run `--all --dry-run`; SUM ainda idêntico
- [ ] **Live validation breaking change**: `tsx scripts/recompute-costs.ts` sem flags AGORA imprime usage + exit 1 (NÃO recomputa silenciosamente)
- [ ] **Live PRAGMA integrity_check**: após `--all --dry-run`, `PRAGMA integrity_check` retorna `'ok'` (no partial-page artifacts)

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1] (2026-05-11 17:35)

Inline execution. `reconcileSessionsByIds(db, ids)` adicionada em `lib/ingest/reconcile.ts` reusando `getPrepared`. TDD: RED(3 fail/compile) → GREEN(3 pass). TCs cobrem happy path + array vazio + IDs inexistentes.

### Batch 2 [TASK-IMPL, TASK-PKG] (2026-05-11 17:45)

Inline sequencial (worktree creation falha local).

- **TASK-PKG**: 1-line addition em `package.json` (`"recompute-cost": "tsx scripts/recompute-costs.ts"`).
- **TASK-IMPL**: refactor de `scripts/recompute-costs.ts` (~280 LOC). Adicionado `parseArgs` exportado retornando `ParsedArgs` tagged union, `Scope` type, scope-filtered SELECT (`--all` / `--since DATE` / `--session ID`), `DryRunRollback` subclass de Error pra rollback determinístico, summary shape extendido preservando fields existentes (`zeroedBefore`/`zeroedAfter`), CLI dispatch via `main()` com `[dry-run]` prefix no log message. TDD: RED(23 unit fail) → GREEN(23 pass).
- Discovery durante implementação: `migrate()` chama `reconcileAllSessions(db)` automaticamente, que reseta `sessions.started_at = MIN(turns.timestamp)`. Quebrava `--since` tests onde turn.timestamp < seeded session.started_at. Fix: `seedTurnSimple` agora alinha timestamp ao session.started_at por default.

Validação:

- `pnpm typecheck` clean.
- `pnpm test --run` (root): 1111/1111 (1 flaky watcher na primeira run; passou no retry).
- Unit tests (parseArgs): 23/23.
- Integration tests (recompute-cost-cli): 22/22 (incluindo 4 existing prefer-otel/recalibrate inalterados).
- Live validation:
  - `pnpm recompute-cost` (no args) → exit 1 + usage.
  - `pnpm recompute-cost --all --dry-run` em data/dashboard.db local: reporta `[dry-run]` + `would update 26224 turns`; `SELECT SUM(cost_usd) FROM turns` antes/depois = 29234.219025 (idêntico — rollback efetivo).
  - `pnpm recompute-cost --since 2026-04-01 --dry-run` aceita, processa filtrado.
  - `pnpm recompute-cost --since 2025-02-29` (non-leap year) → exit 1 (round-trip catches V8 roll).
