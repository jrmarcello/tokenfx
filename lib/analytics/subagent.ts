/**
 * Maximum allowed length (in code units) of a `subagent_type` string after
 * trimming. Values longer than this are rejected as malformed/hostile input.
 *
 * 64 is a generous ceiling: official Claude Code subagent names (e.g.
 * `code-reviewer`, `security-reviewer`, `data-reviewer`) are all comfortably
 * under 32 characters. The cap primarily guards against accidental or
 * malicious oversized strings reaching downstream storage and UI.
 */
export const MAX_SUBAGENT_TYPE_LEN = 64;

/**
 * Matches any ASCII C0 control char (0x00-0x1F) or DEL (0x7F).
 *
 * These are rejected in `subagent_type` to prevent log / UI injection from
 * embedded newlines, NUL bytes, etc. Unicode letters/diacritics are allowed.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Pure structural validation of a candidate `subagent_type` value. Returns
 * the cleaned (trimmed) string when valid, or `null` with a reason suitable
 * for a warn message when invalid.
 */
const validateSubagentType = (
  raw: unknown,
): { ok: true; value: string } | { ok: false; reason: string } => {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reason: `subagent_type is not a string (got ${raw === null ? 'null' : typeof raw})`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'subagent_type is empty or whitespace-only' };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return {
      ok: false,
      reason: 'subagent_type contains ASCII control characters',
    };
  }
  if (trimmed.length > MAX_SUBAGENT_TYPE_LEN) {
    return {
      ok: false,
      reason: `subagent_type exceeds max length of ${MAX_SUBAGENT_TYPE_LEN} (got ${trimmed.length})`,
    };
  }
  return { ok: true, value: trimmed };
};

/**
 * Checks whether a block represents an `Agent` tool_use invocation. We
 * intentionally accept the block even if its `input` is malformed — callers
 * use this to decide whether to attempt subagent extraction (and warn on
 * failure).
 */
const isAgentToolUse = (block: unknown): block is Record<string, unknown> => {
  if (!isRecord(block)) return false;
  if (block.type !== 'tool_use') return false;
  return block.name === 'Agent';
};

/**
 * Given an assistant turn's `content` array (Zod-validated by the parser),
 * find the first `tool_use` block whose `name === "Agent"` and whose
 * `input.subagent_type` is a valid non-empty string. Returns the trimmed
 * subagent_type, or `null` when absent / invalid.
 *
 * Validation rejected by null return + optional warn:
 * - `input` absent or non-object
 * - `subagent_type` absent, non-string, empty after trim, all whitespace
 * - contains ASCII control chars (C0 0x00-0x1F, 0x7F)
 * - length > MAX_SUBAGENT_TYPE_LEN (64) after trim
 *
 * When multiple Agent tool_use blocks appear, returns the first valid one
 * and emits a warn for the extras (documented behavior — REQ-4).
 */
export function extractSubagentType(
  content: unknown[],
  onWarn?: (msg: string) => void,
): string | null {
  // Defensive: callers should pass an array, but guard anyway to avoid
  // throwing on malformed upstream data.
  if (!Array.isArray(content)) return null;

  const agentBlocks = content.filter(isAgentToolUse);
  if (agentBlocks.length === 0) return null;

  let firstValid: string | null = null;

  for (const block of agentBlocks) {
    const input = block.input;
    if (!isRecord(input)) {
      if (firstValid === null) {
        onWarn?.(
          `extractSubagentType: Agent tool_use has missing or non-object input`,
        );
      }
      continue;
    }

    const result = validateSubagentType(input.subagent_type);
    if (!result.ok) {
      if (firstValid === null) {
        onWarn?.(`extractSubagentType: ${result.reason}`);
      }
      continue;
    }

    if (firstValid === null) {
      firstValid = result.value;
    }
  }

  // If there was at least one valid value AND there are additional Agent
  // blocks beyond the first, warn once about the extras (REQ-4).
  if (firstValid !== null && agentBlocks.length > 1) {
    onWarn?.(
      `extractSubagentType: assistant turn contains ${agentBlocks.length} Agent tool_use blocks; using the first and ignoring the rest`,
    );
  }

  return firstValid;
}
