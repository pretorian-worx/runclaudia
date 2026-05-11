import { execFileSync } from "node:child_process";

const MARKER = "<!-- claudia:plan -->";

export interface PRRating {
  prNumber: number;
  url: string;
  thumbsUp: number;
  thumbsDown: number;
  verdict: "useful" | "not_useful" | "no_signal";
}

export interface RatingsSummary {
  repo: string;
  total: number;
  useful: number;
  notUseful: number;
  noSignal: number;
  usefulPercent: number | null;
  perPR: PRRating[];
}

export interface RatingsOptions {
  repo: string;
  limit?: number;
  state?: "open" | "closed" | "all";
}

interface Reaction {
  content: string;
  user: { login: string } | null;
}

interface CommentSummary {
  id: number;
  body?: string | null;
}

interface PullRequestSummary {
  number: number;
  url: string;
}

/**
 * Aggregates 👍 / 👎 reactions on claudia's sticky comments across a repo's
 * pull requests. Only +1 and -1 from non-bot users count; everything else
 * (laugh, hooray, confused, heart, rocket, eyes, or reactions from the
 * github-actions bot itself) is ignored.
 */
export function aggregateRatings(opts: RatingsOptions): RatingsSummary {
  const limit = opts.limit ?? 100;
  const state = opts.state ?? "all";

  const prs = ghJson<PullRequestSummary[]>(["pr", "list", "-R", opts.repo, "--state", state, "--limit", String(limit), "--json", "number,url"]);

  const perPR: PRRating[] = [];
  for (const pr of prs) {
    const comments = ghJson<CommentSummary[]>([
      "api",
      `repos/${opts.repo}/issues/${pr.number}/comments`,
      "--paginate",
      "--jq",
      "[.[] | {id, body}]",
    ]);
    const claudiaComment = comments.find((c) => c.body?.includes(MARKER));
    if (!claudiaComment) continue;

    const reactions = ghJson<Reaction[]>([
      "api",
      `repos/${opts.repo}/issues/comments/${claudiaComment.id}/reactions`,
      "--paginate",
      "--jq",
      "[.[] | {content, user: {login: .user.login}}]",
    ]);

    const thumbsUp = countReactions(reactions, "+1");
    const thumbsDown = countReactions(reactions, "-1");
    const verdict: PRRating["verdict"] =
      thumbsUp + thumbsDown === 0
        ? "no_signal"
        : thumbsUp > thumbsDown
          ? "useful"
          : "not_useful";

    perPR.push({ prNumber: pr.number, url: pr.url, thumbsUp, thumbsDown, verdict });
  }

  const useful = perPR.filter((p) => p.verdict === "useful").length;
  const notUseful = perPR.filter((p) => p.verdict === "not_useful").length;
  const noSignal = perPR.filter((p) => p.verdict === "no_signal").length;
  const ratedTotal = useful + notUseful;

  return {
    repo: opts.repo,
    total: perPR.length,
    useful,
    notUseful,
    noSignal,
    usefulPercent: ratedTotal === 0 ? null : (useful / ratedTotal) * 100,
    perPR,
  };
}

function countReactions(reactions: Reaction[], wanted: string): number {
  // Ignore the github-actions bot's own seeded reactions; we want real user signal.
  return reactions.filter(
    (r) => r.content === wanted && r.user?.login && r.user.login !== "github-actions[bot]",
  ).length;
}

function ghJson<T>(args: string[]): T {
  try {
    const raw = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh ${args.join(" ")}: ${msg}`);
  }
}

export function formatRatings(s: RatingsSummary): string {
  const lines: string[] = [];
  lines.push(`# claudia ratings — ${s.repo}`);
  lines.push("");
  if (s.total === 0) {
    lines.push("No claudia comments found in this repo.");
    return lines.join("\n");
  }
  lines.push(`PRs with a claudia comment: **${s.total}**`);
  lines.push(`- 👍 useful: ${s.useful}`);
  lines.push(`- 👎 not useful: ${s.notUseful}`);
  lines.push(`- ⚪ no signal: ${s.noSignal}`);
  if (s.usefulPercent !== null) {
    lines.push("");
    lines.push(`**Useful%: ${s.usefulPercent.toFixed(1)}%** (of ${s.useful + s.notUseful} rated PRs)`);
  } else {
    lines.push("");
    lines.push("No 👍/👎 reactions yet — no useful% to report.");
  }
  return lines.join("\n");
}
