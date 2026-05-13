import { describe, expect, it } from "vitest";
import { buildCheckOutput, type CheckInput } from "../src/check-format.js";

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    passed: true,
    passedCount: 0,
    failedCount: 0,
    markdown: "## claudia",
    ...overrides,
  };
}

describe("buildCheckOutput — conclusion", () => {
  it("maps passed=true → success", () => {
    expect(buildCheckOutput(input({ passed: true, passedCount: 3 })).conclusion).toBe("success");
  });

  it("maps passed=false → failure", () => {
    expect(buildCheckOutput(input({ passed: false, failedCount: 1 })).conclusion).toBe("failure");
  });
});

describe("buildCheckOutput — name", () => {
  it("defaults to 'claudia / deploy-verified'", () => {
    expect(buildCheckOutput(input()).name).toBe("claudia / deploy-verified");
  });

  it("respects an override", () => {
    expect(buildCheckOutput(input({ name: "claudia / staging" })).name).toBe("claudia / staging");
  });
});

describe("buildCheckOutput — title", () => {
  it("singularizes when exactly one test passed", () => {
    const o = buildCheckOutput(input({ passed: true, passedCount: 1 }));
    expect(o.title).toBe("1 test passed");
  });

  it("pluralizes for >1", () => {
    const o = buildCheckOutput(input({ passed: true, passedCount: 12 }));
    expect(o.title).toBe("12 tests passed");
  });

  it("includes target host (scheme stripped) when provided", () => {
    const o = buildCheckOutput(
      input({ passed: true, passedCount: 4, target: "https://app.example.com/" }),
    );
    expect(o.title).toBe("4 tests passed against app.example.com");
  });

  it("reports failure count on failure", () => {
    const o = buildCheckOutput(
      input({ passed: false, passedCount: 8, failedCount: 2, target: "https://prod.test" }),
    );
    expect(o.title).toBe("2 of 10 failed against prod.test");
  });

  it("handles zero-run as 'No tests ran'", () => {
    const o = buildCheckOutput(input({ passed: true }));
    expect(o.title).toBe("No tests ran");
  });
});

describe("buildCheckOutput — summary", () => {
  it("passes the markdown body through verbatim when under cap", () => {
    const md = "## claudia\n\nstuff happened";
    expect(buildCheckOutput(input({ markdown: md })).summary).toBe(md);
  });

  it("truncates very long summaries to stay under the GitHub 65535 cap", () => {
    const md = "x".repeat(70_000);
    const out = buildCheckOutput(input({ markdown: md })).summary;
    expect(out.length).toBeLessThanOrEqual(60_000);
    expect(out.endsWith("…")).toBe(true);
  });
});
