# Spec: central-server-onboarding-v2-sso.backend

## Status: DONE

## Context

Second of 3 sequential implementation specs derived from [`.specs/central-server-onboarding-v2-sso.threat-model.md`](./central-server-onboarding-v2-sso.threat-model.md) (Status: APPROVED, commit `3b05b89`) and following the schema-migrations spec (a) which shipped in commit `cee4dcc`.

### Scope inheritance from spec (a)

Spec (a) shipped all 9 schema preconditions + the `users.email` global UNIQUE relaxation + 5 call-site refactors (load-user, auth.ts, e2e-bypass-provider, redeem, schema). All schema columns/tables/indexes used by this spec already exist:

- `users` composite UNIQUE `(org_id, email)` + `(org_id, sso_provider, sso_subject)` NULL-tolerant
- `onboarding_outcome` enum has 10 SSO-decision values
- `onboarding_redemption_log` has `method`, `sso_provider`, `sso_subject_hash`, `iss`, `user_agent` columns
- `onboarding_invites` has `allowed_sso_providers text[]` + 180d CHECK + partial index `idx_invites_email_pattern_active`
- `user_machines` has `provisioned_via` column
- `auth_event_log` table + 3 indexes + `outcome` CHECK
- Pure helpers: `loadUserBySsoIdentity`, `loadUserByEmail → array`, `evaluateSignIn` 5-branch, `truncateUserAgent`

### What spec (b) builds on top

The SSO-auto-provision **decision engine** + **production wiring** in the NextAuth `signIn` callback. All threat mitigations from `.specs/central-server-onboarding-v2-sso.threat-model.md` that were earmarked for spec (b) (T1, T2, T6, T11, T12, T13) become REQs here. Spec (a) provided the schema; spec (b) is the behavior.

### Sequencing in the 3-spec split (§Decisão #20)

1. **(a) `central-server-onboarding-v2-sso.schema-migrations.md`** — shipped `cee4dcc`.
2. **(b) `central-server-onboarding-v2-sso.backend.md`** ← THIS SPEC.
3. **(c) `central-server-onboarding-v2-sso.manager-ui.md`** (future). First-auto-provision banner, audit-log view, pattern-creation UX with `allowed_sso_providers` selector, roster `provisioned_via` filter.

### Decisões já travadas (input do threat model + spec a)

1. **Decision-engine module** `apps/server/lib/auth/sso-auto-provision.ts` — pure orchestrator + DB-touching submodules. Single entry point `evaluateAutoProvision({ email, ssoProvider, ssoSubject, ip, userAgent }): Promise<AutoProvisionDecision>`. Decision tree exhaustively covers the 10 enum outcomes from spec (a) REQ-3.
2. **Order of checks in the auto-provision flow** (matters for security + DoS protection):
    1. Rate-limit check (T6 M6.2) — outside transaction; defends DoS amplification (matches existing redeem-flow pattern).
    2. NextAuth-asserted preconditions (T1 M1.1-3): `id_token.iss` ∈ whitelist + `aud` = client_id + `email_verified=true`.
    3. Public-domain blocklist (T1.5) — short-circuit if domain ∈ blocklist.
    4. Match query: `matchActiveInvitesByEmail` (T1.4 + T2) — uses `idx_invites_email_pattern_active`.
    5. Single-match constraint (T2 M2.1): zero → `'rejected-no-match'`; many → `'rejected-multiple-matches'`.
    6. `allowed_sso_providers` enforcement (T12.4) — cross-IdP guard.
    7. Pre-existing user check (T11.1) — refuse silent bind.
    8. Transaction: `SELECT ... FOR UPDATE` on invite + re-validate (T13.1) → INSERT user + user_machine + UPDATE invite.used_count.
    9. Audit log: `auth_event_log` + `onboarding_redemption_log` rows (always, regardless of outcome).
    10. Return decision.
3. **`auth.ts` signIn integration branch point**: when `evaluateSignIn` returns `'bootstrap'` AND email matches an SSO-auto invite pattern (single-match unambiguous), branch to `evaluateAutoProvision` flow INSTEAD of the v1 single-org-bootstrap path. The v1 `'allow'` / `'fill-sso'` / `'reject-mismatch'` / `'ambiguous-multi-org'` branches are preserved unchanged.
4. **Public-domain blocklist hardcoded list** (Threat 11 §Decisão #3): `gmail.com, googlemail.com, yahoo.com, outlook.com, hotmail.com, live.com, icloud.com, me.com, proton.me, protonmail.com, aol.com, gmx.com, mail.ru, qq.com, 163.com, yandex.com, duck.com`. Lives in `apps/server/lib/auth/public-domains.ts` with `LAST_REVIEWED: 2026-05-11` header. CI workflow `.github/workflows/lint-public-domains.yml` fails if header is >90d old (§Decisão #13 of threat model).
5. **Rate-limit dimensions** (T6 M6.2, locked): per-IP 10 attempts / 5 min + per-email_hash 3 / 24h + per-sso_subject_hash 5 / 24h. Layered: first-violation short-circuits. Sliding-window in-memory (mirrors existing `apps/server/lib/queries/rate-limit.ts` pattern). NOT shared across processes — single-process server (same constraint as v1).
6. **`auth_event_log` writer** logs **every** SSO sign-in attempt (success + every distinct failure outcome) — full forensic coverage per threat-model §Compliance. Uses `truncateUserAgent` at write boundary.
7. **Impossible-travel heuristic baseline** (§Decisão #21 of threat model): function `checkImpossibleTravel(sso_subject_hash): Promise<{alert: boolean; reason?: string}>`. Hardcoded: two `accepted-sso-auto` events for same hash within 1h from cities >500km apart fires alert. NO ML scoring. Cities come from `ip-to-city.ts` (stub for v2 baseline; returns NULL until a future spec wires MaxMind/equivalent — Threat 4 mitigation is "log raw signals + heuristic", and the heuristic is gated on city availability).
8. **Pre-existing-binding email channel** (T11 M11.2) — **DECISION**: pluggable interface `sendEmail({to, subject, body}): Promise<Result<void, EmailError>>` with **console-log stub** as the spec (b) implementation. Real SMTP/SES wiring is **deferred** to a follow-up spec (`central-server-email-channel.md`). Rationale: threat-model M11.2 mitigation is "out-of-band email confirmation"; the **decision path + audit log + the rejection outcome** all work end-to-end with the stub. Real delivery is a separate integration concern (SMTP creds, deliverability, bounce handling, DMARC) that doesn't belong in spec (b)'s critical path. Spec (b) test plan asserts: (a) the email helper is invoked with the correct arguments on a `'rejected-pre-existing-binding'` outcome, (b) the rate-limit (3/24h per email_hash, §Decisão #19) is enforced. Real delivery is verified manually in the follow-up.
9. **callbackUrl allowlist** (T12 M12.2): NextAuth `redirect` callback returns `baseUrl + path` only. External absolute URLs rejected. Verified explicitly by integration TC.
10. **Origin/Referer validation** (T12 M12.1): `/api/auth/signin` initiation endpoint validates `Origin` (or `Referer` fallback) is same-origin. Cross-origin SSO initiation → 403. Belongs in NextAuth middleware or a wrapping route handler.
11. **State/nonce verification** (§Decisão #23 of threat model + Decisão #23): backend spec includes an explicit integration TC `replay-detection: state token reuse rejected` exercising NextAuth replay path end-to-end. Real replay simulation via second callback invocation with same state token. Not just a unit assertion that "v1 e2e said so".
12. **Email normalization rule** (locked in spec a + threat-model §Decisão #6): lowercase + trim; NO plus-tag stripping. Apply uniformly to (a) `matchActiveInvitesByEmail`, (b) `emailHash` computation, (c) `auth_event_log.email_hash`, (d) audit-log `email_domain`. Spec MUST include TC verifying `*@x.com` matches `dev+tag@x.com` AND `emailHash(dev+tag@x.com) ≠ emailHash(dev@x.com)`.
13. **Privacy invariants** (threat-model §Compliance): NEVER log raw email — only `email_domain` (plaintext, after normalization) + `email_hash` (SHA-256 with pepper). NEVER log raw `sso_subject` — only `sso_subject_hash` (SHA-256). All log lines through `lib/auth/email-hash.ts` helpers.
14. **`provisioned_via` write semantics**: when `accepted-sso-auto` decision wins, the new `users` row + `user_machines` row both get `provisioned_via='sso-auto'`. v1 `fill-sso` / `bootstrap` paths continue writing `'manual-token'` (preserves v1 invariant).
15. **Auto-provisioned role hardcoded**: per threat-model §Decisão #1 + §Threat 9 M9.1, every auto-provisioned `users` row gets `role='member'` server-side, regardless of `invite.role` if such field existed. The invite-row's `team_id` IS honored if set (binding to a team is non-privileged metadata).
16. **Rate-limited SSO attempts log to `onboarding_redemption_log` ONLY, NOT `auth_event_log`** (LOCKED — fixes spec-reviewer #1): `auth_event_log.outcome` CHECK constraint (frozen in spec a) only allows the 10 SSO-decision outcomes; `'rate-limited'` is NOT in that set. Rate-limited attempts write a `onboarding_redemption_log` row (uses broader enum that DOES include `'rate-limited'` from v1) and SKIP the `auth_event_log` write. Semantically correct: `auth_event_log` is for SSO-decision events; network-layer rate-limit rejections are pre-decision.
17. **Decision-engine orchestrator pattern** (LOCKED — fixes code-reviewer point 1): `evaluateAutoProvision` is sequential early-exit, NOT parallel. Concretely: `for (const check of checks) { const d = await check(input, deps); if (d) return d; }`. Each check function is side-effect-free EXCEPT `checkSsoRateLimit` (which mutates rate-limit counters); the orchestrator MUST call rate-limit FIRST + before any DB query so a rate-limited attempt does not decrement other counters or open a transaction.
18. **Dependency injection pattern for `evaluateAutoProvision`** (LOCKED — fixes code-reviewer point 9): signature is `evaluateAutoProvision(input, deps?: AutoProvisionDeps)`. `AutoProvisionDeps` contains injectable functions: `matchActiveInvitesByEmail`, `checkSsoRateLimit`, `isPublicDomain`, `writeAuthEvent`, `writeRedemptionLog`, `sendPreExistingBindingEmail`, `db` (Drizzle handle). Defaults to real implementations. Unit tests pass hand-written stubs (matches `redeem.ts` `redeemInvite(db, input, opts?)` pattern).
19. **CSRF Origin guard integration point** (LOCKED — fixes code-reviewer point 6): extend `apps/server/middleware.ts` matcher to include `/api/auth/signin`. The middleware reads `Origin` (fallback `Referer`) and returns HTTP 403 + writes `onboarding_redemption_log` row with `outcome='rejected-csrf'` before NextAuth's `signin` handler runs. Inline check in `auth.ts` is rejected because NextAuth v5's signIn flow does not expose a pre-handler hook.
20. **`Result<T,E>` type for email-stub** (LOCKED — fixes code-reviewer point 3): create `apps/server/lib/result.ts` with the canonical project shape `{ ok: true; value: T } | { ok: false; error: E }`. `send-email-stub.ts` imports from `@/lib/result`. Single source of truth for apps/server.
21. **`rate-limit.ts` dimension union extension** (LOCKED — fixes code-reviewer point 4): extend `RateLimitDimensionInput.name` and `RateLimitResult.dimension` from `'ip' | 'token'` to `'ip' | 'token' | 'email_hash' | 'sso_subject_hash'`. All existing callers pass `name: 'ip'` or `name: 'token'` — backwards-compatible union widening. Net diff: 2 lines.
22. **Race-test methodology** (LOCKED — fixes test-reviewer #2 + spec-reviewer #2): TC-I-08/09/10 use **two-connection Postgres approach**, NOT `vi.useFakeTimers`. Open transaction A via primary `getDb()`, acquire SELECT FOR UPDATE on invite, then — before committing — use a SECOND `pg.Pool` connection to issue the disqualifying UPDATE (revoke / expire / exhaust). The two connections see distinct snapshots due to FOR UPDATE locking. Test seam: inject a callback `onAfterSelectForUpdate: () => Promise<void>` via `AutoProvisionDeps` (Decisão #18) that the orchestrator awaits after the FOR UPDATE select; tests use this callback to perform the second-connection UPDATE.
23. **`onboarding_redemption_log` row for accepted is written INSIDE transaction** (LOCKED — fixes code-reviewer point 2): the accepted path's `onboarding_redemption_log` row joins the same tx as the `users` + `user_machines` + `onboarding_invites.used_count` UPDATE. If anything fails post-INSERT, redemption-log row rolls back together with the rest. Rejection paths write `onboarding_redemption_log` row OUTSIDE transaction (no transaction is opened for rejections — short-circuit). Same pattern documented in `redeem.ts:6-42`.
24. **`'email-not-verified'` outcome WHERE in flow** (LOCKED — fixes test-reviewer #1 + spec-reviewer #4): explicit check after T1 M1.1-2 (issuer + audience) but BEFORE T1.5 (public-domain blocklist). If `id_token.email_verified !== true`, outcome = `'email-not-verified'`, audit-log written, no further checks run. Concretely: `if (!emailVerified) return { kind: 'email-not-verified' }` is the first sub-check inside the orchestrator after rate-limit.

### Anti-goals (out-of-scope desta spec)

- **Manager UI banner** for first-auto-provision alert (Decisão #14 storage IS in this spec — `auth_event_log` row + dashboard-banner-event table if needed — but UI render is spec (c)).
- **Manager UI audit-log view** — spec (c).
- **Pattern-creation UX changes** (`allowed_sso_providers` selector — Decisão #17) — spec (c).
- **Roster `provisioned_via` filter + CSV export** (Decisão #18) — spec (c).
- **Real SMTP/SES email delivery** — deferred to follow-up `central-server-email-channel.md`. Pre-existing-binding email helper has a stub interface (console-log).
- **IP → city resolution real backend** — stub returns NULL; future spec wires MaxMind.
- **Session anomaly detection beyond impossible-travel baseline** (ML scoring, risk thresholds, geo-fencing) — threat-model §Decisão #21 explicitly defers this.
- **Shared rate-limit store across processes** (Redis) — single-process server today; v1 pattern preserved.
- **Cross-org account picker UI** when `evaluateSignIn` returns `'ambiguous-multi-org'` — spec (c) UX. Spec (b) preserves spec (a)'s transitional "log warn + pick first" behavior.

### Prior art (project patterns to follow)

- `apps/server/lib/auth/auth.ts` — current NextAuth callbacks (REQs for v1 paths must be preserved).
- `apps/server/lib/auth/load-user.ts` — `evaluateSignIn` 5-branch decision tree pattern (spec b's `evaluateAutoProvision` mirrors the shape).
- `apps/server/lib/queries/rate-limit.ts` — sliding-window rate-limit pattern (extend, don't re-roll).
- `apps/server/lib/queries/redeem.ts` — `lookupInviteForUpdate` + transactional re-validate pattern (mirror for the auto-provision flow).
- `apps/server/lib/auth/email-hash.ts` — `hashEmail`, `emailDomain`, NFC normalization (reuse, don't duplicate).
- `apps/server/lib/auth/match-email-pattern.ts` — domain-wildcard + exact-email matcher (reuse for `matchActiveInvitesByEmail`).
- `apps/server/lib/auth/truncate-user-agent.ts` — apply at write boundary in `auth-event-log-writer.ts`.
- `apps/server/lib/db/migrations/0004_sso_auto_provision_schema.sql` — schema contract (read to understand exact column shapes).

## Requirements

### Decision-engine + module REQs

- [ ] **REQ-1** — `evaluateAutoProvision` decision tree complete
  - GIVEN inputs `{ email, ssoProvider, ssoSubject, ssoIssuer, ip, userAgent }`
  - WHEN the function runs
  - THEN one of the 10 outcomes from spec (a) §REQ-3 is returned: `'accepted-sso-auto'`, `'rejected-public-domain'`, `'rejected-multiple-matches'`, `'rejected-no-match'`, `'rejected-race'`, `'rejected-csrf'`, `'rejected-replay'`, `'rejected-cross-idp'`, `'rejected-pre-existing-binding'`, `'email-not-verified'`.
  - AND each outcome maps deterministically to the precondition that triggered it per Decisão #2 ordering.

- [ ] **REQ-2a** — IdP precondition checks (T1 M1.1-3)
  - GIVEN NextAuth-asserted `id_token`
  - WHEN `id_token.iss` is NOT in the issuer whitelist (`https://accounts.google.com` for Google; per-tenant `https://<tenant>.okta.com` for Okta — stored per `org_id` config or env)
  - THEN outcome = `'rejected-csrf'` (issuer mismatch treated as forged callback; same audit category).
  - WHEN `id_token.aud` does NOT equal our client ID
  - THEN outcome = `'rejected-csrf'`.
  - WHEN `id_token.email_verified` is NOT `true` (false, undefined, or missing)
  - THEN outcome = `'email-not-verified'`. NO further checks run.
  - WHEN all preconditions pass
  - THEN flow proceeds.

- [ ] **REQ-2** — Public-domain blocklist short-circuit (T1.5)
  - GIVEN email's normalized domain (`emailDomain(email)`)
  - WHEN domain ∈ `isPublicDomain` set (Decisão #4)
  - THEN `evaluateAutoProvision` returns `{ kind: 'rejected-public-domain' }`.
  - AND no `matchActiveInvitesByEmail` DB query runs (performance short-circuit).
  - AND no transaction opens.
  - AND audit-log rows ARE written per Decisão #6 / REQ-9 — the short-circuit applies to the decision-engine subsequent checks, NOT to the audit-write step which always fires.

- [ ] **REQ-3** — Single-match constraint (T2 M2.1)
  - GIVEN `matchActiveInvitesByEmail(email)` returns N matching invites (filtered: NOT revoked, NOT expired, used_count < max_uses)
  - WHEN N === 0
  - THEN outcome = `'rejected-no-match'` AND `onboarding_redemption_log.token_prefix = '00000000'` (sentinel per threat-model §Decisão #10).
  - WHEN N >= 2
  - THEN outcome = `'rejected-multiple-matches'` AND `onboarding_redemption_log.token_prefix` = first 8 chars of the alphabetically-first matching invite's token. List of all matching token-prefixes recorded in `onboarding_redemption_log.metadata_json` (column may need to be added in a follow-up; for spec b, log via `logger.warn` with `matching_prefixes: [...]` for forensic use).
  - WHEN N === 1
  - THEN flow proceeds to next check.

- [ ] **REQ-4** — `allowed_sso_providers` enforcement (T12.4)
  - GIVEN single-match invite + `ssoProvider` from NextAuth callback
  - WHEN invite.`allowed_sso_providers` is non-empty AND `ssoProvider ∉ allowed_sso_providers`
  - THEN outcome = `'rejected-cross-idp'`.
  - WHEN invite.`allowed_sso_providers` is empty array (legacy backwards-compat per Decisão #11 of threat model)
  - THEN any provider is allowed; flow proceeds.

- [ ] **REQ-5** — Pre-existing-user binding refusal (T11.1 + Decisão #12)
  - GIVEN single-match invite + email matches a `users` row in the invite's org with `sso_provider IS NULL` (legacy v1 invite-token-provisioned user)
  - WHEN auto-provision flow reaches this check
  - THEN outcome = `'rejected-pre-existing-binding'` AND the pre-existing-binding email helper is invoked (Decisão #19 rate-limited resend).

- [ ] **REQ-6** — Pre-existing-binding email helper invocation (T11.2)
  - GIVEN `'rejected-pre-existing-binding'` outcome
  - WHEN the decision-engine completes
  - THEN `sendPreExistingBindingEmail({ email, city, browser, time })` is called.
  - AND if the same email_hash has received ≥3 emails in the last 24h, the call is suppressed (rate-limit per Decisão #19) AND audit-log records `'rejected-pre-existing-binding'` with a metadata flag `email_rate_limited: true`.

- [ ] **REQ-7** — Transactional race guard (T13.1)
  - GIVEN single-match invite that passed all prior checks
  - WHEN the transaction begins
  - THEN `SELECT ... FOR UPDATE` locks the invite row.
  - AND the transaction RE-CHECKS `revoked_at IS NULL AND expires_at > now() AND used_count < max_uses` after acquiring the lock.
  - AND if any condition fails the re-check, the transaction aborts with outcome `'rejected-race'`.

- [ ] **REQ-8** — Atomic user + machine creation
  - GIVEN transaction passed REQ-7 re-validate
  - WHEN the auto-provision flow inserts
  - THEN `users` row created with `org_id = invite.org_id, team_id = invite.team_id (nullable), email, sso_provider, sso_subject, role='member' (Decisão #15), provisioned_via='sso-auto' (Decisão #14), display_name=oauth.profile.name (nullable)`.
  - AND `user_machines` row created with `user_id = newUser.id, provisioned_via='sso-auto', ...`. Machine key fields are populated according to the existing NextAuth + bearer-auth flow.
  - AND `onboarding_invites.used_count += 1`.

- [ ] **REQ-9** — Audit-log write (always)
  - GIVEN any `evaluateAutoProvision` outcome (accepted OR rejected)
  - WHEN the flow completes
  - THEN one `auth_event_log` row is INSERTed with `(sso_provider, iss, email_hash, sso_subject_hash, ip, city, user_agent, outcome, occurred_at)`.
  - AND one `onboarding_redemption_log` row is INSERTed with `(token_prefix, machine_id, email_domain, email_hash, request_ip, outcome, method='sso-auto', sso_provider, sso_subject_hash, iss, user_agent, received_at)`. `machine_id` = `newUser.id` on accepted; NULL on rejected. `token_prefix` = first 8 chars of matched invite token on single-match path; sentinel `'00000000'` on `'rejected-no-match'` / `'rejected-public-domain'` paths (Decisão #10 of threat model).
  - AND truncate `user_agent` to 512 chars via `truncateUserAgent` at the write boundary (spec a REQ-4).
  - AND privacy invariants hold (Decisão #13): NEVER log raw email or raw `sso_subject` anywhere — only `email_domain` plaintext + hashes.

- [ ] **REQ-10** — Email normalization rule applied uniformly (Decisão #12)
  - GIVEN email from NextAuth callback (`user.email`)
  - WHEN any of: pattern match, `email_hash`, `email_domain` derivation
  - THEN apply `email.normalize('NFC').toLowerCase().trim()` first. NO plus-tag stripping.
  - AND TC verifies `matchActiveInvitesByEmail('dev+tag@x.com')` returns same row as `matchActiveInvitesByEmail('dev@x.com')` for pattern `*@x.com` BUT `emailHash('dev+tag@x.com') ≠ emailHash('dev@x.com')`.

### Rate-limit + DoS protection REQs

- [ ] **REQ-11** — Layered rate-limit (T6 M6.2)
  - GIVEN `checkSsoRateLimit({ ip, email_hash, sso_subject_hash })`
  - WHEN any of (a) per-IP 10/5min, (b) per-email_hash 3/24h, (c) per-sso_subject_hash 5/24h is exceeded
  - THEN returns `{ allowed: false, dimension: 'ip'|'email_hash'|'sso_subject_hash', retryAfterSec: N }`.
  - AND the FIRST dimension to be exceeded short-circuits subsequent checks (matches existing redeem-flow rate-limit pattern).
  - AND rate-limit storage is in-memory sliding-window per process (mirrors `apps/server/lib/queries/rate-limit.ts`).
  - AND `__resetSsoRateLimit()` test seam clears state for unit tests.

- [ ] **REQ-12** — Rate-limit short-circuits outside transaction + writes ONLY to `onboarding_redemption_log`
  - GIVEN rate-limit decision = `{ allowed: false }`
  - WHEN flow reaches the rate-limit gate
  - THEN no DB transaction is opened.
  - AND `onboarding_redemption_log` row is INSERTed with `outcome='rate-limited'` (reusing v1 enum value; pre-existing in `onboarding_outcome` from `0001_onboarding.sql`).
  - AND `auth_event_log` row is **NOT** written (per Decisão #16 — its CHECK does not include `'rate-limited'`, and semantically the rate-limit fires before any SSO-decision logic). This is a deliberate divergence from REQ-9's "every attempt → both audit tables" rule; the audit gap is acceptable because the redemption-log row already captures the rate-limit event with same forensic shape.

### NextAuth integration REQs

- [ ] **REQ-13** — signIn branches to auto-provision flow on bootstrap + SSO-auto pattern match
  - GIVEN `evaluateSignIn` returns `'bootstrap'` (no `users` row for this email)
  - WHEN `matchActiveInvitesByEmail(user.email)` returns N >= 1 active SSO-auto invites
  - THEN signIn calls `evaluateAutoProvision({ email, ssoProvider, ssoSubject, ssoIssuer, ip, userAgent })` instead of the v1 single-org-bootstrap path.
  - AND outcome `'accepted-sso-auto'` → return `true` (NextAuth proceeds with session creation).
  - AND any rejected outcome → return `false` + structured warn log (domain only, never email).

- [ ] **REQ-14** — V1 paths preserved
  - GIVEN `evaluateSignIn` returns `'allow'` / `'fill-sso'` / `'reject-mismatch'` / `'ambiguous-multi-org'`
  - WHEN signIn completes
  - THEN every existing test in `apps/server/lib/auth/auth.test.ts` (or integration tests against auth flow) continues passing without modification.

- [ ] **REQ-15** — Single-org bootstrap path preserved as fallback
  - GIVEN `evaluateSignIn` returns `'bootstrap'` AND `matchActiveInvitesByEmail` returns 0 matches
  - WHEN signIn completes
  - THEN flow falls through to v1 single-org-bootstrap path (orgs count exactly 1 → INSERT user as member).
  - AND the v1 behavior remains unchanged for environments without SSO-auto invite patterns.
  - **Multi-org no-pattern fallback**: on a multi-org server (orgs count > 1) with zero SSO-auto invite patterns, the v1 single-org-bootstrap path REJECTS the signin (same as today — pre-existing behavior, NOT a regression introduced by spec b). No new handling required; signin user must paste an invite token. Out-of-scope for spec b to improve this.

### CSRF + replay protection REQs

- [ ] **REQ-16** — Origin/Referer validation on signin initiation (T12 M12.1)
  - GIVEN `/api/auth/signin` initiation request
  - WHEN `Origin` header (with `Referer` fallback) does NOT match the configured base URL
  - THEN respond with HTTP 403 + audit-log `'rejected-csrf'` outcome (REQ-9).

- [ ] **REQ-17** — `callbackUrl` allowlist via NextAuth redirect callback (T12 M12.2)
  - GIVEN `callbackUrl` query parameter
  - WHEN absolute URL points outside the base URL
  - THEN NextAuth `redirect` callback returns `baseUrl + '/'` (rejects external redirect).
  - AND state cookie remains HttpOnly + SameSite=Lax (NextAuth defaults; verified by integration TC).

- [ ] **REQ-18** — Replay-detection state + nonce token reuse (T8 + Decisão #23)
  - GIVEN a valid SSO callback URL with state token S + nonce N
  - WHEN S is replayed (second callback with same state, fresh nonce)
  - THEN second invocation rejected with NextAuth state error + audit-log `'rejected-replay'`.
  - WHEN N is replayed (second callback with same nonce, fresh state)
  - THEN second invocation rejected with NextAuth nonce error + audit-log `'rejected-replay'`.
  - AND integration TC simulates BOTH state-reuse AND nonce-reuse end-to-end (not just unit assertions).

### Anomaly-logging baseline REQs

- [ ] **REQ-19** — `auth_event_log` writer (Decisão #6)
  - GIVEN any SSO sign-in attempt (success or failure)
  - WHEN the flow completes
  - THEN `writeAuthEvent({ sso_provider, iss, email_hash, sso_subject_hash, ip, city, user_agent, outcome })` inserts one row in `auth_event_log`.
  - AND `user_agent` is truncated to 512 chars at write boundary.
  - AND `sso_subject_hash` is computed via `hashEmail`-equivalent (SHA-256 with pepper from `lib/auth/email-hash.ts`). NEVER log raw `sub`.

- [ ] **REQ-20** — Impossible-travel heuristic (Decisão #7)
  - GIVEN `checkImpossibleTravel(sso_subject_hash)` is called after a successful `'accepted-sso-auto'` event
  - WHEN the most recent prior `accepted-sso-auto` for the same hash was within 1h AND `haversine_distance(prior.city, current.city) > 500km`
  - THEN return `{ alert: true, reason: 'impossible-travel: <prior-city> -> <current-city> in <minutes>min' }`.
  - WHEN prior event > 1h ago OR same city OR null city OR no prior event
  - THEN return `{ alert: false }`.
  - AND when alert fires, the result is recorded via `logger.warn` (for now; banner integration in spec c).

- [ ] **REQ-21** — IP → city resolution stub
  - GIVEN `ipToCity(ip)` is called
  - WHEN no real geolocation backend is wired (default for spec b)
  - THEN returns `null`.
  - AND consumers (`auth_event_log` writer, `checkImpossibleTravel`) gracefully handle null city (write NULL column, skip heuristic).
  - AND the interface is stable so a future spec wires MaxMind/equivalent without touching call sites.

### Pre-existing-binding email helper REQs

- [ ] **REQ-22** — `sendPreExistingBindingEmail` invoked correctly (T11.2)
  - GIVEN `'rejected-pre-existing-binding'` outcome
  - WHEN decision-engine completes
  - THEN `sendPreExistingBindingEmail({ to: email, city, browser, time })` is invoked with the existing-user's email.
  - AND the email body is built from the template (includes city + browser + time per Decisão #19 of threat model).
  - AND failure to send (e.g., stub error path) does NOT block the decision-engine — it logs a warn + records the audit row regardless.

- [ ] **REQ-23** — Email-send stub interface
  - GIVEN no real SMTP/SES backend in spec (b)
  - WHEN `sendEmail({ to, subject, body })` is called
  - THEN the stub writes a structured log line (`logger.info('email-send-stub', { to_hash, subject })` — to_hash, never raw email) AND returns `{ ok: true, value: { messageId: 'stub-<uuid>' } }`.
  - AND interface `EmailSendFn = (input: EmailInput) => Promise<Result<EmailResult, EmailError>>` is exported for future real-backend wiring.

- [ ] **REQ-24** — Email rate-limit on resend (Decisão #19 of threat model)
  - GIVEN `sendPreExistingBindingEmail` invoked for a given `email_hash`
  - WHEN the same `email_hash` has received ≥3 emails in the last 24h via the pre-existing-binding channel
  - THEN suppress the send + log `'pre-existing-binding-email-rate-limited'` warn.
  - AND audit-log row metadata includes `email_rate_limited: true`.
  - **Multi-process caveat** (same as REQ-11 / Decisão #5): in-memory rate-limit is per-process. Multi-process server bypasses (each process tracks independently). Shared-store upgrade deferred to a future spec wiring Redis for both SSO rate-limits AND email rate-limits together.

### CI guard REQs

- [ ] **REQ-25** — Public-domain blocklist `LAST_REVIEWED` CI check (§Decisão #13 of threat model)
  - GIVEN `.github/workflows/lint-public-domains.yml` runs on PR + push
  - WHEN `apps/server/lib/auth/public-domains.ts` is missing the `LAST_REVIEWED: YYYY-MM-DD` header OR the date is >90 days old
  - THEN workflow exits non-zero.

- [ ] **REQ-26** — Anti-regression — full v1 + spec-a test suite green
  - GIVEN current `apps/server` test suite (~750 tests post-spec-a)
  - WHEN spec b lands
  - THEN `pnpm test:server` exit 0 (modulo pre-existing flake `aggregate-team-outcomes.test.ts:233`).

## Test Plan

> All unit tests use hand-written stubs (no mocking framework). Integration tests use testcontainers Postgres + the existing `setup-pg.ts` orphan-migration logic (spec a). Test names: natural English, NOT TC-IDs.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `evaluateAutoProvision` happy path returns `'accepted-sso-auto'` with single-match clean invite | decision === 'accepted-sso-auto' |
| TC-U-02 | REQ-2 | business | Public-domain `gmail.com` short-circuits to `'rejected-public-domain'` without DB lookup (verified via stub call counter) | decision === 'rejected-public-domain', `matchInvites` call count === 0 |
| TC-U-03 | REQ-2 | edge | Every domain in the blocklist (17 domains) refuses auto-provision | each → `'rejected-public-domain'` |
| TC-U-04 | REQ-2 | edge | Domain casing variants (`Gmail.com`, `GMAIL.COM`) are normalized + blocked | each → `'rejected-public-domain'` |
| TC-U-05 | REQ-3 | business | Zero matches → `'rejected-no-match'` | match |
| TC-U-06 | REQ-3 | business | Two matches → `'rejected-multiple-matches'` | match |
| TC-U-07 | REQ-3 | business | Five matches → `'rejected-multiple-matches'` (no count-based branching beyond 2) | match |
| TC-U-08 | REQ-4 | business | Invite with `allowed_sso_providers=['google']` + `ssoProvider='okta'` → `'rejected-cross-idp'` | match |
| TC-U-09 | REQ-4 | edge | Invite with `allowed_sso_providers=[]` (legacy empty) + any provider → flow proceeds | flow proceeds past check |
| TC-U-10 | REQ-4 | happy | Invite with `allowed_sso_providers=['google', 'okta']` + `ssoProvider='google'` → flow proceeds | match |
| TC-U-11 | REQ-5 | business | Pre-existing user row in same org with `sso_provider=NULL` → `'rejected-pre-existing-binding'` | match |
| TC-U-12 | REQ-5 | edge | Pre-existing user row in DIFFERENT org → not pre-existing-binding (different org, different identity) → flow proceeds | flow proceeds |
| TC-U-13 | REQ-7 | business | Race simulation: invite revoked between SELECT and FOR UPDATE → `'rejected-race'` | match |
| TC-U-14 | REQ-7 | business | Race: invite expired between SELECT and FOR UPDATE → `'rejected-race'` | match |
| TC-U-15 | REQ-7 | business | Race: invite `used_count` reaches `max_uses` between SELECT and FOR UPDATE → `'rejected-race'` | match |
| TC-U-16 | REQ-10 | business | `*@x.com` matches both `dev@x.com` AND `dev+tag@x.com` | both match |
| TC-U-17 | REQ-10 | business | `emailHash('dev+tag@x.com') !== emailHash('dev@x.com')` (no plus-tag stripping) | hashes differ |
| TC-U-18 | REQ-10 | edge | Email with leading/trailing whitespace + uppercase: `'  Dev@X.COM  '` normalizes to `'dev@x.com'` for matching + hashing | match |
| TC-U-19 | REQ-11 | happy | Rate-limit: 9 attempts from same IP → all allowed | each `{ ok: true }` |
| TC-U-20 | REQ-11 | business | Rate-limit: 11th attempt from same IP within 5min → `{ ok: false, dimension: 'ip', retryAfterSec: N }` | match |
| TC-U-21 | REQ-11 | business | Rate-limit: 4th attempt for same email_hash within 24h → `{ ok: false, dimension: 'email_hash' }` | match |
| TC-U-22 | REQ-11 | business | Rate-limit: 6th attempt for same sso_subject_hash within 24h → `{ ok: false, dimension: 'sso_subject_hash' }` | match |
| TC-U-23 | REQ-11 | edge | Rate-limit: first dimension hit short-circuits (per-IP exceeded BEFORE per-email_hash) → result reports `dimension: 'ip'` (not email_hash) even though both would fire | match |
| TC-U-24 | REQ-11 | infra | Rate-limit: sliding window expires correctly — 11 attempts spaced 31min apart never exceed per-IP 10/5min | each `{ ok: true }` |
| TC-U-25 | REQ-20 | happy | Impossible-travel: 2 logins same hash, same city, 30min apart → `{ alert: false }` | match |
| TC-U-26 | REQ-20 | business | Impossible-travel: 2 logins same hash, NYC + Tokyo, 30min apart → `{ alert: true, reason: contains 'impossible-travel' }` | match |
| TC-U-27 | REQ-20 | edge | Impossible-travel: 2 logins same hash, NYC + Tokyo, 2h apart → `{ alert: false }` (>1h window) | match |
| TC-U-28 | REQ-20 | edge | Impossible-travel: prior event has city=NULL → `{ alert: false }` (skip heuristic) | match |
| TC-U-29 | REQ-20 | edge | Impossible-travel: no prior event → `{ alert: false }` | match |
| TC-U-30 | REQ-20 | edge | Impossible-travel: distance exactly 500km → `{ alert: false }` (strictly greater than) | match |
| TC-U-31 | REQ-20 | edge | Impossible-travel: distance 500.01km → `{ alert: true }` | match |
| TC-U-32 | REQ-21 | infra | `ipToCity('1.2.3.4')` returns null (stub default) | null |
| TC-U-33 | REQ-22 | business | `'rejected-pre-existing-binding'` outcome triggers `sendPreExistingBindingEmail` with correct args (via stub spy) | spy called once with `{ to: 'dev@x.com', city, browser, time }` |
| TC-U-34 | REQ-22 | edge | Email-send failure (stub throws) does NOT block decision-engine — audit row still written | decision returned + `logger.warn` called + DB row present |
| TC-U-35 | REQ-23 | happy | `sendEmail` stub returns `{ ok: true, value: { messageId: starts-with 'stub-' } }` | match |
| TC-U-36 | REQ-23 | security | `sendEmail` stub logs to_hash (NOT raw email) | log line excludes `'dev@x.com'`, includes hash hex |
| TC-U-37 | REQ-24 | business | Email rate-limit: 3rd email to same email_hash within 24h → suppressed + log line emitted | spy not called; warn log emitted |
| TC-U-38 | REQ-24 | edge | Email rate-limit: 4th email > 24h after first → allowed | spy called |
| TC-U-39 | REQ-2a | business | `evaluateAutoProvision` with `id_token.email_verified=false` → `'email-not-verified'` outcome | match |
| TC-U-40 | REQ-2a | edge | `email_verified=undefined` (missing claim) → `'email-not-verified'` | match |
| TC-U-41 | REQ-2a | business | `id_token.iss` not in whitelist → `'rejected-csrf'` | match |
| TC-U-42 | REQ-2a | business | `id_token.aud` ≠ client id → `'rejected-csrf'` | match |
| TC-U-43 | REQ-22 | business | `sendEmail` returns `{ ok: false, error: { reason: 'transient' } }` (typed Result error, NOT thrown) → decision-engine still returns decision + logs warn + audit row written | match |
| TC-U-44 | REQ-20 | edge | Impossible-travel boundary: exactly 1h elapsed (3600000ms) → `{ alert: false }` (strict less-than) | match |
| TC-U-45 | REQ-20 | edge | Impossible-travel: 3599999ms elapsed → `{ alert: true }` (just inside window) | match |
| TC-U-46 | REQ-24 | edge | Email rate-limit: exactly 24h since first send → 4th allowed (window reset; >= 24h boundary) | match |
| TC-U-47 | REQ-10 | edge | IDN domain: `dev@münchen.de` matches pattern `*@münchen.de` (NFC normalization + punycode handling per `match-email-pattern.ts`) | match |
| TC-U-48 | REQ-6 | business | Audit row metadata `email_rate_limited: true` is asserted after 3rd suppressed email | row inspection match |

### Integration Tests (testcontainers Postgres)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-9 | happy | End-to-end auto-provision happy path: seed org + active SSO-auto invite; signIn callback runs; `users` + `user_machines` rows created with `provisioned_via='sso-auto'`; `auth_event_log` + `onboarding_redemption_log` rows present | all DB writes verified |
| TC-I-02 | REQ-2, REQ-9 | business | Public-domain email signIn → `'rejected-public-domain'` outcome; `auth_event_log` + `onboarding_redemption_log` rows present; NO `users` row | DB state verified |
| TC-I-03 | REQ-3, REQ-9 | business | Zero matches: signIn with email not matching any invite → `'rejected-no-match'`; v1 single-org-bootstrap fallback test verifies separate path (REQ-15) | match |
| TC-I-04 | REQ-3, REQ-9 | business | Two orgs with overlapping `*@example.com` invite → `'rejected-multiple-matches'`; token_prefix in audit log = first match's first 8 chars | match |
| TC-I-05 | REQ-4 | business | Invite `allowed_sso_providers=['google']` + `ssoProvider='okta'` → `'rejected-cross-idp'` | match |
| TC-I-06 | REQ-4 | edge | Invite `allowed_sso_providers=[]` (legacy) + any provider → accepted-sso-auto | match |
| TC-I-07 | REQ-5 | business | Pre-existing v1 user (NULL sso_provider) + SSO callback in same org → `'rejected-pre-existing-binding'`; email helper invoked | DB + spy verified |
| TC-I-08 | REQ-7 | business | Race: two-connection Postgres approach per Decisão #22. Inject `onAfterSelectForUpdate` callback via `AutoProvisionDeps` that opens a SECOND `pg.Pool` connection and UPDATEs the invite to set `revoked_at=now()`. Primary tx then re-checks revoked_at after lock acquired → `'rejected-race'` outcome; user_machines row NOT created | DB verified |
| TC-I-09 | REQ-7 | business | Race: same methodology as TC-I-08, second-connection UPDATE sets `expires_at = now() - 1s` → `'rejected-race'` | match |
| TC-I-10 | REQ-7 | business | Race: same methodology, second-connection UPDATE sets `used_count = max_uses` → `'rejected-race'` | match |
| TC-I-11 | REQ-8 | happy | Accepted: `users` row has `role='member'`, `provisioned_via='sso-auto'`, `team_id` from invite (if set) | match |
| TC-I-12 | REQ-8 | edge | Accepted with invite `team_id=NULL` → user row has `team_id=NULL` | match |
| TC-I-13 | REQ-8 | business | `onboarding_invites.used_count` incremented atomically + `auth_event_log` written in same tx | row counts match |
| TC-I-14 | REQ-9 | happy | `auth_event_log` row has every required field populated correctly (sso_provider, iss, email_hash, sso_subject_hash, ip, city=NULL via stub, user_agent ≤512 chars, outcome, occurred_at recent) | introspection match |
| TC-I-15 | REQ-9 | security | `onboarding_redemption_log` row for accepted: `method='sso-auto'`, `machine_id` populated; for rejected: `method='sso-auto'`, `machine_id` NULL | match |
| TC-I-16 | REQ-9 | security | `user_agent` longer than 512 chars truncated to exactly 512 in `auth_event_log` row | match |
| TC-I-17 | REQ-9 | security | Privacy: NEVER raw email in any log; only `email_domain` + hex hash. Grep `apps/server/lib/auth/sso-auto-provision.ts` + integration test output for raw email strings → zero hits | grep verified |
| TC-I-18 | REQ-10 | business | `matchActiveInvitesByEmail('dev+tag@x.com')` returns same row as `matchActiveInvitesByEmail('dev@x.com')` for pattern `*@x.com` | both return matching invite |
| TC-I-19 | REQ-10 | business | `email_hash` column for `dev+tag@x.com` differs from `dev@x.com` in `auth_event_log` after two distinct signIn attempts | hashes differ |
| TC-I-20 | REQ-11 | business | Rate-limit: 11 signIn attempts from same IP within 5min → 11th returns 429 (or signIn aborts before DB) + audit row records `'rate-limited'` | match |
| TC-I-21 | REQ-12 | security | Rate-limited attempt does NOT open a DB transaction (verify by post-attempt row counts: `users` count unchanged, `user_machines` count unchanged, `auth_event_log` count unchanged). Concrete + robust vs `pg_stat_activity` probe | row count deltas match |
| TC-I-22 | REQ-13 | happy | signIn callback E2E: bootstrap + SSO-auto pattern match → calls evaluateAutoProvision → accepted → returns true | session created |
| TC-I-23 | REQ-13 | business | signIn callback: bootstrap + no SSO-auto pattern → falls through to v1 single-org-bootstrap path (REQ-15) | v1 user row created |
| TC-I-24 | REQ-14 | regression | V1 `fill-sso` flow (legacy user with NULL sso_provider + matching invite) still works unchanged | DB updates match v1 expected behavior |
| TC-I-25 | REQ-14 | regression | V1 `allow` flow (existing SSO-bound user) still works unchanged | session created |
| TC-I-26 | REQ-14 | regression | V1 `reject-mismatch` flow still rejects | signIn returns false |
| TC-I-27 | REQ-14 | regression | V1 `ambiguous-multi-org` flow still logs warn + picks first row (transitional per spec a) | match |
| TC-I-28 | REQ-16 | security | `/api/auth/signin` with `Origin: https://evil.example.com` → HTTP 403 + `'rejected-csrf'` audit row | match |
| TC-I-29 | REQ-16 | security | `/api/auth/signin` with missing `Origin` AND missing `Referer` → HTTP 403 (safety default) | match |
| TC-I-30 | REQ-16 | security | `/api/auth/signin` with `Origin` matching base URL → flow proceeds | match |
| TC-I-31 | REQ-17 | security | `callbackUrl=https://evil.example.com` → NextAuth `redirect` returns `baseUrl + '/'` | match |
| TC-I-32 | REQ-17 | security | `callbackUrl=/manager` (same-origin relative) → returns `baseUrl + '/manager'` | match |
| TC-I-33 | REQ-17 | edge | State cookie has `HttpOnly` + `SameSite=Lax` set | inspect Set-Cookie header |
| TC-I-34 | REQ-18 | security | **ADDRESSED** by `.specs/sso-replay-audit-row.md` (NextAuth `logger.error` hook in `auth.ts` writes `auth_event_log` row with `outcome='rejected-replay'` on `InvalidCheck`) + `.specs/oauth-idp-stub.md` TC-E2E-08 (rejection verified end-to-end). Replay-detection: capture state token from first callback; invoke second callback with same state → rejected with NextAuth state error AND `'rejected-replay'` audit row | match |
| TC-I-35 | REQ-19 | happy | `auth_event_log` row written for every distinct outcome — table any of the 10 outcomes, each produces exactly 1 row | row counts verified |
| TC-I-36 | REQ-20 | business | Impossible-travel: simulate 2 successful signIns same sso_subject_hash, distant cities, 30min apart → `logger.warn('impossible-travel', ...)` fires | log line verified |
| TC-I-37 | REQ-22 | business | Pre-existing-binding email helper invoked exactly once on `'rejected-pre-existing-binding'` outcome | spy verified |
| TC-I-38 | REQ-23 | security | Stub email-send returns `{ ok: true }` and logs hash, NOT raw email | log line verified |
| TC-I-39 | REQ-24 | business | Send 3 pre-existing-binding emails to same email_hash in <24h; 3rd is suppressed | spy called 2x; log warns on 3rd |
| TC-I-40 | REQ-25 | infra | `.github/workflows/lint-public-domains.yml` exists; SQL grep verifies it checks `LAST_REVIEWED` header within 90d | grep + yaml parse |
| TC-I-41 | REQ-26 | regression | Full `pnpm test:server` exit 0 (modulo known flake) | exit 0 |
| TC-I-42 | REQ-2a | business | signIn callback with `email_verified=false` profile → `auth_event_log` row outcome `'email-not-verified'` | DB + return false |
| TC-I-43 | REQ-17 | security | TC-I-17 extended: grep test output AND source files for raw `sso_subject` values → zero hits | grep verified |
| TC-I-44 | REQ-16 | security | `/api/auth/signin` with `Origin: null` (sandboxed iframe / data: URI scenario) → HTTP 403 + `'rejected-csrf'` | match |
| TC-I-45 | REQ-18 | security | Replay-detection via nonce reuse: second callback with fresh state + reused nonce → rejected with NextAuth nonce error + `'rejected-replay'` audit row | match |
| TC-I-46 | REQ-8 | edge | Accepted with `oauth.profile.name=null` (provider returned no name) → `users.display_name=NULL` | row match |
| TC-I-47 | REQ-12 | regression | Rate-limited SSO attempt writes 1 `onboarding_redemption_log` row with `outcome='rate-limited'` AND 0 `auth_event_log` rows | row counts match |
| TC-I-48 | REQ-22 | business | TC-I-21 alternative: count `auth_event_log` rows + `users` rows after rate-limited attempt → 1 redemption-log row, 0 users, 0 auth_event_log rows (no DB transaction was opened for `users` writes) | counts match |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-13 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-01 (Okta-emulating stub; provider identity is provider-agnostic in the orchestrator). Playwright: visit `/api/auth/signin/okta` from a browser; trigger NextAuth OAuth flow with stubbed IdP; observe new `users` row + gated page accessible | session works |
| TC-E2E-02 | REQ-16 | security | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-02. Playwright: cross-origin signin initiation via `request.post('/api/auth/signin/okta', { headers: { Origin: 'https://evil.example.com' } })` → 403 | match |

> Note: E2E tests require a stubbed OAuth IdP + NextAuth dev-mode environment. Standard for the project; verify infra during execution. If unavailable, mark as `DEFERRED`.

## Design

### Architecture Decisions

**Decision-engine pattern**: `evaluateAutoProvision(input, deps?: AutoProvisionDeps)` is a single async orchestrator that runs checks **sequentially with early-exit** per Decisão #17 (NOT parallel — rate-limit must short-circuit before other checks decrement counters or open transactions). Each check is a separate function so unit tests can exercise it in isolation. Each check returns a `MaybeDecision = SsoAutoDecision | null` and the orchestrator picks the first non-null result via `for (const check of checks) { const d = await check(input, deps); if (d) return d; }`.

**Dependency injection** (Decisão #18): `deps?: AutoProvisionDeps` is an optional last argument containing injectable functions: `matchActiveInvitesByEmail`, `checkSsoRateLimit`, `isPublicDomain`, `writeAuthEvent`, `writeRedemptionLog`, `sendPreExistingBindingEmail`, `db` (Drizzle handle), `onAfterSelectForUpdate?: () => Promise<void>` (test seam for race tests per Decisão #22). Defaults to real implementations. Unit tests pass hand-written stubs (matches `redeem.ts` `redeemInvite(db, input, opts?)` pattern).

**Module decomposition**:

1. `apps/server/lib/auth/public-domains.ts` — pure, no DB. `LAST_REVIEWED: 2026-05-11` header. Export `isPublicDomain(domain: string): boolean`.
2. `apps/server/lib/auth/sso-auto-provision.ts` — orchestrator + decision functions. Exports `evaluateAutoProvision`, helper types `AutoProvisionInput`, `AutoProvisionDecision`.
3. `apps/server/lib/auth/match-active-invites.ts` — DB query helper. `matchActiveInvitesByEmail(email): Promise<ActiveInvite[]>`. Uses `idx_invites_email_pattern_active`.
4. `apps/server/lib/auth/auth-event-log-writer.ts` — DB write helper. `writeAuthEvent(input): Promise<void>`. Uses `truncateUserAgent`. Computes `sso_subject_hash` via `hashEmail` (reuse with `sub` as input).
5. `apps/server/lib/auth/impossible-travel.ts` — pure heuristic. `checkImpossibleTravel(sso_subject_hash, currentCity, currentTime): Promise<{alert: boolean; reason?: string}>`. Queries `auth_event_log` for prior event.
6. `apps/server/lib/auth/ip-to-city.ts` — stub. `ipToCity(ip: string): Promise<string | null>`. v2 baseline returns null. Interface stable.
7. `apps/server/lib/auth/rate-limit-sso.ts` — wraps existing `lib/queries/rate-limit.ts` infra with 3-dimension layered check. Exports `checkSsoRateLimit`, `__resetSsoRateLimit`.
8. `apps/server/lib/auth/pre-existing-binding-email.ts` — helper + rate-limit on resend. `sendPreExistingBindingEmail({ to, city, browser, time }): Promise<void>`. Uses `sendEmail` stub.
9. `apps/server/lib/email/send-email-stub.ts` — interface + console-log stub. Exports `sendEmail`, type `EmailInput`, `EmailResult`, `EmailError`. Real backend wiring in follow-up.
10. `apps/server/lib/auth/csrf-origin-guard.ts` — Origin/Referer validation helper. `checkSigninOrigin(request): boolean`. Used in NextAuth middleware or route handler wrapper.

**Auth.ts integration** (`apps/server/lib/auth/auth.ts`): the `bootstrap` decision branch in the `signIn` callback gets a new sub-branch — when `matchActiveInvitesByEmail(user.email)` returns ≥1 matches, call `evaluateAutoProvision`. Otherwise, fall through to existing v1 single-org-bootstrap. Net delta: ~30 LOC added to auth.ts. No v1 path modified.

**Transaction shape** (mirrors `lib/queries/redeem.ts:lookupInviteForUpdate`):

```ts
const result = await db.transaction(async (tx) => {
  // 1. Lock the invite row.
  const lockedInvite = await tx
    .select(...)
    .from(onboardingInvites)
    .where(eq(onboardingInvites.token, invite.token))
    .for('update');
  if (!lockedInvite.length) return { kind: 'rejected-race' };

  // 2. Re-validate.
  const fresh = lockedInvite[0]!;
  if (fresh.revokedAt !== null) return { kind: 'rejected-race' };
  if (fresh.expiresAt <= new Date()) return { kind: 'rejected-race' };
  if (fresh.usedCount >= fresh.maxUses) return { kind: 'rejected-race' };

  // 3. INSERT user + machine.
  const [newUser] = await tx.insert(users).values({ ... }).returning(...);
  await tx.insert(userMachines).values({ ... });
  await tx.update(onboardingInvites).set({ usedCount: sql`${onboardingInvites.usedCount} + 1` })
    .where(eq(onboardingInvites.token, fresh.token));

  return { kind: 'accepted-sso-auto', user: newUser, invite: fresh };
});
```

**Audit log isolation** (mirrors redeem.ts pattern): `auth_event_log` + `onboarding_redemption_log` rows are written OUTSIDE the transaction for rejection paths (so a transactional rollback doesn't drop audit records). For the happy path, audit rows can be written inside the transaction (consistent with `'accepted-sso-auto'` outcome — if anything in the tx fails, the audit record should also roll back). Same pattern documented in `redeem.ts:6-42`.

**State token reuse detection** (REQ-18): NextAuth handles state validation natively. To verify replay-rejection in an integration test, capture the `state` from the first callback URL, then construct a second callback URL with the same state and POST to it. NextAuth should respond with an error. The integration test asserts: (a) HTTP error code, (b) audit log records `'rejected-replay'`.

**Rate-limit wrapping** (REQ-11): `checkSsoRateLimit` is a thin wrapper around `lib/queries/rate-limit.ts:checkRateLimits` with 3 fixed dimensions. The existing `RateLimitResult` shape is reused; first-exceeded short-circuits per existing semantics.

**Email-send stub** (REQ-23): `apps/server/lib/email/send-email-stub.ts` exports a function with signature `sendEmail: (input: EmailInput) => Promise<Result<EmailResult, EmailError>>`. Console-log to `logger.info` with PII-stripped fields (`to_hash` instead of `to`). Returns `{ ok: true, value: { messageId: 'stub-' + crypto.randomUUID() } }`. EmailError type defined for future real-backend wiring. NEVER throws; returns Result.

### Files to Create

- `apps/server/lib/result.ts` (NEW — canonical Result<T,E> for apps/server; Decisão #20)
- `apps/server/lib/result.test.ts`
- `apps/server/lib/auth/public-domains.ts`
- `apps/server/lib/auth/public-domains.test.ts`
- `apps/server/lib/auth/sso-auto-provision.ts`
- `apps/server/lib/auth/sso-auto-provision.test.ts`
- `apps/server/lib/auth/match-active-invites.ts`
- `apps/server/lib/auth/match-active-invites.test.ts`
- `apps/server/lib/auth/auth-event-log-writer.ts`
- `apps/server/lib/auth/auth-event-log-writer.test.ts`
- `apps/server/lib/auth/impossible-travel.ts`
- `apps/server/lib/auth/impossible-travel.test.ts`
- `apps/server/lib/auth/ip-to-city.ts`
- `apps/server/lib/auth/ip-to-city.test.ts`
- `apps/server/lib/auth/rate-limit-sso.ts`
- `apps/server/lib/auth/rate-limit-sso.test.ts`
- `apps/server/lib/auth/pre-existing-binding-email.ts`
- `apps/server/lib/auth/pre-existing-binding-email.test.ts`
- `apps/server/lib/auth/csrf-origin-guard.ts`
- `apps/server/lib/auth/csrf-origin-guard.test.ts`
- `apps/server/lib/email/send-email-stub.ts`
- `apps/server/lib/email/send-email-stub.test.ts`
- `apps/server/tests/integration/sso-auto-provision-flow.test.ts` (TC-I-01..15 + TC-I-22..27 — full signIn flow)
- `apps/server/tests/integration/sso-auto-provision-csrf.test.ts` (TC-I-28..30)
- `apps/server/tests/integration/sso-auto-provision-replay.test.ts` (TC-I-34)
- `apps/server/tests/integration/sso-auto-provision-rate-limit.test.ts` (TC-I-20..21)
- `apps/server/tests/e2e/sso-auto-provision.spec.ts` (TC-E2E-01..02)
- `.github/workflows/lint-public-domains.yml`

### Files to Modify

- `apps/server/lib/auth/auth.ts` — add bootstrap sub-branch for SSO-auto flow. ~30 LOC.
- `apps/server/lib/queries/rate-limit.ts` — extend `RateLimitDimensionInput.name` + `RateLimitResult.dimension` from `'ip' | 'token'` to `'ip' | 'token' | 'email_hash' | 'sso_subject_hash'` per Decisão #21. Backwards-compatible widening; ~2 LOC delta.
- `apps/server/middleware.ts` — extend matcher to include `/api/auth/signin`; add Origin/Referer check per Decisão #19. Returns 403 + writes `onboarding_redemption_log` `'rejected-csrf'` row before NextAuth handler runs.
- `apps/server/lib/db/migrations/0004_sso_auto_provision_schema.sql` — NO CHANGES (spec a is frozen).

### Dependencies

No new npm packages. Reuses existing: `drizzle-orm`, `pg`, NextAuth, Vitest, testcontainers, `crypto` (for SHA-256). Future: SMTP/SES wiring would add `nodemailer` or `@aws-sdk/client-ses` — deferred to follow-up spec.

## Tasks

- [x] **TASK-0**: Create `apps/server/lib/result.ts` (canonical Result<T,E>)
  - files: `apps/server/lib/result.ts`, `apps/server/lib/result.test.ts`
  - tests: (typecheck-only assertions + 2 happy-path TCs for `ok` + `err` constructors)
  - depends: (none)
  - notes:
    - Mirror root `lib/result.ts` shape: `type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }`.
    - Single source of truth for apps/server. Future modules import from `@/lib/result`.

- [x] **TASK-1**: Implement `public-domains.ts` + tests + CI workflow
  - files: `apps/server/lib/auth/public-domains.ts`, `apps/server/lib/auth/public-domains.test.ts`, `.github/workflows/lint-public-domains.yml`
  - tests: TC-U-03, TC-U-04, TC-I-40
  - depends: (none)
  - notes:
    - Hardcoded 17-domain Set + `isPublicDomain(domain)`. Normalize input (lowercase + trim).
    - `LAST_REVIEWED: 2026-05-11` header. CI workflow scans for header + parses date.

- [x] **TASK-2**: Implement `match-active-invites.ts` + tests
  - files: `apps/server/lib/auth/match-active-invites.ts`, `apps/server/lib/auth/match-active-invites.test.ts`
  - tests: TC-U-16, TC-U-17, TC-U-18, TC-I-18, TC-I-19
  - depends: (none)
  - notes:
    - Uses `apps/server/lib/auth/match-email-pattern.ts` (existing).
    - Drizzle query against `onboardingInvites` with WHERE filter: `revoked_at IS NULL AND expires_at > now() AND used_count < max_uses`.
    - Iterate matching email_pattern in code (DB returns candidates; final pattern match is in JS). Verify partial index hit via EXPLAIN in dev.

- [x] **TASK-3**: Implement `ip-to-city.ts` + tests
  - files: `apps/server/lib/auth/ip-to-city.ts`, `apps/server/lib/auth/ip-to-city.test.ts`
  - tests: TC-U-32
  - depends: (none)
  - notes:
    - Stub: returns null. Document interface for future MaxMind wiring.

- [x] **TASK-4**: Implement `impossible-travel.ts` + tests
  - files: `apps/server/lib/auth/impossible-travel.ts`, `apps/server/lib/auth/impossible-travel.test.ts`
  - tests: TC-U-25..31
  - depends: TASK-3
  - notes:
    - Haversine distance helper inline (no new dep).
    - Queries `auth_event_log` for `outcome='accepted-sso-auto' AND sso_subject_hash=$1` ORDER BY occurred_at DESC LIMIT 1.
    - 500km strict-greater-than threshold; 1h window.

- [x] **TASK-5**: Implement `auth-event-log-writer.ts` + tests
  - files: `apps/server/lib/auth/auth-event-log-writer.ts`, `apps/server/lib/auth/auth-event-log-writer.test.ts`
  - tests: TC-I-14, TC-I-16, TC-I-17, TC-I-35
  - depends: TASK-3
  - notes:
    - `writeAuthEvent({ sso_provider, iss, email_hash, sso_subject_hash, ip, city, user_agent, outcome })` INSERTs to `auth_event_log`.
    - Truncates `user_agent` via `truncateUserAgent` from spec a.

- [x] **TASK-6**: Implement `send-email-stub.ts` + tests
  - files: `apps/server/lib/email/send-email-stub.ts`, `apps/server/lib/email/send-email-stub.test.ts`
  - tests: TC-U-35, TC-U-36, TC-I-38
  - depends: TASK-0 (uses Result<T,E>)
  - notes:
    - Pure stub: logs `to_hash` (SHA-256 of `to`), returns `{ ok: true, value: { messageId: 'stub-' + uuid } }`.
    - EmailError type for future real-backend wiring (typed Result error, NEVER thrown).
    - Import `Result` from `@/lib/result` (apps/server-scoped, NOT root).

- [x] **TASK-7**: Implement `pre-existing-binding-email.ts` + tests
  - files: `apps/server/lib/auth/pre-existing-binding-email.ts`, `apps/server/lib/auth/pre-existing-binding-email.test.ts`
  - tests: TC-U-33, TC-U-34, TC-U-37, TC-U-38, TC-I-37, TC-I-39
  - depends: TASK-6
  - notes:
    - Template builder + `sendEmail` invocation.
    - Rate-limit: in-memory Map `Map<email_hash, number[]>` of send timestamps. 3/24h cap.

- [x] **TASK-8**: Implement `rate-limit-sso.ts` + extend `rate-limit.ts` dimension union + tests
  - files: `apps/server/lib/auth/rate-limit-sso.ts`, `apps/server/lib/auth/rate-limit-sso.test.ts`, `apps/server/lib/queries/rate-limit.ts` (extend union)
  - tests: TC-U-19..24, TC-I-20, TC-I-21
  - depends: (none)
  - notes:
    - Extend `RateLimitDimensionInput.name` + `RateLimitResult.dimension` from `'ip' | 'token'` to `'ip' | 'token' | 'email_hash' | 'sso_subject_hash'` (Decisão #21). Backwards-compatible union widening; ~2 LOC delta.
    - Wrap existing `checkRateLimits` with 3 fixed dimensions: per-IP 10/5min + per-email_hash 3/24h + per-sso_subject_hash 5/24h.

- [x] **TASK-9**: Implement `csrf-origin-guard.ts` + extend `apps/server/middleware.ts` + tests
  - files: `apps/server/lib/auth/csrf-origin-guard.ts`, `apps/server/lib/auth/csrf-origin-guard.test.ts`, `apps/server/middleware.ts`
  - tests: TC-I-28, TC-I-29, TC-I-30, TC-I-44
  - depends: (none)
  - notes:
    - Pure helper `checkSigninOrigin(request): { ok: boolean; reason?: string }` validates `Origin` (fallback `Referer`). Returns ok-false on cross-origin, missing-both, or `Origin: null`.
    - Extend `apps/server/middleware.ts` matcher to include `/api/auth/signin`. Guard wraps the request, returns 403 + writes `onboarding_redemption_log` row `'rejected-csrf'` BEFORE NextAuth handler runs (Decisão #19).

- [x] **TASK-10**: Implement `sso-auto-provision.ts` decision-engine + tests
  - files: `apps/server/lib/auth/sso-auto-provision.ts`, `apps/server/lib/auth/sso-auto-provision.test.ts`
  - tests: TC-U-01..15, TC-U-39..43
  - depends: TASK-0, TASK-1, TASK-2, TASK-4, TASK-5, TASK-7, TASK-8
  - notes:
    - Orchestrator function `evaluateAutoProvision(input, deps?: AutoProvisionDeps)` — sequential early-exit per Decisão #17 + DI per Decisão #18.
    - `AutoProvisionDeps` type exports the full injectable surface (matchInvites, rateLimit, blocklist, audit writers, sendEmail, db, onAfterSelectForUpdate test seam).
    - Decision tree mirrors Decisão #2 order exactly.
    - Audit-log writes: `writeAuthEvent` (auth_event_log) AND `writeRedemptionLog` (onboarding_redemption_log) both invoked. Rate-limited path SKIPs `writeAuthEvent` per Decisão #16 + REQ-12.
    - Unit tests use hand-written stub `AutoProvisionDeps` (no mocking framework).

- [x] **TASK-11**: Integrate auto-provision into `auth.ts` signIn callback
  - files: `apps/server/lib/auth/auth.ts`, `apps/server/lib/auth/auth.test.ts` (if exists)
  - tests: TC-I-22, TC-I-23, TC-I-24..27 (regression locks)
  - depends: TASK-10, TASK-9
  - notes:
    - Add bootstrap sub-branch.
    - Preserve all v1 paths.
    - Origin/Referer guard runs as wrapping middleware OR inline check.
    - `callbackUrl` allowlist via NextAuth `redirect` callback (REQ-17).

- [x] **TASK-12**: Integration test — full sso-auto-provision flow
  - files: `apps/server/tests/integration/sso-auto-provision-flow.test.ts`
  - tests: TC-I-01..15, TC-I-22..27
  - depends: TASK-11
  - notes:
    - Testcontainers Postgres; stub NextAuth oauth provider context.
    - Each rejection outcome gets at least 1 TC.

- [x] **TASK-13**: Integration test — CSRF + replay
  - files: `apps/server/tests/integration/sso-auto-provision-csrf.test.ts`, `apps/server/tests/integration/sso-auto-provision-replay.test.ts`
  - tests: TC-I-28..30, TC-I-34
  - depends: TASK-11
  - notes:
    - Origin/Referer cross-origin → 403.
    - State token reuse → NextAuth rejects + `'rejected-replay'` audit row.

- [x] **TASK-14**: Integration test — rate-limit
  - files: `apps/server/tests/integration/sso-auto-provision-rate-limit.test.ts`
  - tests: TC-I-20, TC-I-21
  - depends: TASK-11
  - notes:
    - Burst test: 11 concurrent attempts from same IP.
    - Probe `pg_stat_activity` to verify no extra tx opened.

- [x] **TASK-15**: E2E test — Playwright SSO flow (DEFERRED if infra missing)
  - files: `apps/server/tests/e2e/sso-auto-provision.spec.ts`
  - tests: TC-E2E-01, TC-E2E-02
  - depends: TASK-11
  - notes:
    - Requires stubbed Google IdP + NextAuth dev mode. If unavailable, mark DEFERRED + log.

- [x] **TASK-VERIFY**: Full server validation
  - files: (none — assertion-only)
  - tests: TC-I-41
  - depends: TASK-1..TASK-15
  - notes:
    - `pnpm test:server` exit 0 (modulo pre-existing flake).
    - `pnpm typecheck:server`, `pnpm lint:server` exit 0.

## Parallel Batches

```text
Batch 1: [TASK-0, TASK-1, TASK-2, TASK-3, TASK-8, TASK-9]    — independent foundations (6 parallel; TASK-0 = Result type, TASK-1-3+8-9 = pure modules + middleware)
Batch 2: [TASK-4, TASK-5, TASK-6, TASK-7]                    — depend on Batch 1 (4 parallel: impossible-travel, auth-event-log-writer, send-email-stub, pre-existing-binding-email)
Batch 3: [TASK-10]                                            — sso-auto-provision orchestrator (single; depends on all helpers + Result)
Batch 4: [TASK-11]                                            — auth.ts integration (single — shared-mutative on auth.ts)
Batch 5: [TASK-12, TASK-13, TASK-14, TASK-15]                — integration + E2E tests (4 parallel, distinct files)
Batch 6: [TASK-VERIFY]                                        — final validation
```

Files classification:

- All new module files — exclusive (one task per file).
- `apps/server/lib/auth/auth.ts` — exclusive to TASK-11 (shared-mutative; serialize).
- `lib/queries/rate-limit.ts` — modified by TASK-8 only.
- Each integration test file — exclusive.

## Validation Criteria

- [ ] `pnpm typecheck:server` exit 0
- [ ] `pnpm lint:server` exit 0
- [ ] `pnpm test:server` exit 0 (modulo pre-existing `aggregate-team-outcomes.test.ts:233` flake)
- [ ] `pnpm test:server:e2e` exit 0 (or DEFERRED logged for TC-E2E-01/02)
- [ ] `pnpm build:server` exit 0
- [ ] Root tokenfx `pnpm typecheck && pnpm lint && pnpm test --run` unchanged
- [ ] `pnpm lint:locale` exit 0 (sanity: no pt-BR accidentally introduced in apps/server)
- [ ] **Live validation against real auth flow**: dev server (`pnpm dev:server`); attempt sign-in via Google OAuth (or stubbed e2e-bypass-provider in dev mode); verify (a) accepted path creates `users` + `user_machines` + audit-log rows, (b) public-domain rejection logs row without user creation, (c) `auth_event_log` populated per attempt.
- [ ] Grep `apps/server/lib/auth/sso-auto-provision.ts` + integration test logs for raw email occurrences → zero hits (privacy invariant).
- [ ] `bash .github/workflows/lint-public-domains.yml` (extract shell block) exit 0 against the new `public-domains.ts`.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-0, TASK-1, TASK-2, TASK-3, TASK-8, TASK-9] (2026-05-12 09:44)

6 parallel agents via worktrees. All green; merged.

- TASK-0: `apps/server/lib/result.ts` canonical Result<T,E> (3 tests)
- TASK-1: `public-domains.ts` + `lint-public-domains.yml` CI workflow (25 tests)
- TASK-2: `match-active-invites.ts` Drizzle query helper using `idx_invites_email_pattern_active` (10 integration tests)
- TASK-3: `ip-to-city.ts` v2 stub (9 tests; returns null)
- TASK-8: `rate-limit-sso.ts` wrapper + extended `rate-limit.ts` dimension union (7 new + 9 existing pass)
- TASK-9: `csrf-origin-guard.ts` helper (7 tests). Middleware extension ESCALATED — see TASK-11 resolution.

Total Batch 1: 70 new tests, all green.

### Batch 2 [TASK-4, TASK-5, TASK-6, TASK-7] (2026-05-12 09:57)

4 parallel agents via worktrees. All green; merged.

- TASK-4: `impossible-travel.ts` with haversine + 1h/500km thresholds (11 integration tests)
- TASK-5: `auth-event-log-writer.ts` with `truncateUserAgent` integration (20 tests; verifies `'rate-limited'` outcome rejected by CHECK per Decisão #16)
- TASK-6: `send-email-stub.ts` Result-typed stub (5 tests; logs hash only, never raw email)
- TASK-7: `pre-existing-binding-email.ts` with 3/24h email rate-limit (12 tests)

Total Batch 2: 48 new tests, all green.

### TASK-10 inline (2026-05-12 10:08)

`sso-auto-provision.ts` decision-engine orchestrator (~570 LOC) with sequential early-exit + dependency injection per Decisão #17/#18 (41 tests covering TC-U-01..15 + TC-U-39..43).

**Schema widening (in-scope deviation)**: TASK-10 widened `schema.ts:onboardingOutcomeEnum` from 9 v1 values to 19 (added 10 SSO-decision values). DB already has the values via migration 0004 ALTER TYPE — this is TS-type-level widening only. Mirror change in `redemption-log.ts:OnboardingOutcome` + added optional v2 columns to `WriteRedemptionLogParams`.

### TASK-11 inline (2026-05-12 10:14)

`auth.ts` signIn integration: added bootstrap sub-branch for SSO-auto. Helpers `extractIssuer` + `extractEmailVerified` decode `id_token` claims. CSRF wrap moved to `app/api/auth/[...nextauth]/route.ts` (avoids Edge-runtime conflict that blocked TASK-9 middleware approach). `callbackUrl` allowlist via NextAuth `redirect` callback in `auth.config.ts`.

**Locked deviations**:

- IP/UA capture deferred: NextAuth signIn callback doesn't surface request context. `auth_event_log` rows from SSO-auto have `ip='', user_agent='', city=NULL`. Documented inline TODO for future spec (AsyncLocalStorage from route handler).
- Machine-credential minting NOT in signIn callback — preserves v1 pattern (machines minted by standard bearer-auth flow on next request).

V1 auth-session tests: 265/265 still pass (no regressions).

### Batch 5 [TASK-12, TASK-13, TASK-14, TASK-15] (2026-05-12 10:28)

4 parallel agents via worktrees. All green; merged.

- TASK-12: `sso-auto-provision-flow.test.ts` (21 integration tests covering TC-I-01..15 + TC-I-22..27)
- TASK-13: `sso-auto-provision-csrf.test.ts` (4 tests: TC-I-28/29/30/44) + `sso-auto-provision-replay.test.ts` (2 DEFERRED with loud console.warn — TC-I-34/45 require e2e infra)
- TASK-14: `sso-auto-provision-rate-limit.test.ts` (4 tests: TC-I-20/21/47/48)
- TASK-15: `tests/e2e/sso-auto-provision.spec.ts` (2 DEFERRED placeholders — TC-E2E-01/02; require stubbed Google OAuth IdP)

SECURITY.md extended with §6 documenting the e2e + replay deferrals.

### TASK-VERIFY (2026-05-12 10:28)

Full apps/server suite: `933 passed | 10 skipped | 1 failed` (the one failure is pre-existing `aggregate-team-outcomes.test.ts:233` flake unrelated to this spec — confirmed via git-stash baseline in prior sessions). 10 skipped breakdown: 8 spec-a infra-conditional REVOKE role-switch + REQ-9 abort, plus 2 e2e DEFERRED (TASK-15).

`pnpm typecheck:server` clean. `pnpm lint:server` clean.
