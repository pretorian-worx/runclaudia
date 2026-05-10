import { classifySkip, readDiff } from "./diff.js";
import { loadOrBuildMap } from "./map.js";
import { buildUserMessage } from "./prompt.js";
import { callPlanner, type LlmResult } from "./llm.js";
import type { AppMap, Diff, Plan } from "./types.js";

export interface PlanRunOptions {
  rootDir: string;
  base: string;
  head: string;
  targetUrl?: string;
  refreshMap?: boolean;
  apiKey?: string;
  model?: string;
}

export interface PlanRunResult {
  diff: Diff;
  map: AppMap;
  plan: Plan;
  skipped: boolean;
  skipReason?: string;
  usage?: LlmResult["usage"];
  model?: string;
}

export async function runPlan(opts: PlanRunOptions): Promise<PlanRunResult> {
  const diff = readDiff({ base: opts.base, head: opts.head, cwd: opts.rootDir });
  const map = loadOrBuildMap({ rootDir: opts.rootDir, refresh: opts.refreshMap });

  const skip = classifySkip(diff);
  if (skip.skip) {
    return {
      diff,
      map,
      plan: {
        verdict: "skip",
        skipReason: skip.reason,
        summary: skip.reason ?? "No testable changes.",
        flows: [],
        unmappedFiles: [],
        coverageGaps: [],
      },
      skipped: true,
      skipReason: skip.reason,
    };
  }

  const userMessage = buildUserMessage({ diff, map, targetUrl: opts.targetUrl });

  const splitIdx = userMessage.indexOf("\n# Diff ");
  const mapBlock = splitIdx >= 0 ? userMessage.slice(0, splitIdx) : userMessage;
  const diffBlock = splitIdx >= 0 ? userMessage.slice(splitIdx + 1) : "";

  const result = await callPlanner({
    apiKey: opts.apiKey,
    model: opts.model,
    mapBlock,
    diffBlock,
  });

  return {
    diff,
    map,
    plan: result.plan,
    skipped: false,
    usage: result.usage,
    model: result.model,
  };
}
