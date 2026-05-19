/**
 * Unit tests for `buildSpawnOptions` (TASK-0 / TC-U-01 + TC-U-02 of
 * `.specs/fix-sso-e2e-remaining-5.md`).
 *
 * Pure-function tests — no actual `spawn` call. The integration suite
 * (`spawn-with-log.integration.test.ts`) covers the real child-process
 * + filesystem behavior (TC-I-01..04).
 */
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { buildSpawnOptions } from './spawn-with-log';

describe('buildSpawnOptions', () => {
  it('TC-U-01 returns stdio:["ignore","pipe","pipe"] + resolved log path', () => {
    const result = buildSpawnOptions('dev-server', '/tmp/logs');
    expect(result.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(result.logPath).toBe(path.resolve('/tmp/logs', 'dev-server.log'));
  });

  it.each([
    { label: 'idp-stub' },
    { label: 'dev-server' },
    { label: 'child-process-1' },
  ])('TC-U-01 accepts safe labels: $label', ({ label }) => {
    expect(() => buildSpawnOptions(label, '/tmp/logs')).not.toThrow();
  });

  it.each([
    { label: '..', why: 'parent traversal' },
    { label: '../etc', why: 'parent traversal with path' },
    { label: '/etc/passwd', why: 'absolute path' },
    { label: 'foo/bar', why: 'embedded slash' },
    { label: '', why: 'empty string' },
    { label: '   ', why: 'whitespace only' },
  ])('TC-U-02 rejects unsafe label: $label ($why)', ({ label }) => {
    expect(() => buildSpawnOptions(label, '/tmp/logs')).toThrow();
  });
});
