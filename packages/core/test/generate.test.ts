import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Anthropic SDK mock — captures the constructor args and exposes a
// `messages.create` we can stub per-test.
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

// Diff + map readers — pure functions, easier to stub at the module level than
// to set up real git repos and route caches per test.
const readDiffMock = vi.fn();
vi.mock("../src/diff.js", async () => {
  const actual = await vi.importActual<typeof import("../src/diff.js")>("../src/diff.js");
  return { ...actual, readDiff: (...args: Parameters<typeof readDiffMock>) => readDiffMock(...args) };
});

const loadMapMock = vi.fn();
vi.mock("../src/map.js", async () => {
  const actual = await vi.importActual<typeof import("../src/map.js")>("../src/map.js");
  return { ...actual, loadOrBuildMap: (...args: Parameters<typeof loadMapMock>) => loadMapMock(...args) };
});

import { runGenerate, formatGenerationMarkdown } from "../src/generate.js";
import type { AppMap } from "../src/types.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "claudia-gen-"));
}

const sampleMap = (overrides: Partial<AppMap> = {}): AppMap => ({
  framework: "nextjs-app",
  generatedAt: "2026-05-13T00:00:00.000Z",
  rootDir: "/repo",
  routes: [{ route: "/checkout", files: ["app/checkout/page.tsx"] }],
  endpoints: [],
  infra: [],
  dbModels: [],
  specs: [],
  fileToRoutes: {},
  fileToEndpoints: {},
  fileToInfra: {},
  fileToTables: {},
  fileToSpecs: {},
  ...overrides,
});

function mockSuccessResponse(fileName: string, contents: string, reasoning = "verifies the flow") {
  return {
    content: [
      {
        type: "tool_use",
        name: "emit_spec",
        id: "x",
        input: { file_name: fileName, contents, reasoning },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

beforeEach(() => {
  createMock.mockReset();
  readDiffMock.mockReset();
  loadMapMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("runGenerate — empty cases", () => {
  it("returns no generated specs when there are no uncovered routes", async () => {
    const cwd = tmpRepo();
    // Diff touches `/checkout` and a covering spec exists → no uncovered routes.
    readDiffMock.mockReturnValue({
      base: "a",
      head: "b",
      files: [{ path: "app/checkout/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false }],
    });
    loadMapMock.mockReturnValue(
      sampleMap({
        specs: [
          {
            framework: "playwright",
            file: "e2e/checkout.spec.ts",
            name: "completes checkout",
            routesCovered: ["/checkout"],
            endpointsCovered: [],
            hasSharedSetup: false,
            flowAnnotations: [],
          },
        ],
      }),
    );
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    expect(r.generated).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not call Anthropic at all when there's nothing to generate", async () => {
    const cwd = tmpRepo();
    readDiffMock.mockReturnValue({ base: "a", head: "b", files: [] });
    loadMapMock.mockReturnValue(sampleMap());
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    expect(r.generated).toEqual([]);
    expect(r.totalUsage.inputTokens).toBe(0);
  });
});

describe("runGenerate — generates for uncovered routes", () => {
  function setupSingleGap(cwd: string) {
    // app/checkout/page.tsx is in the diff. No spec covers /checkout.
    readDiffMock.mockReturnValue({
      base: "a",
      head: "b",
      files: [{ path: "app/checkout/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false }],
    });
    loadMapMock.mockReturnValue(
      sampleMap({
        specs: [
          {
            framework: "playwright",
            file: "e2e/auth.spec.ts",
            name: "signin",
            routesCovered: ["/signin"],
            endpointsCovered: [],
            hasSharedSetup: false,
            flowAnnotations: [],
          },
        ],
      }),
    );
    // Provide a sample spec on disk so the generator can pick it as the style anchor.
    mkdirSync(join(cwd, "e2e"), { recursive: true });
    writeFileSync(
      join(cwd, "e2e", "auth.spec.ts"),
      `import { test, expect } from "@playwright/test";\ntest("signin", async ({ page }) => { await page.goto("/signin"); });`,
      "utf8",
    );
  }

  it("writes the generated spec to .claudia/generated/", async () => {
    const cwd = tmpRepo();
    setupSingleGap(cwd);
    createMock.mockResolvedValueOnce(
      mockSuccessResponse(
        "checkout.spec.ts",
        `import { test, expect } from "@playwright/test";\ntest("checkout", async ({ page }) => { await page.goto("/checkout"); });`,
      ),
    );
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    expect(r.generated).toHaveLength(1);
    expect(existsSync(r.generated[0]!.filePath)).toBe(true);
    expect(readFileSync(r.generated[0]!.filePath, "utf8")).toContain("page.goto(\"/checkout\")");
    expect(r.generated[0]!.fileRel).toBe(".claudia/generated/checkout.spec.ts");
  });

  it("sanitizes model-supplied filenames (strips path components, replaces unsafe chars)", async () => {
    const cwd = tmpRepo();
    setupSingleGap(cwd);
    // Model tries to write outside the out-dir / uses weird chars.
    createMock.mockResolvedValueOnce(mockSuccessResponse("../../etc/passwd <evil>.spec.ts", "doesn't matter"));
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    // Final filename lives under outDir and contains only safe chars.
    expect(r.generated[0]!.filePath).toContain(".claudia/generated/");
    expect(r.generated[0]!.filePath).not.toContain("..");
    expect(r.generated[0]!.filePath).toMatch(/[a-zA-Z0-9._-]+\.spec\.ts$/);
  });

  it("appends .spec.ts when the model emits a bare name", async () => {
    const cwd = tmpRepo();
    setupSingleGap(cwd);
    createMock.mockResolvedValueOnce(mockSuccessResponse("checkout-flow", "x"));
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    expect(r.generated[0]!.filePath).toMatch(/checkout-flow\.spec\.ts$/);
  });

  it("respects maxFlows and reports skipped flows", async () => {
    const cwd = tmpRepo();
    // 3 uncovered routes; cap to 2.
    readDiffMock.mockReturnValue({
      base: "a",
      head: "b",
      files: [
        { path: "app/a/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false },
        { path: "app/b/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false },
        { path: "app/c/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false },
      ],
    });
    loadMapMock.mockReturnValue(
      sampleMap({
        routes: [
          { route: "/a", files: ["app/a/page.tsx"] },
          { route: "/b", files: ["app/b/page.tsx"] },
          { route: "/c", files: ["app/c/page.tsx"] },
        ],
      }),
    );
    createMock
      .mockResolvedValueOnce(mockSuccessResponse("a.spec.ts", "x"))
      .mockResolvedValueOnce(mockSuccessResponse("b.spec.ts", "x"));
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b", maxFlows: 2 });
    expect(r.generated).toHaveLength(2);
    expect(r.skippedFlows).toHaveLength(1);
  });

  it("aggregates token usage across all generated flows", async () => {
    const cwd = tmpRepo();
    readDiffMock.mockReturnValue({
      base: "a",
      head: "b",
      files: [
        { path: "app/a/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false },
        { path: "app/b/page.tsx", status: "modified", additions: 1, deletions: 0, hunks: [], binary: false },
      ],
    });
    loadMapMock.mockReturnValue(
      sampleMap({
        routes: [
          { route: "/a", files: ["app/a/page.tsx"] },
          { route: "/b", files: ["app/b/page.tsx"] },
        ],
      }),
    );
    createMock
      .mockResolvedValueOnce(mockSuccessResponse("a.spec.ts", "x"))
      .mockResolvedValueOnce(mockSuccessResponse("b.spec.ts", "x"));
    const r = await runGenerate({ rootDir: cwd, base: "a", head: "b" });
    expect(r.totalUsage.inputTokens).toBe(2000);
    expect(r.totalUsage.outputTokens).toBe(400);
  });
});

describe("formatGenerationMarkdown", () => {
  it("renders the generated specs with reasoning + truncated source", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [
          {
            flow: "/checkout",
            filePath: "/x/.claudia/generated/checkout.spec.ts",
            fileRel: ".claudia/generated/checkout.spec.ts",
            contents: "test(\"checkout\", () => {});",
            reasoning: "Verifies the checkout page renders.",
            usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
          },
        ],
        skippedFlows: [],
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x/.claudia/generated",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("Generated **1** spec");
    expect(md).toContain("/checkout");
    expect(md).toContain("Verifies the checkout page renders.");
    expect(md).toContain("test(\"checkout\"");
  });

  it("renders nothing-to-generate when no uncovered routes exist", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [],
        skippedFlows: [],
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("Nothing to generate");
  });

  it("shows a passed-against-prod verdict when runOutcome is passed (B.2)", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [
          {
            flow: "/checkout",
            filePath: "/x/.claudia/generated/checkout.spec.ts",
            fileRel: ".claudia/generated/checkout.spec.ts",
            contents: "test(\"checkout\", () => {});",
            reasoning: "verifies render",
            usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "passed", durationMs: 4321 },
          },
        ],
        skippedFlows: [],
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x/.claudia/generated",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("✅ passes against prod");
    expect(md).toContain("4.3s");
  });

  it("shows a failed-against-prod verdict with the failure body when runOutcome is failed (B.2)", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [
          {
            flow: "/checkout",
            filePath: "/x/.claudia/generated/checkout.spec.ts",
            fileRel: ".claudia/generated/checkout.spec.ts",
            contents: "test(\"checkout\", () => {});",
            reasoning: "verifies render",
            usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "failed", durationMs: 5000, error: "Expected #pay to be visible" },
          },
        ],
        skippedFlows: [],
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x/.claudia/generated",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("❌ fails against prod");
    expect(md).toContain("Expected #pay to be visible");
  });

  it("shows an errored verdict when the run couldn't start (B.2)", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [
          {
            flow: "/x",
            filePath: "/x/.claudia/generated/x.spec.ts",
            fileRel: ".claudia/generated/x.spec.ts",
            contents: "test(\"x\", () => {});",
            reasoning: "r",
            usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "errored", error: "playwright exited with code 127" },
          },
        ],
        skippedFlows: [],
        totalUsage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("⚠️ run errored");
    expect(md).toContain("playwright exited with code 127");
  });

  it("shows a not-executed verdict when runOutcome is undefined (default B.1 path)", () => {
    const md = formatGenerationMarkdown(
      {
        generated: [
          {
            flow: "/x",
            filePath: "/x/.claudia/generated/x.spec.ts",
            fileRel: ".claudia/generated/x.spec.ts",
            contents: "test(\"x\", () => {});",
            reasoning: "r",
            usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
          },
        ],
        skippedFlows: [],
        totalUsage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        outDir: "/x",
      },
      { base: "a", head: "b" },
    );
    expect(md).toContain("📝 not executed");
  });
});
