export type OtelScrape = {
  metricName: string;
  labels: Record<string, string>;
  value: number;
  scrapedAt: number; // epoch ms, injected by caller
};

const LINE_RE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?[0-9.eE+]+|NaN|\+?Inf|-Inf)(\s+([0-9]+))?\s*$/;

function parseValue(raw: string): number {
  if (raw === "NaN") return NaN;
  if (raw === "+Inf" || raw === "Inf") return Infinity;
  if (raw === "-Inf") return -Infinity;
  const n = parseFloat(raw);
  return n;
}

/**
 * Parse Prometheus-style label block content (the inside of `{...}`).
 * Supports: key="value", comma-separated, with `\"` escape sequences in values.
 * Returns null if parse fails.
 */
function parseLabels(body: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const trimmed = body.trim();
  if (trimmed === "") return out;

  let i = 0;
  const n = trimmed.length;

  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(trimmed[i])) i++;
    if (i >= n) break;

    // Read key: [a-zA-Z_][a-zA-Z0-9_]*
    const keyStart = i;
    if (!/[a-zA-Z_]/.test(trimmed[i])) return null;
    while (i < n && /[a-zA-Z0-9_]/.test(trimmed[i])) i++;
    const key = trimmed.slice(keyStart, i);
    if (key === "") return null;

    // Skip whitespace
    while (i < n && /\s/.test(trimmed[i])) i++;

    // Expect '='
    if (trimmed[i] !== "=") return null;
    i++;

    // Skip whitespace
    while (i < n && /\s/.test(trimmed[i])) i++;

    // Expect opening quote
    if (trimmed[i] !== '"') return null;
    i++;

    // Read value until unescaped closing quote
    let value = "";
    while (i < n) {
      const ch = trimmed[i];
      if (ch === "\\" && i + 1 < n) {
        const next = trimmed[i + 1];
        if (next === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (next === "\\") {
          value += "\\";
          i += 2;
          continue;
        }
        if (next === "n") {
          value += "\n";
          i += 2;
          continue;
        }
        value += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        break;
      }
      value += ch;
      i++;
    }
    if (trimmed[i] !== '"') return null;
    i++;

    out[key] = value;

    // Skip whitespace
    while (i < n && /\s/.test(trimmed[i])) i++;

    if (i >= n) break;
    if (trimmed[i] === ",") {
      i++;
      continue;
    }
    // Unexpected character
    return null;
  }

  return out;
}

export function parsePrometheusText(text: string, scrapedAt: number): OtelScrape[] {
  const rows: OtelScrape[] = [];
  if (!text) return rows;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue;

    const m = LINE_RE.exec(line);
    if (!m) continue;

    const metricName = m[1];
    const labelBody = m[3];
    const valueRaw = m[4];

    let labels: Record<string, string> = {};
    if (labelBody !== undefined) {
      const parsed = parseLabels(labelBody);
      if (parsed === null) continue;
      labels = parsed;
    }

    const value = parseValue(valueRaw);
    if (valueRaw !== "NaN" && Number.isNaN(value)) continue;

    rows.push({ metricName, labels, value, scrapedAt });
  }

  return rows;
}

export async function fetchAndParse(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ ok: true; value: OtelScrape[] } | { ok: false; error: Error }> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      return {
        ok: false,
        error: new Error(`fetchAndParse: non-OK response (status=${response.status}) for ${url}`),
      };
    }
    const text = await response.text();
    const value = parsePrometheusText(text, Date.now());
    return { ok: true, value };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  }
}
