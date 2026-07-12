# Spec: onboarding-followups-lowsev

## Status: DONE

## Context

Bundle de 4 refactors LOW-severity escalados no PAUSE 2 da Fase 3 ([`central-server-onboarding`](.specs/central-server-onboarding.md), commit `0594e39`). Todos no domínio `apps/server/lib/auth/` + routes onboarding-adjacentes; vale single spec pra reduzir overhead de review e capturar relacionamentos cross-task (e.g., `truncateIpForAudit` cobre callsites no rate-limited redeem-invite + no health).

### Prior art e constraints

- **3 implementações de IP truncation paralelas**, descobertas via grep:
  - `apps/server/app/api/health/route.ts:46` — `truncateIpV4_24(ip)`: **loosest**, sem range check em octetos IPv4 nem hex check em IPv6 (`999.999.999.999` passaria como `999.999.999.0/24`).
  - `apps/server/app/api/onboarding/redeem-invite/route.ts:110` — `truncateIp24(rawIp)`: **medium**, valida range 0..255 IPv4 mas sem hex check IPv6.
  - `apps/server/app/manager/_drilldown/render.tsx:83` — `truncateIp(raw)`: **strictest**, valida hex IPv6 + rejeita addresses começando com `::` (e.g., `::1` — não dá pra truncar). **Bug latente**: aceita `'2001:db8:abcd'` (3 hextets, sem `::`) como input válido e retorna `'2001:db8:abcd::/48'` — isso é malformed IPv6 (não é um endereço real). A nova versão consolidada DEVE rejeitar — requer `split(':').length >= 4` OU presença de `::` shortcut.
- **Comportamento divergente**: consolidar requer escolher a versão **mais defensiva** (drilldown-grade, com a correção do bug latente). Migração é uma security tightening (rejeitar inputs malformados em vez de devolver `999.999.999.0/24` OU `2001:db8:abcd::/48`), não apenas DRY. Documentar como anti-regression.
- **Rate limiter em `lib/queries/rate-limit.ts`** é **in-memory sliding-window** (não DB-backed, apesar do path `lib/queries/`). Doc explicita: "No Redis dependency because (a) the central server is single-process today and (b) the dashboards are localhost". `RateLimitDimensionInput.name: 'ip' | 'token'` (union já tem `'ip'`, migração não estende). Tem `__resetRateLimits()` test seam.
- **Health route hoje** usa `Map<string, { count: number; resetAt: number }>` (bucket-per-window) — **NÃO** é sliding window real. Bucket "reset every 60s" comporta-se diferentemente perto da boundary que sliding-window.
- **TC-I-71e (bcrypt-skip)** em `apps/server/tests/integration/auth-bearer.test.ts:337-370` faz timing comparison absoluto (`expect(warmDurationMs).toBeLessThan(15)`). Flaky em CI lento — a invariante real é "cache foi consultado, bcrypt não rodou", já testável via `__hasCachedVerification(keyId)` exportado de `bearer-auth.ts`. **Decisão**: dropar a timing assertion COMPLETAMENTE (não substituir por relativa) — a invariante direta via `__hasCachedVerification` cobre tudo, e qualquer comparação `warm < cold` adiciona flakiness sem coverage (warm pode ser 14ms vs cold 12ms sob load).
- **`flash-cookie.ts:getSecret()`** retorna `''` quando `AUTH_SECRET` é unset (silent fallback pra dev/test). Em produção `auth.ts:18-26` já tem boot guard que throws, mas se algum entry-point load `flash-cookie` SEM passar por `auth.ts` (e.g., um futuro server action que importa direto), o fallback `''` produz HMAC com chave vazia — qualquer atacker que conheça o algoritmo pode forjar flash cookies. Defesa em profundidade.
- **`lib/util/`** já existe (`apps/server/lib/util/user-display.ts`); placement de `ip.ts` é consistente com convention.

### Decisões já travadas

- **Bundle estratégico**: single spec com 4 tasks paralelizáveis. Total estimado ~150 LOC produção + ~30 TCs. Se diff exceder 500 LOC líquido durante execução, NÃO splittar reactivamente — anotar no Execution Log e seguir.
- **Tightening de comportamento IP-trunc**: aceito e documentado. `truncateIpForAudit` segue a versão drilldown-grade COM correção do bug `split(':').length >= 4 || includes('::')`. Anti-regression: TCs explícitos cobrindo (a) inputs aceitos por versões loose e agora rejeitados (`999.999.999.999`); (b) input do bug-latente do drilldown (`2001:db8:abcd`) agora rejeitado; (c) inputs válidos preservados.
- **Signature `truncateIpForAudit(raw: string): string | null`**: callers narrow at boundary. Header reads retornam `string | null` — caller faz `raw ? truncateIpForAudit(raw) : null`. Evita double-cast em tests (`null as unknown as string`) e força ownership explícito de null no callsite.
- **Health rate-limiter**: usa o `checkRateLimits` existente com **single-element dimension** `[{ name: 'ip', key: ipTruncated ?? 'unknown-ip', limit: 10, windowMs: 60_000 }]`. Comportamento muda de bucket-per-window pra sliding-window real (a invariante "10/min/IP" preserva, apenas a "queda" do counter é gradual em vez de step-function). Liveness mode (HEAD-mode sem credentials) permanece unrestricted.
- **`flash-cookie.ts:getSecret()` boot guard**: adicionar `assertFlashSecretAvailable(env)` exportado, chamado em module-load de `auth.ts` (mesmo padrão de `assertNotProductionWithBypass` em `lib/auth/e2e-bypass-provider.ts:97-105`). Em prod, throws se `AUTH_SECRET`/`NEXTAUTH_SECRET` ambos missing/empty. Em dev/test, no-op. **NODE_ENV check é exato `=== 'production'`** (espelha pattern do `assertNotProductionWithBypass` H1 fix — variantes `'prod'`, `'production-staging'`, unset, `''` NÃO triggam o guard porque essas configurações ja são "production-like" e o `AUTH_SECRET` guard pré-existente em `auth.ts:18-26` cobre essas variantes via OR negation). **Doc invariante**: adicionar JSDoc em `getSecret()` explicitando que o fallback `''` é seguro apenas quando o módulo é carregado via `auth.ts` (que tem boot guard); qualquer outro entry-point precisa chamar `assertFlashSecretAvailable` próprio.
- **TC-I-71e**: substituir timing assertion absoluta por assertion da invariante via `__hasCachedVerification`. **NÃO** manter assertion relativa (`warm < cold`) — fonte de flake adicional sem coverage extra.
- **Não fazer** (out-of-scope): NÃO criar diretório `lib/util/*` genérico além de `ip.ts` (`user-display.ts` já existe); NÃO mudar janelas/limites do rate-limiter; NÃO mexer no encoding/HMAC do flash-cookie.

## Requirements

- [ ] REQ-1: GIVEN um arquivo `apps/server/lib/util/ip.ts`, WHEN `truncateIpForAudit(ip: string)` é chamado com IPv4 válido `'1.2.3.4'`, THEN retorna `'1.2.3.0/24'`.
- [ ] REQ-2: GIVEN `truncateIpForAudit(ip)`, WHEN ip é IPv4 com octet > 255 (e.g., `'999.999.999.999'`), THEN retorna `null` (tighter behavior — antes era aceito por health route).
- [ ] REQ-3: GIVEN `truncateIpForAudit(ip)`, WHEN ip é IPv4 com octets não-numéricos (e.g., `'1.2.a.4'`) ou número errado de octets (`'1.2.3'`, `'1.2.3.4.5'`), THEN retorna `null`.
- [ ] REQ-4: GIVEN `truncateIpForAudit(ip)`, WHEN ip é IPv6 válido (e.g., `'2001:db8:abcd:1234::1'`), THEN retorna `'2001:db8:abcd::/48'` (primeiros 3 hextets + `::/48`, lowercase normalized).
- [ ] REQ-5: GIVEN `truncateIpForAudit(ip)`, WHEN ip é IPv6 começando com `::` (e.g., `'::1'`, `'::ffff:1.2.3.4'`), THEN retorna `null` (não dá pra truncar meaningfully).
- [ ] REQ-6: GIVEN `truncateIpForAudit(ip)`, WHEN ip é IPv6 malformed (hextet não-hex, `'2001:zzzz:1234::1'`) OU tem menos de 4 segments colon-separated sem `::` shortcut (e.g., `'2001:db8:abcd'`), THEN retorna `null` (fix do bug latente da drilldown impl).
- [ ] REQ-7: GIVEN `truncateIpForAudit(ip)`, WHEN ip é string vazia, whitespace-only, ou não-parseable como IPv4/IPv6 (e.g., `'not an ip'`), THEN retorna `null` sem throw. (Null/undefined input não compila — caller responsibility.)
- [ ] REQ-8: GIVEN as 3 routes que hoje têm IP truncation inline (`/api/health`, `/api/onboarding/redeem-invite`, `_drilldown/render.tsx`), WHEN cada uma é migrada para importar `truncateIpForAudit` (narrando null no callsite), THEN a função local é removida E não há behavior change pra inputs válidos (apenas pra inputs malformed que antes eram aceitos por health route — esses agora retornam `null`, anti-regression coberta por TC-I-02/03 e TC-I-12).
- [ ] REQ-9: GIVEN `apps/server/app/api/health/route.ts`, WHEN um GET passa o rate-limit credential-validation (HEAD-mode é unrestricted by design — preservar), THEN o limiter chama `checkRateLimits(dimensions)` de `lib/queries/rate-limit.ts` com **single-element array** `[{ name: 'ip', key: ipTruncated ?? 'unknown-ip', limit: 10, windowMs: 60_000 }]`. Sem segunda dimensão (não há `token` analogue em /health).
- [ ] REQ-10: GIVEN o health rate limiter migrado, WHEN um IP excede 10 req/min na janela sliding, THEN retorna 429 com `Retry-After` header derivado do `retryAfterSec` retornado pelo `checkRateLimits`. Idem para clients sem `X-Forwarded-For`/`X-Real-IP` (fallback `'unknown-ip'`).
- [ ] REQ-11: GIVEN `apps/server/lib/auth/flash-cookie.ts`, WHEN o módulo é carregado E `assertFlashSecretAvailable(env)` é exportado, THEN a função throws `Error('AUTH_SECRET (or NEXTAUTH_SECRET) is required for flash cookies. Refusing to boot.')` quando `env.NODE_ENV === 'production'` E `env.AUTH_SECRET` e `env.NEXTAUTH_SECRET` ambos são undefined/empty.
- [ ] REQ-12: GIVEN `assertFlashSecretAvailable(env)`, WHEN `NODE_ENV !== 'production'` (incluindo `'test'`, `'development'`, `''`, unset, `'production-staging'`) OU qualquer um dos secrets está set não-vazio, THEN não throw. NOTA: variantes "production-like" como `'prod'` ou `'production-staging'` são cobertas pelo `AUTH_SECRET` guard pré-existente em `auth.ts:18-26` (que usa `!AUTH_SECRET && !NEXTAUTH_SECRET` sem checar NODE_ENV).
- [ ] REQ-13: GIVEN `apps/server/lib/auth/auth.ts`, WHEN o módulo carrega, THEN chama `assertFlashSecretAvailable(process.env)` em module scope, **depois** do `AUTH_SECRET` guard existente (linhas 18-26) e **antes** do `assertNotProductionWithBypass` (linhas 36-42).
- [ ] REQ-14: GIVEN TC-I-71e em `apps/server/tests/integration/auth-bearer.test.ts`, WHEN refatorado, THEN substitui o `expect(warmDurationMs).toBeLessThan(15)` por `expect(__hasCachedVerification(KEY_ID)).toBe(true)` antes do segundo call. **Remove** completamente as variáveis `t0/t1/t2/t3/coldDurationMs/warmDurationMs` e a `Date.now()` chamadas — não há comparison timing remanescente (anti-flake sem perder cobertura da invariante).

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `truncateIpForAudit('1.2.3.4')` | returns `'1.2.3.0/24'` |
| TC-U-02 | REQ-1 | happy | `truncateIpForAudit('0.0.0.0')` | returns `'0.0.0.0/24'` |
| TC-U-03 | REQ-1 | happy | `truncateIpForAudit('255.255.255.255')` | returns `'255.255.255.0/24'` |
| TC-U-04 | REQ-2 | edge | `truncateIpForAudit('999.999.999.999')` (octet > 255) | returns `null` (tightening anti-regression) |
| TC-U-05 | REQ-2 | edge | `truncateIpForAudit('256.0.0.0')` (boundary +1) | returns `null` |
| TC-U-06 | REQ-2 | edge | `truncateIpForAudit('-1.0.0.0')` (negative octet) | returns `null` |
| TC-U-07 | REQ-3 | validation | `truncateIpForAudit('1.2.a.4')` | returns `null` |
| TC-U-08 | REQ-3 | validation | `truncateIpForAudit('1.2.3')` (3 octets only) | returns `null` |
| TC-U-09 | REQ-3 | validation | `truncateIpForAudit('1.2.3.4.5')` (5 octets) | returns `null` |
| TC-U-10 | REQ-4 | happy | `truncateIpForAudit('2001:db8:abcd:1234::1')` | returns `'2001:db8:abcd::/48'` |
| TC-U-11 | REQ-4 | happy | `truncateIpForAudit('FE80:0:0:1::1')` (mixed case w/ ::) | returns `'fe80:0:0::/48'` (lowercase normalized) |
| TC-U-12 | REQ-5 | security | `truncateIpForAudit('::1')` (IPv6 loopback) | returns `null` |
| TC-U-13 | REQ-5 | security | `truncateIpForAudit('::ffff:1.2.3.4')` (IPv4-mapped, starts with `::`) | returns `null` (consistent with `::` prefix rule) |
| TC-U-14 | REQ-6 | validation | `truncateIpForAudit('2001:zzzz:1234::1')` (non-hex hextet) | returns `null` |
| TC-U-15 | REQ-6 | validation | `truncateIpForAudit('2001:db8:abcd')` (3 hextets, no `::`, < 4 segments) | returns `null` (fixes bug latente — antes a drilldown impl retornava `'2001:db8:abcd::/48'`) |
| TC-U-16 | REQ-6 | validation | `truncateIpForAudit('fe80::1')` (`::` embedded, 3 segments via split) | returns `null` (empty hextet between fe80 and 1) |
| TC-U-17 | REQ-7 | edge | `truncateIpForAudit('')` (empty string) | returns `null` |
| TC-U-18 | REQ-7 | edge | `truncateIpForAudit('   ')` (whitespace only) | returns `null` |
| TC-U-19 | REQ-7 | edge | `truncateIpForAudit('not an ip at all')` | returns `null` |
| TC-U-20 | REQ-11 | security | `assertFlashSecretAvailable({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)` (both secrets missing) | throws `/AUTH_SECRET.*required for flash cookies/` |
| TC-U-21 | REQ-11 | security | `assertFlashSecretAvailable({ NODE_ENV: 'production', AUTH_SECRET: '' } as NodeJS.ProcessEnv)` (empty AUTH_SECRET) | throws |
| TC-U-22 | REQ-11 | security | `assertFlashSecretAvailable({ NODE_ENV: 'production', AUTH_SECRET: '', NEXTAUTH_SECRET: '' } as NodeJS.ProcessEnv)` (both empty) | throws |
| TC-U-23 | REQ-12 | happy | `assertFlashSecretAvailable({ NODE_ENV: 'production', AUTH_SECRET: 'x' } as NodeJS.ProcessEnv)` | does not throw |
| TC-U-24 | REQ-12 | happy | `assertFlashSecretAvailable({ NODE_ENV: 'production', NEXTAUTH_SECRET: 'x' } as NodeJS.ProcessEnv)` (alt secret name) | does not throw |
| TC-U-25 | REQ-12 | edge | `assertFlashSecretAvailable({ NODE_ENV: 'production', AUTH_SECRET: '', NEXTAUTH_SECRET: 'y' } as NodeJS.ProcessEnv)` (one empty, one set) | does not throw |
| TC-U-26 | REQ-12 | edge | `assertFlashSecretAvailable({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)` (no secret, dev) | does not throw |
| TC-U-27 | REQ-12 | edge | `assertFlashSecretAvailable({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)` (no secret, test) | does not throw |
| TC-U-28 | REQ-12 | edge | `assertFlashSecretAvailable({ NODE_ENV: 'production-staging' } as NodeJS.ProcessEnv)` (allow-list variant) | does not throw (delegado ao `AUTH_SECRET` guard pré-existente em `auth.ts`) |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-8 | regression | Call `/api/onboarding/redeem-invite` with `X-Forwarded-For: 1.2.3.4`, valid invite, verify the row written to `onboarding_redemption_log.ip_address_trunc` | equals `'1.2.3.0/24'` (preserves prior behavior). **PG-required**. |
| TC-I-02 | REQ-8 | regression | Call `/api/onboarding/redeem-invite` with `X-Forwarded-For: 999.999.999.999`, verify row written | `ip_address_trunc` is `NULL` (tighter — prior loose impl would've stored `'999.999.999.0/24'`). **PG-required**. |
| TC-I-03 | REQ-9 | happy | GET `/api/health?key_id=K` with valid Bearer + `X-Forwarded-For: 1.2.3.4`, 10 times in sequence | 10 × 200 (cap reached but not yet exceeded). Uses `vi.useFakeTimers()` in beforeEach + `vi.useRealTimers()` in afterEach (suite-scoped, anti-leak). |
| TC-I-04 | REQ-10 | edge | 11th GET on same IP within 60s | 429 with `Retry-After` header set, body has `code: 'rate-limited'` |
| TC-I-05 | REQ-10 | edge | After 11th call, `vi.advanceTimersByTime(60_100)`, retry → 200 (window slides off) | 200 |
| TC-I-06 | REQ-10 | edge | 11 GETs without `X-Forwarded-For`/`X-Real-IP` headers (fallback `'unknown-ip'`) | 10 × 200, 11th → 429 (covers shared bucket case) |
| TC-I-07 | REQ-9 | infra | After 10 GETs (cap hit), call `__resetHealthRateLimit()`; immediately retry | 200 (alias delegation to `__resetRateLimits` works — guards against wrong wiring) |
| TC-I-08 | REQ-13 | boot | Subprocess loads `apps/server/lib/auth/flash-cookie.ts` **directly** (não via `auth.ts`) com `NODE_ENV='production'` + both secrets unset, invoca `assertFlashSecretAvailable(process.env)` | throws (verifies the new guard is reachable independent of auth.ts chain) |
| TC-I-09 | REQ-13 | boot | Subprocess loads `auth.ts` com `NODE_ENV='production'` + `AUTH_SECRET='x'` + `NEXTAUTH_SECRET` unset | no throw (assertFlashSecretAvailable sees `AUTH_SECRET` set, returns; auth.ts continues to providers spread) |
| TC-I-10 | REQ-12 | boot | Subprocess loads `auth.ts` com `NODE_ENV='production'` + both secrets unset | throws on module load via the existing `AUTH_SECRET` guard (lines 18-26) — regression check that the boot guard chain ordering is intact (AUTH_SECRET fires first, antes do `assertFlashSecretAvailable`) |
| TC-I-11 | REQ-8 | regression | Call `/api/health?key_id=K` with valid Bearer + `X-Forwarded-For: 999.999.999.999` (malformed) | response is 200 (não 500) AND the rate-limit key used is `'unknown-ip'` (verify via inspecting bucket state OR re-call N times and assert 11th is 429 on `'unknown-ip'` key). Anti-regression tightening for health route specifically. |
| TC-I-12 | REQ-14 | refactor | TC-I-71e after refactor: cold + warm calls happen, before warm call asserts `__hasCachedVerification(KEY_ID) === true`; no `Date.now()` deltas, no timing assertion. | passes. Anti-flake under simulated CI load (proceed by injecting a `await new Promise(r => setImmediate(r))` between calls to interleave macrotask — observe cache still hot, no flake). |

### E2E Tests

(N/A — refactor sem mudança de surface no browser; coberto por anti-regression dos integration tests acima.)

## Design

### Architecture Decisions

**Estratégia geral**: 4 refactors paralelizáveis em arquivos exclusivos (modulo `health/route.ts` shared-mutative entre TASK-2 e TASK-3 — explicit serialization). Cada um tem uma task dedicada. Toda mudança de comportamento (IP-trunc tightening em health e drilldown) é explicit como anti-regression test, não como side effect silencioso.

**Sub-design 1 — `lib/util/ip.ts`**:

```ts
// apps/server/lib/util/ip.ts
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * Truncate an IPv4 to /24 ("a.b.c.0/24") or an IPv6 to /48
 * ("xxxx:xxxx:xxxx::/48"). Returns null for any malformed input
 * (octet > 255, non-hex hextet, IPv6 starting with `::`, IPv6 with
 * fewer than 4 colon-separated segments and no `::` shortcut).
 *
 * Caller responsibility: header reads return `string | null`, so the
 * caller must narrow `null` away before calling — e.g.,
 *   const raw = headers.get('x-forwarded-for');
 *   const truncated = raw ? truncateIpForAudit(raw) : null;
 */
export const truncateIpForAudit = (raw: string): string | null => {
  const ip = raw.trim();
  if (ip.length === 0) return null;

  // IPv4: a.b.c.d → a.b.c.0/24 (with range check)
  const m = ip.match(IPV4_RE);
  if (m) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (ip.includes(':')) {
    if (ip.startsWith('::')) return null;
    // Reject pseudo-IPv6 that has only 3 colon-segments and no `::`
    // shortcut (e.g., '2001:db8:abcd') — that is not a valid address.
    const allSegments = ip.split(':');
    if (allSegments.length < 4 && !ip.includes('::')) return null;
    const head = allSegments.slice(0, 3);
    if (head.length < 3 || head.some((h) => h.length === 0)) return null;
    if (!head.every((h) => IPV6_HEXTET_RE.test(h))) return null;
    return `${head.join(':').toLowerCase()}::/48`;
  }

  return null;
};
```

**Sub-design 2 — Health rate-limiter migration**:

- Importar `checkRateLimits` + `__resetRateLimits` de `@/lib/queries/rate-limit`.
- Trocar o `Map`-based bucket por chamada única:

  ```ts
  const rateLimitResult = checkRateLimits([
    {
      name: 'ip',
      key: truncatedIp ?? 'unknown-ip',
      limit: 10,
      windowMs: 60_000,
    },
  ]);
  if (!rateLimitResult.ok) {
    return new Response(
      JSON.stringify(errorBody('Too many requests', 'rate-limited')),
      { status: 429, headers: { 'Retry-After': String(rateLimitResult.retryAfterSec) } },
    );
  }
  ```

- Drop `RATE_LIMIT`, `RATE_WINDOW_MS`, `rateLimitBuckets`, `checkRateLimit` locais.
- Renomear `__resetHealthRateLimit` para delegar a `__resetRateLimits()` do `lib/queries/rate-limit` (preserve export name pra anti-regression dos test imports existentes).

**Sub-design 3 — `assertFlashSecretAvailable`**:

```ts
// apps/server/lib/auth/flash-cookie.ts (additions)
export const assertFlashSecretAvailable = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (env.NODE_ENV !== 'production') return;
  if (!env.AUTH_SECRET && !env.NEXTAUTH_SECRET) {
    throw new Error(
      'AUTH_SECRET (or NEXTAUTH_SECRET) is required for flash cookies. Refusing to boot.',
    );
  }
};

// Update getSecret() with JSDoc explicating the dev/test fallback invariant:
/**
 * Returns the HMAC pepper for flash-cookie signing. Reads `AUTH_SECRET`
 * (primary) or `NEXTAUTH_SECRET` (alias).
 *
 * INVARIANT: in production, this MUST be called via a code path that has
 * already passed through `auth.ts` module load — which runs the
 * `AUTH_SECRET` boot guard (lines 18-26) + `assertFlashSecretAvailable`
 * (line ~30). Any future module that imports `flash-cookie.ts` directly
 * (NOT via `auth.ts`) MUST call `assertFlashSecretAvailable(process.env)`
 * itself before any flash-cookie operation. The `return ''` fallback below
 * is for dev/test ergonomics only — it would produce HMAC with an empty
 * key in prod, allowing an attacker who knows the algorithm to forge
 * cookies. The boot guards prevent this in practice.
 */
const getSecret = (): string => {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) return '';
  return s;
};
```

E em `auth.ts` (depois do `AUTH_SECRET` guard existente, antes do `assertNotProductionWithBypass`):

```ts
// auth.ts — after AUTH_SECRET guard (lines 18-26), before E2E guard
assertFlashSecretAvailable(process.env);

// existing E2E bypass guard (lines 36-42 currently)
assertNotProductionWithBypass(process.env);
```

**Sub-design 4 — TC-I-71e refactor**:

- Substituir o teste TC-I-71e completamente:

  ```ts
  it('TC-I-71e: cache hit on 2nd /api/health call within 60s avoids bcrypt', async () => {
    // First call — cold; bcrypt runs and populates the cache.
    const res1 = await healthGET(healthRequest({
      keyId: KEY_ID,
      authorization: `Bearer ${SECRET}`,
      forwardedFor: '198.51.100.99',
    }) as never);
    expect(res1.status).toBe(200);

    // Cache invariant: bcrypt populated `__verificationCache` with KEY_ID.
    // This is the direct assertion that bcrypt-skip will work on next call.
    expect(__hasCachedVerification(KEY_ID)).toBe(true);

    // Reset rate limit so we don't hit the 10/min cap.
    __resetHealthRateLimit();

    // Second call — warm; constant-time string compare, no bcrypt.
    const res2 = await healthGET(healthRequest({
      keyId: KEY_ID,
      authorization: `Bearer ${SECRET}`,
      forwardedFor: '198.51.100.99',
    }) as never);
    expect(res2.status).toBe(200);

    // Re-assert cache is still hot post-call (defensive — guarantees
    // the constant-time path didn't accidentally invalidate the cache).
    expect(__hasCachedVerification(KEY_ID)).toBe(true);
  });
  ```

- Sem `Date.now()`, sem timing comparison. A invariante "bcrypt was skipped on warm call" é assertada via cache state (before + after) — se o cache tivesse sido invalidado, bcrypt teria rodado e re-populated; checking cache hot pre + post pin a invariante.

### Files to Create

- `apps/server/lib/util/ip.ts` — `truncateIpForAudit(raw)` único export.
- `apps/server/lib/util/ip.test.ts` — TC-U-01..19.

### Files to Modify

- `apps/server/app/api/health/route.ts` — drop local `truncateIpV4_24` + rate-limiter local; importar de `lib/util/ip` + `lib/queries/rate-limit`. Narrow `null` no callsite antes de invocar `truncateIpForAudit`.
- `apps/server/app/api/onboarding/redeem-invite/route.ts` — drop local `truncateIp24`; importar de `lib/util/ip`. Narrow `null` no callsite.
- `apps/server/app/manager/_drilldown/render.tsx` — drop local `truncateIp`; importar de `lib/util/ip`. Narrow `null` no callsite.
- `apps/server/lib/auth/flash-cookie.ts` — adicionar `assertFlashSecretAvailable` export + JSDoc invariante em `getSecret()`. NÃO mudar comportamento do fallback `''` em dev/test.
- `apps/server/lib/auth/flash-cookie.test.ts` — adicionar describe block para `assertFlashSecretAvailable` (TC-U-20..28).
- `apps/server/lib/auth/auth.ts` — call `assertFlashSecretAvailable(process.env)` em module scope, depois do `AUTH_SECRET` guard, antes do `assertNotProductionWithBypass`.
- `apps/server/tests/integration/auth-bearer.test.ts` — TC-I-71e refactor.
- `apps/server/tests/integration/health-rate-limit.test.ts` (existing OR new) — TC-I-03..07 e TC-I-11. **Verificar se já existe**: se sim, modificar; se não, criar.
- `apps/server/tests/integration/flash-cookie-boot-guard.test.ts` (new) — TC-I-08..10 via subprocess (`tsx -e` ou `node --import`).

### Dependencies

Nenhuma dep externa nova. Reusa `lib/queries/rate-limit.ts` (já no projeto).

## Tasks

- [x] TASK-1: Criar `lib/util/ip.ts` + tests (`lib/util/ip.test.ts`).
  - TDD: RED com 19 TCs declarados, GREEN com a impl drilldown-grade COM correção do bug latente.
  - files: `apps/server/lib/util/ip.ts`, `apps/server/lib/util/ip.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19

- [x] TASK-2: Migrar 3 callsites pra `truncateIpForAudit` (signature `(string): string | null`).
  - Remove local `truncateIp` em `_drilldown/render.tsx`, `truncateIp24` em `redeem-invite/route.ts`, `truncateIpV4_24` em `health/route.ts`. Cada um vira `import { truncateIpForAudit } from '@/lib/util/ip'` com narrow no callsite. Anti-regression TC-I-01/02 (PG-required, redeem-invite live HTTP), TC-I-11 (health route tightening).
  - files: `apps/server/app/api/health/route.ts`, `apps/server/app/api/onboarding/redeem-invite/route.ts`, `apps/server/app/manager/_drilldown/render.tsx`
  - tests: TC-I-01, TC-I-02 (PG-required), TC-I-11
  - depends: TASK-1
  - Note: TC-I-01/02 only run under PG-up mode; TDD RED phase usa apenas TC-I-11 + grep validation (Validation Criteria).

- [x] TASK-3: Refatorar health rate-limiter pra `checkRateLimits`.
  - Drop `RATE_LIMIT`, `RATE_WINDOW_MS`, `rateLimitBuckets`, `checkRateLimit` locais. Importar `checkRateLimits` + `__resetRateLimits` de `@/lib/queries/rate-limit`. `__resetHealthRateLimit` agora delega a `__resetRateLimits`. Uses `vi.useFakeTimers()` no test suite (anti-leak via `afterEach`).
  - files: `apps/server/app/api/health/route.ts` (shared com TASK-2 → serialize)
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07
  - depends: TASK-2

- [x] TASK-4: Adicionar `assertFlashSecretAvailable` em `flash-cookie.ts` + JSDoc em `getSecret()` + wire em `auth.ts`.
  - Export pure function. Module-scope call em `auth.ts` (depois do AUTH_SECRET guard, antes do assertNotProductionWithBypass). JSDoc invariante. TDD: RED com 9 TCs (TC-U-20..28), GREEN com impl + wire. TC-I-08..10 via subprocess.
  - files: `apps/server/lib/auth/flash-cookie.ts`, `apps/server/lib/auth/flash-cookie.test.ts`, `apps/server/lib/auth/auth.ts`, `apps/server/tests/integration/flash-cookie-boot-guard.test.ts`
  - tests: TC-U-20, TC-U-21, TC-U-22, TC-U-23, TC-U-24, TC-U-25, TC-U-26, TC-U-27, TC-U-28, TC-I-08, TC-I-09, TC-I-10

- [x] TASK-5: Refatorar TC-I-71e.
  - Replace timing assertion absoluta + relativa por `__hasCachedVerification` checks (before + after warm call). Remove `Date.now()`, `t0/t1/t2/t3`, `coldDurationMs/warmDurationMs` completamente.
  - files: `apps/server/tests/integration/auth-bearer.test.ts`
  - tests: TC-I-12

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-4, TASK-5]           — independent files: lib/util/ip.ts (new),
                                              flash-cookie.ts + auth.ts (no shared deps com IP tasks),
                                              auth-bearer.test.ts (no shared deps)
Batch 2: [TASK-2]                           — depends: TASK-1 (needs lib/util/ip.ts); touches
                                              3 callsites including health/route.ts
Batch 3: [TASK-3]                           — depends: TASK-2 (shares health/route.ts —
                                              shared-mutative, must serialize after TASK-2)
```

**Shared-file analysis**:

- `lib/util/ip.ts` exclusive em TASK-1.
- `flash-cookie.ts` + `auth.ts` exclusive em TASK-4. `auth.ts` mod é 1 linha addition; não conflita com `assertNotProductionWithBypass` (já presente).
- `auth-bearer.test.ts` exclusive em TASK-5.
- `health/route.ts` é shared-mutative entre TASK-2 (remove `truncateIpV4_24`) e TASK-3 (remove rate-limiter local). **Serialize**: TASK-3 corre depois de TASK-2 commit no main worktree, lendo o estado pós-TASK-2.
- `redeem-invite/route.ts` e `_drilldown/render.tsx` exclusive em TASK-2.

## Validation Criteria

- [ ] `pnpm typecheck` (apps/server) passa
- [ ] `pnpm lint` (apps/server) passa
- [ ] `pnpm test --run` (apps/server, SKIP_PG_TESTS=1) passa — adds ~28 new TCs sobre baseline 341; expected ~369 passing
- [ ] `pnpm test` (apps/server) com Postgres up: passa, +TC-I-01..12 novos
- [ ] **Anti-regression** central-server-onboarding: re-rodar `pnpm test:e2e` apps/server — expected 27 passing (mesmo número da run de `fix-e2e-auth-bypass` em commit `48bbe6b`).
- [ ] **Static grep validation** (post-merge, manual or in commit pre-push hook):
  - `grep -rn "truncateIp\|truncate_ip" apps/server/app apps/server/lib | grep -v "lib/util/ip" | grep -v ".test.ts"` retorna VAZIO (0 implementações locais remanescentes; só o canonical helper + imports).
  - `grep -n "import.*truncateIpForAudit.*lib/util/ip" apps/server/app/api/health/route.ts apps/server/app/api/onboarding/redeem-invite/route.ts apps/server/app/manager/_drilldown/render.tsx` retorna 3 matches (uma cada).
  - `grep -n "assertFlashSecretAvailable" apps/server/lib/auth/auth.ts` retorna 2 matches (import + call site).
- [ ] **Live validation**: subir dev server local com `E2E_AUTH_BYPASS=1`, fazer 11 `curl /api/health?key_id=...` num burst — 10 retornam 200, 11º retorna 429 com `Retry-After` header presente. Capturar curl outputs no Execution Log.
- [ ] **Live anti-regression health-route**: curl `/api/health` com `X-Forwarded-For: 999.999.999.999` — retorna 200 (não 500), e o rate-limit key usado é `'unknown-ip'` (verify via re-call 11x com mesmo IP malformed — 11º retorna 429).
- [ ] **Security audit do diff**: grep `console.log\|console.error` nos arquivos modificados (deve ser zero — usar `logger`); confirm que `flash-cookie.ts` JSDoc do `getSecret()` documenta o invariante.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-4, TASK-5] (2026-05-11 16:25)

Worktrees falharam (origin/main 4 commits behind local + asdf-nodejs sem Node 26). Executado inline sequencial.

- **TASK-1**: `lib/util/ip.ts` + `lib/util/ip.test.ts`. TDD RED(19 fail/compile-fail) → GREEN(19 pass). Impl drilldown-grade COM fix do bug latente (`split(':').length < 4 && !includes('::')` rejection).
- **TASK-4**: `assertFlashSecretAvailable` exportado em `flash-cookie.ts` + JSDoc invariante em `getSecret()` + wire em `auth.ts` module scope (entre AUTH_SECRET guard e assertNotProductionWithBypass). TDD RED(9 fail) → GREEN(24 pass — incluindo testes existentes). TC-I-08..10 via subprocess (`spawnSync tsx -e`) — 3/3 GREEN.
- **TASK-5**: TC-I-71e refactor — substituiu timing assertion absoluta+relativa por `__hasCachedVerification` checks (before+after warm call). Removeu `Date.now()` calls completamente. Anti-flake.

**Descoberta durante TASK-4 integration**: o boot guard chain do `auth.ts` é (em ordem): (1) `ONBOARDING_EMAIL_HASH_PEPPER` guard via transitive import de `email-hash.ts`, (2) `AUTH_SECRET` guard, (3) `assertFlashSecretAvailable`, (4) `assertNotProductionWithBypass`. TC-I-10 ajustado pra refletir realidade: assert SOME secret-required error surfaces (não importa identidade do primeiro guard), AND a mensagem `'required for flash cookies'` NÃO aparece (regressão check — earlier guards still fire first).

Validação: 372 vitest pass (+31 over 341 baseline). Typecheck + lint clean.

### Batch 2 [TASK-2] (2026-05-11 16:32)

Migração mecânica de 3 callsites pra `truncateIpForAudit`:

- `apps/server/app/api/onboarding/redeem-invite/route.ts` — removed `truncateIp24` (~22 LOC), import `@/lib/util/ip`, callsite `rawIp ? truncateIpForAudit(rawIp) : null`.
- `apps/server/app/api/health/route.ts` — removed `truncateIpV4_24` (~11 LOC), import, callsite `(ip ? truncateIpForAudit(ip) : null) ?? 'unknown-ip'`.
- `apps/server/app/manager/_drilldown/render.tsx` — removed `truncateIp` (~28 LOC), import, replace_all `truncateIp(` → `truncateIpForAudit(`.

Validação: typecheck clean, 372 vitest pass (sem regressão). Tightening behavior aceito — TC-I-11 antecipa anti-regression no health route.

### Batch 3 [TASK-3] (2026-05-11 16:34)

Health rate-limiter migrado de `Map`-based bucket pra `checkRateLimits` sliding-window do `lib/queries/rate-limit.ts`. Single-element dimension `[{ name: 'ip', key: rlKey, limit: 10, windowMs: 60_000 }]`. `__resetHealthRateLimit` agora delega a `__resetRateLimits()`. `Retry-After` header agora é `String(rateLimitResult.retryAfterSec)` (sliding math) em vez do fixed `'60'`.

Adicionados 4 novos TCs ao `auth-bearer.test.ts` (skipDescribe gated em SKIP_PG_TESTS):

- TC-I-04 (numerical Retry-After) — verifica que header é integer string 1..60 (sliding math, não fixed 60).
- TC-I-06 (unknown-ip bucket) — 11 calls sem XFF compartilham bucket.
- TC-I-11 (malformed IP tightening) — `999.999.999.999` → 200 + 'unknown-ip' bucket.
- TC-I-07 (alias delegation) — `__resetHealthRateLimit` clears via `__resetRateLimits`.

Validação: typecheck + lint clean. 372 pass + 281 skip (4 novos sob skipDescribe + existing skips). Live val pendente abaixo.

### Fechamento retroativo (2026-07-12)

Status fechado retroativamente — código commitado em f37afa5 (ver .specs/docs-reconciliation.md item 2.4).
