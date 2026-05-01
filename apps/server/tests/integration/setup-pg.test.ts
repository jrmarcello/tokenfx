/**
 * Smoke test for the Postgres globalSetup wiring (TASK-11).
 *
 * Verifies the module exports both `setup` and `teardown` as functions —
 * Vitest's globalSetup contract requires this shape. Importing the module
 * also catches obvious type/syntax regressions in the setup file itself.
 */
import { describe, expect, it } from 'vitest';
import * as setupModule from './setup-pg';

describe('setup-pg', () => {
  it('exports a setup function', () => {
    expect(typeof setupModule.setup).toBe('function');
  });

  it('exports a teardown function', () => {
    expect(typeof setupModule.teardown).toBe('function');
  });
});
