import { describe, it, expect } from 'vitest';
import {
  extractSubagentType,
  MAX_SUBAGENT_TYPE_LEN,
} from '@/lib/analytics/subagent';

/**
 * Helper to collect warnings emitted by `onWarn` so we can assert on count +
 * content without a mocking framework.
 */
const makeWarnCollector = () => {
  const warnings: string[] = [];
  const onWarn = (msg: string) => {
    warnings.push(msg);
  };
  return { warnings, onWarn };
};

describe('MAX_SUBAGENT_TYPE_LEN', () => {
  it('is exported as 64', () => {
    expect(MAX_SUBAGENT_TYPE_LEN).toBe(64);
  });
});

describe('extractSubagentType — happy paths', () => {
  it('TC-U-01: single Agent tool_use returns subagent_type', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('Explore');
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-02: returns subagent_type "code-reviewer"', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'code-reviewer' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('code-reviewer');
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-03: mixed blocks with Bash/Agent/text returns Agent subagent_type', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Explore' },
      },
      { type: 'text', text: 'hi' },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('Explore');
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-04: text-only content returns null with no warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [{ type: 'text', text: 'hi' }];
    expect(extractSubagentType(content, onWarn)).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-05: tool_uses without any Agent returns null with no warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a' } },
    ];
    expect(extractSubagentType(content, onWarn)).toBeNull();
    expect(warnings).toHaveLength(0);
  });
});

describe('extractSubagentType — validation failures (return null + warn)', () => {
  const validationCases: Array<{
    tc: string;
    desc: string;
    block: unknown;
  }> = [
    {
      tc: 'TC-U-06',
      desc: 'input missing entirely',
      block: { type: 'tool_use', name: 'Agent' },
    },
    {
      tc: 'TC-U-07',
      desc: 'input is empty object (no subagent_type)',
      block: { type: 'tool_use', name: 'Agent', input: {} },
    },
    {
      tc: 'TC-U-08',
      desc: 'subagent_type is empty string',
      block: {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: '' },
      },
    },
    {
      tc: 'TC-U-09',
      desc: 'subagent_type is a number',
      block: {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 42 },
      },
    },
    {
      tc: 'TC-U-10',
      desc: 'subagent_type contains NUL (C0) char',
      block: {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'bad\x00name' },
      },
    },
    {
      tc: 'TC-U-17',
      desc: 'subagent_type exceeds MAX length (65)',
      block: {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'a'.repeat(65) },
      },
    },
    {
      tc: 'TC-U-19',
      desc: 'subagent_type contains internal newline (control char)',
      block: {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Ex\nplore' },
      },
    },
    {
      tc: 'TC-U-20',
      desc: 'input is explicit null',
      block: { type: 'tool_use', name: 'Agent', input: null },
    },
  ];

  it.each(validationCases)(
    '$tc: $desc → null + warn',
    ({ block }) => {
      const { warnings, onWarn } = makeWarnCollector();
      const result = extractSubagentType([block], onWarn);
      expect(result).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual(expect.any(String));
      expect(warnings[0].length).toBeGreaterThan(0);
    },
  );

  it('TC-U-08 (whitespace-only): subagent_type is "   " → null + warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: '   ' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('extractSubagentType — edge cases', () => {
  it('TC-U-11: padded whitespace trims to "Explore", no warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: '  Explore  ' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('Explore');
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-12: two Agent tool_uses returns first + warns about extras', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Explore' },
      },
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Plan' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('Explore');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].length).toBeGreaterThan(0);
  });

  it('TC-U-13: Unicode "análise-código" preserved literally', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'análise-código' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('análise-código');
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-14: empty content array returns null, no warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    expect(extractSubagentType([], onWarn)).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-15: unknown block types (e.g. thinking) + valid Agent returns Explore', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      { type: 'thinking', text: 'hmm' },
      { type: 'redacted_thinking' },
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Explore' },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe('Explore');
    expect(warnings).toHaveLength(0);
  });

  it.each([
    ['code-reviewer', 'code-reviewer'],
    ['Explore', 'Explore'],
    ['CODE-REVIEWER', 'CODE-REVIEWER'],
  ])('TC-U-16: case preserved (%s → %s)', (input, expected) => {
    const { warnings, onWarn } = makeWarnCollector();
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: input },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe(expected);
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-18: subagent_type at exactly MAX length (64) is accepted', () => {
    const { warnings, onWarn } = makeWarnCollector();
    const maxStr = 'a'.repeat(64);
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: maxStr },
      },
    ];
    expect(extractSubagentType(content, onWarn)).toBe(maxStr);
    expect(warnings).toHaveLength(0);
  });

  it('TC-U-21: non-array content does not throw, returns null with no warn', () => {
    const { warnings, onWarn } = makeWarnCollector();
    // Defensive: upstream types say unknown[], but guard against bad callers.
    // Cast via unknown to exercise the defensive runtime path.
    const bad = 'not-an-array' as unknown as unknown[];
    expect(() => extractSubagentType(bad, onWarn)).not.toThrow();
    expect(extractSubagentType(bad, onWarn)).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it('works without an onWarn callback (optional)', () => {
    const content = [
      {
        type: 'tool_use',
        name: 'Agent',
        input: { subagent_type: 'Explore' },
      },
    ];
    expect(extractSubagentType(content)).toBe('Explore');
    // invalid input, no onWarn — must not throw
    const bad = [
      { type: 'tool_use', name: 'Agent', input: { subagent_type: '' } },
    ];
    expect(() => extractSubagentType(bad)).not.toThrow();
    expect(extractSubagentType(bad)).toBeNull();
  });
});
