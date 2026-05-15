---
name: fix-sso-issuer-host-bridge spec review — iteration 2
description: Host.docker.internal approach confirmed; remaining gaps after v2 rewrite
type: project
---

Spec reviewed: `.specs/fix-sso-issuer-host-bridge.md` (DRAFT, iteration 2, 2026-05-15)

## Approach confirmed

Switched from "localhost + AUTH_TRUST_HOST" to "host.docker.internal everywhere". All three env vars (OKTA_ISSUER, IDP_STUB_BASE_URL, TOKENFX_SSO_ISSUERS_OKTA) set to http://host.docker.internal:3001 in TASK-1. Previous critical gaps from v1 are closed.

## Remaining gaps after v2

### MUST FIX

1. **REQ-4 cross-platform claim is over-broad.** REQ-4 says "proves host.docker.internal:host-gateway works cross-platform" but the fix only adds extra_hosts to tokenfx-server. On Linux, browser resolution still requires a manual /etc/hosts step. The REQ language overstates what the compose fix proves.

2. **TC-V-08 is not a unit test and has no implementation path.** It says "unit-style test inside the server container" but lists no test file and no mechanism to call evaluateAutoProvision directly inside a running container. TASK-6 has files: [] and no test file path. Either add a real unit test file (collocated test) or make it a manual validation step with an explicit curl/exec command.

3. **TASK-SMOKE touches docs/smoke-runbook.md AND runs Playwright.** docs/smoke-runbook.md is also touched by TASK-2 (Batch 2) and TASK-8 (Batch 3). TASK-SMOKE is in Batch 4 and says files: docs/smoke-runbook.md — if ralph-loop serializes strictly by files:, there's no conflict, but the overlap needs a depends: TASK-8 (currently only TASK-3, TASK-4, TASK-8 listed — actually TASK-8 is listed, so this may be OK).

### SHOULD FIX

4. **No TC for the idp-stub healthcheck regression.** The healthcheck in docker-compose.yaml uses `http://localhost:3001` (container-internal). After IDP_STUB_BASE_URL changes to host.docker.internal, the healthcheck still works (it probes localhost inside the stub container, which is fine). But there's no TC asserting the stub comes up healthy post-change. Worth a TC-V-XX.

5. **TC-V-06 is not actionable without a test mechanism.** The spec says "HTTP 200 — ACCEPTED behavior" with no curl command or Playwright step that actually fires a spoofed Host header. It documents the trade-off but provides no verification path.

6. **AUTH_TRUST_HOST security note does not mention NEXTAUTH_URL interaction.** When AUTH_TRUST_HOST=1, NextAuth ignores the Host header for callback URL construction and uses NEXTAUTH_URL instead. This is actually the safer behavior here (NEXTAUTH_URL=http://localhost:3232 pins the callback). Worth one sentence in the security note.

## Why

Prevents a spec that ships with an over-broad REQ claim (REQ-4), a phantom test (TC-V-08 with no file), and a trade-off note missing a key nuance about NEXTAUTH_URL.

## How to apply

When reviewing next iteration: verify REQ-4 is narrowed to "server-side fetch succeeds", TC-V-08 has a concrete implementation path, and the AUTH_TRUST_HOST note mentions NEXTAUTH_URL as the callback pin.
