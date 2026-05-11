import * as core from "@actions/core";
import * as github from "@actions/github";
import { resolve } from "node:path";
import {
  decideGating,
  formatPlanJson as formatJson,
  formatPlanMarkdown as formatMarkdown,
  runPlan,
  type GatingMode,
  type RiskLevel,
} from "@pretorian-worx/runclaudia-core";

const STICKY_MARKER = "<!-- claudia:plan -->";
const CHECK_NAME = "claudia / plan";

function parseMode(raw: string): GatingMode {
  const v = (raw || "shadow").trim().toLowerCase();
  if (v === "shadow" || v === "advisory" || v === "gating") return v;
  throw new Error(`Invalid 'mode': ${raw}. Expected shadow | advisory | gating.`);
}

function parseRisk(raw: string): RiskLevel {
  const v = (raw || "high").trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`Invalid 'blocking-risk': ${raw}. Expected low | medium | high.`);
}

async function main(): Promise<void> {
  const apiKey = core.getInput("anthropic-api-key", { required: true });
  const githubToken = core.getInput("github-token");
  const base = core.getInput("base");
  const head = core.getInput("head");
  const targetUrl = core.getInput("target-url") || undefined;
  const model = core.getInput("model") || undefined;
  const cwd = resolve(core.getInput("cwd") || ".");
  const mode = parseMode(core.getInput("mode"));
  const blockingRisk = parseRisk(core.getInput("blocking-risk"));

  if (!base || !head) {
    core.setFailed("base and head must be set; this action runs on pull_request events");
    return;
  }

  const result = await runPlan({ rootDir: cwd, base, head, targetUrl, apiKey, model });

  const md = formatMarkdown(result);
  const json = formatJson(result);
  const gating = decideGating(result.plan, { mode, blockingRisk });

  core.setOutput("verdict", result.plan.verdict);
  core.setOutput("plan-json", json);
  core.setOutput("check-conclusion", gating.postCheck ? gating.conclusion : "");
  core.summary.addRaw(md).write();

  const ctx = github.context;
  if (!ctx.payload.pull_request || !githubToken) return;

  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = ctx.repo;
  const pr = ctx.payload.pull_request;
  const issue_number = pr.number;
  const headSha = (pr.head as { sha: string }).sha;

  // 1. Sticky comment (always, regardless of mode)
  const body = `${STICKY_MARKER}\n${md}`;
  const existing = await octokit.rest.issues.listComments({ owner, repo, issue_number, per_page: 100 });
  const prior = existing.data.find((c) => c.body?.includes(STICKY_MARKER));

  let commentId: number;
  if (prior) {
    const updated = await octokit.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body });
    commentId = updated.data.id;
  } else {
    const created = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    commentId = created.data.id;
  }

  // 2. Seed +1 / -1 reactions so reviewers can click them inline.
  await octokit.rest.reactions
    .createForIssueComment({ owner, repo, comment_id: commentId, content: "+1" })
    .catch(() => {});
  await octokit.rest.reactions
    .createForIssueComment({ owner, repo, comment_id: commentId, content: "-1" })
    .catch(() => {});

  // 3. Trust-gradient: post a check run in advisory or gating modes.
  if (gating.postCheck) {
    try {
      await octokit.rest.checks.create({
        owner,
        repo,
        name: CHECK_NAME,
        head_sha: headSha,
        status: "completed",
        conclusion: gating.conclusion,
        output: {
          title: gating.title,
          summary: gatingSummary(gating, md),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not create check run (mode=${mode}): ${msg}. Did the workflow grant 'checks: write'?`);
    }
  }
}

function gatingSummary(
  gating: ReturnType<typeof decideGating>,
  planMarkdown: string,
): string {
  if (gating.failingFlows.length === 0) return planMarkdown;
  const blockingList = gating.failingFlows
    .map((f) => `- **${f.name}** (${f.risk}) — ${f.reasoning}`)
    .join("\n");
  return `### Blocking flows\n${blockingList}\n\n---\n\n${planMarkdown}`;
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
