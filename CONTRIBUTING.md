# Guia de Contribuição

Obrigado pelo interesse em contribuir com o **TokenFx**!

## Como começar

1. Clone o projeto
2. Crie uma branch: `git checkout -b feat/minha-feature`
3. Setup: `pnpm setup` (instala deps + popula banco com dados sintéticos pra UI aparecer)
4. Dev server: `pnpm dev` → `http://localhost:3131`

## Propor features e reportar bugs

Use o **Issues** do GitHub para sugerir melhorias ou reportar problemas:

1. Verifique se já existe uma issue similar
2. Crie uma issue com o tipo adequado:
   - **Bug**: algo não funciona como esperado (inclua steps to reproduce + versão do Node/pnpm)
   - **Enhancement**: nova funcionalidade ou melhoria (descreva o problema, não só a solução)
   - **Task**: melhoria técnica, refactor, docs

Se quiser implementar a feature, comente na issue antes de começar para alinhar a abordagem.

## Desenvolvimento

Ferramentas necessárias: **Node 20+**, **pnpm 9+**.

```bash
pnpm setup                # install + seed-dev (primeira vez)
pnpm dev                  # Next.js dev server
pnpm ingest               # ingere ~/.claude/projects/*.jsonl
pnpm test                 # Vitest watch
pnpm test --run           # Vitest single pass
pnpm test:e2e             # Playwright (primeira vez: pnpm exec playwright install chromium)
pnpm typecheck            # tsc --noEmit
pnpm lint                 # ESLint
pnpm validate             # typecheck + lint + test --run
pnpm build                # production build
```

## Commits

Seguimos **Conventional Commits**. O `cliff.toml` roteia cada tipo pra uma seção do CHANGELOG automaticamente:

```text
feat(scope): nova funcionalidade          → Funcionalidades
fix(scope): correção de bug               → Correções
refactor(scope): mudança sem mudar comportamento → Refatoração
docs(scope): documentação                 → Documentação
test(scope): testes                       → Testes
chore(scope): config, deps, housekeeping  → Manutenção
perf(scope): performance                  → Performance
ci(scope): pipelines                      → CI/CD
build(scope): build tooling               → Build
style(scope): formatação                  → Estilo
```

Exemplo: `feat(otel): add accept rate signal to composite score`

Scope é opcional mas recomendado. Usados nesse projeto: `ui`, `ingest`, `scoring`, `otel`, `db`, `api`, `dx`, `docs`, `config`.

Commits `Merge` / `Merged` são ignorados pelo changelog automaticamente.

## Pull requests

Ao abrir um PR:

1. Descreva **o quê** e **por que** — não só o diff
2. Garanta que `pnpm validate` passa (typecheck + lint + tests)
3. Se mudou rotas/queries/UI, rode `pnpm test:e2e` localmente
4. **Não edite `CHANGELOG.md` manualmente** — ele é gerado a partir dos commits via `git-cliff` durante `pnpm release`. Para prever o changelog a qualquer momento: `pnpm changelog`

## Releases

> Seção para mantenedores. Contribuidores externos não precisam rodar `pnpm release`.

### Pré-requisito

Instale `git-cliff` uma vez:

```bash
brew install git-cliff     # macOS
# ou veja https://git-cliff.org para outras plataformas
```

### Quando lançar

Rode `pnpm release` quando houver pelo menos **um commit `feat:` ou `fix:` user-visible** desde a última tag. Commits apenas de `chore`, `docs`, `ci`, `refactor`, `test`, `style` **não** justificam release — é ruído pra quem acompanha o projeto.

Verifique o que entraria:

```bash
git log v<última-tag>..HEAD --oneline   # se já houver tag
git log --oneline                       # primeira release
```

### Escolhendo a versão (semver pré-1.0)

O projeto começa em `0.x.x`. Regra prática:

| Situação desde a última tag | Bump | Exemplo |
| --- | --- | --- |
| Apenas `fix:` | PATCH | `0.3.0` → `0.3.1` |
| Qualquer `feat:` | MINOR | `0.3.0` → `0.4.0` |
| Breaking change | MINOR + seção `BREAKING CHANGES` na descrição | `0.3.0` → `0.4.0` |

Quem decide MAJOR/MINOR/PATCH é você no `VERSION=...`. `git-cliff` só gera o changelog a partir dos commits.

### Fluxo

```bash
pnpm release VERSION=0.2.0
```

O script `scripts/release.sh` faz, em ordem:

1. Valida que working tree está limpa
2. Captura o SHA do `HEAD` atual — será o alvo da tag
3. `git-cliff --tag v0.2.0 --output CHANGELOG.md`
4. `git commit -m "chore(release): v0.2.0 [skip ci]"` — commit meta sobre o CHANGELOG
5. `git tag -a v0.2.0 <sha-capturado>` — tag anotada apontando para o commit anterior ao `chore(release)`
6. Pergunta `Push para origin/main + tag? [y/N]` — responda `y` para publicar
7. `git push origin main --follow-tags`

**Por que a tag aponta para o commit anterior ao `chore(release)`?**

O `[skip ci]` no commit de release impede o GitHub Actions de rodar qualquer workflow para o push desse commit — inclusive o `release.yml`. Se a tag apontasse para o commit de CHANGELOG (HEAD), o tag push herdaria o `[skip ci]` e a GitHub Release não seria publicada. Apontando a tag para o commit anterior (sem `[skip ci]`), o tag push dispara o workflow normalmente.

Após o push, o workflow `.github/workflows/release.yml` dispara e publica a **GitHub Release** em ~30s, com notes geradas pelo `git-cliff` (só commits desde a tag anterior).

### Checklist mental antes de rodar

- [ ] `git log v<última-tag>..HEAD --oneline` contém algum `feat:` ou `fix:`?
- [ ] `pnpm validate` passa?
- [ ] Estou na `main` atualizada (`git pull`)?
- [ ] Bump correto (`feat` → MINOR, `fix` → PATCH)?

## Testes

Padrão: tests colocados (`foo.ts` + `foo.test.ts`) para unit/integration, exceto a suíte cross-module em `tests/integration/` e E2E em `tests/e2e/`.

Novas funcionalidades devem incluir:

- **Unit tests** para funções puras (parsers, scoring, pricing, formatters) em Vitest
- **Integration tests** com SQLite in-memory para queries e handlers de API
- **E2E smoke** (Playwright) para fluxos críticos — home KPIs, drill-down, rating
- Cobrir tanto **happy path** quanto **error paths** — regex de correção tem +50 casos testados como referência

Sem frameworks de mocking. Use stubs hand-written colocados no próprio `*.test.ts`.

## SDD Workflow (features complexas)

Para features não-triviais, use o fluxo Specification-Driven Development:

1. **Spec**: crie com `/spec "descrição"` — gera requisitos, test plan, tasks e análise de paralelismo em `.specs/`
2. **Review**: revise a spec, ajuste, aprove (status `APPROVED`)
3. **Execute**: `/ralph-loop .specs/<nome>.md` — execução autônoma task-by-task com TDD
4. **Validate**: `/spec-review .specs/<nome>.md` — revisão formal contra os requisitos

Regras completas em `.claude/rules/sdd.md`. Spec modelo em `.specs/TEMPLATE.md`. Spec concluída do MVP: `.specs/dashboard-mvp.md`.

## Convenções de código

- **TS strict** — sem `any`, `unknown` + narrowing nos boundaries
- **Named exports** preferidos; default só onde Next exige (`page.tsx`, `layout.tsx`, `route.ts`)
- **Prepared statements reusados** (WeakMap-cached por DB) — nunca `db.prepare()` dentro de loops
- **`console.*`** só em `lib/logger.ts`
- **Zod** em toda fronteira de ingestão / API
- **Result pattern** nos parsers: `{ ok: true, value } | { ok: false, error }`

Regras detalhadas em `.claude/rules/` (auto-aplicadas via hooks).

## Arquitetura

Antes de criar/modificar arquivos, consulte:

- `README.md` — seção "Como funciona" explica o modelo mental
- `CLAUDE.md` — visão geral da arquitetura, padrões e comandos
- `.specs/dashboard-mvp.md` — spec do MVP com requisitos e test plan
- `.claude/rules/ts-conventions.md` + `nextjs-conventions.md` — convenções

## Claude Code DX

O projeto é otimizado pra desenvolvimento com IA. Recursos:

- **Agents**: `code-reviewer`, `security-reviewer`, `data-reviewer` (model: sonnet/opus)
- **Skills**: `/spec`, `/spec-review`, `/ralph-loop`, `/validate`, `/review`, `/full-review-team`
- **Hooks**: guard-bash (pre), lint-ts-file (post edit), stop-validate (post), ralph-loop (post), worktree-create/remove

Tudo configurado em `.claude/`. Documentado no `CLAUDE.md`.
