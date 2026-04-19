import { describe, it, expect } from 'vitest';
import { QuotaSettingsSchema } from './schema';

// Valid baseline where every field is `null` — tests then override one field
// with the value under examination so each TC focuses on a single boundary.
const BASE = {
  quotaTokens5h: null as number | null,
  quotaTokens7d: null as number | null,
  quotaSessions5h: null as number | null,
  quotaSessions7d: null as number | null,
};

type Case = {
  id: string;
  req: string;
  category: 'validation';
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
    id: 'TC-U-19',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaSessions5h = 10_001 rejected (> upper)',
    input: { ...BASE, quotaSessions5h: 10_001 },
    expectSuccess: false,
  },
  {
    id: 'TC-U-20',
    req: 'REQ-5',
    category: 'validation',
    description: 'quotaSessions5h = 10_000 accepted (upper bound)',
    input: { ...BASE, quotaSessions5h: 10_000 },
    expectSuccess: true,
  },
  {
    id: 'TC-U-21',
    req: 'REQ-5',
    category: 'validation',
    description: 'all 4 fields null accepted (reset)',
    input: { ...BASE },
    expectSuccess: true,
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
});
