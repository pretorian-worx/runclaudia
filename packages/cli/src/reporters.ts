import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildSlackPayload, type SlackPayloadInput } from "./slack-format.js";
import { buildCheckOutput, type CheckInput } from "./check-format.js";

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
  /**
   * Structured run data used to build the Slack Block Kit payload. When
   * omitted, Slack receives a plain-markdown text post (legacy behavior).
   * Step-summary + PR back-comment continue to use {@link markdown} unchanged.
   */
  slack?: Omit<SlackPayloadInput, "repo" | "headSha" | "prUrl" | "commitUrl" | "runUrl" | "branch">;
  /**
   * Structured run data used to build the GitHub check-run. When omitted, no
   * check is posted (the sink is skipped, not failed).
   */
  check?: Omit<CheckInput, "markdown">;
}

export interface ReporterOptions {
  slackWebhook?: string;
  disableStepSummary?: boolean;
  disablePrComment?: boolean;
  disableCheck?: boolean;
}

export async function dispatchReporters(ctx: ReportContext, opts: ReporterOptions = {}): Promise<void> {
  // Look up the PR once and share it between the PR-comment sink (needs the
  // number) and the Slack sink (wants a "View PR" button URL). Avoids two
  // `gh api` round-trips and keeps the two sinks consistent on which PR they
  // think this SHA belongs to.
  const repo = ctx.repo ?? process.env.GITHUB_REPOSITORY;
  const slackEnabled = Boolean(opts.slackWebhook ?? process.env.CLAUDIA_SLACK_WEBHOOK);
  const prCommentEnabled = !opts.disablePrComment;
  // Only look up the PR if at least one sink will use it. Avoids a `gh api`
  // call (and the test surface that goes with it) when the user has fully
  // opted out of PR-touching reporters.
  let prNumber: number | null = null;
  if (repo && ctx.headSha && (prCommentEnabled || slackEnabled)) {
    try {
      prNumber = findPullRequestForSha(repo, ctx.headSha);
    } catch (err) {
      warn("pr-lookup", err);
    }
  }
  const prUrl = repo && prNumber ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/pull/${prNumber}` : undefined;

  await Promise.allSettled([
    writeStepSummary(ctx, opts),
    backCommentOnMergedPr(ctx, opts, repo, prNumber),
    postToSlack(ctx, opts, prUrl),
    postCheckRun(ctx, opts, repo),
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

async function backCommentOnMergedPr(
  ctx: ReportContext,
  opts: ReporterOptions,
  repo: string | undefined,
  prNumber: number | null,
): Promise<void> {
  if (opts.disablePrComment) return;
  if (!repo || !prNumber) return;

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

async function postToSlack(ctx: ReportContext, opts: ReporterOptions, prUrl?: string): Promise<void> {
  const url = opts.slackWebhook ?? process.env.CLAUDIA_SLACK_WEBHOOK;
  if (!url) return;
  try {
    const payload = ctx.slack
      ? buildSlackPayload({
          ...ctx.slack,
          repo: ctx.repo ?? process.env.GITHUB_REPOSITORY,
          headSha: ctx.headSha,
          commitUrl: commitUrlFor(ctx.repo ?? process.env.GITHUB_REPOSITORY, ctx.headSha),
          runUrl: githubActionsRunUrl(),
          branch: process.env.GITHUB_REF_NAME || undefined,
          prUrl,
        })
      : { text: ctx.markdown };
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

// ---------- 4. GitHub check-run ----------

async function postCheckRun(
  ctx: ReportContext,
  opts: ReporterOptions,
  repo: string | undefined,
): Promise<void> {
  if (opts.disableCheck) return;
  if (!ctx.check) return; // sink only fires when caller supplied structured data
  if (!repo) return;
  if (!ctx.headSha) return;

  const out = buildCheckOutput({ ...ctx.check, markdown: ctx.markdown });
  try {
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `/repos/${repo}/check-runs`,
        "-H",
        "Accept: application/vnd.github+json",
        "-f",
        `name=${out.name}`,
        "-f",
        `head_sha=${ctx.headSha}`,
        "-f",
        "status=completed",
        "-f",
        `conclusion=${out.conclusion}`,
        "-f",
        `output[title]=${out.title}`,
        "-f",
        `output[summary]=${out.summary}`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // Most common failure: workflow lacks `checks: write` permission. Surface
    // clearly rather than silently swallow — the user's check just won't show
    // up otherwise and they'll have no way to know why.
    warn("check", err);
  }
}

function commitUrlFor(repo: string | undefined, sha: string): string | undefined {
  if (!repo || !sha) return undefined;
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  return `${server}/${repo}/commit/${sha}`;
}

function githubActionsRunUrl(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) return undefined;
  return `${server}/${repo}/actions/runs/${runId}`;
}

function warn(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`claudia: reporter[${label}] failed: ${msg}\n`);
}
