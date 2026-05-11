import * as core from "@actions/core";
import * as github from "@actions/github";
import { resolve } from "node:path";
import { runPlan } from "@claudia/core";
import { formatJson, formatMarkdown } from "@claudia/cli/dist/format.js";

const STICKY_MARKER = "<!-- claudia:plan -->";

async function main(): Promise<void> {
  const apiKey = core.getInput("anthropic-api-key", { required: true });
  const githubToken = core.getInput("github-token");
  const base = core.getInput("base");
  const head = core.getInput("head");
  const targetUrl = core.getInput("target-url") || undefined;
  const model = core.getInput("model") || undefined;
  const cwd = resolve(core.getInput("cwd") || ".");

  if (!base || !head) {
    core.setFailed("base and head must be set; this action runs on pull_request events");
    return;
  }

  const result = await runPlan({ rootDir: cwd, base, head, targetUrl, apiKey, model });

  const md = formatMarkdown(result);
  const json = formatJson(result);

  core.setOutput("verdict", result.plan.verdict);
  core.setOutput("plan-json", json);
  core.summary.addRaw(md).write();

  const ctx = github.context;
  if (ctx.payload.pull_request && githubToken) {
    const octokit = github.getOctokit(githubToken);
    const body = `${STICKY_MARKER}\n${md}`;
    const { owner, repo } = ctx.repo;
    const issue_number = ctx.payload.pull_request.number;

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

    // Seed +1 / -1 reactions from the bot so users can click them inline rather
    // than digging through the reactions picker. Idempotent: GitHub silently
    // accepts repeated identical reactions from the same user.
    await octokit.rest.reactions
      .createForIssueComment({ owner, repo, comment_id: commentId, content: "+1" })
      .catch(() => {});
    await octokit.rest.reactions
      .createForIssueComment({ owner, repo, comment_id: commentId, content: "-1" })
      .catch(() => {});
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
