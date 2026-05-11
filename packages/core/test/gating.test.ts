import { describe, expect, it } from "vitest";
import { decideGating } from "../src/gating.js";
import type { Plan, PlanFlow } from "../src/types.js";

function flow(risk: PlanFlow["risk"], name = "f"): PlanFlow {
  return { name, routes: ["/"], risk, reasoning: "x", suggestedChecks: [] };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    verdict: "test",
    summary: "s",
    flows: [],
    unmappedFiles: [],
    coverageGaps: [],
    ...overrides,
  };
}

describe("decideGating", () => {
  describe("shadow mode", () => {
    it("never posts a check", () => {
      const d = decideGating(plan({ flows: [flow("high")] }), { mode: "shadow" });
      expect(d.postCheck).toBe(false);
    });
  });

  describe("advisory mode", () => {
    it("posts a neutral check regardless of risk", () => {
      const d = decideGating(plan({ flows: [flow("high")] }), { mode: "advisory" });
      expect(d.postCheck).toBe(true);
      expect(d.conclusion).toBe("neutral");
      expect(d.failingFlows).toEqual([]);
    });

    it("posts neutral even for skip verdicts", () => {
      const d = decideGating(plan({ verdict: "skip", skipReason: "docs only" }), { mode: "advisory" });
      expect(d.conclusion).toBe("neutral");
      expect(d.title).toContain("skipped");
    });
  });

  describe("gating mode (default threshold = high)", () => {
    it("passes when no flow meets the threshold", () => {
      const d = decideGating(plan({ flows: [flow("low"), flow("medium")] }), { mode: "gating" });
      expect(d.conclusion).toBe("success");
      expect(d.failingFlows).toEqual([]);
    });

    it("fails when any flow is high-risk", () => {
      const d = decideGating(plan({ flows: [flow("low"), flow("high", "checkout")] }), { mode: "gating" });
      expect(d.conclusion).toBe("failure");
      expect(d.failingFlows.map((f) => f.name)).toEqual(["checkout"]);
    });

    it("treats skip verdicts as success (nothing to verify)", () => {
      const d = decideGating(plan({ verdict: "skip", skipReason: "lockfile" }), { mode: "gating" });
      expect(d.conclusion).toBe("success");
    });
  });

  describe("gating mode with custom threshold", () => {
    it("threshold=medium fails any medium-or-higher flow", () => {
      const d = decideGating(plan({ flows: [flow("medium", "edit")] }), {
        mode: "gating",
        blockingRisk: "medium",
      });
      expect(d.conclusion).toBe("failure");
      expect(d.failingFlows.map((f) => f.name)).toEqual(["edit"]);
    });

    it("threshold=low fails on any flow at all", () => {
      const d = decideGating(plan({ flows: [flow("low", "cosmetic")] }), {
        mode: "gating",
        blockingRisk: "low",
      });
      expect(d.conclusion).toBe("failure");
    });

    it("threshold=high passes a medium flow", () => {
      const d = decideGating(plan({ flows: [flow("medium")] }), { mode: "gating", blockingRisk: "high" });
      expect(d.conclusion).toBe("success");
    });
  });
});
