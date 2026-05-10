import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: createMock };
    },
  };
});

import { callPlanner, PlannerError } from "../src/llm.js";

const validPlanFields = {
  verdict: "test",
  summary: "ok",
  flows: [],
  unmappedFiles: [],
  coverageGaps: [],
};

function mockResponse(toolInput: unknown) {
  return {
    content: [{ type: "tool_use", name: "emit_plan", id: "x", input: toolInput }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  createMock.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("callPlanner unwrap behavior", () => {
  it("accepts a flat tool input", async () => {
    createMock.mockResolvedValueOnce(mockResponse(validPlanFields));
    const r = await callPlanner({ mapBlock: "m", diffBlock: "d" });
    expect(r.plan.verdict).toBe("test");
  });

  it("unwraps a `plan`-wrapped tool input (the observed real-world failure)", async () => {
    createMock.mockResolvedValueOnce(mockResponse({ plan: validPlanFields }));
    const r = await callPlanner({ mapBlock: "m", diffBlock: "d" });
    expect(r.plan.verdict).toBe("test");
  });

  it("unwraps single-key wrappers under arbitrary names", async () => {
    createMock.mockResolvedValueOnce(mockResponse({ result: validPlanFields }));
    const r = await callPlanner({ mapBlock: "m", diffBlock: "d" });
    expect(r.plan.verdict).toBe("test");
  });

  it("throws PlannerError with rawInput when nothing parses", async () => {
    createMock.mockResolvedValueOnce(mockResponse({ verdict: "garbage" }));
    await expect(callPlanner({ mapBlock: "m", diffBlock: "d" })).rejects.toBeInstanceOf(
      PlannerError,
    );
  });
});
