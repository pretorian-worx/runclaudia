import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { readDiff } from "./diff.js";
import { loadOrBuildMap } from "./map.js";
import { filterMapForDiff } from "./prompt.js";
import { PlannerError } from "./llm.js";
import type { AppMap } from "./types.js";

export interface GenerateOptions {
  rootDir: string;
  base: string;
  head: string;
  apiKey?: string;
  model?: string;
  /** Where generated specs are written. Default: `<rootDir>/.claudia/generated/`. */
  outDir?: string;
  /** Cap on how many uncovered routes to generate for in one run. Default: 5. */
  maxFlows?: number;
}

export interface GeneratedSpec {
  /** The route the spec was generated to cover, e.g. "/workspaces/:ws/docs". */
  flow: string;
  /** Absolute path to the written spec file. */
  filePath: string;
  /** Relative-to-rootDir filename, for display. */
  fileRel: string;
  /** Source of the spec. */
  contents: string;
  /** Brief reasoning from the model about what the spec verifies. */
  reasoning: string;
  /** Anthropic usage for this generation. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  /**
   * Post-generation execution outcome, when claudia generate --run was used.
   * undefined when the spec was generated but not executed.
   */
  runOutcome?: SpecRunOutcome;
}

export type SpecRunOutcome =
  | { status: "passed"; durationMs: number }
  | { status: "failed"; durationMs: number; error: string }
  | { status: "errored"; error: string };

export interface GenerationResult {
  generated: GeneratedSpec[];
  /** Routes we found gaps for but skipped because of maxFlows. */
  skippedFlows: string[];
  /** Total Anthropic spend across this run, in tokens. */
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  outDir: string;
}

const SPEC_TOOL_SCHEMA = {
  name: "emit_spec",
  description:
    "Emit a single complete Playwright spec file. Call this exactly once with the full spec source.",
  input_schema: {
    type: "object",
    required: ["file_name", "contents", "reasoning"],
    properties: {
      file_name: {
        type: "string",
        description:
          "Filename for the new spec, kebab-case, ending in `.spec.ts`. Should describe the flow (e.g. 'initiative-docs-detail.spec.ts').",
      },
      contents: {
        type: "string",
        description:
          "Complete `.spec.ts` source. Use the same imports, helpers, and assertion style as the sample spec provided in context. Skip auth setup — it's handled globally.",
      },
      reasoning: {
        type: "string",
        description:
          "One-paragraph explanation of what this spec verifies and why it's the right shape for the target flow.",
      },
    },
  },
} as const;

const SPEC_INPUT_SCHEMA = z.object({
  file_name: z.string(),
  contents: z.string(),
  reasoning: z.string(),
});

const SYSTEM_PROMPT = `You are claudia's test generator. Your job: write a single Playwright spec file that verifies a specific user-facing flow works in production.

Hard rules:
- **Imports**: ONLY import from \`@playwright/test\`. Do NOT import any project-internal helpers (e.g. \`./helpers/nav\`, \`@/lib/...\`). Generated specs live in \`.claudia/generated/\` where relative paths don't resolve. Use \`page.goto\`, \`page.click\`, \`expect\` directly. This means even if the sample spec in context uses a helper like \`appNav(page, path)\`, your generated spec should inline it as \`await page.goto(path)\`.
- **Style otherwise**: match the EXISTING SPEC sample for assertion shape (\`expect(page.getByText(...)).toBeVisible()\`, \`{ timeout: ... }\`, \`describe\` blocks, etc.).
- **Auth**: skip auth setup. The team's global-setup file handles login; specs run with an authenticated context.
- **Scope**: focus on the happy path — navigate, verify key elements render, optionally exercise one core interaction. Keep it short: 1–2 \`test()\` blocks. Verification, not exhaustive testing.
- **Reviewability**: generated specs are reviewed by a human before merging. Optimize for "obvious, easy to review, easy to delete if wrong" rather than "comprehensive."

Output via the emit_spec tool, exactly once.`;

export async function runGenerate(opts: GenerateOptions): Promise<GenerationResult> {
  const rootDir = resolve(opts.rootDir);
  const outDir = opts.outDir ?? join(rootDir, ".claudia", "generated");
  const maxFlows = opts.maxFlows ?? 5;

  const diff = readDiff({ base: opts.base, head: opts.head, cwd: rootDir });
  const map = loadOrBuildMap({ rootDir });
  const filtered = filterMapForDiff(map, diff);

  const flowsToGenerate = filtered.uncoveredRoutes.slice(0, maxFlows);
  const skippedFlows = filtered.uncoveredRoutes.slice(maxFlows);

  if (flowsToGenerate.length === 0) {
    return {
      generated: [],
      skippedFlows: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      outDir,
    };
  }

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });
  const model = opts.model ?? "claude-sonnet-4-6";

  const sampleSpec = pickSampleSpec(rootDir, map);
  const changedFiles = renderChangedFiles(diff, rootDir);

  mkdirSync(outDir, { recursive: true });

  const generated: GeneratedSpec[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

  for (const flow of flowsToGenerate) {
    const userMessage = buildUserMessage({ flow, changedFiles, sampleSpec });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [SPEC_TOOL_SCHEMA] as unknown as Anthropic.Tool[],
      tool_choice: { type: "tool", name: "emit_spec" },
      messages: [
        {
          role: "user",
          content: [
            // Sample spec is cacheable across multiple flow generations in the same run.
            { type: "text", text: userMessage.cachedPrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: userMessage.volatile },
          ],
        },
      ],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "emit_spec",
    );
    if (!toolUse) {
      throw new PlannerError("Model did not call emit_spec tool", {
        stopReason: response.stop_reason,
        contentTypes: response.content.map((b) => b.type),
        flow,
      });
    }
    const parsed = SPEC_INPUT_SCHEMA.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new PlannerError("emit_spec input did not match schema", {
        stopReason: response.stop_reason,
        rawInput: toolUse.input,
        zodIssues: parsed.error.issues,
        flow,
      });
    }

    const safeFileName = sanitizeFileName(parsed.data.file_name);
    const filePath = join(outDir, safeFileName);
    writeFileSync(filePath, parsed.data.contents, "utf8");

    const usage = response.usage as Anthropic.Messages.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const thisUsage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    };
    totalUsage.inputTokens += thisUsage.inputTokens;
    totalUsage.outputTokens += thisUsage.outputTokens;
    totalUsage.cacheCreationTokens += thisUsage.cacheCreationTokens;
    totalUsage.cacheReadTokens += thisUsage.cacheReadTokens;

    generated.push({
      flow,
      filePath,
      fileRel: relPath(rootDir, filePath),
      contents: parsed.data.contents,
      reasoning: parsed.data.reasoning,
      usage: thisUsage,
    });
  }

  return { generated, skippedFlows, totalUsage, outDir };
}

// ---------- Prompt construction ----------

interface UserMessage {
  /** Stable across all flows in the same run — cacheable. */
  cachedPrefix: string;
  /** Volatile per-flow content — not cached. */
  volatile: string;
}

function buildUserMessage(args: {
  flow: string;
  changedFiles: string;
  sampleSpec: { path: string; contents: string } | null;
}): UserMessage {
  const parts: string[] = [];
  parts.push("# Existing spec style in this repo");
  if (args.sampleSpec) {
    parts.push(`Sample: \`${args.sampleSpec.path}\` — use the same imports, helpers, and assertion patterns.`);
    parts.push("");
    parts.push("```ts");
    parts.push(args.sampleSpec.contents);
    parts.push("```");
  } else {
    parts.push("(no existing specs found — write a minimal Playwright spec using `page.goto` and `expect`)");
  }
  parts.push("");
  parts.push("# Changed files in this diff");
  parts.push(args.changedFiles);
  const cachedPrefix = parts.join("\n");

  const volatile = [
    "",
    "# Flow to generate a spec for",
    `Route: \`${args.flow}\``,
    "",
    "Emit a single spec file via the emit_spec tool that verifies this route renders and behaves correctly in production.",
  ].join("\n");

  return { cachedPrefix, volatile };
}

function pickSampleSpec(rootDir: string, map: AppMap): { path: string; contents: string } | null {
  // Prefer a spec from the indexed set — that's our ground truth for what
  // "the team's style" looks like. Sort by file path so the same repo+map
  // picks the same sample each time, keeping the cached prefix stable.
  const candidates = (map.specs ?? [])
    .map((s) => s.file)
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .sort();
  for (const rel of candidates) {
    try {
      const abs = join(rootDir, rel);
      const src = readFileSync(abs, "utf8");
      if (src.includes("test(") || src.includes("it(")) {
        return { path: rel, contents: truncate(src, 6000) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function renderChangedFiles(diff: { files: { path: string; hunks: string[]; binary: boolean }[] }, rootDir: string): string {
  const lines: string[] = [];
  for (const f of diff.files) {
    lines.push(`## ${f.path}`);
    if (f.binary) {
      lines.push("(binary)");
      continue;
    }
    // Inline the current source so the generator can see what the change shipped.
    try {
      const abs = join(rootDir, f.path);
      if (existsSafe(abs)) {
        lines.push("```");
        lines.push(truncate(readFileSync(abs, "utf8"), 4000));
        lines.push("```");
      } else {
        for (const h of f.hunks) {
          lines.push("```diff");
          lines.push(truncate(h, 2000));
          lines.push("```");
        }
      }
    } catch {
      // best-effort
    }
  }
  return lines.join("\n");
}

function existsSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [${s.length - n} chars truncated]` : s;
}

function sanitizeFileName(name: string): string {
  // Strip any path components — generated files always go in outDir.
  const base = name.split("/").pop()!.split("\\").pop()!;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!cleaned.endsWith(".spec.ts") && !cleaned.endsWith(".spec.js")) {
    return `${cleaned}.spec.ts`;
  }
  return cleaned;
}

function relPath(rootDir: string, abs: string): string {
  // Avoid pulling in node:path's relative for cross-platform reasons here.
  if (abs.startsWith(rootDir + "/") || abs.startsWith(rootDir + "\\")) {
    return abs.slice(rootDir.length + 1).replace(/\\/g, "/");
  }
  return abs;
}

export function formatGenerationMarkdown(r: GenerationResult, args: { base: string; head: string }): string {
  const lines: string[] = [];
  lines.push("## claudia — generated specs");
  lines.push("");
  lines.push(`Diff: \`${args.base}..${args.head}\``);
  lines.push("");

  if (r.generated.length === 0 && r.skippedFlows.length === 0) {
    lines.push("**Nothing to generate.** No uncovered routes implicated by this diff.");
    return lines.join("\n");
  }

  if (r.generated.length === 0 && r.skippedFlows.length > 0) {
    lines.push(`**No specs generated yet** — ${r.skippedFlows.length} uncovered route(s) exist but the run cap was 0.`);
    return lines.join("\n");
  }

  lines.push(`Generated **${r.generated.length}** spec${r.generated.length === 1 ? "" : "s"} in \`${r.outDir}\`.`);
  lines.push("");

  for (const g of r.generated) {
    const verdict = g.runOutcome ? runVerdict(g.runOutcome) : "📝 not executed";
    lines.push(`### ${verdict} — \`${g.fileRel}\` covers \`${g.flow}\``);
    lines.push("");
    lines.push(g.reasoning);
    if (g.runOutcome && g.runOutcome.status === "failed") {
      lines.push("");
      lines.push("**Run failure:**");
      lines.push("```");
      lines.push(truncate(g.runOutcome.error, 1500));
      lines.push("```");
    } else if (g.runOutcome && g.runOutcome.status === "errored") {
      lines.push("");
      lines.push(`**Run could not start:** ${g.runOutcome.error}`);
    }
    lines.push("");
    lines.push("```ts");
    lines.push(truncate(g.contents, 1200));
    lines.push("```");
    lines.push("");
  }

  if (r.skippedFlows.length > 0) {
    lines.push(`### Skipped (cap reached)`);
    for (const f of r.skippedFlows) lines.push(`- \`${f}\``);
    lines.push("");
  }

  const u = r.totalUsage;
  lines.push(`<sub>tokens: in ${u.inputTokens} (cache write ${u.cacheCreationTokens} / cache read ${u.cacheReadTokens}) · out ${u.outputTokens}</sub>`);

  return lines.join("\n");
}

function runVerdict(o: SpecRunOutcome): string {
  switch (o.status) {
    case "passed":
      return `✅ passes against prod (${(o.durationMs / 1000).toFixed(1)}s)`;
    case "failed":
      return "❌ fails against prod";
    case "errored":
      return "⚠️ run errored";
  }
}

// Hint to the index module that readdirSync is intentionally unused in this file's
// surface; it's only here for future use when we walk for additional sample specs.
void readdirSync;
void dirname;
