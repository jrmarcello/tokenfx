import { describe, it, expect } from 'vitest';
import { QuotaSettingsSchema } from './schema';

// Valid baseline where every field is `null` — tests then override one field
// with the value under examination so each TC focuses on a single boundary.
const BASE = {
  quotaTokens5h: null as number | null,
  quotaTokens7d: null as number | null,
};

type Case = {
  id: string;
  req: string;
  category: 'validation' | 'happy' | 'edge';
  description: string;
  input: Record<string, number | null>;
  expectSuccess: boolean;
};

const CASES: readonly Case[] = [
  {
    id: 'TC-U-12',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = -1 rejected',
    input: { ...BASE, quotaTokens5h: -1 },
    expectSuccess: false,
  },
  {
    id: 'TC-U-13',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = 0 rejected (positive excludes 0)',
    input: { ...BASE, quotaTokens5h: 0 },
    expectSuccess: false,
  },
  {
    id: 'TC-U-14',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = 1 accepted (lower bound)',
    input: { ...BASE, quotaTokens5h: 1 },
    expectSuccess: true,
  },
  {
    id: 'TC-U-15',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = 1_000_000_000 accepted (upper bound)',
    input: { ...BASE, quotaTokens5h: 1_000_000_000 },
    expectSuccess: true,
  },
  {
    id: 'TC-U-16',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = 1_000_000_001 rejected (> upper)',
    input: { ...BASE, quotaTokens5h: 1_000_000_001 },
    expectSuccess: false,
  },
  {
    id: 'TC-U-17',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = 1.5 rejected (non-integer)',
    input: { ...BASE, quotaTokens5h: 1.5 },
    expectSuccess: false,
  },
  {
    id: 'TC-U-18',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaTokens5h = null accepted',
    input: { ...BASE, quotaTokens5h: null },
    expectSuccess: true,
  },
  {
    id: 'TC-U-21',
    req: 'REQ-5',
    category: 'validation',
    description: 'both token fields null accepted (reset)',
    input: { ...BASE },
    expectSuccess: true,
  },
  // --- TASK-2: session fields removed, tokens-only schema ---
  {
    id: 'TC-U-01',
    req: 'REQ-2',
    category: 'happy',
    description:
      'both token fields set with realistic values accepted (2-field result)',
    input: { quotaTokens5h: 500_000, quotaTokens7d: 3_000_000 },
    expectSuccess: true,
  },
  {
    id: 'TC-U-03',
    req: 'REQ-2',
    category: 'validation',
    description: 'quotaTokens5h = 0 rejected (positive)',
    input: { quotaTokens5h: 0, quotaTokens7d: null },
    expectSuccess: false,
  },
  {
    id: 'TC-U-04',
    req: 'REQ-2',
    category: 'validation',
    description: 'quotaTokens5h = -5 rejected',
    input: { quotaTokens5h: -5, quotaTokens7d: null },
    expectSuccess: false,
  },
  {
    id: 'TC-U-05',
    req: 'REQ-2',
    category: 'validation',
    description: 'quotaTokens5h = 1_000_000_001 rejected (> max 1B)',
    input: { quotaTokens5h: 1_000_000_001, quotaTokens7d: null },
    expectSuccess: false,
  },
  {
    id: 'TC-U-06',
    req: 'REQ-2',
    category: 'happy',
    description: 'both fields null accepted (both nullable)',
    input: { quotaTokens5h: null, quotaTokens7d: null },
    expectSuccess: true,
  },
  {
    id: 'TC-U-07',
    req: 'REQ-2',
    category: 'validation',
    description: 'quotaTokens5h = 1.5 rejected (int)',
    input: { quotaTokens5h: 1.5, quotaTokens7d: null },
    expectSuccess: false,
  },
];

describe('QuotaSettingsSchema', () => {
  it.each(CASES)(
    '$id ($req, $category): $description',
    ({ input, expectSuccess }) => {
      const result = QuotaSettingsSchema.safeParse(input);
      expect(result.success).toBe(expectSuccess);
    }
  );

  // TC-U-02: explicit — Zod default (non-strict) strips extra keys, schema accepts.
  it('TC-U-02 (REQ-2, edge): extra session key is stripped (Zod non-strict default)', () => {
    const input = {
      quotaTokens5h: 500_000,
      quotaTokens7d: 3_000_000,
      quotaSessions5h: 100,
    };
    const result = QuotaSettingsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        quotaTokens5h: 500_000,
        quotaTokens7d: 3_000_000,
      });
      expect('quotaSessions5h' in result.data).toBe(false);
    }
  });
});
