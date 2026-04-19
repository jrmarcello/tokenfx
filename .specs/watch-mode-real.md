# Spec: Watch mode real — ingestão push-based via chokidar

## Status: DONE

## Context

Hoje a ingestão é **pull-based**: cada `Server Component` renderiza e chama `ensureFreshIngest()` em `app/**/page.tsx`. Isso funciona mas tem três custos ao vivo:

1. **Latência**: a sessão ativa do Claude Code está gravando no `.jsonl` em tempo real, mas o dashboard só pega quando o usuário refresha a página. Pra monitorar uma sessão de 1000+ turnos em andamento (como a devtools-observability), isso é frustrante.
2. **Overhead por page load**: mesmo com o per-file mtime gate, cada navegação faz `stat()` em N arquivos. Barato, mas inútil quando nada mudou.
3. **Ponto único de ingestão**: Playwright E2E precisa de `TOKENFX_DISABLE_AUTO_INGEST=1` pra não ingerir transcripts reais nos testes — mas o próprio mecanismo é o que precisamos desativar, não substituir.

A substituição natural: **push-based** via `chokidar` observando `~/.claude/projects/**/*.jsonl`. Quando um novo arquivo aparece ou um existente cresce, o watcher ingesta aquele arquivo específico — sem esperar page load. O `ensureFreshIngest` fica como fallback quando o watcher está desligado.

O watcher roda dentro do processo Next.js via `instrumentation.ts` (Next 16 hook de boot do server). Alternativa: `pnpm watch` como standalone CLI pra cenários onde o usuário quer ingestão viva sem UI rodando (ex: pipeline de backfill em terminal).

### Decisões já travadas (locked antes da implementação)

- **Opt-in por flag** `TOKENFX_WATCH_MODE=1`. Default OFF — migração gradual sem quebrar o fluxo atual.
- **Dependência**: `chokidar@^4.x` (estável, maintained). Node ≥ 20 compat. Import **dinâmico** (`await import('chokidar')`) dentro do `register()` pra não carregar no build estático.
- **Config chokidar**: `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }`, `followSymlinks: false`, `ignored: /(^|[/\\])\../` (sem dotfiles). Trade-off: latência end-to-end ≈ 500ms-1.5s entre `write()` do Claude Code e dashboard atualizado. Aceitável pra "live"; reduzir o `stabilityThreshold` gera double-ingestions.
- **Startup order (NÃO-BLOQUEANTE)**: `register()` retorna imediatamente. Backfill via `ingestAll()` roda em background (`.catch(log.error)`) concorrente com o spawn do watcher. Evita travar o boot do Next por 40s em cold start com backlog grande. Eventos de `change` durante o backfill são idempotentes (ON CONFLICT DO UPDATE).
- **Per-file serialization**: `Map<absolutePath, Promise>` encadeia events do mesmo arquivo. Eventos em arquivos diferentes rodam em paralelo.
- **Helper compartilhado** `ingestSingleFile(db, absPath)` extraído do loop interno de `ingestAll()` — reusa `parseTranscriptFile` + `writeSession` + atualização de `ingested_files`. Watcher chama esse helper por evento; `ingestAll()` passa a chamá-lo no loop. DRY.
- **Entrypoint testável** `startWatcherIfEnabled(env)` como função pura recebendo `NodeJS.ProcessEnv` (ou similar), retornando `WatcherHandle | null`. `instrumentation.ts.register()` é só o glue (`startWatcherIfEnabled(process.env)`).
- **HMR idempotência**: `globalThis.__tokenfxWatcher` detecta watcher existente; close + recreate em recompile.
- **Shutdown**: `process.on('SIGINT' | 'SIGTERM' | 'beforeExit', ...)` fecha `chokidar.close()` e aguarda queue drenar.
- **Coexistência com auto-ingest-on-page-load**: `ensureFreshIngest()` verifica se o watcher está rodando (via `globalThis.__tokenfxWatcher?.running === true`) — se sim, vira no-op imediato. Idempotente.
- **E2E**: `TOKENFX_DISABLE_AUTO_INGEST=1` desabilita AMBOS (watcher + on-page). Mesma flag, duas intenções.
- **Path validation**: cada evento passa por `resolveWithinClaudeProjects(path)` pra rejeitar symlink escape.
- **CLI `pnpm watch`**: script standalone em `scripts/watch.ts`. Reusa `startWatcher`; log uniforme `[watch]` (sem prefixo especial). `SIGINT` → close limpo.
- **Telemetria**: `log.info` em startup (`[watch] ready — watching <root> (N files)`), cada `add`/`change` (`[watch] <event> <path> → X turns, Y tool_calls`), cada `error` (`[watch] error on <file>: ...`).

## Requirements

- [ ] **REQ-1**: GIVEN `TOKENFX_WATCH_MODE=1` WHEN Next.js boot chama `instrumentation.ts.register()` THEN (a) `ingestAll()` é disparado em background (`.catch(log.error)`) pra drenar o backlog — **register() não aguarda**; (b) um `chokidar` watcher é spawned observando `~/.claude/projects/**/*.jsonl` com `ignoreInitial: true`; (c) `log.info` registra `[watch] ready — watching <root> (N files)` (N = contagem imediata, sem esperar backfill).

- [ ] **REQ-2**: GIVEN `TOKENFX_WATCH_MODE` não está setado (ou ≠ `"1"`) WHEN `register()` executa THEN nenhum watcher é criado. Log silencioso (sem ruído pros usuários que não opt-in).

- [ ] **REQ-3**: GIVEN `TOKENFX_DISABLE_AUTO_INGEST=1` WHEN `register()` executa THEN o watcher **não** é criado mesmo se `TOKENFX_WATCH_MODE=1` estiver setado. A flag de disable tem precedência (E2E respeita).

- [ ] **REQ-4**: GIVEN o watcher está ativo AND um novo arquivo `.jsonl` é criado em `~/.claude/projects/<project>/` WHEN `chokidar` emite `add` THEN (a) o path passa por `resolveWithinClaudeProjects`; (b) se válido, `parseTranscriptFile` + `writeSession` são chamados; (c) `log.info` registra `[watch] add <abs-path> → N turns, M tool_calls`.

- [ ] **REQ-5**: GIVEN um arquivo já watched recebe append (Claude Code continuou a sessão) WHEN `awaitWriteFinish` dispara `change` THEN o mesmo pipeline do REQ-4 roda. O `INSERT ... ON CONFLICT DO UPDATE` no writer garante idempotência por `turn.id`.

- [ ] **REQ-6**: GIVEN dois eventos (`add` + `change`, ou `change` + `change`) chegam pro mesmo arquivo em <500ms WHEN o `awaitWriteFinish` + per-file queue processam THEN só uma execução de `parseTranscriptFile` completa e outras ficam na fila por arquivo — eventos em arquivos **diferentes** continuam em paralelo.

- [ ] **REQ-7**: GIVEN um evento aponta pra path fora de `~/.claude/projects/` (symlink escape) WHEN `resolveWithinClaudeProjects` lança THEN o watcher registra `log.warn` e **não** tenta parsear. Não derruba o watcher.

- [ ] **REQ-8**: GIVEN `parseTranscriptFile` retorna `{ok: false, ...}` (JSON inválido, schema mismatch) WHEN o handler processa THEN `log.warn` + continue. Watcher sobrevive.

- [ ] **REQ-9**: GIVEN `writeSession` lança exceção (DB corrompido, FK violation) WHEN o handler processa THEN `log.error` + continue. Watcher sobrevive.

- [ ] **REQ-10**: GIVEN um arquivo `.jsonl` é deletado do filesystem WHEN `chokidar` emite `unlink` THEN o handler **não** apaga do DB (preserva histórico). `log.info` opcional `[watch] unlink <file> — retained in DB`.

- [ ] **REQ-11**: GIVEN o watcher está ativo WHEN `ensureFreshIngest()` é chamado (por qualquer Server Component) THEN ele detecta `globalThis.__tokenfxWatcher?.running === true` e retorna imediatamente (no-op). Sem stat() de 400 arquivos por page load.

- [ ] **REQ-12**: GIVEN o processo do Next.js em dev mode recompila (HMR) WHEN `register()` é invocado novamente THEN (a) o watcher existente é fechado via `chokidar.close()`; (b) a queue per-file atual drena antes de recriar; (c) um novo watcher é criado com o mesmo estado inicial. Sem watcher fantasma.

- [ ] **REQ-13**: GIVEN o processo recebe `SIGINT`/`SIGTERM`/`beforeExit` WHEN o handler de shutdown executa THEN o watcher fecha e a queue per-file drena. Graceful shutdown com timeout de 2s; após isso, force-exit.

- [ ] **REQ-14**: GIVEN `pnpm watch` é executado WHEN o CLI inicia THEN usa o mesmo módulo `startWatcher` (reusa código) e loga `[watch] ready — …` (mesmo prefixo; CLI não adiciona um `[watch-cli]` separado). `Ctrl+C` fecha limpo (REQ-13). `TOKENFX_WATCH_MODE` não é exigido no CLI — o próprio comando implica intent.

- [ ] **REQ-15**: O watcher **nunca** observa filesystem fora do path validado. Mesmo em caso de `chokidar.watch('**/*.jsonl')` com base fora do root, a path validation por evento (REQ-7) garante a invariant.

- [ ] **REQ-16**: GIVEN o singleton `globalThis.__tokenfxWatcher` já existe ao chamar `register()` WHEN sem HMR (double boot acidental em produção) THEN o segundo `register()` detecta e no-op-a com `log.warn`. Previne dois watchers em paralelo no mesmo processo.

- [ ] **REQ-17**: Telemetria mínima — para cada evento processado, incluir no log o path (absolute), counts de `turnsUpserted` e `toolCallsUpserted`. Formato estável `[watch] <event> <path> → X turns, Y tool_calls` para grep.

- [ ] **REQ-18**: GIVEN `claudeProjectsRoot()` retorna um path que **não existe** no filesystem WHEN `startWatcher()` é chamado THEN (a) não lança; (b) `log.warn` registra `[watch] root not found: <path> — watcher idle`; (c) watcher fica em `running: false`; (d) coexistência: `ensureFreshIngest` detecta `running !== true` e funciona normalmente (sem short-circuit).

- [ ] **REQ-19**: Helper `ingestSingleFile(db, absPath)` é exportado de `lib/ingest/writer.ts` e reutilizado tanto pelo loop interno de `ingestAll()` quanto pelos handlers de `add`/`change` do watcher. Deduplica o caminho "parse + writeSession + upsert em `ingested_files`".

## Test Plan

### Unit Tests — `lib/ingest/watcher.ts` (helpers puros)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-6 | happy | `enqueue(path, fn)` — 3 calls no mesmo path serializam (promise chain) | fn resolvidas em ordem |
| TC-U-02 | REQ-6 | happy | `enqueue(pathA, slowFn)` + `enqueue(pathB, fastFn)` | pathB completa antes de pathA terminar (paralelo entre paths) |
| TC-U-03 | REQ-6 | edge | `enqueue(path, fn)` — fn rejeita, próxima chamada no mesmo path ainda roda | chain não trava |
| TC-U-04 | REQ-2 | validation | `shouldStart({ watchMode: undefined })` | `false` |
| TC-U-05 | REQ-1 | validation | `shouldStart({ watchMode: '1' })` | `true` |
| TC-U-06 | REQ-3 | validation | `shouldStart({ watchMode: '1', disableAutoIngest: '1' })` | `false` (disable > watch) |
| TC-U-07 | REQ-1 | edge | `shouldStart({ watchMode: '0' })` | `false` (estritamente `'1'`) |
| TC-U-08 | REQ-1 | edge | `shouldStart({ watchMode: 'true' })` | `false` (evita strings truthy ambíguas) |
| TC-U-09 | REQ-11 | happy | `isWatcherRunning()` com `globalThis.__tokenfxWatcher.running = true` | `true` |
| TC-U-10 | REQ-11 | happy | `isWatcherRunning()` sem singleton | `false` |
| TC-U-11 | REQ-11 | edge | `isWatcherRunning()` com `running = false` | `false` |

### Integration Tests — `lib/ingest/watcher.test.ts`

Usa tmp dir + `chokidar` real + in-memory DB.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-4 | happy | `startWatcher({ root: tmp, db })`; escrever `new.jsonl` | 1 turn ingerido em ≤2s após write |
| TC-I-02 | REQ-5 | happy | `startWatcher`; arquivo existente ganha append via `fs.appendFile` | re-ingerido; turns_upserted ≥ 1 |
| TC-I-03 | REQ-10 | edge | `startWatcher`; `fs.unlinkSync(file)` | DB row ainda existe; log.info emitido |
| TC-I-04 | REQ-8 | infra | arquivo `.jsonl` com JSON inválido | log.warn, watcher.running === true |
| TC-I-05 | REQ-7 | security | chamar o handler interno de `add` diretamente (exportado pra teste) com um path fora do root — simula chokidar devolvendo path escape | handler rejeita via `resolveWithinClaudeProjects`; log.warn; nenhum write no DB |
| TC-I-06 | REQ-6 | edge | 10 appends ao mesmo arquivo em 1s | queue serializa; zero erros; contagem final igual a append final |
| TC-I-07 | REQ-13 | happy | `startWatcher` → `watcher.stop()` → criar arquivo após stop | arquivo **não** ingerido (watcher parou) |
| TC-I-08 | REQ-12 | idempotency | `startWatcher` 2x; segundo fecha o primeiro | só 1 watcher ativo; queue drenada limpa |
| TC-I-09 | REQ-16 | idempotency | `globalThis.__tokenfxWatcher` já preenchido; chamar `startWatcher` | retorna existing; log.warn sobre double-register |
| TC-I-10 | REQ-4 | happy | `.jsonl` novo em subdiretório `project-x/`, caminho absoluto no evento | ingestão OK, log com path absoluto |
| TC-I-11 | REQ-1, REQ-4 | infra | chokidar emite `error` event (simulável injetando um erro no EventEmitter) | `log.error` registrado, watcher.running permanece `true` |
| TC-I-12b | REQ-9 | infra | `writeSession` lança (mock injetado via spy throwing); handler recebe evento válido | `log.error`, watcher.running === true, próximo evento no mesmo arquivo ainda é processado |
| TC-I-12c | REQ-18 | edge | `startWatcher({ root: '/nonexistent-xyz-123' })` | não lança; watcher.running === false; log.warn emitido |
| TC-I-12d | REQ-19 | happy | `ingestSingleFile(db, validPath)` chama parse+write; `ingestAll` usa internamente | ambos fluxos produzem mesmas rows no DB |

### Integration — `instrumentation.ts` + `lib/ingest/auto.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-12 | REQ-2 | validation | `TOKENFX_WATCH_MODE` unset; chamar `register()` | não cria watcher; `globalThis.__tokenfxWatcher` undefined |
| TC-I-13 | REQ-3 | validation | `TOKENFX_WATCH_MODE=1 TOKENFX_DISABLE_AUTO_INGEST=1`; `register()` | não cria watcher |
| TC-I-14 | REQ-1 | happy | `TOKENFX_WATCH_MODE=1`; `register()` | singleton criado, `running === true` |
| TC-I-15 | REQ-11 | happy | com singleton rodando, `ensureFreshIngest()` | retorna cedo sem tocar no DB |
| TC-I-16 | REQ-11 | edge | singleton presente mas `running === false` (parado) → `ensureFreshIngest()` | executa normalmente (watcher não está confiável) |
| TC-I-17 | REQ-14 | happy | `scripts/watch.ts` invocado via `tsx` subprocess; aguardar `[watch] ready` no stdout; matar processo | exit code 0 (shutdown limpo após SIGTERM) |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1, REQ-4, REQ-11 | happy | Start dev server com `TOKENFX_WATCH_MODE=1` apontando pro tmp dir; abrir `/sessions`; append um transcript ao tmp dir; sem refresh, fazer nova request → deve aparecer | nova sessão visível sem `pnpm ingest` manual |

*Nota E2E*: Playwright hoje seta `TOKENFX_DISABLE_AUTO_INGEST=1` (REQ-3 já cobre o disable). Este TC **exige um harness dedicado** — não roda no batch E2E normal. Executado manualmente na Checkpoint 2.

## Design

### Architecture Decisions

1. **Watcher singleton por processo.** `globalThis.__tokenfxWatcher: { running: boolean; stop: () => Promise<void> }`. Sobrevive à HMR do Next (register re-runs), mas o código detecta double-register + fecha o antigo antes de criar o novo.

2. **`instrumentation.ts` no root do projeto.** Next 16 carrega ele automaticamente quando presente. Export: `export async function register() { ... }`. Runs once per server boot (with HMR re-invocation in dev).

3. **Ordem de boot (non-blocking)**: (a) `register()` importa `startWatcherIfEnabled(process.env)`; (b) função lê envs via `shouldStart()`; (c) se habilitado, cria `chokidar.watch(...)` com `ignoreInitial: true` **primeiro**; (d) `ingestAll()` é disparado em background (`.catch(log.error)`) — register() não aguarda; (e) registra shutdown hooks. O watcher pode receber eventos de `change` durante o backfill — idempotência do writer (ON CONFLICT DO UPDATE) cobre qualquer overlap.

4. **`chokidar` config concreta**:

    ```ts
    const { watch } = await import('chokidar'); // dynamic — keeps static build clean
    watch(claudeProjectsRoot(), {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: /(^|[/\\])\../, // dotfiles
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });
    ```

    Observa recursivamente (`chokidar` default). Filtra `.jsonl` no handler porque o glob pattern com `**/*.jsonl` reduz performance em dirs grandes.

    **Trade-off documentado**: `stabilityThreshold: 500` cria latência mínima ~500ms entre Claude Code `write()` e ingestão — peça da aposta "live mas não real-time absoluto". Baixar esse valor dispara double-events por write parcial (Claude Code escreve linhas + newline separadamente). Aceito.

5. **Per-file queue (serialização por path)**:

    ```ts
    const queue = new Map<string, Promise<void>>();
    function enqueue(path: string, task: () => Promise<void>): Promise<void> {
      const prev = queue.get(path) ?? Promise.resolve();
      const next = prev.then(task).catch((err) => {
        log.error(`[watch] task failed on ${path}:`, err);
      });
      queue.set(path, next);
      // cleanup: remove when the chain settles AND no one else appended
      next.finally(() => { if (queue.get(path) === next) queue.delete(path); });
      return next;
    }
    ```

    Paths diferentes → promessas independentes → paralelismo natural.

6. **Coexistência com `ensureFreshIngest`**:

    ```ts
    // lib/ingest/auto.ts (modificado)
    export async function ensureFreshIngest(): Promise<void> {
      if (process.env.TOKENFX_DISABLE_AUTO_INGEST === '1') return;
      if (isWatcherRunning()) return; // watcher is authoritative
      // ... existing logic
    }
    ```

7. **HMR idempotência**:

    ```ts
    declare global {
      // eslint-disable-next-line no-var
      var __tokenfxWatcher: WatcherHandle | undefined;
    }
    if (globalThis.__tokenfxWatcher?.running) {
      await globalThis.__tokenfxWatcher.stop();
    }
    globalThis.__tokenfxWatcher = handle;
    ```

8. **Shutdown**:

    ```ts
    const shutdown = async () => {
      if (!globalThis.__tokenfxWatcher?.running) return;
      await Promise.race([
        globalThis.__tokenfxWatcher.stop(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('beforeExit', shutdown);
    ```

9. **CLI `pnpm watch`**: `scripts/watch.ts` importa `startWatcher` do mesmo módulo, seta `running=true`, `process.on('SIGINT', ...)` handler. Não precisa `TOKENFX_WATCH_MODE` — intent é o comando.

10. **Path validation**:

    ```ts
    try {
      const safe = resolveWithinClaudeProjects(rawPath);
      if (!safe.endsWith('.jsonl')) return;
      // ... ingest safe
    } catch {
      log.warn(`[watch] rejected (escape): ${rawPath}`);
    }
    ```

11. **Telemetria** — formato estável pra grep:

    - Startup: `[watch] ready — watching <root> (N existing files backfilled)`
    - Add/Change: `[watch] <event> <abs-path> → X turns, Y tool_calls` (X+Y vêm do `IngestSummary` retornado)
    - Error de handler: `[watch] handler error on <path>: <msg>`
    - Unlink: `[watch] unlink <path> — retained in DB`
    - HMR: `[watch] recompile detected, recreating watcher`

### Files to Create

- `instrumentation.ts` (root do projeto) — `export async function register()` chama `startWatcherIfEnabled(process.env)`. Glue thin, sem lógica testável; toda a decisão está em `watcher.ts`.
- `lib/ingest/watcher.ts` — exports: `startWatcher(opts)`, `startWatcherIfEnabled(env)`, `isWatcherRunning()`, `shouldStart(env)`, `enqueue(path, fn)`, tipos `WatcherHandle`, `WatcherOptions`.
- `lib/ingest/watcher.test.ts` — TCs TC-U-01..11 + TC-I-01..12d (mix de unit + integration usando tmp dir + chokidar real + in-memory DB).
- `scripts/watch.ts` — CLI standalone (`tsx`), mesmas opts do watcher + graceful SIGINT + prefixo `[watch]` (não `[watch-cli]`).
- `tests/integration/instrumentation.test.ts` — TCs TC-I-12..14 (testa `startWatcherIfEnabled(env)` diretamente — import Next's `instrumentation.ts` do Vitest não executa o hook).
- `tests/integration/watch-cli.test.ts` — TC-I-17 (spawn `pnpm watch` como child process + SIGTERM).

### Files to Modify

- `lib/ingest/writer.ts` — extrair `ingestSingleFile(db, absPath, opts?)` do loop de `ingestAll`; `ingestAll` passa a reusá-lo. Exportar.
- `lib/ingest/auto.ts` — `ensureFreshIngest` retorna early quando `isWatcherRunning()`.
- `lib/ingest/auto.test.ts` (criar se não existir) — TCs TC-I-15, 16.
- `package.json` — `scripts.watch: "tsx scripts/watch.ts"`; nova dep `chokidar@^4.0.0`.
- `README.md` — seção "Modo watch" documentando `TOKENFX_WATCH_MODE=1` e `pnpm watch`.
- `CLAUDE.md` — atualizar seção "Common Commands" com `pnpm watch`.

### Dependencies

**Nova**: `chokidar@^4.x` (peer-dep nenhuma; `glob`/`fsevents` como optional). Size: ~2MB transitivo. Stable, maintained (paulmillr). Alternativas consideradas: Node `fs.watch` (menos robusto em macOS/Linux corner cases); `nodemon` (overkill).

## Tasks

- [x] **TASK-1**: Helpers puros em `lib/ingest/watcher.ts` — `shouldStart(env)`, `enqueue(path, fn)`, `isWatcherRunning()`. Testes TC-U-01..11.
  - files: lib/ingest/watcher.ts, lib/ingest/watcher.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11

- [x] **TASK-2**: Dep `chokidar@^4.0.0` — adicionar em `package.json`, rodar `pnpm install`. Adicionar `scripts.watch`.
  - files: package.json, pnpm-lock.yaml

- [x] **TASK-2.5**: Extrair `ingestSingleFile(db, absPath, opts?)` de `lib/ingest/writer.ts` — refatora o loop interno de `ingestAll` pra reusar o helper. Testes existentes de writer permanecem verdes; adicionar TC-I-12d que confirma equivalência entre fluxos.
  - files: lib/ingest/writer.ts, lib/ingest/writer.test.ts
  - depends: TASK-2
  - tests: TC-I-12d

- [x] **TASK-3**: Implementação principal — `startWatcher(opts)` em `lib/ingest/watcher.ts`. Config chokidar da Design §4, singleton via `globalThis.__tokenfxWatcher`, handlers `add`/`change`/`unlink`/`error` conforme REQs 4-10, shutdown hooks REQ-13. Backfill via `ingestAll` **em background** (REQ-1 non-blocking). Import dinâmico de chokidar. Reusa `ingestSingleFile` do TASK-2.5. Testes TC-I-01..12c.
  - files: lib/ingest/watcher.ts, lib/ingest/watcher.test.ts
  - depends: TASK-1, TASK-2.5
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12b, TC-I-12c

- [x] **TASK-4**: `instrumentation.ts` — `export async function register()` chama `startWatcherIfEnabled()` com as envs. HMR-safe via singleton check.
  - files: instrumentation.ts, tests/integration/instrumentation.test.ts
  - depends: TASK-3
  - tests: TC-I-12, TC-I-13, TC-I-14

- [x] **TASK-5**: Coexistência — `lib/ingest/auto.ts` `ensureFreshIngest` checa `isWatcherRunning()`. Testes TC-I-15, 16.
  - files: lib/ingest/auto.ts, lib/ingest/auto.test.ts (criar se não existir)
  - depends: TASK-3
  - tests: TC-I-15, TC-I-16

- [x] **TASK-6**: CLI `pnpm watch` — `scripts/watch.ts`, reusa `startWatcher`, SIGINT handler. Log prefix unificado `[watch]`. Testes TC-I-17 via child_process.
  - files: scripts/watch.ts, tests/integration/watch-cli.test.ts
  - depends: TASK-3
  - tests: TC-I-17

- [x] **TASK-7**: Docs — atualizar `README.md` seção nova "Modo watch" + `CLAUDE.md` `Common Commands`.
  - files: README.md, CLAUDE.md
  - depends: TASK-3

- [x] **TASK-SMOKE**: Validação manual do E2E TC-E2E-01 + live check no Checkpoint 2 (documentar no Execution Log).
  - files: (nenhum código — procedimento documentado)
  - depends: TASK-4, TASK-5, TASK-6, TASK-7
  - tests: TC-E2E-01

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]             — helpers puros + install de dep (files disjuntos)
Batch 2: [TASK-2.5]                   — refactor ingestSingleFile (precisa da dep do TASK-2)
Batch 3: [TASK-3]                     — implementação principal (precisa de 1 + 2.5)
Batch 4: [TASK-4, TASK-5, TASK-6, TASK-7]  — paralelo (files disjuntos)
Batch 5: [TASK-SMOKE]                 — validação manual
```

File overlap analysis:

- `lib/ingest/watcher.ts` + `.test.ts`: exclusivo TASK-1 → TASK-3 (mesma task continua; TASK-3 **expande** `watcher.ts`)
- `package.json`, `pnpm-lock.yaml`: exclusivo TASK-2 (shared-additive historicamente; aqui exclusivo)
- `instrumentation.ts`, `tests/integration/instrumentation.test.ts`: exclusivo TASK-4
- `lib/ingest/auto.ts` (+ eventual `.test.ts`): exclusivo TASK-5
- `scripts/watch.ts`: exclusivo TASK-6
- `README.md`, `CLAUDE.md`: exclusivo TASK-7 (shared-additive histórico com outras specs)

Batch 4 é o único com paralelismo real (4 tasks com files disjuntos). Pode rodar em worktrees.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos TC-U + TC-I verdes)
- [ ] `pnpm build` passa (instrumentation.ts compila)
- [ ] `pnpm test:e2e` passa (baseline — watcher desativado por `TOKENFX_DISABLE_AUTO_INGEST=1` segue funcionando)
- [ ] **Checkpoint 2 obrigatório — live check**:
    - [ ] Rodar `TOKENFX_WATCH_MODE=1 pnpm dev` em background; verificar log `[watch] ready` com contagem de arquivos observados
    - [ ] Em outra janela: `touch /tmp/fake-session.jsonl` (dentro de `~/.claude/projects/test/`? requer cuidado — usar `/tmp/tokenfx-watch-live/`-like + override `claudeProjectsRoot()` via env se já existente, ou criar arquivo real no root real)
    - [ ] Confirmar log `[watch] add <path> → X turns, Y tool_calls` em <5s
    - [ ] Sem refresh de browser, fazer `curl http://localhost:3000/sessions` — novo session aparece no HTML
    - [ ] `Ctrl+C` no server — log de shutdown limpo (`SIGTERM (exit 143)` é esperado)
- [ ] **`pnpm watch` standalone**:
    - [ ] Rodar `pnpm watch`; confirmar `[watch-cli] ready`
    - [ ] Touch file → ingestão; Ctrl+C → close limpo

## Follow-ups (explicitamente out of scope)

- UI indicator "watcher ativo" (LED verde na nav). Pode ser spec separada.
- Real-time push ao browser (WebSocket/SSE) pra auto-refresh sem polling. Fase 2 maior.
- Metrics-level observability (prometheus counter de `watcher_events_total`). Overkill pra single-user local tool.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
