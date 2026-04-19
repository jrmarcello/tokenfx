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
        cacheCreation5mTokens: 100_000,
        cacheCreation1hTokens: 0,
        // 15 + 37.5 + 3 + 1.875 = 57.375
        expected: 57.375,
      },
      {
        model: "claude-sonnet-4-5",
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        cacheCreation5mTokens: 200_000,
        cacheCreation1hTokens: 0,
        // 6 + 15 + 0.15 + 0.75 = 21.9
        expected: 21.9,
      },
      {
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 0,
        // 1 + 5 + 0.1 + 1.25 = 7.35
        expected: 7.35,
      },
    ];

    it.each(cases)(
      "computes cost for $model via new split params",
      ({
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreation5mTokens,
        cacheCreation1hTokens,
        expected,
      }) => {
        const cost = computeCost({
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreation5mTokens,
          cacheCreation1hTokens,
        });
        expect(cost).toBeCloseTo(expected, 6);
      }
    );

    it.each(cases)(
      "computes cost for $model via legacy cacheCreationTokens (backward compat)",
      ({
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreation5mTokens,
        expected,
      }) => {
        const cost = computeCost({
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens: cacheCreation5mTokens,
        });
        expect(cost).toBeCloseTo(expected, 6);
      }
    );

    it("legacy cacheCreationTokens produces same cost as new split params (1h=0)", () => {
      const shared = {
        model: "claude-opus-4-1",
        inputTokens: 500_000,
        outputTokens: 250_000,
        cacheReadTokens: 1_000_000,
      };
      const viaNew = computeCost({
        ...shared,
        cacheCreation5mTokens: 300_000,
        cacheCreation1hTokens: 0,
      });
      const viaLegacy = computeCost({
        ...shared,
        cacheCreationTokens: 300_000,
      });
      expect(viaLegacy).toBeCloseTo(viaNew, 6);
    });
  });

  describe("TC-U-04 edge: unknown model → 0 (REQ-2)", () => {
    it("returns 0 without throwing for unknown model", () => {
      expect(() =>
        computeCost({
          model: "claude-xyz-999",
          inputTokens: 10_000,
          outputTokens: 10_000,
          cacheReadTokens: 10_000,
          cacheCreation5mTokens: 10_000,
        })
      ).not.toThrow();
      expect(
        computeCost({
          model: "claude-xyz-999",
          inputTokens: 10_000,
          outputTokens: 10_000,
          cacheReadTokens: 10_000,
          cacheCreation5mTokens: 10_000,
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
          cacheCreation5mTokens: 0,
          cacheCreation1hTokens: 0,
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
          cacheCreation5mTokens: 0,
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
          cacheCreation5mTokens: 0,
        })
      ).toBe(75.0);
    });
  });

  describe("TC-U-08 business: cache_creation_1h tokens priced at 2× input (REQ-14)", () => {
    it("1000 tokens in cacheCreation1hTokens on Opus → $0.030 (1000/1M * 30)", () => {
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation1hTokens: 1_000,
      });
      // 1000 / 1_000_000 * 30 = 0.03
      expect(cost).toBeCloseTo(0.03, 6);
    });

    it("1h tokens are NOT doubled by default-5m path", () => {
      // Only 1h provided; 5m should default to 0 (not silently copied from 1h).
      const only1h = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation1hTokens: 1_000,
      });
      const only5m = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 1_000,
      });
      // 1h at 30/M = 0.030; 5m at 18.75/M = 0.01875. Must differ.
      expect(only1h).toBeCloseTo(0.03, 6);
      expect(only5m).toBeCloseTo(0.01875, 6);
      expect(only1h).not.toBeCloseTo(only5m, 6);
    });

    it("split 5m + 1h sums correctly on Opus", () => {
      // 1M 5m @ 18.75 + 1M 1h @ 30 = 48.75
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(48.75, 6);
    });
  });

  describe("TC-U-09 business: service_tier='batch' → 0.5× multiplier (REQ-13)", () => {
    it("1M input Opus + batch → $7.50 (15 * 0.5)", () => {
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        serviceTier: "batch",
      });
      expect(cost).toBeCloseTo(7.5, 6);
    });

    it("batch multiplier applies to ALL components, not just input", () => {
      // Without batch: 15 + 75 = 90. With batch: 45.
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        serviceTier: "batch",
      });
      expect(cost).toBeCloseTo(45, 6);
    });
  });

  describe("TC-U-10 validation: non-canonical service_tier → default 1.0 (REQ-13)", () => {
    it("service_tier='priority' → multiplier 1.0 (permissive default, no crash)", () => {
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        serviceTier: "priority",
      });
      expect(cost).toBeCloseTo(15, 6);
    });

    it("service_tier='unknown-weird-string' → multiplier 1.0, no crash", () => {
      expect(() =>
        computeCost({
          model: "claude-opus-4-1",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreation5mTokens: 0,
          serviceTier: "unknown-weird-string",
        })
      ).not.toThrow();
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        serviceTier: "unknown-weird-string",
      });
      expect(cost).toBeCloseTo(15, 6);
    });

    it("service_tier='standard' → multiplier 1.0", () => {
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        serviceTier: "standard",
      });
      expect(cost).toBeCloseTo(15, 6);
    });

    it("serviceTier undefined → multiplier 1.0", () => {
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
      });
      expect(cost).toBeCloseTo(15, 6);
    });
  });

  describe("resolution priority: split params override legacy (REQ-12)", () => {
    it("when cacheCreation5mTokens provided, cacheCreationTokens is ignored", () => {
      // Provide BOTH: split says 0 (should win), legacy says 1M (ignored).
      const cost = computeCost({
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreationTokens: 1_000_000,
      });
      expect(cost).toBe(0);
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

    it("has new cacheCreation5m and cacheCreation1h fields per family (REQ-14)", () => {
      const opus = PRICING["claude-opus-4-1"];
      expect(opus?.cacheCreation5m).toBe(18.75);
      expect(opus?.cacheCreation1h).toBe(30);
      const sonnet = PRICING["claude-sonnet-4-5"];
      expect(sonnet?.cacheCreation5m).toBe(3.75);
      expect(sonnet?.cacheCreation1h).toBe(6);
      const haiku = PRICING["claude-haiku-4-5"];
      expect(haiku?.cacheCreation5m).toBe(1.25);
      expect(haiku?.cacheCreation1h).toBe(2);
    });
  });
});
