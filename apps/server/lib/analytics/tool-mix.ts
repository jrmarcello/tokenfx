/**
 * Tool-mix bucketizer for the manager dashboard (REQ-3 of
 * `manager-dashboard-v2`).
 *
 * Folds an unbounded set of tool names into a fixed 5-element closed enum
 * suitable for stacked-bar visualization:
 *
 *   Edit  → Edit
 *   Read  → Read
 *   Bash  → Bash
 *   Task  → Agent  (legacy: Claude Code's subagent-dispatch tool was renamed
 *                   `Task` → `Agent` without bumping the tool_use schema, so
 *                   both names appear in historical JSONL data — both must
 *                   land in the same `Agent` bucket. See
 *                   `lib/analytics/subagent.ts` SUBAGENT_TOOL_NAME comment.)
 *   Agent → Agent
 *   *     → Other
 *
 * The returned object always contains all 5 keys (count 0 if no matches),
 * so chart code can rely on the shape without null-checks. This module is
 * pure — no DB, no IO — to keep it cheap to call per-row inside aggregation.
 */

export type ToolBucket = 'Edit' | 'Read' | 'Bash' | 'Agent' | 'Other';

export const TOOL_BUCKETS = ['Edit', 'Read', 'Bash', 'Agent', 'Other'] as const;

/**
 * Map a single raw tool name to its bucket. Unknown names fall to `Other`.
 * The literal string `'Other'` itself is treated as unknown — it's not in
 * the first-class set, so it lands in the `Other` bucket like any other
 * miss. This keeps the rule "everything not in the first 4 → Other" total.
 */
const bucketOf = (toolName: string): ToolBucket => {
  switch (toolName) {
    case 'Edit':
      return 'Edit';
    case 'Read':
      return 'Read';
    case 'Bash':
      return 'Bash';
    // Both legacy `Task` and current `Agent` collapse into the Agent bucket.
    case 'Task':
    case 'Agent':
      return 'Agent';
    default:
      return 'Other';
  }
};

/**
 * Bucketize a list of tool names into the 5 closed-enum buckets.
 *
 * @param toolNames - raw tool_name strings as emitted by Claude Code
 * @returns object with all 5 buckets present; values are non-negative ints
 */
export const bucketizeToolMix = (
  toolNames: readonly string[],
): Record<ToolBucket, number> => {
  const result: Record<ToolBucket, number> = {
    Edit: 0,
    Read: 0,
    Bash: 0,
    Agent: 0,
    Other: 0,
  };
  for (const name of toolNames) {
    result[bucketOf(name)] += 1;
  }
  return result;
};
