import type { Plan, PlanFlow } from "./types.js";

export type GatingMode = "shadow" | "advisory" | "gating";
export type RiskLevel = PlanFlow["risk"];

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export interface GatingDecision {
  /** Whether to post a check at all (false in shadow mode). */
  postCheck: boolean;
  /** Final conclusion of the check, when posted. */
  conclusion: "success" | "failure" | "neutral";
  /** Short summary line that goes into the check's title field. */
  title: string;
  /** Flows that triggered a failure, for human-facing detail. */
  failingFlows: PlanFlow[];
}

export interface GatingOptions {
  mode: GatingMode;
  /** Minimum risk level that causes a `gating`-mode failure. Default `high`. */
  blockingRisk?: RiskLevel;
}

/**
 * Pure decision function — takes the plan and the user's gating config and
 * tells the action what check (if any) to post.
 *
 * Rules:
 *   shadow   → never post a check
 *   advisory → post a neutral check unconditionally
 *   gating   → post a check; fails if any flow has risk >= blockingRisk;
 *              skip-verdict plans always pass (nothing to verify)
 */
export function decideGating(plan: Plan, opts: GatingOptions): GatingDecision {
  if (opts.mode === "shadow") {
    return { postCheck: false, conclusion: "success", title: "", failingFlows: [] };
  }

  if (opts.mode === "advisory") {
    return {
      postCheck: true,
      conclusion: "neutral",
      title: summarizeForCheck(plan, "advisory"),
      failingFlows: [],
    };
  }

  // mode === "gating"
  const threshold = opts.blockingRisk ?? "high";
  const thresholdLevel = RISK_ORDER[threshold];

  if (plan.verdict === "skip") {
    return {
      postCheck: true,
      conclusion: "success",
      title: `claudia: skipped (${plan.skipReason ?? "no testable changes"})`,
      failingFlows: [],
    };
  }

  const failing = plan.flows.filter((f) => RISK_ORDER[f.risk] >= thresholdLevel);
  if (failing.length === 0) {
    return {
      postCheck: true,
      conclusion: "success",
      title: summarizeForCheck(plan, "gating-pass"),
      failingFlows: [],
    };
  }
  return {
    postCheck: true,
    conclusion: "failure",
    title: `${failing.length} flow${failing.length === 1 ? "" : "s"} at or above risk threshold "${threshold}"`,
    failingFlows: failing,
  };
}

function summarizeForCheck(plan: Plan, kind: "advisory" | "gating-pass"): string {
  if (plan.verdict === "skip") return `claudia: skipped (${plan.skipReason ?? "no testable changes"})`;
  const flows = plan.flows.length;
  if (kind === "gating-pass") return `claudia: ${flows} flow${flows === 1 ? "" : "s"} to verify — no blocking risk`;
  return `claudia: ${flows} flow${flows === 1 ? "" : "s"} to verify`;
}
