import Anthropic from "@anthropic-ai/sdk";
import { PlanSchema, type Plan } from "./types.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const WRAPPER_KEYS = ["plan", "result", "output", "data", "emit_plan"];

function unwrapCandidates(input: unknown): unknown[] {
  const out: unknown[] = [input];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const only = obj[keys[0]!];
      if (only && typeof only === "object") out.push(only);
    }
    for (const k of WRAPPER_KEYS) {
      if (k in obj && obj[k] && typeof obj[k] === "object") out.push(obj[k]);
    }
  }
  return out;
}

export class PlannerError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "PlannerError";
    this.details = details;
  }
}

export interface LlmCallOptions {
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  mapBlock: string;
  diffBlock: string;
  maxTokens?: number;
}

export interface LlmResult {
  plan: Plan;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  model: string;
}

const PLAN_TOOL = {
  name: "emit_plan",
  description:
    "Emit the structured test plan. Always call this exactly once. The tool input MUST be a flat object with the fields verdict, summary, flows, unmappedFiles, coverageGaps at the top level — DO NOT nest them under a 'plan' or other wrapper key.",
  input_schema: {
    type: "object",
    required: ["verdict", "summary", "flows", "unmappedFiles", "coverageGaps"],
    properties: {
      verdict: { type: "string", enum: ["test", "skip"] },
      skipReason: { type: "string" },
      summary: { type: "string" },
      flows: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "routes", "risk", "reasoning", "suggestedChecks"],
          properties: {
            name: { type: "string" },
            routes: { type: "array", items: { type: "string" } },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            reasoning: { type: "string" },
            suggestedChecks: { type: "array", items: { type: "string" } },
          },
        },
      },
      unmappedFiles: { type: "array", items: { type: "string" } },
      coverageGaps: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export async function callPlanner(opts: LlmCallOptions): Promise<LlmResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? "claude-opus-4-7";

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    system: [
      {
        type: "text",
        text: opts.systemPrompt ?? SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [PLAN_TOOL] as unknown as Anthropic.Tool[],
    tool_choice: { type: "tool", name: "emit_plan" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: opts.mapBlock,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: opts.diffBlock },
        ],
      },
    ],
  });

  const toolUses = response.content.filter(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "emit_plan",
  );
  if (toolUses.length === 0) {
    const textPreview = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .slice(0, 2000);
    throw new PlannerError("Model did not call emit_plan tool", {
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
      textPreview,
    });
  }

  const last = toolUses[toolUses.length - 1]!;
  const candidates = unwrapCandidates(last.input);
  let plan: Plan | undefined;
  let lastIssues: unknown;
  for (const c of candidates) {
    const parsed = PlanSchema.safeParse(c);
    if (parsed.success) {
      plan = parsed.data;
      break;
    }
    lastIssues = parsed.error.issues;
  }
  if (!plan) {
    throw new PlannerError("emit_plan tool input did not match schema", {
      stopReason: response.stop_reason,
      rawInput: last.input,
      zodIssues: lastIssues,
    });
  }

  const usage = response.usage as Anthropic.Messages.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };

  return {
    plan,
    model,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}
