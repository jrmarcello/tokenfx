import { describe, it, expect } from "vitest";
import { parsePrometheusText, fetchAndParse } from "./parser";

describe("parsePrometheusText", () => {
  it("happy: parses HELP/TYPE plus labeled + unlabeled metrics", () => {
    const text = `# HELP claude_code_token_usage_tokens_total total tokens
# TYPE claude_code_token_usage_tokens_total counter
claude_code_token_usage_tokens_total{model="claude-sonnet-4-5",type="input"} 1234
claude_code_session_count_total 5
`;
    const rows = parsePrometheusText(text, 1000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      metricName: "claude_code_token_usage_tokens_total",
      labels: { model: "claude-sonnet-4-5", type: "input" },
      value: 1234,
      scrapedAt: 1000,
    });
    expect(rows[1]).toEqual({
      metricName: "claude_code_session_count_total",
      labels: {},
      value: 5,
      scrapedAt: 1000,
    });
  });

  it("edge: parses NaN, +Inf, -Inf correctly", () => {
    const text = `metric_a NaN
metric_b +Inf
metric_c -Inf
metric_d Inf
`;
    const rows = parsePrometheusText(text, 0);
    expect(rows).toHaveLength(4);
    expect(Number.isNaN(rows[0].value)).toBe(true);
    expect(rows[1].value).toBe(Infinity);
    expect(rows[2].value).toBe(-Infinity);
    expect(rows[3].value).toBe(Infinity);
  });

  it("edge: skips malformed lines silently", () => {
    const text = `good_metric 1
bad_metric{unbalanced 2
another_bad{key="no-value"}
missing_value_entirely{a="b"}
good_metric_two{} 42
# comment
`;
    const rows = parsePrometheusText(text, 0);
    const names = rows.map((r) => r.metricName);
    expect(names).toContain("good_metric");
    // "good_metric_two{} 42" should parse (empty labels)
    expect(names).toContain("good_metric_two");
    expect(names).not.toContain("bad_metric");
    expect(names).not.toContain("another_bad");
    expect(names).not.toContain("missing_value_entirely");
  });

  it("labels with special chars: model + type", () => {
    const text = `m{model="claude-sonnet-4-5",type="input"} 7\n`;
    const rows = parsePrometheusText(text, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].labels).toEqual({ model: "claude-sonnet-4-5", type: "input" });
  });

  it("labels with escaped quotes parse correctly", () => {
    const text = `m{msg="hello \\"world\\"",x="y"} 1\n`;
    const rows = parsePrometheusText(text, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].labels).toEqual({ msg: 'hello "world"', x: "y" });
  });

  it("empty string → empty array", () => {
    expect(parsePrometheusText("", 0)).toEqual([]);
  });

  it("passes scrapedAt through", () => {
    const rows = parsePrometheusText("m 1\n", 42);
    expect(rows[0].scrapedAt).toBe(42);
  });
});

describe("fetchAndParse", () => {
  it("happy: parses via fake fetch", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "m{a=\"b\"} 3\n",
    })) as unknown as typeof fetch;
    const res = await fetchAndParse("http://x", fakeFetch);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0].metricName).toBe("m");
      expect(res.value[0].labels).toEqual({ a: "b" });
      expect(res.value[0].value).toBe(3);
    }
  });

  it("network error: returns ok:false", async () => {
    const fakeFetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await fetchAndParse("http://x", fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(Error);
    }
  });

  it("non-200: returns ok:false", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "",
    })) as unknown as typeof fetch;
    const res = await fetchAndParse("http://x", fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(Error);
    }
  });
});
