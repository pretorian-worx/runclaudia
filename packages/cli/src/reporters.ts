import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const STICKY_MARKER = "<!-- claudia:verify -->";

export interface ReportContext {
  /** Pre-rendered markdown summary of the verification run. */
  markdown: string;
  /** SHA whose deployment was verified. Used to look up the originating PR. */
  headSha: string;
  /** Whether the verification passed overall. */
  passed: boolean;
  /** Repo identifier "owner/name". Auto-detected from GITHUB_REPOSITORY when not set. */
  repo?: string;
}

export interface ReporterOptions {
  slackWebhook?: string;
  disableStepSummary?: boolean;
  disablePrComment?: boolean;
}

export async function dispatchReporters(ctx: ReportContext, opts: ReporterOptions = {}): Promise<void> {
  await Promise.allSettled([
    writeStepSummary(ctx, opts),
    backCommentOnMergedPr(ctx, opts),
    postToSlack(ctx, opts),
  ]);
}

// ---------- 1. $GITHUB_STEP_SUMMARY ----------

async function writeStepSummary(ctx: ReportContext, opts: ReporterOptions): Promise<void> {
  if (opts.disableStepSummary) return;
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, ctx.markdown + "\n", "utf8");
  } catch (err) {
    warn("step-summary", err);
  }
}

// ---------- 2. PR back-comment ----------

async function backCommentOnMergedPr(ctx: ReportContext, opts: ReporterOptions): Promise<void> {
  if (opts.disablePrComment) return;
  const repo = ctx.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) return;
  if (!ctx.headSha) return;

  let prNumber: number | null;
  try {
    prNumber = findPullRequestForSha(repo, ctx.headSha);
  } catch (err) {
    warn("pr-lookup", err);
    return;
  }
  if (!prNumber) return;

  const body = `${STICKY_MARKER}\n${ctx.markdown}`;
  try {
    upsertStickyComment(repo, prNumber, body);
  } catch (err) {
    warn("pr-comment", err);
  }
}

function findPullRequestForSha(repo: string, sha: string): number | null {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        `/repos/${repo}/commits/${sha}/pulls`,
        "-H",
        "Accept: application/vnd.github+json",
        "--jq",
        "[.[] | .number] | first",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!out || out === "null") return null;
    const n = parseInt(out, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function upsertStickyComment(repo: string, prNumber: number, body: string): void {
  const comments = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        `/repos/${repo}/issues/${prNumber}/comments`,
        "--jq",
        "[.[] | {id, body}]",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ),
  ) as Array<{ id: number; body?: string }>;

  const prior = comments.find((c) => c.body?.includes(STICKY_MARKER));

  if (prior) {
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `/repos/${repo}/issues/comments/${prior.id}`,
        "-f",
        `body=${body}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } else {
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `/repos/${repo}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }
}

// ---------- 3. Slack ----------

async function postToSlack(ctx: ReportContext, opts: ReporterOptions): Promise<void> {
  const url = opts.slackWebhook ?? process.env.CLAUDIA_SLACK_WEBHOOK;
  if (!url) return;
  try {
    const payload = {
      text: ctx.markdown,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      warn("slack", new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`));
    }
  } catch (err) {
    warn("slack", err);
  }
}

function warn(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`claudia: reporter[${label}] failed: ${msg}\n`);
}
