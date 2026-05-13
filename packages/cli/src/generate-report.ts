import type { GenerationResult } from "@pretorian-worx/runclaudia-core";
import type { CheckInput } from "./check-format.js";
import type { SlackPayloadInput } from "./slack-format.js";

export interface GenerateReportInput {
  result: GenerationResult;
  target: string;
}

export interface GenerateReportShape {
  /** Did all drafts that ran pass? Requires at least one passing draft. */
  passed: boolean;
  /** Data for the Slack Block Kit payload (sans environment-derived fields). */
  slack: Omit<SlackPayloadInput, "repo" | "headSha" | "prUrl" | "commitUrl" | "runUrl" | "branch">;
  /** Data for the GitHub check-run (sans markdown body). */
  check: Omit<CheckInput, "markdown">;
}

/**
 * Translate a Path B generation result (after --run executed each draft) into
 * the structured inputs the reporters expect. Pure — no I/O, no env reads.
 *
 * Drafts where `runOutcome` is undefined are ignored (--run didn't actually
 * execute them). Drafts in `failed` or `errored` states count as failures,
 * with the error text plumbed through for the Slack failure snippets.
 */
export function buildGenerateReportShape(input: GenerateReportInput): GenerateReportShape {
  const ran = input.result.generated.filter((s) => s.runOutcome !== undefined);
  const passedDrafts = ran.filter((s) => s.runOutcome?.status === "passed");
  const failedDrafts = ran.filter((s) => s.runOutcome?.status !== "passed");

  const failedTests = failedDrafts.map((s) => ({
    file: s.fileRel,
    title: s.flow,
    error: errorOf(s.runOutcome),
  }));

  const durationMs = ran.reduce((acc, s) => {
    if (s.runOutcome?.status === "passed" || s.runOutcome?.status === "failed") {
      return acc + s.runOutcome.durationMs;
    }
    return acc;
  }, 0);

  const passed = failedDrafts.length === 0 && passedDrafts.length > 0;

  return {
    passed,
    slack: {
      passed,
      target: input.target,
      generatedSpecCount: ran.length,
      passedCount: passedDrafts.length,
      failedCount: failedDrafts.length,
      durationMs,
      failedTests,
    },
    check: {
      passed,
      target: input.target,
      passedCount: passedDrafts.length,
      failedCount: failedDrafts.length,
    },
  };
}

function errorOf(outcome: GenerationResult["generated"][number]["runOutcome"]): string {
  if (!outcome) return "no run outcome";
  if (outcome.status === "passed") return "";
  if (outcome.status === "failed") return outcome.error;
  if (outcome.status === "errored") return outcome.error;
  return "unknown failure";
}
