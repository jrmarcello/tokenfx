import { describe, expect, it } from 'vitest';
import { TOOL_BUCKETS, bucketizeToolMix, type ToolBucket } from './tool-mix';

/**
 * Unit tests for `bucketizeToolMix` (REQ-3, REQ-4 of manager-dashboard-v2).
 *
 * Mapping rule (REQ-3):
 *   Edit  → Edit
 *   Read  → Read
 *   Bash  → Bash
 *   Task  → Agent  (legacy: the Claude Code tool was renamed Task → Agent;
 *                   both names appear in historical JSONL data)
 *   Agent → Agent
 *   *     → Other
 *
 * Bucket structure is a fixed 5-element closed enum. Empty / unknown inputs
 * still return all 5 keys with count 0 so downstream chart code can rely on
 * the shape without null-checks.
 */

type ToolMixCase = {
  readonly name: string;
  readonly input: readonly string[];
  readonly expected: Record<ToolBucket, number>;
};

const cases: readonly ToolMixCase[] = [
  {
    name: "TC-U-19: known tools + 'Other' literal + Grep both fall to Other",
    input: ['Edit', 'Read', 'Bash', 'Agent', 'Grep', 'Other'],
    expected: { Edit: 1, Read: 1, Bash: 1, Agent: 1, Other: 2 },
  },
  {
    name: 'TC-U-19b: Task and Agent both map to Agent bucket',
    input: ['Edit', 'Read', 'Bash', 'Task', 'Agent', 'Grep'],
    expected: { Edit: 1, Read: 1, Bash: 1, Agent: 2, Other: 1 },
  },
  {
    name: 'TC-U-19c: empty input returns all buckets at 0',
    input: [],
    expected: { Edit: 0, Read: 0, Bash: 0, Agent: 0, Other: 0 },
  },
  {
    name: 'TC-U-19d: single known tool, other buckets present at 0',
    input: ['Edit'],
    expected: { Edit: 1, Read: 0, Bash: 0, Agent: 0, Other: 0 },
  },
  {
    name: 'TC-U-19e: all-unknown tools collapse into Other',
    input: ['Glob', 'Grep', 'WebSearch'],
    expected: { Edit: 0, Read: 0, Bash: 0, Agent: 0, Other: 3 },
  },
];

describe('bucketizeToolMix', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    expect(bucketizeToolMix(input)).toEqual(expected);
  });

  it('always returns all 5 bucket keys', () => {
    const result = bucketizeToolMix([]);
    for (const bucket of TOOL_BUCKETS) {
      expect(result).toHaveProperty(bucket);
      expect(typeof result[bucket]).toBe('number');
    }
    expect(Object.keys(result).sort()).toEqual([...TOOL_BUCKETS].sort());
  });

  it('sum of bucket counts equals input length', () => {
    const input = ['Edit', 'Read', 'Bash', 'Task', 'Agent', 'Grep', 'Other', 'Foo'];
    const result = bucketizeToolMix(input);
    const total = TOOL_BUCKETS.reduce((acc, b) => acc + result[b], 0);
    expect(total).toBe(input.length);
  });

  it('TOOL_BUCKETS lists exactly the 5 closed-enum bucket names', () => {
    expect(TOOL_BUCKETS).toEqual(['Edit', 'Read', 'Bash', 'Agent', 'Other']);
  });
});
