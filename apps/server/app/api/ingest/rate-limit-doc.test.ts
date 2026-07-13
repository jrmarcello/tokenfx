/**
 * Doc-guard tests for the ingest rate limiter's single-instance premise.
 * Spec: .specs/arch-followups-lowsev.md (REQ-5, TC-U-09/TC-U-10).
 *
 * Pure filesystem grep — no Postgres, runs regardless of SKIP_PG_TESTS. Guards
 * against silently dropping the operational documentation of the in-memory,
 * single-instance rate limiter.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const serverRoot = path.resolve(__dirname, '..', '..', '..');

describe('rate-limiter single-instance documentation', () => {
  it('route.ts documents the single-instance premise adjacent to rateLimitBuckets (TC-U-09)', () => {
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    const lines = src.split('\n');
    const declIdx = lines.findIndex((l) => l.includes('const rateLimitBuckets'));
    expect(declIdx).toBeGreaterThan(-1);
    // The single-instance note must sit in the block immediately above the
    // declaration (within ~10 lines), not merely somewhere in the file.
    const block = lines.slice(Math.max(0, declIdx - 10), declIdx).join('\n');
    expect(block.toLowerCase()).toMatch(/single-instance|single instance/);
  });

  it('README documents the single-instance rate-limit premise (TC-U-10)', () => {
    const readme = readFileSync(path.join(serverRoot, 'README.md'), 'utf8');
    const idx = readme.indexOf('## Rate limits');
    expect(idx).toBeGreaterThan(-1); // fail loudly if the heading is renamed
    const rateSection = readme.slice(idx);
    expect(rateSection.toLowerCase()).toMatch(/single-instance|single instance/);
  });
});
