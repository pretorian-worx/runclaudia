/**
 * GitHub check-run payload builder for the post-deploy verification report.
 *
 * Pure function: takes structured run data, returns the fields needed for
 * `POST /repos/{owner}/{repo}/check-runs`. The check is posted against the
 * deployed SHA so the verdict shows up in the PR's status-checks UI even
 * after merge — closing the loop without leaving GitHub.
 *
 * GitHub limits:
 *   - output.title is capped at 255 chars (we cap at 240 for headroom).
 *   - output.summary is capped at 65535 chars (we cap at 60000).
 */

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface CheckInput {
  passed: boolean;
  passedCount: number;
  failedCount: number;
  skippedCount?: number;
  flakyCount?: number;
  target?: string;
  /** Pre-rendered markdown from formatRunMarkdown — used as the summary body. */
  markdown: string;
  /** Override the default "claudia / deploy-verified" check name. */
  name?: string;
}

export interface CheckOutput {
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

const DEFAULT_NAME = "claudia / deploy-verified";
const MAX_TITLE = 240;
const MAX_SUMMARY = 60000;

export function buildCheckOutput(input: CheckInput): CheckOutput {
  return {
    name: input.name ?? DEFAULT_NAME,
    conclusion: input.passed ? "success" : "failure",
    title: truncate(buildTitle(input), MAX_TITLE),
    summary: truncate(input.markdown, MAX_SUMMARY),
  };
}

function buildTitle(input: CheckInput): string {
  const totalRun = input.passedCount + input.failedCount;
  const where = input.target ? ` against ${stripScheme(input.target)}` : "";
  if (input.passed) {
    if (totalRun === 0) return `No tests ran${where}`;
    return `${totalRun} test${pl(totalRun)} passed${where}`;
  }
  return `${input.failedCount} of ${totalRun} failed${where}`;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function pl(n: number): string {
  return n === 1 ? "" : "s";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
