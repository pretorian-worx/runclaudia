import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { scoreSpecRelevance, type SpecForScoring } from "../src/relevance.js";
import type { Diff } from "../src/types.js";

const baseDiff: Diff = {
  base: "a",
  head: "b",
  files: [
    {
      path: "src/components/rich-text-editor.tsx",
      status: "modified",
      additions: 5,
      deletions: 2,
      hunks: ["@@ -10,3 +10,3 @@", "-old line", "+new line"],
      binary: false,
    },
  ],
};

const baseSpec = (overrides: Partial<SpecForScoring> = {}): SpecForScoring => ({
  file: "e2e/workspaces.spec.ts",
  source: "import { test } from '@playwright/test';\ntest('lists workspaces', async () => {});",
  routesCovered: ["/workspaces"],
  endpointsCovered: [],
  ...overrides,
});

function mockResponse(scores: Array<{ file: string; relevance: string; rationale: string }>) {
  createMock.mockResolvedValue({
    content: [
      {
        type: "tool_use",
        name: "emit_relevance",
        input: { scores },
      },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 600,
      cache_read_input_tokens: 0,
    },
  });
}

beforeEach(() => {
  createMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("scoreSpecRelevance — happy path", () => {
  it("returns per-spec scores parsed from the emit_relevance tool call", async () => {
    mockResponse([
      { file: "e2e/workspaces.spec.ts", relevance: "low", rationale: "Editor change unrelated to listing." },
    ]);
    const r = await scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff });
    expect(r.scores).toEqual([
      { file: "e2e/workspaces.spec.ts", relevance: "low", rationale: "Editor change unrelated to listing." },
    ]);
    expect(r.unscored).toEqual([]);
  });

  it("plumbs cache token usage out of the response", async () => {
    mockResponse([{ file: "e2e/workspaces.spec.ts", relevance: "medium", rationale: "x" }]);
    const r = await scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff });
    expect(r.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 600,
      cacheReadTokens: 0,
    });
  });

  it("sends spec source + diff in a single call, with system + specs cache-tagged", async () => {
    mockResponse([{ file: "e2e/workspaces.spec.ts", relevance: "high", rationale: "x" }]);
    await scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff });

    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0]![0];
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
    const userBlocks = call.messages[0].content;
    // First user block is the preselected-specs bundle; second is the diff.
    expect(userBlocks[0].text).toContain("<preselected-specs>");
    expect(userBlocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(userBlocks[1].text).toContain("<diff>");
    expect(userBlocks[1].cache_control).toBeUndefined(); // diff is volatile
    expect(call.tool_choice).toEqual({ type: "tool", name: "emit_relevance" });
  });
});

describe("scoreSpecRelevance — empty / edge cases", () => {
  it("short-circuits without calling the API when there are no specs", async () => {
    const r = await scoreSpecRelevance({ specs: [], diff: baseDiff });
    expect(createMock).not.toHaveBeenCalled();
    expect(r.scores).toEqual([]);
    expect(r.unscored).toEqual([]);
  });

  it("treats every spec as unscored when the model doesn't call the tool", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "I refuse to use the tool" }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });
    const r = await scoreSpecRelevance({
      specs: [baseSpec({ file: "a.spec.ts" }), baseSpec({ file: "b.spec.ts" })],
      diff: baseDiff,
    });
    expect(r.scores).toEqual([]);
    expect(r.unscored).toEqual(["a.spec.ts", "b.spec.ts"]);
  });

  it("treats every spec as unscored when the tool input fails schema validation", async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "emit_relevance",
          input: { scores: [{ file: "a.spec.ts", relevance: "unknown-level", rationale: "x" }] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const r = await scoreSpecRelevance({
      specs: [baseSpec({ file: "a.spec.ts" })],
      diff: baseDiff,
    });
    expect(r.scores).toEqual([]);
    expect(r.unscored).toEqual(["a.spec.ts"]);
  });

  it("drops hallucinated file paths the caller didn't ask about", async () => {
    mockResponse([
      { file: "e2e/workspaces.spec.ts", relevance: "high", rationale: "real" },
      { file: "e2e/hallucinated.spec.ts", relevance: "low", rationale: "made up" },
    ]);
    const r = await scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff });
    expect(r.scores).toEqual([
      { file: "e2e/workspaces.spec.ts", relevance: "high", rationale: "real" },
    ]);
    expect(r.unscored).toEqual([]);
  });

  it("reports unscored specs the model omitted", async () => {
    mockResponse([
      { file: "a.spec.ts", relevance: "high", rationale: "yep" },
    ]);
    const r = await scoreSpecRelevance({
      specs: [
        baseSpec({ file: "a.spec.ts" }),
        baseSpec({ file: "b.spec.ts" }),
        baseSpec({ file: "c.spec.ts" }),
      ],
      diff: baseDiff,
    });
    expect(r.scores.map((s) => s.file)).toEqual(["a.spec.ts"]);
    expect(r.unscored.sort()).toEqual(["b.spec.ts", "c.spec.ts"]);
  });
});

describe("scoreSpecRelevance — truncation guards", () => {
  it("truncates each spec source to maxSpecChars", async () => {
    mockResponse([{ file: "huge.spec.ts", relevance: "high", rationale: "x" }]);
    const huge = "x".repeat(20_000);
    await scoreSpecRelevance({
      specs: [baseSpec({ file: "huge.spec.ts", source: huge })],
      diff: baseDiff,
      maxSpecChars: 500,
    });
    const bundleText = createMock.mock.calls[0]![0].messages[0].content[0].text as string;
    expect(bundleText.length).toBeLessThan(20_000);
    expect(bundleText).toContain("… [truncated]");
  });

  it("truncates the diff payload at maxDiffChars", async () => {
    mockResponse([{ file: "e2e/workspaces.spec.ts", relevance: "high", rationale: "x" }]);
    const bigDiff: Diff = {
      base: "a",
      head: "b",
      files: Array.from({ length: 50 }, (_, i) => ({
        path: `src/x${i}.tsx`,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        hunks: ["@@ -1,1 +1,1 @@", `+line ${i} ` + "y".repeat(500)],
        binary: false,
      })),
    };
    await scoreSpecRelevance({ specs: [baseSpec()], diff: bigDiff, maxDiffChars: 2_000 });
    const diffText = createMock.mock.calls[0]![0].messages[0].content[1].text as string;
    expect(diffText.length).toBeLessThan(5_000);
    expect(diffText).toContain("diff truncated at 2000 chars");
  });
});

describe("scoreSpecRelevance — auth", () => {
  it("throws if no API key is available", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff }),
    ).rejects.toThrow("ANTHROPIC_API_KEY is not set");
  });

  it("uses an explicit apiKey over the env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockResponse([{ file: "e2e/workspaces.spec.ts", relevance: "high", rationale: "x" }]);
    const r = await scoreSpecRelevance({ specs: [baseSpec()], diff: baseDiff, apiKey: "explicit-key" });
    expect(r.scores).toHaveLength(1);
  });
});
