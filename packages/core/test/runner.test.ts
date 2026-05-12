import { describe, expect, it } from "vitest";
import {
  buildPlaywrightCommand,
  formatRunMarkdown,
  parsePlaywrightReport,
} from "../src/runner.js";
import type { SelectionResult } from "../src/select.js";

const baseSelection = (
  overrides: Partial<SelectionResult> = {},
): SelectionResult => ({
  totalSpecs: 5,
  selected: [
    {
      framework: "playwright",
      file: "e2e/bugs.spec.ts",
      tests: ["creates a bug", "lists bugs"],
      hasSharedSetup: false,
    },
  ],
  selectedTestCount: 2,
  uncoveredRoutes: [],
  uncoveredEndpoints: [],
  playwrightGrep: "creates a bug|lists bugs",
  cypressSpecs: "",
  diffFiles: ["src/app/api/bugs/route.ts", "src/components/CreateBugButton.tsx"],
  ...overrides,
});

describe("buildPlaywrightCommand", () => {
  it("constructs a runnable npx playwright test command with target + grep", () => {
    const cmd = buildPlaywrightCommand({
      selection: baseSelection(),
      target: "https://app.example.com",
      jsonReportPath: "/tmp/report.json",
    });
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("npx");
    expect(cmd!.args).toContain("playwright");
    expect(cmd!.args).toContain("test");
    expect(cmd!.args).toContain("e2e/bugs.spec.ts");
    expect(cmd!.args).toContain("--grep");
    expect(cmd!.args).toContain("creates a bug|lists bugs");
    expect(cmd!.args.some((a) => a.startsWith("--reporter"))).toBe(true);
    expect(cmd!.env.PLAYWRIGHT_BASE_URL).toBe("https://app.example.com");
    expect(cmd!.env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe("/tmp/report.json");
  });

  it("includes --config when playwrightConfig is provided", () => {
    const cmd = buildPlaywrightCommand({
      selection: baseSelection(),
      target: "https://x.example.com",
      jsonReportPath: "/tmp/r.json",
      playwrightConfig: "playwright.prod.config.ts",
    });
    expect(cmd!.args).toContain("--config");
    expect(cmd!.args).toContain("playwright.prod.config.ts");
  });

  it("returns null when no Playwright specs were selected", () => {
    const cypressOnly = baseSelection({
      selected: [
        {
          framework: "cypress",
          file: "cypress/e2e/x.cy.ts",
          tests: ["x"],
          hasSharedSetup: false,
        },
      ],
      playwrightGrep: null,
    });
    expect(buildPlaywrightCommand({
      selection: cypressOnly,
      target: "https://x",
      jsonReportPath: "/tmp/r.json",
    })).toBeNull();
  });

  it("returns null when selection is empty", () => {
    const empty = baseSelection({ selected: [], selectedTestCount: 0, playwrightGrep: null });
    expect(buildPlaywrightCommand({
      selection: empty,
      target: "https://x",
      jsonReportPath: "/tmp/r.json",
    })).toBeNull();
  });

  it("merges extraEnv on top of the defaults", () => {
    const cmd = buildPlaywrightCommand({
      selection: baseSelection(),
      target: "https://x",
      jsonReportPath: "/tmp/r.json",
      extraEnv: { CI: "true", TEST_USER_TOKEN: "abc" },
    });
    expect(cmd!.env.CI).toBe("true");
    expect(cmd!.env.TEST_USER_TOKEN).toBe("abc");
    expect(cmd!.env.PLAYWRIGHT_BASE_URL).toBe("https://x");
  });

  it("omits --grep when the selection has none (shared-setup-only)", () => {
    const sharedOnly = baseSelection({
      selected: [
        {
          framework: "playwright",
          file: "e2e/checkout.spec.ts",
          tests: ["completes checkout"],
          hasSharedSetup: true,
        },
      ],
      playwrightGrep: null,
    });
    const cmd = buildPlaywrightCommand({
      selection: sharedOnly,
      target: "https://x",
      jsonReportPath: "/tmp/r.json",
    });
    expect(cmd!.args).toContain("e2e/checkout.spec.ts");
    expect(cmd!.args).not.toContain("--grep");
  });
});

describe("parsePlaywrightReport", () => {
  it("extracts stats from the top-level stats object", () => {
    const raw = {
      stats: { duration: 12345, expected: 4, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [],
    };
    const r = parsePlaywrightReport(raw);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.durationMs).toBe(12345);
    expect(r.totalTests).toBe(5);
  });

  it("walks nested suites and collects failed test details", () => {
    const raw = {
      stats: { duration: 100, expected: 1, unexpected: 1 },
      suites: [
        {
          file: "e2e/bugs.spec.ts",
          specs: [
            {
              title: "creates a bug",
              file: "e2e/bugs.spec.ts",
              tests: [{ results: [{ status: "passed" }] }],
            },
          ],
          suites: [
            {
              title: "errors",
              specs: [
                {
                  title: "fails on conflict",
                  file: "e2e/bugs.spec.ts",
                  tests: [
                    {
                      results: [
                        { status: "failed", error: { message: "Expected 200, got 500" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const r = parsePlaywrightReport(raw);
    expect(r.failedTests).toEqual([
      { file: "e2e/bugs.spec.ts", title: "fails on conflict", error: "Expected 200, got 500" },
    ]);
  });

  it("treats timedOut the same as failed", () => {
    const raw = {
      stats: { expected: 0, unexpected: 1 },
      suites: [
        {
          file: "e2e/x.spec.ts",
          specs: [
            {
              title: "hangs",
              file: "e2e/x.spec.ts",
              tests: [{ results: [{ status: "timedOut", error: { message: "Test timeout" } }] }],
            },
          ],
        },
      ],
    };
    const r = parsePlaywrightReport(raw);
    expect(r.failedTests.length).toBe(1);
    expect(r.failedTests[0]!.error).toContain("timeout");
  });

  it("defaults gracefully when given an empty object", () => {
    const r = parsePlaywrightReport({});
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.failedTests).toEqual([]);
  });
});

describe("formatRunMarkdown", () => {
  it("renders a pass verdict with stats line", () => {
    const md = formatRunMarkdown({
      selection: baseSelection(),
      report: { passed: 2, failed: 0, flaky: 0, skipped: 0, durationMs: 1234, totalTests: 2, failedTests: [] },
      target: "https://prod",
      nothingToRun: false,
    });
    expect(md).toContain("✅ Pass");
    expect(md).toContain("2/2 passed");
    expect(md).toContain("https://prod");
  });

  it("renders a fail verdict with failure detail blocks", () => {
    const md = formatRunMarkdown({
      selection: baseSelection(),
      report: {
        passed: 1,
        failed: 1,
        flaky: 0,
        skipped: 0,
        durationMs: 500,
        totalTests: 2,
        failedTests: [{ file: "e2e/bugs.spec.ts", title: "lists bugs", error: "500 from /api/bugs" }],
      },
      target: "https://prod",
      nothingToRun: false,
    });
    expect(md).toContain("❌ Fail");
    expect(md).toContain("e2e/bugs.spec.ts");
    expect(md).toContain("lists bugs");
    expect(md).toContain("500 from /api/bugs");
  });

  it("reports clean-run (not 'nothing to verify') when diff touched nothing in the map", () => {
    const md = formatRunMarkdown({
      selection: baseSelection({
        selected: [],
        selectedTestCount: 0,
        playwrightGrep: null,
        diffFiles: [".github/workflows/claudia-verify.yml"],
      }),
      report: null,
      target: "https://prod",
      nothingToRun: true,
    });
    expect(md).toContain("✅ Clean run");
    expect(md).not.toContain("Nothing to verify"); // old phrasing should be gone
    expect(md).toContain("1 file changed");
    expect(md).toContain(".github/workflows/claudia-verify.yml");
  });

  it("includes a per-file sample when the no-op diff has 2-5 files", () => {
    const md = formatRunMarkdown({
      selection: baseSelection({
        selected: [],
        selectedTestCount: 0,
        playwrightGrep: null,
        diffFiles: ["a.ts", "b.ts", "c.ts"],
      }),
      report: null,
      target: "https://prod",
      nothingToRun: true,
    });
    expect(md).toContain("3 files changed");
    expect(md).toContain("- `a.ts`");
    expect(md).toContain("- `c.ts`");
  });

  it("truncates the diff sample with '…and N more' for large diffs", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((s) => `${s}.ts`);
    const md = formatRunMarkdown({
      selection: baseSelection({
        selected: [],
        selectedTestCount: 0,
        playwrightGrep: null,
        diffFiles: files,
      }),
      report: null,
      target: "https://prod",
      nothingToRun: true,
    });
    expect(md).toContain("7 files changed");
    expect(md).toContain("…and 2 more");
  });

  it("reports coverage gaps when the diff implicates uncovered flows", () => {
    const md = formatRunMarkdown({
      selection: baseSelection({
        selected: [],
        selectedTestCount: 0,
        playwrightGrep: null,
        uncoveredRoutes: ["/checkout/confirm"],
        uncoveredEndpoints: ["POST /api/orders"],
      }),
      report: null,
      target: "https://prod",
      nothingToRun: true,
    });
    expect(md).toContain("⚠️ Coverage gaps");
    expect(md).toContain("/checkout/confirm");
    expect(md).toContain("POST /api/orders");
  });

  it("reports cypress-only when only cypress specs were selected", () => {
    const md = formatRunMarkdown({
      selection: baseSelection({
        selected: [
          { framework: "cypress", file: "cypress/e2e/x.cy.ts", tests: ["x"], hasSharedSetup: false },
        ],
        selectedTestCount: 1,
        playwrightGrep: null,
        cypressSpecs: "cypress/e2e/x.cy.ts",
      }),
      report: null,
      target: "https://prod",
      nothingToRun: true,
    });
    expect(md).toContain("ℹ️ Cypress-only");
    expect(md).toContain('npx cypress run --spec "cypress/e2e/x.cy.ts"');
  });

  it("always renders the diff summary line, even for successful runs", () => {
    const md = formatRunMarkdown({
      selection: baseSelection(),
      report: { passed: 2, failed: 0, flaky: 0, skipped: 0, durationMs: 1234, totalTests: 2, failedTests: [] },
      target: "https://prod",
      nothingToRun: false,
    });
    expect(md).toContain("Diff: 2 files changed");
  });
});
