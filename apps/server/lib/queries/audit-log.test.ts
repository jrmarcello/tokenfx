/**
 * Unit tests for the audit-log query module (TASK-6).
 *
 * Spec: .specs/central-server-onboarding-v2-sso.manager-ui.md
 *
 * Scope: pure-logic helpers that don't need a live Postgres — escape of
 * LIKE metacharacters in user-supplied filter values + the page-bound
 * runtime guard. Postgres-backed end-to-end coverage (LEFT JOIN, cross-org
 * isolation, ORDER BY, COUNT(*) OVER, ILIKE behaviour, perf budget) lives
 * in `tests/integration/audit-log-view.test.ts`.
 *
 * Conventions: hand-written stubs (no mocking framework), natural-English
 * `it()` names, TC-IDs annotated as comments for spec traceability.
 */
import { describe, expect, it } from 'vitest';

import {
  escapeLikePattern,
  loadAuditLogPage,
  writeAuditMachineRevoked,
} from './audit-log';

describe('writeAuditMachineRevoked', () => {
  // TC-I-07 (REQ-6): param → insert mapping, via a hand-written stub db (no
  // Postgres). End-to-end DB coverage is TC-I-07 in machines.test.ts; this is
  // the unit-level param-mapping guard.
  it('maps params to a prefix-only machine-revoked audit row', async () => {
    let captured: Record<string, unknown> | undefined;
    const stubDb = {
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          captured = v;
        },
      }),
    } as unknown as Parameters<typeof writeAuditMachineRevoked>[0];

    await writeAuditMachineRevoked(stubDb, {
      orgId: 'org-1',
      actorUserId: 'admin-1',
      targetTokenPrefix: 'k_a1b2c3',
      metadata: { keyPrefix: 'k_a1b2c3', machineId: 'm-1', userEmail: 'dev@x.example' },
    });

    expect(captured).toMatchObject({
      orgId: 'org-1',
      actorUserId: 'admin-1',
      action: 'machine-revoked',
      targetTokenPrefix: 'k_a1b2c3',
    });
    // Metadata is prefix-only — no full key_id.
    expect(JSON.stringify(captured?.metadata)).toContain('k_a1b2c3');
  });
});

describe('escapeLikePattern', () => {
  // TC-I-15 (REQ-4): literal % in user input must NOT act as a wildcard.
  it('escapes a bare percent so it is matched literally by ILIKE', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  // TC-I-15 (REQ-4): literal _ in user input must NOT act as a wildcard.
  it('escapes a bare underscore so it is matched literally by ILIKE', () => {
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
  });

  // TC-I-15 (REQ-4): both metacharacters present must both be escaped.
  it('escapes every percent and underscore in mixed input', () => {
    expect(escapeLikePattern('%_a%_b')).toBe('\\%\\_a\\%\\_b');
  });

  // Defensive: empty string is a noop (not an error).
  it('returns empty string unchanged', () => {
    expect(escapeLikePattern('')).toBe('');
  });

  // Defensive: a string without metacharacters passes through unchanged.
  it('returns a clean string unchanged', () => {
    expect(escapeLikePattern('São Paulo')).toBe('São Paulo');
  });

  // The backslash itself must be escaped first so subsequent rule swaps
  // don't double-escape (`\%` would become `\\\%` and never match).
  it('escapes a backslash so it does not cascade into the metachar escape', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });
});

describe('loadAuditLogPage page-bound guard', () => {
  // Minimal Db stub — we never reach query execution because the guard
  // throws beforehand. The shape only has to satisfy the type system.
  const stubDb = {} as Parameters<typeof loadAuditLogPage>[0];

  // TC-I-43c (REQ-4): negative pages are a programmer error at the
  // query layer — the page-component caller is responsible for clamping
  // user input to a safe value via Zod BEFORE calling this function.
  it('throws when page is negative (caller must clamp to 0 via Zod)', async () => {
    await expect(
      loadAuditLogPage(stubDb, 'org-1', {}, -1),
    ).rejects.toThrow(/page must be non-negative integer/);
  });

  // TC-I-43c (REQ-4): NaN propagated to SQL would silently break LIMIT/OFFSET;
  // the runtime guard catches it before binding.
  it('throws when page is NaN', async () => {
    await expect(
      loadAuditLogPage(stubDb, 'org-1', {}, Number.NaN),
    ).rejects.toThrow(/page must be non-negative integer/);
  });

  // TC-I-43c (REQ-4): non-integer floats are also rejected — OFFSET requires
  // an integer in Postgres and a silent floor would mask caller bugs.
  it('throws when page is a non-integer float', async () => {
    await expect(
      loadAuditLogPage(stubDb, 'org-1', {}, 1.5),
    ).rejects.toThrow(/page must be non-negative integer/);
  });
});
