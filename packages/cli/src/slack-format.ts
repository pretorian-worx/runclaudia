/**
 * Slack Block Kit payload builder for the post-deploy verification report.
 *
 * Pure function: takes structured run data, returns a payload object suitable
 * for POSTing to an incoming-webhook URL. The `text` field is a plain-text
 * fallback used by Slack for notifications and clients that don't render
 * blocks; `blocks` is the structured rendering.
 *
 * Targeted at the "deploy-verified" Slack message from ROADMAP.md §Mission
 * Complete — verdict header, repo/target context line, counts, failure
 * snippets, and links back to the workflow run + PR.
 */

export interface SlackFailedTest {
  file: string;
  title: string;
  error: string;
}

export interface SlackPayloadInput {
  passed: boolean;
  repo?: string;
  target?: string;
  headSha?: string;
  branch?: string;
  selectedSpecCount?: number;
  selectedTestCount?: number;
  generatedSpecCount?: number;
  passedCount: number;
  failedCount: number;
  skippedCount?: number;
  flakyCount?: number;
  durationMs?: number;
  failedTests?: SlackFailedTest[];
  runUrl?: string;
  prUrl?: string;
  commitUrl?: string;
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

const MAX_FAILURE_BLOCKS = 3;
const MAX_ERROR_CHARS = 240;

export function buildSlackPayload(input: SlackPayloadInput): SlackPayload {
  const emoji = input.passed ? ":white_check_mark:" : ":x:";
  const verdictWord = input.passed ? "deploy-verified" : "deploy-failed";
  const title = `${emoji} claudia: ${verdictWord}`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    },
  ];

  const contextParts = buildContextParts(input);
  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("  ·  ") }],
    });
  }

  blocks.push({
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text: `*Flows tested*\n${formatFlowsTested(input)}`,
      },
      {
        type: "mrkdwn",
        text: `*Result*\n${formatResultLine(input)}`,
      },
    ],
  });

  const failureBlocks = buildFailureBlocks(input.failedTests);
  if (failureBlocks.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push(...failureBlocks);
  }

  const actions = buildActionElements(input);
  if (actions.length > 0) {
    blocks.push({ type: "actions", elements: actions });
  }

  return {
    text: buildFallbackText(input, title),
    blocks,
  };
}

function buildContextParts(input: SlackPayloadInput): string[] {
  const parts: string[] = [];
  if (input.repo) parts.push(`*${input.repo}*`);
  if (input.target) parts.push(`<${input.target}|${stripScheme(input.target)}>`);
  if (input.headSha) {
    const short = input.headSha.slice(0, 7);
    parts.push(input.commitUrl ? `<${input.commitUrl}|\`${short}\`>` : `\`${short}\``);
  }
  if (input.branch) parts.push(`branch \`${input.branch}\``);
  return parts;
}

function formatFlowsTested(input: SlackPayloadInput): string {
  const totalRun = input.passedCount + input.failedCount;
  const detail: string[] = [];
  if (input.selectedSpecCount !== undefined && input.selectedSpecCount > 0) {
    const tests = input.selectedTestCount ?? 0;
    detail.push(`${input.selectedSpecCount} spec${pl(input.selectedSpecCount)} from suite${tests ? ` (${tests} test${pl(tests)})` : ""}`);
  }
  if (input.generatedSpecCount !== undefined && input.generatedSpecCount > 0) {
    detail.push(`${input.generatedSpecCount} generated`);
  }
  const detailStr = detail.length > 0 ? ` — ${detail.join(", ")}` : "";
  return `${totalRun}${detailStr}`;
}

function formatResultLine(input: SlackPayloadInput): string {
  const parts: string[] = [];
  parts.push(`${input.passedCount} passed`);
  parts.push(`${input.failedCount} failed`);
  if (input.flakyCount) parts.push(`${input.flakyCount} flaky`);
  if (input.skippedCount) parts.push(`${input.skippedCount} skipped`);
  if (input.durationMs && input.durationMs > 0) {
    parts.push(`${(input.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(" · ");
}

function buildFailureBlocks(failed: SlackFailedTest[] | undefined): SlackBlock[] {
  if (!failed || failed.length === 0) return [];
  const shown = failed.slice(0, MAX_FAILURE_BLOCKS);
  const remaining = failed.length - shown.length;

  const blocks: SlackBlock[] = shown.map((f) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${escapeMrkdwn(f.title)}*\n\`${escapeMrkdwn(f.file)}\`\n\`\`\`${truncate(f.error, MAX_ERROR_CHARS)}\`\`\``,
    },
  }));

  if (remaining > 0) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `…and ${remaining} more failure${pl(remaining)} — see the workflow run for the full report.` },
      ],
    });
  }
  return blocks;
}

function buildActionElements(input: SlackPayloadInput): SlackBlock[] {
  const out: SlackBlock[] = [];
  if (input.runUrl) {
    out.push({
      type: "button",
      text: { type: "plain_text", text: "View run", emoji: false },
      url: input.runUrl,
    });
  }
  if (input.prUrl) {
    out.push({
      type: "button",
      text: { type: "plain_text", text: "View PR", emoji: false },
      url: input.prUrl,
    });
  }
  return out;
}

function buildFallbackText(input: SlackPayloadInput, title: string): string {
  const counts = `${input.passedCount} passed, ${input.failedCount} failed`;
  const where = input.repo ? ` — ${input.repo}` : "";
  return `${title}${where}: ${counts}`;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function pl(n: number): string {
  return n === 1 ? "" : "s";
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/```/g, "ʼʼʼ").trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, n - 1) + "…";
}

function escapeMrkdwn(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c));
}
