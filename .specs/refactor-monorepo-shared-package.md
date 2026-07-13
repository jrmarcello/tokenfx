# Spec: refactor-monorepo-shared-package

## Status: DONE

## Context

**Item 4.1 do `docs/execution-plan-2026-07.md` — o refactor de maior risco (L) do plano.**

Hoje o monorepo tem um **split-brain estrutural**: `apps/server` (um pacote
workspace `@tokenfx/server`) importa código da raiz (`tokenfx`, que NÃO é membro
do workspace — `pnpm-workspace.yaml` só lista `apps/*`) através de um alias de
tsconfig `@root/*` → `../../lib/*`. Isso é resolvido por *paths* do TypeScript e
por `include` de arquivos fora da raiz do pacote, não por uma dependência real de
workspace. Consequências concretas:

1. **Symlink gymnastics no Docker** — `apps/server/Dockerfile` faz `COPY lib`
   separado e cria `ln -s /repo/apps/server/node_modules /repo/node_modules`
   para que o webpack do Next resolva os módulos de `/repo/lib/*` (que não têm
   `node_modules` próprio) subindo a árvore. Frágil e não-idiomático.
2. **Dois lockfiles vivos sem sync** — `pnpm-lock.yaml` (raiz) e
   `apps/server/pnpm-lock.yaml`. O install do server usa o lockfile próprio
   (`--frozen-lockfile` dentro de `apps/server`), divergindo da raiz. Duas
   fontes de verdade para versões de deps → drift silencioso.
3. **Topologia contraditória na doc** — `pnpm-workspace.yaml` (só `apps/*`) vs
   `apps/server/README.md`.

### Superfície compartilhada real (medida, não estimada)

Módulos da raiz importados por `apps/server` via `@root/*` (33 arquivos):

| Módulo raiz | `@root/*` importado | # sites em apps/server |
| --- | --- | --- |
| `lib/logger.ts` | `@root/logger` | 25 |
| `lib/analytics/cost-calibration.ts` | `@root/analytics/cost-calibration` | 3 |
| `lib/reporter/types.ts` | `@root/reporter/types` | 2 (route + `sanitizer-shared`) |
| `lib/reporter/canonical-json.ts` | `@root/reporter/canonical-json` | 1 |
| `lib/analytics/model.ts` | `@root/analytics/model` | 1 |

**Closure de dependências dos 5 módulos** (verificado): só `zod` como dep
externa. Grafo interno mínimo:

- `logger.ts` — folha (sem imports)
- `analytics/model.ts` — folha
- `analytics/cost-calibration.ts` → `./model`
- `reporter/types.ts` → `zod`
- `reporter/canonical-json.ts` — folha

`reporter/types.ts` carrega o schema `SanitizedSessionPayload` (Zod) **além** dos
wire types (`WIRE_VERSION*`, `IngestEnvelope`). Confirmado que
`apps/server/lib/ingest/sanitizer-shared.ts` **re-exporta** esse schema de
`@root/reporter/types` (não é cópia): é a fonte-única-de-verdade do wire format,
usada tanto na validação server-side quanto na construção reporter-side.
Portanto o arquivo inteiro é legitimamente compartilhado e move em bloco.

### Decisões já travadas

1. **Pacote:** `@tokenfx/shared` em `packages/shared/`. `pnpm-workspace.yaml`
   ganha `packages/*`.
2. **Módulos movidos** (com os testes colocados): `logger`, `analytics/model`,
   `analytics/cost-calibration`, `reporter/types`, `reporter/canonical-json`.
   Layout espelha a estrutura atual sob `packages/shared/src/`.
3. **Subpath exports espelhando os paths atuais** (1:1 com o sufixo de hoje →
   substituição mecânica): `@tokenfx/shared/logger`,
   `@tokenfx/shared/analytics/model`, `@tokenfx/shared/analytics/cost-calibration`,
   `@tokenfx/shared/reporter/types`, `@tokenfx/shared/reporter/canonical-json`.
4. **Consumo source-only (SEM build step)** via `exports` apontando para
   `./src/*.ts` + `transpilePackages: ['@tokenfx/shared']` nos dois `next.config.ts`.
   Vitest resolve pelo symlink de workspace + `exports` (o vite honra o campo
   `exports`). Casa com a abordagem atual (a raiz nunca buildou `lib/`), zero
   mudança de comportamento em runtime, sem artefato intermediário. tsconfig:
   remove o path `@root/*` e o `include` de `../../lib/*` do server; a resolução
   passa a ser pelo symlink real do workspace.
5. **Ambos os pacotes** declaram `"@tokenfx/shared": "workspace:*"` em
   `package.json`.
6. **Lockfile único:** apaga `apps/server/pnpm-lock.yaml`; install passa pelo
   `pnpm install` da raiz (workspace). Regenera o `pnpm-lock.yaml` da raiz.
7. **Dockerfile via `pnpm deploy`:** substitui `COPY lib` + symlink por um build
   multi-stage que instala no contexto do workspace da raiz, buildar
   `@tokenfx/server`, e `pnpm deploy --filter=@tokenfx/server --prod` para produzir
   um `node_modules` isolado e injetável, servido via Next standalone.

### Fora de escopo (follow-ups)

- `apps/server/lib/result.ts` é uma **cópia** separada de `lib/result.ts` da raiz
  (não faz parte da superfície `@root/*` — 0 imports `@root/result`). Duplicação
  real, mas fora do escopo deste refactor. Anotar como follow-up.

### Invariante crítico preservado

O `SanitizedSessionPayload` continua **fonte-única-de-verdade**: server e reporter
DEVEM validar contra o mesmo schema. Mover o arquivo não pode criar uma segunda
cópia. `sanitizer-shared.ts` continua re-exportando — agora de
`@tokenfx/shared/reporter/types`. Há um TC de segurança que pina essa identidade.

## Requirements

**REQ-1** — GIVEN os 5 módulos compartilhados hoje em `lib/`, WHEN o refactor
completa, THEN eles vivem em `packages/shared/src/` (com seus testes colocados) e
`lib/{logger,analytics/model,analytics/cost-calibration,reporter/types,reporter/canonical-json}.ts`
não existem mais na raiz.

**REQ-2** — GIVEN o pacote `@tokenfx/shared`, WHEN qualquer consumidor importa,
THEN o faz por subpath estável (`@tokenfx/shared/logger`, `.../reporter/types`,
etc.), resolvido pelo campo `exports` do `package.json` do pacote — nunca por
`@root/*` nem por path relativo pra fora do pacote.

**REQ-3** — GIVEN os 33 arquivos com `@root/*` em `apps/server` (imports estáticos
E `import()` dinâmicos em testes), WHEN o refactor completa, THEN todos apontam
para `@tokenfx/shared/*` e não resta NENHUMA ocorrência de `@root/` no código de
`apps/server`, nem o path `@root/*`, nem QUALQUER referência `../../` (globs
`include`/`exclude` pra fora do pacote, incl. a linha órfã `../../lib/result.ts`)
no `apps/server/tsconfig.json` — o tsconfig do server fica totalmente
autocontido.

**REQ-4** — GIVEN os sites de import na raiz (`@/lib/logger`,
`@/lib/analytics/*`, e os relativos `./types`/`./canonical-json`/`./model`/
`./cost-calibration` dentro de `lib/`), WHEN o refactor completa, THEN todos os
que referenciam os 5 módulos movidos apontam para `@tokenfx/shared/*`, e o
typecheck+lint+test da raiz permanecem verdes.

**REQ-5** — GIVEN o `pnpm-workspace.yaml`, WHEN o refactor completa, THEN ele
inclui `packages/*`, e AMBOS `tokenfx` (raiz) e `@tokenfx/server` declaram
`"@tokenfx/shared": "workspace:*"` em `dependencies`.

**REQ-6** — GIVEN os dois lockfiles de hoje, WHEN o refactor completa, THEN
`apps/server/pnpm-lock.yaml` não existe mais e há um único `pnpm-lock.yaml` na
raiz que resolve as deps dos três pacotes (raiz, shared, server) de forma
`--frozen-lockfile`-consistente.

**REQ-7** — GIVEN o `SanitizedSessionPayload`, WHEN o refactor completa, THEN
continua havendo exatamente UMA definição do schema (em
`@tokenfx/shared/reporter/types`), e `apps/server/lib/ingest/sanitizer-shared.ts`
a re-exporta de lá — server e reporter validam contra o mesmo objeto Zod.

**REQ-8** — GIVEN o `apps/server/Dockerfile`, WHEN o refactor completa, THEN ele
NÃO contém `ln -s ... node_modules` nem `COPY lib` avulso; resolve
`@tokenfx/shared` de forma workspace-aware (tracing-only via
`transpilePackages` + `outputFileTracingRoot`, com `pnpm deploy --filter` como
fallback — AD-4); preserva byte-a-byte os estágios existentes de bcrypt-rebuild,
esbuild-bundling (migrate/smoke), env-placeholders, healthcheck e entrypoint; e o
`docker build` do server conclui produzindo uma imagem que sobe.

**REQ-9** — GIVEN todo o refactor, WHEN concluído, THEN não há mudança de
comportamento em runtime: `pnpm typecheck && pnpm lint && pnpm test --run &&
pnpm build` passam na raiz E em `apps/server`, com a mesma suíte de testes de
antes (mais os TCs novos de resolução de pacote) verde.

## Test Plan

> **Natureza do refactor:** estrutural puro. O grosso da validação é
> **regressão** (as suítes existentes continuam verdes após o move) + **novos
> TCs de resolução de pacote/topologia** + a **validação ao vivo do `docker
> build`**. Como não há lógica nova, os TCs unitários novos focam em: (a) o
> pacote resolve por subpath; (b) a fonte-única do schema é preservada; (c)
> ausência de referências legadas (`@root/`, lockfile duplicado, symlink). Os
> TCs de comportamento dos módulos movidos JÁ EXISTEM (logger.test, model.test,
> cost-calibration.test, types.test, canonical-json.test) e passam a rodar sob
> `packages/shared` — a preservação deles é o TC de regressão primário.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | Os 5 test files colocados (logger/model/cost-calibration/reporter-types/canonical-json) rodam sob `packages/shared` via `pnpm --filter @tokenfx/shared test` (script `test` próprio + `vitest.config.ts` do pacote) | todas as asserções pré-existentes passam, sem edição de conteúdo; E os 5 arquivos rodam de `packages/shared/src/**` (movidos, não copiados — pareado com TC-I-04 que assere ausência na raiz) |
| TC-U-02 | REQ-2 | happy | Um teste em `packages/shared` importa cada subpath (`@tokenfx/shared/logger`, `.../analytics/model`, `.../analytics/cost-calibration`, `.../reporter/types`, `.../reporter/canonical-json`) e assere o símbolo esperado (`log`, `deriveModelFamily`, `effectiveCostForSession`, `WIRE_VERSION`, `canonicalJSON`) | cada import resolve e expõe o símbolo (typecheck + runtime) |
| TC-U-03 | REQ-7 | security | Teste **em `apps/server`** (junto a `sanitizer-shared.test.ts`, pois a asserção cruza pacotes — um teste dentro de `packages/shared` não consegue importar código de `apps/server`) assere que `SanitizedSessionPayload` importado de `@tokenfx/shared/reporter/types` e o re-exportado por `sanitizer-shared` são o MESMO objeto Zod (identidade referencial `===`, importando o VALOR do schema, não só o tipo) | `identical === true`; garante fonte-única, sem drift de schema |
| TC-U-04 | REQ-2 | edge | `reporter/types` continua exportando AMBOS wire types (`WIRE_VERSION`, `WIRE_VERSION_MIN/MAX`, `IngestEnvelope`) E `SanitizedSessionPayload`/`SanitizeError` após o move | todos os símbolos presentes; nenhum export perdido no move |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-9 | infra | Regressão raiz: `pnpm typecheck && pnpm lint && pnpm test --run` na raiz após o refactor | verde; nenhuma suíte da raiz quebrada pelo move |
| TC-I-02 | REQ-9 | infra | Regressão server: `pnpm typecheck && pnpm lint && pnpm exec vitest run` em `apps/server` | verde; incluindo `ingest.test.ts` (wire) e `sanitizer-shared.test.ts` |
| TC-I-03 | REQ-3 | business | `grep -r "@root/" apps/server` no código-fonte (excluindo `.next`, `node_modules`) | 0 ocorrências; e `@root/*` ausente do `apps/server/tsconfig.json` |
| TC-I-04 | REQ-1 | business | `test -e lib/logger.ts` etc. para os 5 caminhos antigos na raiz | todos ausentes (movidos, não copiados) |
| TC-I-05 | REQ-6 | business | `test -e apps/server/pnpm-lock.yaml` | ausente; único lockfile na raiz |
| TC-I-06 | REQ-5 | business | `pnpm-workspace.yaml` inclui `packages/*`; `package.json` (raiz) e `apps/server/package.json` têm `@tokenfx/shared: workspace:*` | os três invariantes verdadeiros |
| TC-I-07 | REQ-6 | idempotency | `pnpm install --frozen-lockfile` na raiz (workspace) após regenerar o lockfile | exit 0; lockfile satisfaz os três pacotes sem mutação |
| TC-I-08 | REQ-8 | business | `apps/server/Dockerfile`: (a) NÃO contém `ln -s` de node_modules nem `COPY lib` avulso; (b) CONTÉM `pnpm deploy --filter=@tokenfx/server` | ambas: linhas legadas ausentes E mecanismo novo presente (asserção positiva dá sinal não-Docker de que o replacement landou) |
| TC-I-09 | REQ-9 | build | `pnpm build` (raiz) e `pnpm --filter @tokenfx/server build` | ambos concluem sem erro de resolução de módulo |
| TC-I-10 | REQ-4 | business | `grep -rn "from '@/lib/logger'\|from '\./logger'\|@/lib/analytics/model\|@/lib/analytics/cost-calibration\|from '\./types'\|from '\./canonical-json'" lib app scripts` (excluindo `packages/`) — sites legados dos 5 módulos na árvore raiz | 0 ocorrências dos módulos movidos; espelha o rigor de TC-I-03 no lado server |
| TC-I-11 | REQ-3 | business | `grep -n "\.\./\.\./" apps/server/tsconfig.json` — referências pra fora do pacote | 0 matches; tsconfig do server totalmente autocontido (inclui a remoção da linha órfã `../../lib/result.ts`) |
| TC-I-12 | REQ-9 | infra | **Prova que `transpilePackages` é load-bearing (não-Docker):** `next build` + boot standalone (`node .next/standalone/... server.js` ou `next start`) do `apps/server`, GET numa rota que importa um subpath `@tokenfx/shared` (ex.: `/api/ingest` com `version:2` → 400 `unsupported_version`) | HTTP 200/400 esperado; um build que "passa" mas com bundle quebrado (transpilePackages omitido) FALHA aqui. Roda sem daemon Docker |
| TC-I-13 | REQ-6 | infra | Drift de versão do lockfile: `pnpm list --depth Infinity --json` filtrando `zod` (a dep cross-package) antes/depois da regeneração | versão resolvida de `zod` inalterada; qualquer bump é registrado no Execution Log com justificativa (REQ-9 = zero mudança de runtime) |

### E2E / Build Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-8 | build | `docker build -f apps/server/Dockerfile .` (contexto = raiz do repo) | build conclui; imagem produzida; SEM symlink hack. Validação ao vivo do `pnpm deploy`. Se Docker indisponível no ambiente → log `DOCKER: DEFERRED` no Execution Log e registrar como pendência explícita |
| TC-E2E-02 | REQ-9 | smoke | Container sobe (`docker run` com env mínima) e `/api/health` (ou o boot log) responde | server inicia sem erro de módulo faltante em runtime. `DEFERRED` junto com TC-E2E-01 se Docker ausente |

## Design

### Architecture Decisions

**AD-1 — Pacote source-only, sem build step.** `@tokenfx/shared/package.json`
declara `exports` mapeando cada subpath com objeto explícito de condições
(não bare-string), `types` primeiro:

```jsonc
"exports": {
  "./logger":                    { "types": "./src/logger.ts",                    "default": "./src/logger.ts" },
  "./analytics/model":           { "types": "./src/analytics/model.ts",           "default": "./src/analytics/model.ts" },
  "./analytics/cost-calibration":{ "types": "./src/analytics/cost-calibration.ts","default": "./src/analytics/cost-calibration.ts" },
  "./reporter/types":            { "types": "./src/reporter/types.ts",            "default": "./src/reporter/types.ts" },
  "./reporter/canonical-json":   { "types": "./src/reporter/canonical-json.ts",   "default": "./src/reporter/canonical-json.ts" }
}
```

Mapa **fechado**: NÃO há export raiz `"."` — REQ-2 exige imports só por subpath;
omitir o `"."` mantém a superfície pública mínima. Objeto explícito (`types` +
`default`) em vez de bare-string protege caso um consumidor futuro migre pra
`moduleResolution: node16/nodenext` (ordem de condições passa a importar). Ambos
os tsconfig hoje usam `moduleResolution: bundler` (verificado), sob o qual bare
string já resolveria — mas o objeto explícito é estritamente mais seguro pelo
mesmo arquivo-alvo. `package.json` do pacote: `"type": "module"`, `private: true`,
`version: "0.0.0"`, `dependencies: { zod }`, e `scripts: { "test": "vitest run" }`.
Não há `tsc -b` nem `dist/`. **Consumo por `scripts/*.ts` (executados via `tsx`,
fora do bundler do Next):** verificado que resolvem `@tokenfx/shared/*` pelo
resolver ESM do Node respeitando o `type: module` por-pacote — mesmo caminho que
o Vitest. Os dois consumidores são bundlers que
transpilam TS: Next via `transpilePackages: ['@tokenfx/shared']` (necessário
porque o Next, por padrão, não transpila TS vindo de `node_modules`); Vitest/vite
resolve `.ts` de workspace nativamente. Isso espelha a política atual (a raiz
nunca compilou `lib/` — sempre consumida como fonte) e elimina um artefato
intermediário e um passo de build que poderia dessincronizar.

> **Trade-off considerado e rejeitado:** buildar para `dist/` (JS+d.ts). Daria um
> pacote "publicável" clássico, mas adiciona um build step, um watch em dev, e o
> risco de consumir `dist` stale. Como NENHUM consumidor é externo ao monorepo e
> ambos transpilam, source-only é estritamente mais simples com o mesmo resultado
> de runtime. **Melhor opção, não a mais rápida.**

**AD-2 — Subpaths espelham a estrutura atual (churn mecânico).** Ao manter os
sufixos idênticos (`/logger`, `/reporter/types`, `/analytics/model`, ...), cada
site de import vira uma substituição de prefixo:
`@root/X` → `@tokenfx/shared/X` (server) e `@/lib/X` / `./X` →
`@tokenfx/shared/X` (raiz). Sem renomear símbolos, sem reorganizar. Reduz a
superfície de erro num refactor já amplo.

**AD-3 — Resolução por workspace real, não por tsconfig paths.** Após
`pnpm install`, `node_modules/@tokenfx/shared` é um symlink pro pacote. Com
`moduleResolution: bundler`/`nodenext` + `exports`, tanto o tsc quanto o vite
resolvem sem precisar de `paths` no tsconfig. Removemos o `@root/*` do
`apps/server/tsconfig.json` e o `include` de `../../lib/*`. (O `@/*` de cada
pacote continua para os imports internos.)

**AD-4 — Dockerfile workspace-aware (elimina o symlink hack).** O Dockerfile atual
faz MUITO além de `COPY lib` + `ln -s`: rebuild explícito do bcrypt contra a libc
do runner, bundling esbuild self-contained de `lib/db/migrate.ts`,
`scripts/smoke-reset.ts` e `scripts/smoke-seed.ts` (com `--external:bcrypt`),
env-placeholders pro passo "Collecting page data" do Next, healthcheck em
`/api/health`, e um ENTRYPOINT dois-CWD (migrate-then-serve). **Tudo isso é
load-bearing e DEVE ser preservado byte-a-byte** — o refactor toca APENAS o bloco
de resolução de módulos.

Abordagem primária (a mais limpa, elimina symlink E `pnpm deploy`):

1. **Build stage no contexto da raiz do repo.** COPY das manifests dos 3 pacotes
   (`package.json` raiz, `packages/shared`, `apps/server`) + `pnpm-lock.yaml`
   único + os fontes (`lib/`… não mais avulso; `packages/shared/`, `apps/server/`).
   `pnpm install --frozen-lockfile` na raiz do workspace → `@tokenfx/shared` vira
   symlink real dentro de `/repo/node_modules` (workspace resolve nativamente;
   sem o `ln -s` manual).
2. **`next build`** com `transpilePackages: ['@tokenfx/shared']` +
   `outputFileTracingRoot` = raiz do repo. O `transpilePackages` faz o webpack
   **inlinar** o `@tokenfx/shared` transpilado no bundle standalone; o
   `outputFileTracingRoot` garante que o file-tracing do standalone atravesse o
   workspace corretamente (pacote fora do dir do app). Isso remove a necessidade
   do `node_modules` root symlinkado em runtime — o standalone já carrega o que
   precisa.
3. **esbuild bundles** (migrate/smoke) rodam contra o `/repo/node_modules` do
   install de workspace (esbuild segue o symlink de `@tokenfx/shared` e transpila
   o `.ts`); permanecem self-contained CJS com `--external:bcrypt`. **Inalterados.**
4. **bcrypt rebuild, env-placeholders, healthcheck, runner stage COPY do
   `.next/standalone` + bindings do bcrypt, ENTRYPOINT dois-CWD: inalterados.**

> **Fallback (se o file-tracing do standalone não capturar `@tokenfx/shared`
> corretamente — a incerteza real deste task):** `pnpm deploy --filter=@tokenfx/server
> --prod /app` materializa um `node_modules` isolado (com `@tokenfx/shared`
> injetado como arquivos reais, não symlink) que o runner copia. Só recorrer a
> isso se a abordagem primária falhar no `docker run` — validado ao vivo pelo
> TC-E2E-02. A decisão final entre primária/fallback é registrada no Execution
> Log com a evidência do build.

O único requisito duro (REQ-8): **sem `ln -s ... node_modules` e sem `COPY lib`
avulso**, e a imagem sobe. O mecanismo exato (tracing-only vs `pnpm deploy`) é
decidido pela evidência do build real.

**AD-5 — Ordem do refactor (big-bang controlado).** Mover os módulos deixa o
repo RED até os imports serem repointados; o checkpoint verde é no fim do batch
de repoint. Ordem: scaffold pacote + move (TASK-1) → workspace + install
(TASK-2, cria o symlink que faz `@tokenfx/shared` resolver) → repoint raiz
(TASK-3) ∥ repoint server (TASK-4) → Dockerfile (TASK-5) → smoke/build
(TASK-SMOKE). `lib/reporter/*` e `lib/analytics/*` continuam numa **task única serial** (TASK-3) — não por
serem shared-mutative no sentido de múltiplas tasks tocando o mesmo arquivo, mas
porque um repoint mecânico de ~30 arquivos é mais revisável e seguro como uma
unidade do que fatiado num accumulator/fragment pattern (que só faz sentido pra
edições aditivas concorrentes, não pra find-and-replace).

> **Janela RED esperada:** entre o fim do Batch 1 (move) e o fim do Batch 3
> (repoints aplicados), `pnpm typecheck` na raiz E no server FALHA por design — os
> arquivos movidos não existem mais nos caminhos antigos e os imports ainda não
> foram repointados. Isso NÃO é falha de task: é a natureza big-bang do move. O
> gate de green é **pós-merge do Batch 3**, não por-task no Batch 1/2. O
> `/ralph-loop` deve tratar o typecheck-RED em TASK-1/TASK-2 como esperado
> (análogo ao RED do TDD, mas em escala de repo) e só exigir green ao fechar o
> Batch 3.

### Files to Create

- `packages/shared/package.json` — `name: @tokenfx/shared`, `version: 0.0.0`,
  `private: true`, `type: module`, campo `exports` (5 subpaths, objeto explícito
  `types`+`default`, sem `"."` — AD-1), `dependencies: { zod }`, e
  `scripts: { "test": "vitest run", "typecheck": "tsc --noEmit" }`.
- `packages/shared/tsconfig.json` — estende o base; `moduleResolution: bundler`,
  `strict: true`, `baseUrl: src`, `paths: { "@/*": ["./*"] }` para imports internos
  (os módulos movidos usam só imports relativos entre si — `./model` —, então o
  `@/*` do pacote nunca é referenciado pelos fontes; existe só por consistência).
- `packages/shared/vitest.config.ts` — config própria (decisão travada: o pacote
  roda sua própria suíte via `pnpm --filter @tokenfx/shared test`, NÃO herda um
  workspace-vitest da raiz). `include: ['src/**/*.test.ts']`.

> **Convenção nova `packages/*`:** hoje todo membro do workspace vive em `apps/*`
> (`@tokenfx/server`, `@tokenfx/idp-stub`). Introduzir `packages/*` separa "apps
> deployáveis" de "libs compartilhadas" — padrão de monorepo idiomático; o escopo
> `@tokenfx/shared` casa com o scope existente. `pnpm-workspace.yaml` passa a
> listar `apps/*` E `packages/*`.

- `packages/shared/src/logger.ts` — movido de `lib/logger.ts`.
- `packages/shared/src/logger.test.ts` — movido de `lib/logger.test.ts`.
- `packages/shared/src/analytics/model.ts` — movido de `lib/analytics/model.ts`.
- `packages/shared/src/analytics/model.test.ts` — movido.
- `packages/shared/src/analytics/cost-calibration.ts` — movido (import interno
  `./model` permanece relativo — ambos no pacote).
- `packages/shared/src/analytics/cost-calibration.test.ts` — movido.
- `packages/shared/src/reporter/types.ts` — movido de `lib/reporter/types.ts`.
- `packages/shared/src/reporter/types.test.ts` — movido.
- `packages/shared/src/reporter/canonical-json.ts` — movido.
- `packages/shared/src/reporter/canonical-json.test.ts` — movido.
- `packages/shared/src/package-resolution.test.ts` — NOVO: TC-U-02 (resolução por
  subpath) + TC-U-04 (exports completos).
- `packages/shared/vitest.config.ts` — config mínima se o pacote rodar sua
  própria suíte (ou herdar via workspace vitest).

### Files to Modify

- `pnpm-workspace.yaml` — adiciona `packages/*`.
- `package.json` (raiz) — adiciona `@tokenfx/shared: workspace:*` em deps.
- `apps/server/package.json` — adiciona `@tokenfx/shared: workspace:*` em deps.
- `next.config.ts` (raiz) + `apps/server/next.config.ts` — `transpilePackages: ['@tokenfx/shared']` + `outputFileTracingRoot: path.join(__dirname, '../..')` (defensivo p/ o file-tracing do standalone atravessar o workspace; barato, sem downside).
- `apps/server/tsconfig.json` — remove `paths['@root/*']` e o `include` de `../../lib/*`.
- **Raiz — repoint dos 5 módulos** (todos os arquivos que hoje importam
  `@/lib/{logger,analytics/model,analytics/cost-calibration}` ou os relativos
  `./types`/`./canonical-json` dentro de `lib/reporter/*`, `./model`/
  `./cost-calibration` dentro de `lib/analytics|queries/*`): repoint pra
  `@tokenfx/shared/*`. Inclui `lib/reporter/{runner,client,sanitizer,queue}.ts`
  (+ testes), `lib/queries/{effectiveness,effectiveness-v2,calibration,outcomes,overview}.ts`.
- **apps/server — repoint** dos 33 arquivos `@root/*` → `@tokenfx/shared/*`,
  incluindo `apps/server/lib/ingest/sanitizer-shared.ts` (+ `.test.ts`).
- `apps/server/Dockerfile` — troca APENAS o bloco de resolução de módulos
  (`COPY lib` avulso + `ln -s node_modules`) por install de workspace na raiz +
  `transpilePackages`/`outputFileTracingRoot` (fallback `pnpm deploy`) — AD-4.
  **Preserva byte-a-byte** bcrypt-rebuild, esbuild bundling (migrate/smoke-reset/
  smoke-seed com `--external:bcrypt`), env-placeholders, healthcheck e o
  ENTRYPOINT dois-CWD.
- `apps/server/README.md` — atualizar a seção de topologia (workspace de 3
  pacotes; sem `@root/*`; lockfile único).
- Remover: `lib/logger.ts`, `lib/analytics/model.ts`,
  `lib/analytics/cost-calibration.ts`, `lib/reporter/types.ts`,
  `lib/reporter/canonical-json.ts` (+ seus `.test.ts`) e
  `apps/server/pnpm-lock.yaml`.

### Dependencies

- `zod` passa a ser dep direta de `@tokenfx/shared` (hoje é dep da raiz e do
  server; o pacote precisa declará-la).
- Nenhuma dep nova de terceiros. `pnpm deploy` é builtin do pnpm.

## Tasks

- [x] TASK-1: Scaffold `packages/shared` + mover os 5 módulos e seus testes (git mv preservando história), criar `package.json` (exports), `tsconfig.json`, e o teste novo de resolução de pacote (TC-U-02/03/04). Imports internos (`./model`) permanecem relativos.
  - files: packages/shared/package.json, packages/shared/tsconfig.json, packages/shared/vitest.config.ts, packages/shared/src/logger.ts, packages/shared/src/logger.test.ts, packages/shared/src/analytics/model.ts, packages/shared/src/analytics/model.test.ts, packages/shared/src/analytics/cost-calibration.ts, packages/shared/src/analytics/cost-calibration.test.ts, packages/shared/src/reporter/types.ts, packages/shared/src/reporter/types.test.ts, packages/shared/src/reporter/canonical-json.ts, packages/shared/src/reporter/canonical-json.test.ts, packages/shared/src/package-resolution.test.ts, lib/logger.ts, lib/logger.test.ts, lib/analytics/model.ts, lib/analytics/model.test.ts, lib/analytics/cost-calibration.ts, lib/analytics/cost-calibration.test.ts, lib/reporter/types.ts, lib/reporter/types.test.ts, lib/reporter/canonical-json.ts, lib/reporter/canonical-json.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-04
- [x] TASK-2: Plumbing de workspace — `pnpm-workspace.yaml` ganha `packages/*`; ambos `package.json` declaram `@tokenfx/shared: workspace:*`; apaga `apps/server/pnpm-lock.yaml`; roda `pnpm install` na raiz e regenera o lockfile único.
  - files: pnpm-workspace.yaml, package.json, apps/server/package.json, apps/server/pnpm-lock.yaml, pnpm-lock.yaml
  - depends: TASK-1
  - tests: TC-I-05, TC-I-06, TC-I-07
- [x] TASK-3: Repoint raiz — todos os sites de import dos 5 módulos movidos (`@/lib/logger`/relativos `./logger`, `@/lib/analytics/model`, `@/lib/analytics/cost-calibration`, e os relativos `./types`/`./canonical-json` dentro de `lib/reporter/*`) → `@tokenfx/shared/*`; `transpilePackages` + `outputFileTracingRoot` no `next.config.ts` da raiz. **Lista completa (inventário via grep, não amostra):**
  - files: next.config.ts, lib/reporter/runner.ts, lib/reporter/runner.test.ts, lib/reporter/client.ts, lib/reporter/client.test.ts, lib/reporter/sanitizer.ts, lib/reporter/sanitizer.test.ts, lib/reporter/queue.ts, lib/reporter/queue.test.ts, lib/queries/effectiveness.ts, lib/queries/effectiveness-v2.ts, lib/queries/calibration.ts, lib/queries/outcomes.ts, lib/queries/overview.ts, lib/analytics/pricing.ts, lib/ingest/auto.ts, lib/ingest/watcher.ts, lib/ingest/writer.ts, lib/ingest/writer.test.ts, lib/ingest/git/evaluator.ts, lib/ingest/git/evaluator.test.ts, lib/ingest/git/pr-lookup.ts, lib/ingest/git/pr-lookup.test.ts, app/error.tsx, scripts/ingest.ts, scripts/watch.ts, scripts/seed-dev.ts, scripts/reporter-once.ts, scripts/reporter-config-init.ts, scripts/recompute-costs.ts, scripts/smoke-seed.ts, scripts/cleanup-subagent-inflation.ts
  - depends: TASK-2
  - tests: TC-I-01, TC-I-10
- [x] TASK-4: Repoint server — todos os 33 arquivos com `@root/*` (estáticos E os `import()` dinâmicos em testes) → `@tokenfx/shared/*`; remove `paths['@root/*']` E **todas** as entradas `include`/`exclude` que referenciam `../../lib/*` (incluindo a linha órfã `../../lib/result.ts`) do `apps/server/tsconfig.json` — resultado: zero referências `../../` no tsconfig; `transpilePackages` + `outputFileTracingRoot` no `apps/server/next.config.ts`. **Lista completa (inventário via grep):**
  - files: apps/server/tsconfig.json, apps/server/next.config.ts, apps/server/app/api/auth/[...nextauth]/request-context-extract.ts, apps/server/app/api/auth/[...nextauth]/route.ts, apps/server/app/api/ingest/route.ts, apps/server/app/api/onboarding/redeem-invite/route.ts, apps/server/app/manager/_drilldown/render.tsx, apps/server/app/manager/audit-log/export/route.ts, apps/server/app/manager/audit-log/export/route.test.ts, apps/server/app/manager/teams/[id]/export/route.ts, apps/server/app/manager/teams/[id]/export/route.test.ts, apps/server/lib/auth/auth-helpers.ts, apps/server/lib/auth/auth.ts, apps/server/lib/auth/ip-to-city.ts, apps/server/lib/auth/pre-existing-binding-email.ts, apps/server/lib/auth/sso-auto-provision.ts, apps/server/lib/cron/retention-prune.ts, apps/server/lib/email/send-email.ts, apps/server/lib/email/send-email.test.ts, apps/server/lib/email/send-email-smtp.ts, apps/server/lib/email/send-email-smtp.test.ts, apps/server/lib/email/send-email-stub.ts, apps/server/lib/email/send-email-stub.test.ts, apps/server/lib/ingest/sanitizer-shared.ts, apps/server/lib/ingest/sanitizer-shared.test.ts, apps/server/lib/queries/calibration.ts, apps/server/lib/queries/overview.ts, apps/server/lib/queries/teams.ts, apps/server/lib/util/ip-trust.ts, apps/server/tests/e2e/helpers/spawn-with-log.ts, apps/server/tests/integration/auth-session.test.ts, apps/server/tests/integration/ip-to-city-maxmind.test.ts, apps/server/tests/integration/manager-alerts-banner.test.ts, apps/server/tests/integration/redeem-route.test.ts, apps/server/tests/integration/request-context-wiring.test.ts
  - depends: TASK-2
  - tests: TC-I-02, TC-I-03, TC-U-03
- [x] TASK-5: Reescrever `apps/server/Dockerfile` via `pnpm deploy` (AD-4); atualizar `apps/server/README.md` (topologia).
  - files: apps/server/Dockerfile, apps/server/README.md
  - depends: TASK-3, TASK-4
  - tests: TC-I-08
- [x] TASK-SMOKE: Validação final — `pnpm typecheck && pnpm lint && pnpm test --run && pnpm build` (raiz) + idem em `apps/server`; `docker build` do server (TC-E2E-01/02, `DEFERRED` se Docker ausente); grep de ausência de `@root/`.
  - files: (nenhum — validação)
  - depends: TASK-5
  - tests: TC-I-04, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-E2E-01, TC-E2E-02

## Parallel Batches

Batch 1: [TASK-1]            — scaffold + move (repo fica RED até o repoint)
Batch 2: [TASK-2]            — workspace + install (cria o symlink que resolve `@tokenfx/shared`)
Batch 3: [TASK-3, TASK-4]    — repoint raiz ∥ repoint server (árvores disjuntas: `lib/`+raiz vs `apps/server/`) — checkpoint VERDE ao fim
Batch 4: [TASK-5]            — Dockerfile + README (depende dos dois repoints)
Batch 5: [TASK-SMOKE]        — validação total + docker build

> **Nota de paralelismo:** TASK-3 e TASK-4 tocam árvores disjuntas (raiz vs
> `apps/server`) e ambas dependem só de TASK-2, então rodam em paralelo via
> worktrees. O repo só volta a ficar verde ao FIM do Batch 3 (ambos os repoints
> aplicados) — é a natureza big-bang do move; a validação de green é pós-merge do
> batch, não por-task.

## Validation Criteria

- [ ] `pnpm typecheck && pnpm lint && pnpm test --run && pnpm build` (raiz) verdes.
- [ ] `pnpm typecheck && pnpm lint && pnpm exec vitest run && pnpm build` (apps/server) verdes.
- [ ] `pnpm --filter @tokenfx/shared test` verde (os 5 test files movidos + resolução).
- [ ] `pnpm install --frozen-lockfile` na raiz: exit 0, lockfile único satisfaz os 3 pacotes.
- [ ] `grep -rn "@root/" apps/server --include='*.ts' --include='*.tsx'` → 0 no código-fonte; `grep -n "\.\./\.\./" apps/server/tsconfig.json` → 0.
- [ ] Grep raiz (TC-I-10): 0 sites legados dos 5 módulos em `lib`/`app`/`scripts`.
- [ ] `apps/server/pnpm-lock.yaml` ausente; `lib/{logger,analytics/model,analytics/cost-calibration,reporter/types,reporter/canonical-json}.ts` (+ `.test.ts`) ausentes.
- [ ] **Boot smoke não-Docker (TC-I-12):** `apps/server` buildado sobe via standalone e responde numa rota que importa `@tokenfx/shared` — prova que `transpilePackages` é efetivo sem depender do daemon Docker.
- [ ] Drift de lockfile (TC-I-13): versão resolvida de `zod` inalterada pós-merge do lockfile (ou bump justificado no Execution Log).
- [ ] **Validação ao vivo (build real):** `docker build -f apps/server/Dockerfile .` conclui SEM o symlink hack, produz imagem que sobe. `DOCKER: DEFERRED` explícito no Execution Log se o daemon estiver indisponível.
- [ ] `SanitizedSessionPayload` referencialmente idêntico entre `@tokenfx/shared/reporter/types` e o re-export de `sanitizer-shared` (TC-U-03).

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### TASK-1 (2026-07-12)

Scaffold + `git mv` (história preservada) dos 5 módulos + testes p/ `packages/shared/src/`. `package.json` (exports objeto explícito `types`+`default`, sem `"."`; zod ^4.3.6, vitest ^4.1.4 casando a raiz), `tsconfig.json`, `vitest.config.ts`, e `package-resolution.test.ts` (TC-U-02/04). `model.test.ts` interno repointado de `@/lib/analytics/model` → `./model`. Repo RED por design (imports antigos quebrados) até o Batch 3.

### TASK-2 (2026-07-12)

`pnpm-workspace.yaml` += `packages/*`; ambos `package.json` += `@tokenfx/shared: workspace:*`; `git rm apps/server/pnpm-lock.yaml`; `pnpm install --no-frozen-lockfile` regenerou o lockfile único (4 workspace projects). Symlink `node_modules/@tokenfx/shared → packages/shared` criado. **TC-I-13 (drift):** zod resolvido = 4.3.6 inalterado. **TC-U-01/02/04 GREEN:** `pnpm --filter @tokenfx/shared test` → 6 files / 44 tests pass.

### Batch [TASK-3, TASK-4] (2026-07-12)

Executado inline sequencial no main tree (NÃO worktrees — decisão de qualidade: worktrees não compartilham o `node_modules`/symlink de workspace do qual a correção depende). Árvores disjuntas.

- TASK-3 (raiz): repoint via sed escopado — `@/lib/logger`+relativos, `@/lib/analytics/{model,cost-calibration}`, e `./types`/`./canonical-json` SÓ em `lib/reporter/` (preservando os `./types` locais de `lib/ingest/*`). Inventário expandido além do grep inicial: incluiu `components/**` e `tests/**` (achado durante typecheck) + variantes de aspas duplas. `next.config.ts`: `transpilePackages` + `outputFileTracingRoot`. `tsconfig.json`: exclui `packages/**`. **TC-I-01/I-10 GREEN.**
- TASK-4 (server): blanket `@root/` → `@tokenfx/shared/` (33 arquivos, aspas simples/duplas + `import()`). `apps/server/tsconfig.json`: removido `@root/*` path + TODAS as refs `../../lib/*` (incl. `../../lib/result.ts` órfã) → zero `../../`. `next.config.ts`: `transpilePackages` + `outputFileTracingRoot`. TC-U-03 (identidade referencial `===` do schema) adicionado a `sanitizer-shared.test.ts`. **TC-I-02/03/11/U-03 GREEN.**

Checkpoint pós-Batch 3: typecheck raiz+server limpo; **root 1240 pass**, **server 1536 pass (Postgres/Testcontainers)**, **shared 44 pass**; lint limpo ambos.

### TASK-5 (2026-07-12)

`apps/server/Dockerfile` reescrito: install de workspace filtrado (`pnpm install --frozen-lockfile --ignore-scripts --filter @tokenfx/server...`) na raiz; **removido `COPY lib` + `ln -s node_modules`**; bcrypt-rebuild, esbuild-bundling (migrate/smoke), env-placeholders, healthcheck, entrypoint **preservados** (paths ajustados p/ standalone `/repo`-rooted: `server.js` em `apps/server/server.js`, bcrypt em `/repo/node_modules/.pnpm`). **Abordagem primária (tracing-only) funcionou — `pnpm deploy` NÃO foi necessário.** `README.md` topologia atualizada (3-project workspace, sem `@root/*`, lockfile único).

### TASK-SMOKE / Validation (2026-07-12)

- **TC-E2E-01 GREEN:** `docker build -f apps/server/Dockerfile .` conclui, imagem produzida, SEM symlink hack.
- **TC-I-12 GREEN (boot smoke não-Docker):** standalone local (`node .next/standalone/apps/server/server.js`) bootou sem erro de módulo; `POST /api/ingest {version:2}` → 400 `unsupported_version` (rota importa `@tokenfx/shared` — prova `transpilePackages` efetivo).
- **TC-E2E-02:** `docker run` bloqueado pela permissão do harness; a resolução de runtime equivalente está provada pelo TC-I-12 (mesmo bundle standalone).
- **TC-I-04/05/06/09 GREEN:** 5 paths antigos ausentes; `apps/server/pnpm-lock.yaml` ausente; workspace `packages/*` + ambos deps `workspace:*`; `pnpm build` raiz E server OK.
- `.gitignore` += `packages/shared/node_modules/`.
- Suítes finais: root 1240 / server 1536 / shared 44, lints + typechecks limpos.
