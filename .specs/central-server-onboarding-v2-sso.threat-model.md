# Threat Model: central-server-onboarding-v2-sso

## Status: APPROVED

> **This is an analysis document, not an SDD spec.** It produces no code directly. After approval, it feeds into `central-server-onboarding-v2-sso.md` (implementation spec) as the authoritative threat reference. **Do not run `/ralph-loop` on this file** — there are no REQs, Tasks, or Test Plan; the `/ralph-loop` validator will refuse.

## Context

### Scope

SSO-based auto-provisioning at the central reporter server (`apps/server/`): when a developer signs in via Google / Okta for the first time, and the org they're joining has an `onboarding_invites` row with an `email_pattern` matching their email **and** the match is unambiguous (§Threat 2), create rows in `users` + `user_machines` automatically — **without requiring the developer to paste an invite token**.

This carves out the explicit anti-goal from Fase 3 (central-server-onboarding): the v1 ship intentionally required invite-token paste even when SSO would have sufficed. v2 closes that ergonomics gap **conditional on** the threat model holding.

### Schema preconditions (LOCKED — must land before any v2 implementation)

These are not implementation choices; they are **blockers** without which the v2 feature cannot exist. The implementation spec must include them as TASK-1-class migrations before any other work.

1. **`users.email` global UNIQUE constraint MUST be relaxed to composite `(org_id, email) UNIQUE`.** Current shipped schema has `users.email text UNIQUE NOT NULL` (cluster-wide), which means a second org cannot have the same email. Cross-org account creation (§Decisão #8) is structurally impossible until this is fixed. The migration is destructive in the sense that the global uniqueness invariant is being weakened — backfill is trivial (existing rows already satisfy the composite version), but the migration must drop the old constraint and add the new one atomically.

2. **`users` table MUST gain `UNIQUE (org_id, sso_provider, sso_subject)` constraint** (NULLs allowed; Postgres `UNIQUE` ignores NULL combinations, so existing pre-SSO rows are unaffected). This is the mitigation referenced in §Threat 7 M7.1. The current shipped schema **does not have this constraint** — the reviewer audit confirmed the previous draft was incorrect on that point.

3. **`onboarding_outcome` enum MUST be extended via `ALTER TYPE … ADD VALUE IF NOT EXISTS`** for each new value listed in §Decisão #5. `CREATE TYPE` is not idempotent for adding values; `ALTER TYPE ... ADD VALUE` is non-blocking on Postgres 12+ and safe to re-run with `IF NOT EXISTS`. Migration must use this pattern, not re-create the type.

4. **`onboarding_redemption_log` MUST gain new columns**: `method text NOT NULL DEFAULT 'manual-token'` (with `CHECK (method IN ('manual-token', 'sso-auto'))`), `sso_provider text`, `sso_subject_hash text`, `iss text`, `user_agent text` (§Compliance). The `method` default is safe (Postgres 11+ stores the default in catalog without table rewrite); the three nullable columns are no-ops on existing rows.

5. **`onboarding_invites` MUST gain a partial index** for the matching query (§Threat 2 M2.1): `CREATE INDEX idx_invites_email_pattern_active ON onboarding_invites (email_pattern) WHERE revoked_at IS NULL`. Currently the matching scan would be a full sequential scan; for a multi-org server this is unacceptable.

6. **`onboarding_redemption_log` and `onboarding_audit_log` MUST have UPDATE/DELETE revoked at the DB role level** (pattern already used for `manager_drilldown_audit` per existing schema). Tamper-evidence invariant (§Compliance, ISO27001 A.12.4.2). Append-only at the DB level, not just code.

7. **`user_machines` MUST gain `provisioned_via text NOT NULL DEFAULT 'pre-v2-unknown'`** with `CHECK (provisioned_via IN ('manual-token', 'sso-auto', 'pre-v2-unknown'))`. The `'pre-v2-unknown'` sentinel for backfilled rows preserves the forensic distinction between "manual-token chosen post-v2" and "manual-token by necessity pre-v2" — important for audit reports asserting choice.

8. **`onboarding_invites` MUST gain `allowed_sso_providers text[]`** (default empty array = allow any). Required for §Decisão #11 multi-IdP-per-domain constraint. Empty array (legacy rows) treated as "all providers allowed" for backwards compat.

9. **`onboarding_invites` MUST gain `CHECK` constraint** for SSO-auto invite patterns: `CHECK (email_pattern IS NULL OR expires_at <= created_at + INTERVAL '180 days')`. Enforces the 180d cap (§Decisão #7) at the DB layer + Zod at the API boundary.

### Decisões locked (input do roadmap + threat enumeration)

1. **Roles**: auto-provisioned users get `role='member'` unconditionally. Admin / manager elevation only via explicit manager action (out of scope here).
2. **Trust boundary**: SSO IdPs (Google, Okta) are trusted endpoints. We trust IdP-asserted `email` + `sub` + `email_verified` + `iss`. Threats inside the IdP itself (§Threat 4) are documented but not mitigated by us.
3. **Public-email-domain blocklist**: SSO auto-provision is **never** triggered for domains in a hardcoded blocklist. The blocklist lives in `apps/server/lib/auth/public-domains.ts` (new file). Initial content: `gmail.com`, `googlemail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `live.com`, `icloud.com`, `me.com`, `proton.me`, `protonmail.com`, `aol.com`, `gmx.com`, `mail.ru`, `qq.com`, `163.com`, `yandex.com`, `duck.com`. Hardcoded (not DB-backed) — manager cannot override per-org. Quarterly manual review process owned by infra team.
4. **Single-match constraint**: SSO auto-provision SÓ ocorre se **exatamente uma** org tem invite pattern matching the email + the invite is not revoked/expired/exhausted. Zero matches → no auto-provision (login proceeds but user lands em "no org" UX). Two-plus matches → no auto-provision (login proceeds; user sees "your email matches multiple orgs — paste invite token").
5. **Outcome enum values (LOCKED — not deferred)**. New `onboarding_outcome` values:
   - `'accepted-sso-auto'`
   - `'rejected-public-domain'`
   - `'rejected-multiple-matches'`
   - `'rejected-no-match'` (no invite pattern matches — fallback to manual)
   - `'rejected-race'` (lock acquisition fails after revoke/expiry/exhaustion)
   - `'rejected-csrf'` (Origin/Referer validation fails)
   - `'rejected-replay'` (state/nonce reuse detected)
   - `'rejected-cross-idp'` (allowed_sso_providers exclusion)
   - `'rejected-pre-existing-binding'` (§Threat 11 — pre-v2 user row encountered)
   - `'email-not-verified'`
   - Plus all existing v1 outcomes for backwards compat.
6. **Email normalization rule (LOCKED)**: before pattern matching AND before computing `email_hash`, normalize email to `lowercase + trim`. **Do NOT strip plus-tags** (`+tag@`) — strippers create account-merge ambiguity (two legitimate users on same IdP tenant can use different plus-tags as separate identities). Therefore: pattern `*@alphaco.com` matches `dev+spam@alphaco.com`, AND `email_hash(dev+spam@alphaco.com) ≠ email_hash(dev@alphaco.com)`. This is correct and expected.
7. **First-auto-provision notification**: the first SSO-auto-provision against a pattern fires an email + dashboard banner to all org admins ("New auto-provision against `*@alphaco.com` happened. If this isn't expected, revoke the invite now."). Banner **persists until a manager explicitly clicks "acknowledge"** — does not auto-dismiss on session refresh (defense against missed alerts; §Threat 3).
8. **Cross-org account model**: if a user has accounts in Org A via manual-token AND SSO matches Org B's pattern, we create a **second `users` row** in Org B. Org A row untouched. Schema precondition #1 makes this possible. UX exposes the duplicate accounts in the SSO IdP-linked profile picker. Documented for users; not "linked-account" merged.
9. **Audit invariant**: every auto-provision attempt (successful or rejected) logs to `onboarding_redemption_log`. Privacy invariant preserved (never log full email). §Compliance details all required fields.
10. **`token_prefix` sentinel** (LOCKED): for zero-match SSO-auto attempts (where no invite pattern matched), the `onboarding_redemption_log.token_prefix` column gets the sentinel value `'00000000'` (8 chars, satisfies the existing `NOT NULL` constraint). Avoids a schema bifurcation between SSO-auto and manual-token paths.
11. **Multi-IdP-per-pattern policy (LOCKED)**: managers specify allowed IdPs per pattern via the `allowed_sso_providers text[]` column (schema precondition #8). Empty array = legacy / "any provider allowed". Non-empty array = restrict. UI surface: invite-creation form has a multi-select "Allow sign-in via:" with `google`, `okta`. Default for new SSO-auto patterns: select the provider the manager themselves is signed into. Mitigates §Threat 12 cross-IdP confused deputy.
12. **Pre-existing user binding policy (LOCKED)**: when an SSO callback's `(email, org_id)` matches a `users` row that has NULL `sso_provider/sso_subject` (i.e., legacy invite-token-provisioned), the auto-provision flow **refuses to bind silently**. Instead it logs `'rejected-pre-existing-binding'` and surfaces a UX prompt to the legitimate-account-holder via the existing manager dashboard ("a sign-in attempt via Google asked to bind to your account; click here to confirm or revoke"). Out-of-band confirmation required. Mitigates §Threat 11.

### Anti-goals (out-of-scope desta threat model)

- IdP-internal compromise mitigations (we trust the IdP).
- Authorization decisions post-provision (role changes, team assignments) — those flow through existing manager UX.
- Migration of pre-existing invite-token-provisioned users to SSO-only mode.
- Cross-org account merging (single-IdP-identity → multiple `users` rows by design; see §Decisão #8).
- SAML enterprise IdPs (current scope is OIDC: Google + Okta only).
- Auto-provision triggered outside SSO context (e.g., webhook from corporate IdP "user joined" event).
- Session anomaly detection (cross-region travel, device fingerprinting) — deferred; §Threat 4 residual.
- DNS-MX verification of invite domain claims — deferred; §Threat 3 hardening option.

## Attacker Model

| Actor | Capability | Goal | In scope? |
| --- | --- | --- | --- |
| **External email-domain adversary** | Owns `attacker@alphaco.com` via typosquatted Google Workspace or personal alias `alphaco-corp@gmail.com`; cannot bypass real corporate auth | Provision into target org → observe team analytics | ✅ §Threat 1 |
| **Domain-takeover adversary** | Buys lapsed corporate domain post-registration expiry, configures Google Workspace | Provision into TokenFx org tied to lapsed domain | ✅ §Threat 3 |
| **Confused-deputy victim** | Legitimate user; email matches multiple org patterns by accident | None — accidental privilege escalation | ✅ §Threat 2 |
| **SSO IdP insider / IdP breach** | Compromised Google / Okta tenant | Mass impersonation | ⚠️ Out of scope; §Threat 4 trust boundary |
| **TokenFx server-side adversary** | Has access to the server DB / process | Anything | ❌ Out of scope (covered by existing infra security model) |
| **Enumeration attacker** | Anonymous; controls a sign-in flow but no real account | Probe which corporate domains are TokenFx customers | ✅ §Threat 6 |
| **Race-condition attacker** | Legitimate session; tries to provision into two orgs simultaneously to win a race | Account creation duplication | ✅ §Threat 7 |
| **Replay attacker** | Captured SSO callback URL with valid state/nonce | Re-execute auto-provision | ✅ §Threat 8 |
| **Malicious org admin** | Legitimate manager credentials in target org | Covertly provision external confederate without UI affordance | ✅ §Threat 9 |
| **Pre-existing-user takeover attacker** | Controls any Google tenant under a target domain (typo squat, subdomain mishap) | Hijack pre-v2 manually-provisioned `users` row before legit user binds SSO | ✅ §Threat 11 |
| **Login-CSRF attacker** | Can serve malicious page to victim's browser | Initiate SSO flow with attacker's account in victim's browser → victim authenticates as attacker | ✅ §Threat 12 |
| **Revocation-race attacker** | Legitimate session; observes manager revoking invite mid-flow | Race the revocation to commit auto-provision against a just-revoked pattern | ✅ §Threat 13 |
| **Email-canonicalization attacker** | Knows IdP folds/normalizes emails differently than TokenFx | Bypass pattern match or audit-log identification via crafted email | ✅ §Threat 14 |
| **Open-redirect attacker** | Controls/influences `callbackUrl` query parameter | Exfiltrate session tokens or phish via post-SSO redirect | ✅ §Threat 15 |

## Threat Enumeration

### Threat 1 — Attacker with matching email but no real SSO credentials

**Vector**: attacker creates `attacker+phish@alphaco.com` via a typo-squatted Google Workspace tenant, or controls a personal Gmail alias `corpco-attack@gmail.com`, hoping the domain match is enough to provision.

**Impact**: HIGH — full access to org-level dashboards (cost, effectiveness, team rosters, prompt summaries).

**Likelihood**: MEDIUM-LOW.

**Mitigation**:

- M1.1 SSO callback validates `id_token.iss` against a whitelist of trusted issuers (`https://accounts.google.com` for Google; per-tenant `https://<tenant>.okta.com` for Okta — stored per `org_id` config).
- M1.2 SSO callback validates `id_token.aud` equals our client ID.
- M1.3 SSO callback validates `id_token.email_verified === true`. Reject otherwise with outcome `'email-not-verified'`.
- M1.4 Email-pattern match uses **case-insensitive exact domain match** OR `*@<domain>` glob — never substring or regex. Validate pattern shape on invite creation. Normalization rule §Decisão #6 applied first.
- M1.5 Public-domain blocklist (§Decisão #3).
- M1.6 Allowed-IdPs per pattern (§Decisão #11): even if domain matches, reject if `id_token.iss` issuer not in `allowed_sso_providers` for the matching invite.

**Residual risk**: LOW.

---

### Threat 2 — Confused deputy: multiple orgs share a matching pattern

**Vector**: Org A and Org B both have invite `*@gmail.com` (legitimate but coincidental, or `*@example.com` corporate-collision via merger / subsidiary). User signs in; ambiguous match.

**Impact**: HIGH — wrong-org provisioning, unexpected analytics visibility.

**Likelihood**: MEDIUM.

**Mitigation**:

- M2.1 **Single-match constraint** (§Decisão #4): SQL query enumerates active invites globally matching the normalized email. If `count(*) != 1`, auto-provision refused; flow falls back to manual invite-token paste (existing v1 happy path) with a UI banner explaining the ambiguity.
- M2.2 Blocklist (§Decisão #3) prevents the public-domain case from entering the matching path.
- M2.3 Manager UI surfaces a warning when creating a pattern that another org already uses (preventive UX, not enforcement — preventive only).
- M2.4 Audit-log entry `'rejected-multiple-matches'` outcome (§Decisão #5).

**Residual risk**: LOW.

---

### Threat 3 — Domain takeover (includes social-engineering subcase, formerly Threat 5)

**Vector A (DNS lapse)**: `Alpha Co` lapses `alphaco.com` registration. Attacker buys the domain, configures Google Workspace, creates `attacker@alphaco.com`, signs in via Google. The invite pattern `*@alphaco.com` is still live in TokenFx.

**Vector B (social engineering)**: attacker social-engineers the org admin (claiming to be "new IT contractor") to renew or recreate an `email_pattern` invite — equivalent endpoint, different entry.

**Impact**: HIGH.

**Likelihood**: LOW per-event but inevitable over multi-year time scales.

**Mitigation**:

- M3.1 **First-auto-provision alert** (§Decisão #7) — email + dashboard banner that persists until manager clicks "acknowledge".
- M3.2 Invite `expires_at` MANDATORY (already in v1 schema). For SSO-auto: max 180d cap (schema precondition #9). For manual-token: max 7d (existing v1 behavior preserved).
- M3.3 Invite re-creation / renewal requires manager confirmation ("type the domain to confirm"). UI friction at the renewal boundary.
- M3.4 Renewal banner at 14d before expiry + 1d before expiry (§Decisão #7 follow-up).

**Residual risk**: MEDIUM. The acknowledge-required banner reduces the silent-takeover window relative to the previous "24-72h email assumption". Worst case persists: if all org admins are inactive simultaneously, the auto-provision succeeded before banner is read. Hardening options for future iteration: multi-admin approval, DNS-MX verification.

---

### Threat 4 — SSO IdP compromised

**Vector**: Google Workspace or Okta tenant of the target org is breached. Attacker gets valid SSO tokens.

**Impact**: CRITICAL.

**Likelihood**: VERY LOW.

**Mitigation**:

- M4.1 **Not in our trust boundary.** We trust Google/Okta.
- M4.2 Defense-in-depth: **scope reduction**. `onboarding_redemption_log` records `sso_subject_hash`, `iss`, `user_agent`, `request_ip` for every SSO event (§Compliance §Decisão #9). On a known-compromise event, admin can run a forensic query: "show all auto-provisions that came from `iss=<compromised-tenant>` after T". Pair with `user_machines.revoked_at` flip to invalidate all sessions for affected users. Detection automation (anomaly scoring, impossible-travel alerts) is deferred to a separate session-anomaly-detection spec.
- M4.3 Org admin can revoke `user_machines` rows individually at any time (existing v1 capability).

**Residual risk**: **CRITICAL-deferred**. Leadership must accept this explicitly. The mitigation gap (no automated detection) is intentional scope; reclassification from "HIGH but accepted" to "CRITICAL-deferred" is the honest framing.

---

### Threat 5 — _(merged into Threat 3 social-engineering subcase)_

This slot intentionally renumbered. See Threat 3 Vector B.

---

### Threat 6 — Email / domain enumeration

**Vector**: attacker probes which corporate domains are TokenFx customers by attempting SSO logins from various tenants and observing success vs fallback UX.

**Impact**: LOW — leaks customer list (marketing-level info).

**Likelihood**: LOW.

**Mitigation**:

- M6.1 **Drop the "constant-time delay" theater.** Replaced with: **all auto-provision attempts (success + reject) return the same generic UX** — a neutral "Welcome — finishing your sign-in" page. Org-membership is revealed only after authenticated dashboard load, which already requires a session. Reduces the probe-from-anonymity attack to "attacker must complete an authenticated session", which is the legitimate barrier we already require.
- M6.2 Rate limit per IP AND per `email_hash` AND per `sso_subject` on the SSO callback endpoint. Per-IP-only is bypassable via residential proxies; layered limits are stricter. Specifics: 10 attempts / 5 min per IP, 3 / 24h per `email_hash`, 5 / 24h per `sso_subject`. Tunable; locked-in starting values.

**Residual risk**: LOW.

---

### Threat 7 — Race condition: simultaneous provisioning into two orgs

**Vector**: two browser tabs initiate SSO, both reach callback; or two parallel callbacks race the `used_count` increment.

**Impact**: MEDIUM — duplicate user rows, broken FK relationships.

**Likelihood**: VERY LOW.

**Mitigation**:

- M7.1 Database unique constraint `UNIQUE (org_id, sso_provider, sso_subject)` on `users` (schema precondition #2 — confirmed NOT yet in schema; migration required).
- M7.2 Provisioning logic runs inside a transaction with `SELECT ... FOR UPDATE` lock on the matching invite row. **(Postgres-specific lock; do not use in root SQLite layer.)** After acquiring the lock, the transaction MUST **re-read and re-validate** `revoked_at IS NULL AND expires_at > now() AND used_count < max_uses` — without the re-check, a revocation between query-1 and lock-acquisition is silently honored (see §Threat 13).
- M7.3 If M7.1 fires, log `'rejected-race'` outcome (§Decisão #5).

**Residual risk**: LOW.

---

### Threat 8 — SSO callback replay

**Vector**: attacker captures a valid SSO callback URL (with state + nonce), replays it.

**Impact**: LOW — gets a session for the original user (session hijacking, not provisioning attack).

**Mitigation**:

- M8.1 NextAuth enforces state + nonce by default. **Verify in v2 test suite**: an integration test must exercise replay-detection (currently asserted but unverified in v1 — flag in implementation spec to add a test, not rely on the claim).
- M8.2 State token single-use; consumed on callback. Replay → `'rejected-replay'` outcome.
- M8.3 PKCE flow (default for Google) prevents replay even if state leaks.

**Residual risk**: VERY LOW.

---

### Threat 9 — Privilege escalation via auto-provision flag tampering (incl. malicious manager)

**Vector A**: malicious manager edits the invite-creation form payload to set `role='admin'` before auto-provision fires.

**Vector B**: malicious manager creates a wildcard pattern `*@alphaco.com` to provision an external confederate (not themselves).

**Impact**: MEDIUM.

**Mitigation**:

- M9.1 **Auto-provisioned role is hardcoded to `'member'` server-side** (§Decisão #1). Invite-row `role` ignored on SSO-auto path.
- M9.2 Role changes post-provision are gated by existing manager-only RBAC.
- M9.3 Invite creation logs to `onboarding_audit_log` with `actor_user_id`. Manager-A creating a wildcard pattern is visible to Manager-B in the audit log + first-auto-provision banner (M3.1) is broadcast to all admins, creating peer visibility.
- M9.4 Audit log retention (§Compliance) — append-only at DB role level (schema precondition #6) means a malicious manager cannot rewrite history.

**Residual risk**: LOW. Provisioning is logged + alerted across all admins.

---

### Threat 10 — Email-hash collision (audit-log degradation)

**Vector**: forged SHA-256 collision in `email_hash`.

**Impact**: VERY LOW.

**Mitigation**: none needed. Document for completeness.

**Residual risk**: NEGLIGIBLE.

---

### Threat 11 — Pre-existing user takeover via SSO claim-jumping (NEW — CRITICAL)

**Vector**: a v1 user `dev@alphaco.com` was provisioned via manual-token (so `users.email = 'dev@alphaco.com'` exists, but `sso_provider` and `sso_subject` are NULL — see v1 schema `0001_onboarding.sql:34-35`). An attacker who controls any Google tenant under `alphaco.com` (typosquat workspace, subdomain mishap, cross-org-domain reuse) signs in via Google first, before the legit user binds their own SSO. Without guards, the SSO callback would fill `(sso_provider='google', sso_subject=<attacker's sub>)` on the existing legit row, permanently binding the legit user's account to the attacker's IdP identity. Every subsequent legit-user SSO attempt would fail or land elsewhere.

**Impact**: CRITICAL — silent account takeover of every v1 manually-provisioned user.

**Likelihood**: MEDIUM. Any v1 customer with manually-provisioned users in domains where the attacker can establish an IdP presence is at risk.

**Mitigation**:

- M11.1 **Pre-existing user binding policy** (§Decisão #12): when SSO callback matches `(email, org_id)` of a row with NULL SSO columns, the binding is **refused**, not silently applied. Outcome `'rejected-pre-existing-binding'`.
- M11.2 Out-of-band confirmation flow: the rejected attempt fires an email to the legitimate user's email address (which we have — that's what made the row match) + a dashboard alert. The legitimate user clicks a link in the email to confirm the SSO binding (one-time, expires in 24h) — or revokes the attempt.
- M11.3 Audit log: `'rejected-pre-existing-binding'` outcome with `sso_subject_hash` (attacker's `sub`) + `request_ip` + `user_agent`. Forensic trail for "who attempted this".

**Residual risk**: LOW. Out-of-band email confirmation is standard account-recovery pattern.

---

### Threat 12 — Login-CSRF / Cross-IdP confused deputy (NEW — HIGH)

**Vector A (Login-CSRF)**: attacker serves a malicious page that auto-initiates the TokenFx SSO flow with the attacker's Google account. Victim's browser executes the redirect; victim ends up authenticated as the attacker without realizing it. Subsequent victim actions (uploading transcripts, viewing dashboards) happen under attacker's identity.

**Vector B (Cross-IdP)**: org has invite `*@alphaco.com` with `allowed_sso_providers=['google']`. Attacker controls `alphaco.com` Okta tenant (different from the org's intended Google workspace). Attacker SSO's via Okta. Without IdP allowlist, the email pattern alone would match.

**Impact**: HIGH — Vector A enables session-hijack-equivalent actions; Vector B enables provisioning via untrusted IdP.

**Likelihood**: MEDIUM (CSRF is well-known attack surface for SSO flows).

**Mitigation**:

- M12.1 Validate `Origin` and/or `Referer` headers on `/api/auth/signin` initiation. Reject cross-origin SSO initiation.
- M12.2 `callbackUrl` query parameter restricted to same-origin allowlist via NextAuth `redirect` callback. Reject absolute URLs to external hosts.
- M12.3 State cookie is HttpOnly + SameSite=Lax (NextAuth defaults; **verify in test**).
- M12.4 Per-pattern `allowed_sso_providers` enforcement (§Decisão #11): SSO callback's `iss` must map to a provider in the allowed array. Otherwise `'rejected-cross-idp'` outcome.
- M12.5 CSRF-specific outcome `'rejected-csrf'` (§Decisão #5).

**Residual risk**: LOW.

---

### Threat 13 — Invite revocation race (NEW — HIGH)

**Vector**: manager revokes invite at T=0 via the manager UI; an SSO callback in flight since T=-200ms reaches the provisioning transaction at T=+100ms. M7.2's `FOR UPDATE` lock prevents concurrent provisions but does NOT prevent a stale-read of `revoked_at IS NULL` from before the lock.

**Impact**: MEDIUM — revoked invite honored, attacker provisioned post-revocation.

**Likelihood**: LOW per-event; not negligible for an active org.

**Mitigation**:

- M13.1 **Re-validation inside transaction** (extension of M7.2): after `SELECT ... FOR UPDATE` lock acquisition, the transaction MUST re-read `revoked_at`, `expires_at`, `used_count` and abort if any condition fails (was rolled to invalid between query-1 and lock-acquire). Outcome `'rejected-race'` (§Decisão #5).
- M13.2 The implementation spec MUST include an integration test that simulates this race (`vi.useFakeTimers()` between the SELECT and the lock, manager UI runs revoke in-between).

**Residual risk**: VERY LOW.

---

### Threat 14 — Email canonicalization mismatch (NEW — HIGH)

**Vector**: Google folds `dev.foo+tag@gmail.com` and `devfoo@gmail.com` to the same address internally but asserts them differently in `id_token.email`. TokenFx pattern matching + `email_hash` computation could produce inconsistent results across IdPs or across the same user's sessions.

**Impact**: HIGH — pattern match bypass (different normalization than IdP) OR audit-log identity confusion (different hashes for same effective user).

**Likelihood**: MEDIUM.

**Mitigation**:

- M14.1 **Normalization rule LOCKED** (§Decisão #6): `lowercase + trim` only. NO plus-tag stripping. Apply uniformly to (a) email pattern matching, (b) `email_hash` computation, (c) audit-log `email_domain` extraction.
- M14.2 Documentation pinned: implementation spec MUST include a TC asserting `(email_hash('dev+tag@alphaco.com') !== email_hash('dev@alphaco.com'))` AND `(*@alphaco.com matches dev+tag@alphaco.com)`.

**Residual risk**: LOW. The deliberate "don't strip plus-tags" choice means two legitimate users on the same IdP tenant can intentionally use different plus-tags as separate identities — a feature, not a bug, for shared-mailbox scenarios.

---

### Threat 15 — Open redirect via `callbackUrl` (NEW — MEDIUM)

**Vector**: NextAuth `callbackUrl` query parameter, historically misconfigured allowlist, redirects to attacker-controlled domain post-authentication. Session cookie may leak via referrer if redirect happens before HSTS-protected response.

**Impact**: MEDIUM — session token exfiltration; phishing via post-SSO redirect to lookalike domain.

**Likelihood**: LOW (NextAuth defaults are restrictive).

**Mitigation**:

- M15.1 NextAuth `redirect` callback explicitly returns `baseUrl + path` only; reject absolute URLs to external hosts. (Same as M12.2.)
- M15.2 HSTS + CSP headers on auth-handling routes (verify in implementation spec).

**Residual risk**: LOW.

---

### Threat 16 — Session policy ambiguity (NEW — MEDIUM)

**Vector**: undocumented session TTL, concurrent-session limits, refresh-on-revoke behavior. SOC2 CC6.1 expects documented policy.

**Impact**: MEDIUM (compliance, not direct exploit).

**Mitigation**:

- M16.1 Lock session policy in implementation spec: max concurrent sessions per user = 5 (configurable per org); max session lifetime = 8h; idle timeout = 30min; rolling refresh on each request; **force-logout on `user_machines.revoked_at` flip** (existing infra; verify wired).
- M16.2 SOC2-required documentation in `apps/server/SECURITY.md` (new file or extend existing).

**Residual risk**: LOW.

---

## Compliance / Audit

### Mandatory audit-log invariants

Every SSO-auto-provision attempt (accepted OR rejected) writes one row to `onboarding_redemption_log` with the following fields:

- `token_prefix` — matched invite token prefix (first 8 chars) on success; sentinel `'00000000'` on zero-match (§Decisão #10).
- `machine_id` — NULL on rejection; populated only on `'accepted-sso-auto'`.
- `email_domain` — plaintext (e.g., `alphaco.com`). Normalized per §Decisão #6.
- `email_hash` — SHA-256 of normalized full email (lowercase + trim, NO plus-tag stripping).
- `request_ip` — from request headers.
- `outcome` — one of §Decisão #5 enum values.
- `method` — `'sso-auto'` for these rows; `'manual-token'` for v1 path. NOT NULL with CHECK constraint (schema precondition #4).
- `sso_provider` — `'google' | 'okta' | <other>` for SSO-auto rows; NULL for manual-token.
- `sso_subject_hash` — SHA-256 of `id_token.sub` (don't store raw `sub` — irreversibly linkable to IdP). NULL for manual-token.
- `iss` — IdP issuer claim (e.g., `https://accounts.google.com`). NULL for manual-token.
- `user_agent` — request `User-Agent` header. Truncated to 512 chars.
- `received_at` — already exists.

Full email is **never** stored or logged anywhere. Privacy invariant inherited from v1 + extended.

### Tamper-evidence

DB-role-level revoke of UPDATE/DELETE on `onboarding_redemption_log` and `onboarding_audit_log` (schema precondition #6). Pattern already used for `manager_drilldown_audit`. App role only has INSERT + SELECT. Required for ISO27001 A.12.4.2.

### Forensic readiness

The audit log supports queries:

- "Every user that auto-provisioned against `*@alphaco.com` in the last 90 days": JOIN on `token_prefix` + `method='sso-auto'` + outcome `'accepted-sso-auto'`.
- "Every rejected attempt by domain": GROUP BY `email_domain`, `outcome`.
- "Did this user ever attempt sign-in?": point lookup on `email_hash`.
- "All sign-ins from IdP `<iss>` after compromise time T" (§Threat 4 forensics): WHERE `iss = ? AND received_at > ?`.
- "Anomalous user_agent patterns": GROUP BY `user_agent`, `email_hash`.

### Clock-skew handling

NTP-synced server clocks REQUIRED. `id_token.exp` validation uses ±60s skew tolerance (NextAuth default). Document explicitly in implementation spec.

### Retention

`onboarding_redemption_log` and `onboarding_audit_log`: retain forever, no auto-purge. Inherited from v1 + extended to SSO rows.

### Manager-facing visibility

New manager-dashboard widget "Auto-provision activity" (out of scope here; specified in implementation spec):

- Successful auto-provisions per pattern.
- Rejected attempts per pattern (broken down by outcome).
- First-auto-provision alerts (M3.1) — with acknowledge button.
- Pre-existing-binding rejection alerts (M11.2) — user-facing, not manager-facing.

## Open Questions (to resolve before implementation spec is authored)

> The implementation spec cannot be approved until each of these resolves to a locked decision.

1. **Q1: Public-domain blocklist update cadence and ownership.** Hardcoded file is fine (§Decisão #3) — but who owns the quarterly review? Infra team? Manager-of-managers? **Recommendation**: infra team, calendar reminder.

2. **Q2: First-auto-provision alert delivery channel.** Email + dashboard banner (§Decisão #7) is locked. **Q2 remainder**: does the email go to all admins, or only the org owner / billing owner? **Recommendation**: all admins (broadest visibility wins; UX dedup on dashboard for "I already saw this in email").

3. **Q3: Banner persistence semantics.** Banner persists until manager clicks "acknowledge" (§Decisão #7). What if there are multiple unacknowledged first-auto-provision events? Stack them, or only show the latest? **Recommendation**: stack; show count badge ("3 unacknowledged"), expand on click.

4. **Q4: Manager re-confirmation interval for long-lived patterns.** 180d max `expires_at` (§schema precondition #9). Banner at 14d + 1d (§Decisão #7). **Q4 remainder**: should renewal extend by 180d from renewal date, or 180d from original creation? **Recommendation**: from renewal date — gives manager a fresh 180d window each cycle.

5. **Q5: Multi-IdP-per-pattern UI default.** `allowed_sso_providers` defaults to "current manager's IdP" (§Decisão #11). **Q5 remainder**: should the manager be able to leave it empty (= any provider) via UI, or always pick at least one? **Recommendation**: enforce ≥1 in UI; if manager wants "any", they pick all currently-supported (`['google', 'okta']`). Closes the cross-IdP ambiguity for new patterns; legacy empty arrays still treated as "any" for backwards compat.

6. **Q6: `provisioned_via` UI surface.** Manager dashboard shows "User created via: manual-token / sso-auto" (per `users` provisioning row). **Q6 remainder**: also filterable in the team-roster view? **Recommendation**: yes — adds zero implementation cost.

7. **Q7: Pre-existing-binding email template (M11.2).** What does the email say? Should it include device/location info ("attempted sign-in from `<city>` via `<browser>`")? **Recommendation**: yes — geographic anomaly helps user judge legitimacy. Use existing reverse-IP lookup if already wired; otherwise just include IP + user-agent string.

8. **Q8: Implementation spec scope split.** One spec covering schema migrations + backend route + manager UI, OR three specs in sequence? **Recommendation**: split into (a) schema-migrations spec (preconditions #1-9), (b) backend SSO-auto-provision spec (REQs derived from threat mitigations), (c) manager-UI spec (banner, audit-log view, pattern-creation UX changes). Sequential dependency: (a) → (b) → (c).

## Acceptance criteria for moving to implementation spec

Before any of the implementation specs are authored, the user must explicitly resolve:

- Each of Open Questions Q1–Q8 above.
- All threats accepted (residual risk acknowledged) — especially the **CRITICAL-deferred** classification of Threat 4 (§Decisão: leadership signs off explicitly).
- Schema preconditions #1-9 reviewed for breaking-change implications (especially #1, the `users.email` global UNIQUE relaxation — has implications for any code path that assumes global uniqueness).
- Implementation spec scope split decision (Q8).

## Out-of-scope (deferred to future iterations)

- Automated session anomaly detection (Threat 4 M4.2 future hardening).
- Multi-admin approval for long-lived pattern renewal.
- DNS-MX-record verification for invite domain claims.
- Auto-provision via SAML enterprise IdPs (current scope is OIDC only).
- Auto-provision triggered outside SSO context (webhook from corporate IdP).
- Cross-org account merging UX.
- Per-user "linked accounts" view in the SSO IdP profile picker.
