/**
 * LLM-driven relevance scoring for the candidate spec set produced by
 * `runSelect`. ADVISORY ONLY — the output is rendered alongside selection,
 * never used to filter what runs. This is the v0.20 entry point on the trust
 * gradient: display signal first, earn trust, only later expose any kind of
 * filter flag.
 *
 * Why advisory: false negatives in a verification tool are asymmetrically
 * worse than false positives. Running 38 specs when 12 would do is a few
 * minutes of CI; silently skipping the one spec that would have caught a
 * real regression is the failure mode claudia exists to prevent. The model
 * scores; the user decides.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Diff, FileChange } from "./types.js";

export const RELEVANCE_LEVELS = ["high", "medium", "low"] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];

export interface SpecForScoring {
  /** Spec file path relative to the repo root. Stable identifier across runs. */
  file: string;
  /** Spec file's source text (already read by the caller). */
  source: string;
  /** Routes the spec is known to cover, per the indexed map. */
  routesCovered: string[];
  /** Endpoints the spec is known to cover (method-prefixed). */
  endpointsCovered: string[];
}

export interface SpecRelevance {
  file: string;
  relevance: RelevanceLevel;
  /** One-sentence reason. Rendered next to the spec's selection rationale. */
  rationale: string;
}

export interface RelevanceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface RelevanceResult {
  scores: SpecRelevance[];
  /** Specs the model didn't return a score for. Caller should treat as "unscored". */
  unscored: string[];
  usage: RelevanceUsage;
}

export interface ScoreOptions {
  specs: SpecForScoring[];
  diff: Diff;
  apiKey?: string;
  model?: string;
  /** Cap on diff payload size — defaults to ~50_000 chars across all hunks. */
  maxDiffChars?: number;
  /** Cap on per-spec source size. Defaults to 8_000 chars per spec. */
  maxSpecChars?: number;
}

const SYSTEM_PROMPT = `You are claudia's relevance scorer. You read a diff and a set of E2E specs that were preselected by a static reachability graph (the diff touches files those specs' covered routes depend on). Your job is to rate, per spec, how *likely* the diff is to affect what each spec actually asserts.

Output ADVISORY signal only — the team will see your scores but will still run every preselected spec. Your scores help them understand why selection was wide; they do not filter execution.

Scoring rubric:
- "high": the diff plausibly changes behavior the spec asserts on. Examples: spec asserts on text content of a page and the diff edits that page; spec asserts a successful API call and the diff edits the endpoint or its calling component; spec asserts auth redirect and the diff touches auth middleware.
- "medium": the diff touches files reachable from the spec's routes, but the spec's assertions are about a different concern (e.g. spec asserts a button exists on /workspaces; diff edits the rich-text editor used by a child page). The spec *could* still catch a regression if the change has cross-cutting side effects (global window props, monkey-patches, broken imports), but it's not the primary risk.
- "low": the diff is reachable from the spec's routes only via deep transitive imports (shared layout, design-system component, utility module), and the change is structural/internal to that imported file with no plausible causal path to break the spec's assertions. The spec was selected by graph reachability but the change is not "about" what the spec tests.

Be conservative. When unsure between two levels, pick the higher one. False negatives are far costlier than false positives — a "low" rating that misses a real regression is much worse than a "high" rating that runs unnecessary specs.

Each rationale must be ONE sentence, terse, citing the specific causal link (or absence of one). Examples:
- "Diff edits the page /checkout's component tree; spec asserts page renders."
- "Spec covers /workspaces only via the layout; diff is internal to the rich-text editor used by a sibling route."

Score every spec in the input. If a spec is unreadable or you cannot judge, score it "high" and say so in the rationale.`;

const RELEVANCE_TOOL = {
  name: "emit_relevance",
  description: "Emit the relevance score for every preselected spec.",
  input_schema: {
    type: "object",
    required: ["scores"],
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          required: ["file", "relevance", "rationale"],
          properties: {
            file: { type: "string" },
            relevance: { type: "string", enum: ["high", "medium", "low"] },
            rationale: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const ScoreSchema = z.object({
  file: z.string(),
  relevance: z.enum(RELEVANCE_LEVELS),
  rationale: z.string(),
});
const ScoresSchema = z.object({ scores: z.array(ScoreSchema) });

export async function scoreSpecRelevance(opts: ScoreOptions): Promise<RelevanceResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  if (opts.specs.length === 0) {
    return {
      scores: [],
      unscored: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
  }

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? "claude-sonnet-4-6";

  const maxSpecChars = opts.maxSpecChars ?? 8_000;
  const maxDiffChars = opts.maxDiffChars ?? 50_000;

  const specsBlock = formatSpecsBlock(opts.specs, maxSpecChars);
  const diffBlock = formatDiffBlock(opts.diff, maxDiffChars);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [RELEVANCE_TOOL] as unknown as Anthropic.Tool[],
    tool_choice: { type: "tool", name: "emit_relevance" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: specsBlock, cache_control: { type: "ephemeral" } },
          { type: "text", text: diffBlock },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "emit_relevance",
  );
  if (!toolUse) {
    // Model didn't call the tool. Surface every spec as unscored rather than
    // throwing — the rest of the run should continue, this is advisory.
    return {
      scores: [],
      unscored: opts.specs.map((s) => s.file),
      usage: extractUsage(response.usage),
    };
  }

  const parsed = ScoresSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      scores: [],
      unscored: opts.specs.map((s) => s.file),
      usage: extractUsage(response.usage),
    };
  }

  // Filter the model's output to the specs we actually asked about — guards
  // against hallucinated file names being attached to real-looking scores.
  const requested = new Set(opts.specs.map((s) => s.file));
  const scores = parsed.data.scores.filter((s) => requested.has(s.file));
  const scoredSet = new Set(scores.map((s) => s.file));
  const unscored = opts.specs.map((s) => s.file).filter((f) => !scoredSet.has(f));

  return { scores, unscored, usage: extractUsage(response.usage) };
}

function formatSpecsBlock(specs: SpecForScoring[], maxChars: number): string {
  const parts: string[] = [
    "<preselected-specs>",
    "Each spec below was selected by reachability — the diff touches at least one file in the import closure of one of its `routesCovered`. Score each based on whether the diff's *intent* is likely to affect what the spec asserts.",
    "",
  ];
  for (const s of specs) {
    parts.push(`### ${s.file}`);
    if (s.routesCovered.length > 0) parts.push(`routesCovered: ${s.routesCovered.join(", ")}`);
    if (s.endpointsCovered.length > 0) parts.push(`endpointsCovered: ${s.endpointsCovered.join(", ")}`);
    parts.push("```ts");
    parts.push(truncate(s.source, maxChars));
    parts.push("```");
    parts.push("");
  }
  parts.push("</preselected-specs>");
  return parts.join("\n");
}

function formatDiffBlock(diff: Diff, maxChars: number): string {
  const parts: string[] = ["<diff>"];
  let used = 0;
  for (const file of diff.files) {
    if (file.binary) continue;
    const header = `### ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`;
    const body = renderHunks(file);
    const chunk = `${header}\n${body}\n`;
    if (used + chunk.length > maxChars) {
      parts.push(`_… diff truncated at ${maxChars} chars; remaining files: ${diff.files.length - diff.files.indexOf(file)} …_`);
      break;
    }
    parts.push(chunk);
    used += chunk.length;
  }
  parts.push("</diff>");
  return parts.join("\n");
}

function renderHunks(file: FileChange): string {
  if (file.hunks.length === 0) return "_(no hunks — file added/deleted/renamed only)_";
  return ["```diff", ...file.hunks, "```"].join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "\n… [truncated]";
}

function extractUsage(usage: Anthropic.Messages.Usage): RelevanceUsage {
  const u = usage as Anthropic.Messages.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}
