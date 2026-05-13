import { describe, expect, it } from "vitest";
import type { GeneratedSpec, GenerationResult } from "@pretorian-worx/runclaudia-core";
import { buildGenerateReportShape } from "../src/generate-report.js";

function spec(overrides: Partial<GeneratedSpec> = {}): GeneratedSpec {
  return {
    flow: "/x",
    filePath: "/tmp/x.spec.ts",
    fileRel: ".claudia/generated/x.spec.ts",
    contents: "//",
    reasoning: "r",
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...overrides,
  };
}

function genResult(generated: GeneratedSpec[]): GenerationResult {
  return {
    generated,
    skippedFlows: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    outDir: "/tmp",
  };
}

describe("buildGenerateReportShape — verdict", () => {
  it("passed=true when every executed draft passed", () => {
    const r = buildGenerateReportShape({
      target: "https://app.example.com",
      result: genResult([
        spec({ flow: "/a", runOutcome: { status: "passed", durationMs: 1000 } }),
        spec({ flow: "/b", runOutcome: { status: "passed", durationMs: 500 } }),
      ]),
    });
    expect(r.passed).toBe(true);
    expect(r.slack.passedCount).toBe(2);
    expect(r.slack.failedCount).toBe(0);
  });

  it("passed=false when any draft failed", () => {
    const r = buildGenerateReportShape({
      target: "https://app.example.com",
      result: genResult([
        spec({ flow: "/a", runOutcome: { status: "passed", durationMs: 100 } }),
        spec({ flow: "/b", runOutcome: { status: "failed", durationMs: 200, error: "boom" } }),
      ]),
    });
    expect(r.passed).toBe(false);
    expect(r.check.passedCount).toBe(1);
    expect(r.check.failedCount).toBe(1);
  });

  it("passed=false when zero drafts ran (no run outcomes attached)", () => {
    // Generation produced specs but --run never wired runOutcome onto them
    // (e.g. the run loop crashed mid-execution). We should not falsely claim
    // a green deploy in that case.
    const r = buildGenerateReportShape({
      target: "https://app.example.com",
      result: genResult([spec({ flow: "/a" })]),
    });
    expect(r.passed).toBe(false);
    expect(r.slack.passedCount).toBe(0);
    expect(r.slack.failedCount).toBe(0);
  });

  it("errored drafts count as failures (not silently skipped)", () => {
    const r = buildGenerateReportShape({
      target: "https://x.test",
      result: genResult([
        spec({ flow: "/a", runOutcome: { status: "errored", error: "playwright crashed" } }),
      ]),
    });
    expect(r.passed).toBe(false);
    expect(r.slack.failedCount).toBe(1);
    expect(r.slack.failedTests).toHaveLength(1);
    expect(r.slack.failedTests![0]!.error).toBe("playwright crashed");
  });
});

describe("buildGenerateReportShape — counts and metadata", () => {
  it("reports generatedSpecCount as the number of executed drafts only", () => {
    const r = buildGenerateReportShape({
      target: "https://x.test",
      result: genResult([
        spec({ flow: "/a", runOutcome: { status: "passed", durationMs: 100 } }),
        spec({ flow: "/b", runOutcome: { status: "failed", durationMs: 200, error: "e" } }),
        spec({ flow: "/c" }), // never ran
      ]),
    });
    expect(r.slack.generatedSpecCount).toBe(2);
  });

  it("sums durationMs across passed + failed drafts", () => {
    const r = buildGenerateReportShape({
      target: "https://x.test",
      result: genResult([
        spec({ flow: "/a", runOutcome: { status: "passed", durationMs: 300 } }),
        spec({ flow: "/b", runOutcome: { status: "failed", durationMs: 450, error: "e" } }),
        spec({ flow: "/c", runOutcome: { status: "errored", error: "no duration" } }),
      ]),
    });
    expect(r.slack.durationMs).toBe(750);
  });

  it("plumbs failed-test details from runOutcome.error", () => {
    const r = buildGenerateReportShape({
      target: "https://x.test",
      result: genResult([
        spec({
          flow: "/checkout",
          fileRel: "e2e/gen/checkout.spec.ts",
          runOutcome: { status: "failed", durationMs: 0, error: "expected 200, got 500" },
        }),
      ]),
    });
    expect(r.slack.failedTests).toEqual([
      { file: "e2e/gen/checkout.spec.ts", title: "/checkout", error: "expected 200, got 500" },
    ]);
  });

  it("propagates target into both slack and check inputs", () => {
    const r = buildGenerateReportShape({
      target: "https://prod.example.com",
      result: genResult([
        spec({ runOutcome: { status: "passed", durationMs: 100 } }),
      ]),
    });
    expect(r.slack.target).toBe("https://prod.example.com");
    expect(r.check.target).toBe("https://prod.example.com");
  });
});
