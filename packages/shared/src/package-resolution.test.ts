/**
 * Package-resolution tests for @tokenfx/shared.
 * Spec: .specs/refactor-monorepo-shared-package.md (REQ-2 / TC-U-02, TC-U-04).
 *
 * These import the package by its PUBLIC subpaths (`@tokenfx/shared/*`), not by
 * relative path — so they exercise the `exports` map + the workspace symlink,
 * proving consumers can resolve every subpath. (RED until the workspace install
 * links `node_modules/@tokenfx/shared`.)
 */
import { describe, it, expect } from 'vitest';
import { log } from '@tokenfx/shared/logger';
import { deriveModelFamily } from '@tokenfx/shared/analytics/model';
import { effectiveCostForSession } from '@tokenfx/shared/analytics/cost-calibration';
import {
  WIRE_VERSION,
  WIRE_VERSION_MIN,
  WIRE_VERSION_MAX,
  type IngestEnvelope,
  SanitizedSessionPayload,
  type SanitizeError,
} from '@tokenfx/shared/reporter/types';
import { canonicalJSON } from '@tokenfx/shared/reporter/canonical-json';

describe('@tokenfx/shared subpath resolution (TC-U-02)', () => {
  it('resolves every public subpath and exposes its primary symbol', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof deriveModelFamily).toBe('function');
    expect(typeof effectiveCostForSession).toBe('function');
    expect(WIRE_VERSION).toBe(1);
    expect(typeof canonicalJSON).toBe('function');
  });
});

describe('reporter/types keeps both wire types and the sanitizer schema (TC-U-04)', () => {
  it('exports the wire-version constants and IngestEnvelope shape', () => {
    expect(WIRE_VERSION_MIN).toBe(1);
    expect(WIRE_VERSION_MAX).toBe(1);
    // Type-level assertion: IngestEnvelope is importable (compile-time only).
    const env: IngestEnvelope = {
      version: WIRE_VERSION,
      key_id: 'k',
      machine_id: 'm',
      payload: [],
    };
    expect(env.version).toBe(1);
  });

  it('exports the SanitizedSessionPayload Zod schema and SanitizeError type', () => {
    expect(typeof SanitizedSessionPayload.safeParse).toBe('function');
    // SanitizeError is a type; reference it to assert it survived the move.
    const e: SanitizeError = { kind: 'empty-cwd' };
    expect(e.kind).toBe('empty-cwd');
  });
});
