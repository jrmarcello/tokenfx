import { describe, it, expect } from "vitest";
import { PRICING, getPricing, computeCost } from "./pricing";

describe("pricing", () => {
  describe("TC-U-03 happy: known model → exact cost (REQ-2)", () => {
    const cases = [
      {
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 100_000,
        // 15 + 37.5 + 3 + 1.875 = 57.375
        expected: 57.375,
      },
      {
        model: "claude-sonnet-4-5",
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        cacheCreationTokens: 200_000,
        // 6 + 15 + 0.15 + 0.75 = 21.9
        expected: 21.9,
      },
      {
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        // 1 + 5 + 0.1 + 1.25 = 7.35
        expected: 7.35,
      },
    ];

    it.each(cases)(
      "computes cost for $model",
      ({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, expected }) => {
        const cost = computeCost({
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        });
        expect(cost).toBeCloseTo(expected, 6);
      }
    );
  });

  describe("TC-U-04 edge: unknown model → 0 (REQ-2)", () => {
    it("returns 0 without throwing for unknown model", () => {
      expect(() =>
        computeCost({
          model: "claude-xyz-999",
          inputTokens: 10_000,
          outputTokens: 10_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 10_000,
        })
      ).not.toThrow();
      expect(
        computeCost({
          model: "claude-xyz-999",
          inputTokens: 10_000,
          outputTokens: 10_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 10_000,
        })
      ).toBe(0);
    });

    it("getPricing returns null for unknown model", () => {
      expect(getPricing("claude-xyz-999")).toBeNull();
    });
  });

  describe("family-prefix fallback", () => {
    it.each([
      ["claude-opus-4-6", 15, 75],
      ["claude-opus-4-8-20270101", 15, 75],
      ["claude-sonnet-4-7", 3, 15],
      ["claude-sonnet-5-0", 3, 15],
      ["claude-haiku-4-6", 1, 5],
    ])("maps %s to its family pricing", (model, expectedInput, expectedOutput) => {
      const p = getPricing(model);
      expect(p).not.toBeNull();
      expect(p?.input).toBe(expectedInput);
      expect(p?.output).toBe(expectedOutput);
    });

    it("falls back only when prefix matches claude-(opus|sonnet|haiku)", () => {
      expect(getPricing("claude-sage-1")).toBeNull();
      expect(getPricing("gpt-4")).toBeNull();
    });
  });

  describe("TC-U-06 boundary: 0 tokens and exact values (REQ-2)", () => {
    it("0 tokens → 0 cost", () => {
      expect(
        computeCost({
          model: "claude-opus-4-1",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })
      ).toBe(0);
    });

    it("1,000,000 input tokens for sonnet → exactly 3.0", () => {
      expect(
        computeCost({
          model: "claude-sonnet-4-5",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })
      ).toBe(3.0);
    });

    it("1,000,000 output tokens for opus → exactly 75.0", () => {
      expect(
        computeCost({
          model: "claude-opus-4-1",
          inputTokens: 0,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })
      ).toBe(75.0);
    });
  });

  describe("alias test", () => {
    it("'claude-opus-4-7[1m]' resolves to same pricing as 'claude-opus-4-7'", () => {
      const a = getPricing("claude-opus-4-7[1m]");
      const b = getPricing("claude-opus-4-7");
      expect(a).not.toBeNull();
      expect(a).toEqual(b);
    });

    it("case-insensitive lookup", () => {
      expect(getPricing("CLAUDE-SONNET-4-5")).toEqual(getPricing("claude-sonnet-4-5"));
    });

    it("strips date suffix", () => {
      expect(getPricing("claude-opus-4-1-20250101")).toEqual(getPricing("claude-opus-4-1"));
    });
  });

  describe("PRICING table", () => {
    it("includes required entries", () => {
      expect(PRICING["claude-opus-4-1"]).toBeDefined();
      expect(PRICING["claude-opus-4-7"]).toBeDefined();
      expect(PRICING["claude-sonnet-4-5"]).toBeDefined();
      expect(PRICING["claude-sonnet-4-6"]).toBeDefined();
      expect(PRICING["claude-haiku-4-5"]).toBeDefined();
    });
  });
});
