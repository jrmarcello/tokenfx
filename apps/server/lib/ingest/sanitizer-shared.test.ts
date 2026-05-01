import { describe, it, expect } from 'vitest';
import { SanitizedSessionPayload } from './sanitizer-shared';

describe('sanitizer-shared (TASK-13)', () => {
  it('re-exports the SanitizedSessionPayload Zod schema from @root/reporter/types', () => {
    expect(SanitizedSessionPayload).toBeDefined();
    // Sanity-check: the schema rejects an empty object (root has required fields)
    const result = SanitizedSessionPayload.safeParse({});
    expect(result.success).toBe(false);
  });
});
