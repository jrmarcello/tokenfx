import { describe, it, expect } from 'vitest';
import {
  deriveProjectSlug,
  sanitizeSession,
  type SessionWithAggs,
} from './sanitizer';
import { SanitizedSessionPayload } from './types';

// ---------- Helpers ----------

const SECRET = 'test-project-secret-123';

const baseInput = (): SessionWithAggs => ({
  id: 'sess-abc123',
  cwd: '/Users/alice/work/tokenfx',
  started_at: 1_700_000_000_000,
  ended_at: 1_700_000_001_000,
  git_branch: 'main',
  cc_version: '1.2.3',
  total_input_tokens: 1000,
  total_output_tokens: 500,
  total_cache_read_tokens: 200,
  total_cache_creation_tokens: 100,
  total_cost_usd: 0.05,
  total_cost_usd_otel: 0.045,
  turn_count: 10,
  tool_call_count: 25,
  model_breakdown: [
    {
      model: 'claude-sonnet-4',
      input_tokens: 800,
      output_tokens: 400,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      cost_usd: 0.04,
    },
  ],
  tool_counts: { Edit: 12, Read: 30 },
  avg_rating: 0.5,
  cache_hit_ratio: 0.2,
  output_input_ratio: 0.5,
  subagent_usage_ratio: 0.1,
});

// Deep walker — collects every key seen in a JSON-serialisable structure.
const collectKeys = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    collectKeys(v, out);
  }
  return out;
};

const ALLOWLIST_ROOT = new Set([
  'session_id',
  'started_at',
  'ended_at',
  'project_slug',
  'git_branch',
  'cc_version',
  'total_input_tokens',
  'total_output_tokens',
  'total_cache_read_tokens',
  'total_cache_creation_tokens',
  'total_cost_usd',
  'total_cost_usd_otel',
  'turn_count',
  'tool_call_count',
  'model_breakdown',
  'tool_counts',
  'avg_rating',
  'cache_hit_ratio',
  'output_input_ratio',
  'subagent_usage_ratio',
]);

const ALLOWLIST_MODEL = new Set([
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
]);

// ---------- Tests ----------

describe('sanitizeSession — happy path & allowlist', () => {
  it('TC-U-01: produces all 20 allowlist root fields and types are correct', () => {
    const result = sanitizeSession(baseInput(), { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.value);
    expect(new Set(keys)).toEqual(ALLOWLIST_ROOT);
    expect(typeof result.value.session_id).toBe('string');
    expect(typeof result.value.started_at).toBe('number');
    expect(Array.isArray(result.value.model_breakdown)).toBe(true);
    expect(typeof result.value.tool_counts).toBe('object');
  });
});

describe('sanitizeSession — privacy: prohibited fields never leak', () => {
  type ProhibitedCase = {
    tc: string;
    description: string;
    extras: Record<string, unknown>;
    forbiddenSubstrings: readonly string[];
  };

  const cases: readonly ProhibitedCase[] = [
    {
      tc: 'TC-U-02',
      description: 'user_prompt with secret credentials',
      extras: { user_prompt: 'secret credentials please dont leak' },
      forbiddenSubstrings: ['user_prompt', 'secret credentials'],
    },
    {
      tc: 'TC-U-03',
      description: 'assistant_text with transcript content',
      extras: { assistant_text: 'here is your private answer XYZ123' },
      forbiddenSubstrings: ['assistant_text', 'private answer', 'XYZ123'],
    },
    {
      tc: 'TC-U-04',
      description: 'tool_uses_json with absolute path',
      extras: {
        tool_uses_json:
          '[{"input":{"path":"/Users/alice/.ssh/id_rsa"}}]',
      },
      forbiddenSubstrings: ['tool_uses_json', 'id_rsa', '.ssh'],
    },
    {
      tc: 'TC-U-06',
      description: 'rating note with leaked AWS key',
      extras: { note: 'leaked AWS key AKIA1234567890' },
      forbiddenSubstrings: ['note', 'AKIA1234567890', 'leaked'],
    },
  ];

  it.each(cases)('$tc: $description does not appear in output', ({ extras, forbiddenSubstrings }) => {
    const input = { ...baseInput(), ...extras } as SessionWithAggs &
      Record<string, unknown>;
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = JSON.stringify(result.value);
    for (const needle of forbiddenSubstrings) {
      expect(out.includes(needle)).toBe(false);
    }
  });

  it('TC-U-05: cwd & source_file values do not leak (only project_slug derived)', () => {
    const input = {
      ...baseInput(),
      cwd: '/Users/alice/private',
      source_file: '/Users/alice/.claude/projects/x.jsonl',
    } as SessionWithAggs & Record<string, unknown>;
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = JSON.stringify(result.value);
    expect(out.includes('/Users/alice')).toBe(false);
    expect(out.includes('source_file')).toBe(false);
    expect(out.includes('private')).toBe(false);
    expect(out.includes('cwd')).toBe(false);
    // project_slug must still match expected pattern
    expect(result.value.project_slug).toMatch(/^slug:[0-9a-f]{16}$/);
  });
});

describe('sanitizeSession — TC-U-07 red-team fuzz (100 random extras)', () => {
  it('rejects 100 random injected fields — none leak via deep-walk', () => {
    const adversarialKeys = [
      'password',
      '__proto__',
      'prompt_text',
      'private_key',
      'secret_token',
      'apiKey',
      'auth.bearer',
      'x_user_prompt',
      'completion',
      'transcript',
      'message_body',
      'system_prompt',
      'aws_secret',
      'gh_pat',
      'env_vars',
      'cookies',
      'session_token',
    ];
    // Build 100 random keys (mix adversarial + random gibberish)
    const fuzzKeys: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i < adversarialKeys.length) {
        fuzzKeys.push(adversarialKeys[i]!);
      } else {
        fuzzKeys.push(`fuzz_${i}_${Math.random().toString(36).slice(2, 10)}`);
      }
    }
    const fuzzPayload: Record<string, unknown> = {};
    const sentinelValues: string[] = [];
    fuzzKeys.forEach((k, i) => {
      const sentinel = `LEAK_SENTINEL_${i}_xyz`;
      sentinelValues.push(sentinel);
      fuzzPayload[k] = sentinel;
    });

    const input = { ...baseInput(), ...fuzzPayload } as SessionWithAggs &
      Record<string, unknown>;
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Deep-walk: collect every key in the output and assert no fuzz key appears
    const outKeys = collectKeys(result.value);
    for (const k of fuzzKeys) {
      expect(outKeys.has(k)).toBe(false);
    }
    // Also ensure no sentinel value leaks via stringify
    const stringified = JSON.stringify(result.value);
    for (const s of sentinelValues) {
      expect(stringified.includes(s)).toBe(false);
    }
  });
});

describe('Zod schema .strict() — TC-U-08', () => {
  it('rejects unknown root key foo via schema-level safeParse', () => {
    // Defence-in-depth check: the sanitizer constructs payloads explicitly
    // (so injected keys are stripped before Zod sees them), but the schema
    // itself MUST also reject unknown keys for any direct boundary use.
    const candidate = {
      session_id: 'sess-1',
      started_at: 1,
      ended_at: 2,
      project_slug: 'slug:0123456789abcdef',
      git_branch: null,
      cc_version: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0,
      total_cost_usd_otel: null,
      turn_count: 0,
      tool_call_count: 0,
      model_breakdown: [],
      tool_counts: {},
      avg_rating: null,
      cache_hit_ratio: null,
      output_input_ratio: null,
      subagent_usage_ratio: null,
      foo: 'bar', // unknown key — must be rejected
    };
    const parsed = SanitizedSessionPayload.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown key inside model_breakdown entry', () => {
    const candidate = {
      session_id: 'sess-1',
      started_at: 1,
      ended_at: 2,
      project_slug: 'slug:0123456789abcdef',
      git_branch: null,
      cc_version: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0,
      total_cost_usd_otel: null,
      turn_count: 0,
      tool_call_count: 0,
      model_breakdown: [
        {
          model: 'm',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_usd: 0,
          extra: 'leak', // unknown nested key
        },
      ],
      tool_counts: {},
      avg_rating: null,
      cache_hit_ratio: null,
      output_input_ratio: null,
      subagent_usage_ratio: null,
    };
    const parsed = SanitizedSessionPayload.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });
});

describe('sanitizeSession — numeric boundaries', () => {
  type NumCase = {
    tc: string;
    description: string;
    mutate: (input: SessionWithAggs) => void;
    expectOk: boolean;
  };

  const cases: readonly NumCase[] = [
    {
      tc: 'TC-U-09',
      description: 'negative total_input_tokens rejected',
      mutate: (i) => {
        i.total_input_tokens = -5;
      },
      expectOk: false,
    },
    {
      tc: 'TC-U-10',
      description: 'NaN total_input_tokens rejected',
      mutate: (i) => {
        i.total_input_tokens = Number.NaN;
      },
      expectOk: false,
    },
    {
      tc: 'TC-U-11',
      description: 'Infinity total_input_tokens rejected',
      mutate: (i) => {
        i.total_input_tokens = Number.POSITIVE_INFINITY;
      },
      expectOk: false,
    },
    {
      tc: 'TC-U-12',
      description: 'total_input_tokens=0 accepted (valid min)',
      mutate: (i) => {
        i.total_input_tokens = 0;
      },
      expectOk: true,
    },
    {
      tc: 'TC-U-13',
      description: 'total_input_tokens=MAX_SAFE_INTEGER accepted',
      mutate: (i) => {
        i.total_input_tokens = Number.MAX_SAFE_INTEGER;
      },
      expectOk: true,
    },
    {
      tc: 'TC-U-14',
      description: 'total_input_tokens=MAX_SAFE_INTEGER+1 rejected (precision loss)',
      mutate: (i) => {
        i.total_input_tokens = Number.MAX_SAFE_INTEGER + 1;
      },
      expectOk: false,
    },
    {
      tc: 'TC-U-15',
      description: 'started_at > ended_at rejected via .refine',
      mutate: (i) => {
        i.started_at = 2_000_000_000_000;
        i.ended_at = 1_000_000_000_000;
      },
      expectOk: false,
    },
  ];

  it.each(cases)('$tc: $description', ({ mutate, expectOk }) => {
    const input = baseInput();
    mutate(input);
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(expectOk);
  });
});

describe('sanitizeSession — avg_rating boundaries', () => {
  type RatingCase = {
    tc: string;
    description: string;
    value: number | null;
    expectOk: boolean;
  };

  const cases: readonly RatingCase[] = [
    { tc: 'TC-U-16', description: 'avg_rating=null accepted', value: null, expectOk: true },
    { tc: 'TC-U-17', description: 'avg_rating=2 (out of [-1,1]) rejected', value: 2, expectOk: false },
    { tc: 'TC-U-18', description: 'avg_rating=-1.0001 rejected', value: -1.0001, expectOk: false },
    { tc: 'TC-U-19a', description: 'avg_rating=-1 (boundary) accepted', value: -1, expectOk: true },
    { tc: 'TC-U-19b', description: 'avg_rating=1 (boundary) accepted', value: 1, expectOk: true },
  ];

  it.each(cases)('$tc: $description', ({ value, expectOk }) => {
    const input = baseInput();
    input.avg_rating = value;
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(expectOk);
  });
});

describe('deriveProjectSlug — REQ-2', () => {
  it('TC-U-20: produces slug:<16hex> deterministically', () => {
    const a = deriveProjectSlug('/Users/alice/work/foo', 'abc');
    const b = deriveProjectSlug('/Users/alice/work/foo', 'abc');
    expect(a).toMatch(/^slug:[0-9a-f]{16}$/);
    expect(a).toEqual(b);
  });

  it('TC-U-21: different secrets yield different slugs (non-correlatable)', () => {
    const a = deriveProjectSlug('/Users/alice/work/foo', 'secret-1');
    const b = deriveProjectSlug('/Users/alice/work/foo', 'secret-2');
    expect(a).not.toEqual(b);
  });

  it('TC-U-22a: empty cwd returns sanitize error empty-cwd via sanitizeSession', () => {
    const input = baseInput();
    input.cwd = '';
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-cwd');
  });

  it('TC-U-22b: trailing slash in cwd produces a valid slug', () => {
    const slug = deriveProjectSlug('/Users/alice/work/foo/', 'abc');
    expect(slug).toMatch(/^slug:[0-9a-f]{16}$/);
  });

  it('TC-U-22c: unicode segments produce a valid slug', () => {
    const slug = deriveProjectSlug('/Users/alice/work/プロジェクト', 'abc');
    expect(slug).toMatch(/^slug:[0-9a-f]{16}$/);
  });
});

describe('sanitizeSession — model_breakdown', () => {
  it('TC-U-28: array of 3 models — all present, no extra keys', () => {
    const input = baseInput();
    input.model_breakdown = [
      {
        model: 'claude-opus-4',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        cost_usd: 0.01,
      },
      {
        model: 'claude-sonnet-4',
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 20,
        cache_creation_tokens: 10,
        cost_usd: 0.02,
      },
      {
        model: 'claude-haiku-4',
        input_tokens: 300,
        output_tokens: 150,
        cache_read_tokens: 30,
        cache_creation_tokens: 15,
        cost_usd: 0.03,
      },
    ];
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model_breakdown.length).toBe(3);
    for (const m of result.value.model_breakdown) {
      expect(new Set(Object.keys(m))).toEqual(ALLOWLIST_MODEL);
    }
  });

  it('TC-U-29: model_breakdown[0] with injected prompt does NOT leak', () => {
    const input = baseInput();
    input.model_breakdown[0] = {
      ...input.model_breakdown[0]!,
      // @ts-expect-error: deliberate injection
      prompt: 'secret system prompt LEAK_PROMPT',
    };
    const result = sanitizeSession(input, { projectSecret: SECRET });
    // Sanitizer constructs each model entry explicitly, so injected fields
    // are stripped before reaching Zod. Result should be ok.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = JSON.stringify(result.value);
    expect(out.includes('LEAK_PROMPT')).toBe(false);
    expect(out.includes('"prompt"')).toBe(false);
    // First model entry still valid
    const first = result.value.model_breakdown[0]!;
    expect(new Set(Object.keys(first))).toEqual(ALLOWLIST_MODEL);
  });
});

describe('sanitizeSession — tool_counts', () => {
  it('TC-U-30: shape preserved with non-negative values', () => {
    const input = baseInput();
    input.tool_counts = { Edit: 12, Read: 30 };
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tool_counts).toEqual({ Edit: 12, Read: 30 });
  });

  it('TC-U-31: negative count rejected', () => {
    const input = baseInput();
    input.tool_counts = { Edit: -1 };
    const result = sanitizeSession(input, { projectSecret: SECRET });
    expect(result.ok).toBe(false);
  });
});
