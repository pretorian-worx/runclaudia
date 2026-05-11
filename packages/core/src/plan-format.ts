import type { Plan } from "./types.js";
import type { PlanRunResult } from "./plan.js";
// Renderers live here, alongside the plan logic, so consumers (CLI,
// GitHub Action) can import them from @pretorian-worx/runclaudia-core without reaching into
// the CLI package's internals.

const RISK_BADGE: Record<Plan["flows"][number]["risk"], string> = {
  high: "🔴 high",
  medium: "🟡 medium",
  low: "🟢 low",
};

export function formatPlanMarkdown(result: PlanRunResult): string {
  const { plan, diff, usage, model, skipped } = result;
  const lines: string[] = [];

  lines.push("## claudia — test plan");
  lines.push("");
  lines.push(`Diff: \`${diff.base}..${diff.head}\` — ${diff.files.length} file${diff.files.length === 1 ? "" : "s"} changed.`);
  lines.push("");

  if (skipped || plan.verdict === "skip") {
    lines.push(`**Skipped.** ${plan.skipReason ?? plan.summary}`);
    return lines.join("\n");
  }

  lines.push(plan.summary);
  lines.push("");

  if (plan.flows.length === 0) {
    lines.push("_No user-facing flows inferred._");
  } else {
    lines.push("### Flows to verify");
    for (const f of plan.flows) {
      lines.push("");
      lines.push(`**${f.name}** — ${RISK_BADGE[f.risk]}  ·  ${f.routes.length > 0 ? f.routes.map((r) => `\`${r}\``).join(", ") : "_no route_"}`);
      lines.push("");
      lines.push(f.reasoning);
      if (f.suggestedChecks.length > 0) {
        lines.push("");
        for (const c of f.suggestedChecks) lines.push(`- [ ] ${c}`);
      }
    }
  }

  if (plan.unmappedFiles.length > 0) {
    lines.push("");
    lines.push("### Unmapped files");
    for (const f of plan.unmappedFiles) lines.push(`- \`${f}\``);
  }

  if (plan.coverageGaps.length > 0) {
    lines.push("");
    lines.push("### Coverage gaps");
    for (const g of plan.coverageGaps) lines.push(`- ${g}`);
  }

  if (usage && model) {
    lines.push("");
    lines.push(
      `<sub>${model} · in ${usage.inputTokens} (cache write ${usage.cacheCreationTokens} / cache read ${usage.cacheReadTokens}) · out ${usage.outputTokens}</sub>`,
    );
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("<sub>Was this plan useful? React with 👍 or 👎 on this comment. Other reactions are ignored. Run `claudia ratings` to aggregate over time.</sub>");

  return lines.join("\n");
}

export function formatPlanJson(result: PlanRunResult): string {
  return JSON.stringify(
    {
      diff: { base: result.diff.base, head: result.diff.head, files: result.diff.files.map((f) => f.path) },
      plan: result.plan,
      skipped: result.skipped,
      skipReason: result.skipReason,
      usage: result.usage,
      model: result.model,
    },
    null,
    2,
  );
}
