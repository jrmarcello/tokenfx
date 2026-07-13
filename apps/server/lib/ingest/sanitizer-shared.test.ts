import { describe, it, expect } from 'vitest';
import { SanitizedSessionPayload } from './sanitizer-shared';
import { SanitizedSessionPayload as SharedSchema } from '@tokenfx/shared/reporter/types';

describe('sanitizer-shared (TASK-13)', () => {
  it('re-exports the SanitizedSessionPayload Zod schema from @tokenfx/shared/reporter/types', () => {
    expect(SanitizedSessionPayload).toBeDefined();
    // Sanity-check: the schema rejects an empty object (root has required fields)
    const result = SanitizedSessionPayload.safeParse({});
    expect(result.success).toBe(false);
  });

  it('is the SAME Zod object as @tokenfx/shared/reporter/types — single source of truth (TC-U-03)', () => {
    // Referential identity: server-side validation and reporter-side
    // construction MUST share one schema instance. A second, independently
    // constructed copy would `===`-fail here and signal a privacy-drift risk
    // (the refactor moving the file must not fork it).
    expect(SanitizedSessionPayload).toBe(SharedSchema);
  });
});
