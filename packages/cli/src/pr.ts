import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AppMap,
  GeneratedSpec,
  GenerationResult,
} from "@pretorian-worx/runclaudia-core";

export interface OpenPrOptions {
  rootDir: string;
  /** Generation result. We only PR specs whose runOutcome.status === "passed". */
  generation: GenerationResult;
  /** Map of the indexed repo, used to pick the team's existing spec directory. */
  map: AppMap;
  /** SHA the deploy verified — used in branch name and PR body. */
  headSha: string;
  /** Override the target spec directory; otherwise inferred from map.specs. */
  targetDir?: string;
  /** Override the upstream branch name; otherwise `claudia/specs-<head7>`. */
  branchName?: string;
  /** Dry-run mode: prepare files + print the commands but don't push or open the PR. */
  dryRun?: boolean;
}

export interface PrResult {
  status: "no-passing-drafts" | "opened" | "dry-run" | "skipped";
  /** Files (relative to rootDir) that were moved into the team's spec dir. */
  movedFiles: string[];
  branchName?: string;
  prUrl?: string;
  /** Whatever stderr-worthy message we want to surface to the user. */
  notes: string[];
}

/**
 * Phase B.3: take the passing drafts from a generation run, move them into the
 * team's spec directory, push a branch, and open a draft PR.
 *
 * Intentionally conservative:
 *   - Only acts on drafts whose runOutcome.status === "passed".
 *   - Only moves files we wrote in this run (the GeneratedSpec.filePath entries).
 *   - Uses a deterministic branch name so re-runs on the same SHA update the
 *     same branch (force-with-lease, not force).
 *   - Stages ONLY the new spec files, not whatever else is dirty in the tree.
 */
export function openDraftPr(opts: OpenPrOptions): PrResult {
  const passing = opts.generation.generated.filter(
    (s) => s.runOutcome?.status === "passed",
  );
  if (passing.length === 0) {
    return {
      status: "no-passing-drafts",
      movedFiles: [],
      notes: ["No drafts passed against prod — nothing to PR."],
    };
  }

  const rootDir = resolve(opts.rootDir);
  const notes: string[] = [];
  const targetDir = opts.targetDir ?? detectSpecDir(opts.map);
  mkdirSync(join(rootDir, targetDir), { recursive: true });

  const branchName = opts.branchName ?? `claudia/specs-${opts.headSha.slice(0, 7)}`;
  const movedFiles: string[] = [];

  // Move passing drafts from .claudia/generated/ into the team's spec dir.
  // Files have already been syntax-checked by Playwright (they ran) so this is
  // just a copy + delete. Use rename for atomicity within the same filesystem.
  for (const spec of passing) {
    const filename = spec.filePath.split("/").pop()!;
    const targetRel = join(targetDir, filename);
    const targetAbs = join(rootDir, targetRel);
    renameSync(spec.filePath, targetAbs);
    movedFiles.push(targetRel);
  }

  if (opts.dryRun) {
    return {
      status: "dry-run",
      movedFiles,
      branchName,
      notes: [
        `Would create branch '${branchName}'`,
        `Would commit ${movedFiles.length} file(s) and push`,
        `Would open a draft PR via gh`,
      ],
    };
  }

  // Detect default branch for the PR base. Falls back to "main" if anything
  // about the remote lookup fails.
  let baseBranch = "main";
  try {
    const head = git(["remote", "show", "origin"], rootDir);
    const match = head.match(/HEAD branch: (\S+)/);
    if (match) baseBranch = match[1]!;
  } catch {
    notes.push("Could not detect default branch from origin; defaulting to 'main'.");
  }

  // Branch creation: prefer creating from origin/<base> so the PR diff is
  // strictly the new test files, not the whole deploy diff. If the local
  // branch already exists (re-run case), reset it to origin/<base> first.
  try {
    git(["fetch", "origin", baseBranch, "--quiet"], rootDir);
  } catch (err) {
    notes.push(`git fetch failed: ${msg(err)} — branch will be cut from local HEAD.`);
  }

  const branchExistsLocally = (() => {
    try {
      git(["rev-parse", "--verify", `refs/heads/${branchName}`], rootDir);
      return true;
    } catch {
      return false;
    }
  })();

  if (branchExistsLocally) {
    git(["checkout", "-B", branchName, `origin/${baseBranch}`], rootDir);
  } else {
    git(["checkout", "-b", branchName, `origin/${baseBranch}`], rootDir);
  }

  for (const rel of movedFiles) {
    git(["add", rel], rootDir);
  }

  const commitMsg = `test: claudia-generated specs for ${opts.headSha.slice(0, 7)}\n\n${movedFiles
    .map((f) => `- ${f}`)
    .join("\n")}\n\nGenerated specs all passed against the deployed production URL\nbefore this PR was opened.`;

  try {
    git(["commit", "--message", commitMsg], rootDir);
  } catch (err) {
    // Most common cause: the move left the tree identical to what's already on
    // origin/<base> (e.g. the workflow re-ran and the previous run already
    // landed). Surface clearly rather than crash.
    notes.push(`git commit failed: ${msg(err)}. Nothing new to commit — skipping.`);
    return { status: "skipped", movedFiles, branchName, notes };
  }

  try {
    git(["push", "--force-with-lease", "origin", branchName, "--quiet"], rootDir);
  } catch (err) {
    notes.push(`git push failed: ${msg(err)}`);
    return { status: "skipped", movedFiles, branchName, notes };
  }

  // Open or update the PR via gh. We make it a draft so the team always
  // reviews before merging — claudia is not authoritative on test quality.
  const body = buildPrBody(passing, opts.headSha, movedFiles);
  let prUrl: string | undefined;
  try {
    prUrl = ghCreateOrUpdatePr({
      rootDir,
      branchName,
      base: baseBranch,
      title: `test: claudia-generated specs for ${opts.headSha.slice(0, 7)}`,
      body,
    });
  } catch (err) {
    notes.push(`gh pr create/edit failed: ${msg(err)}`);
    return { status: "skipped", movedFiles, branchName, notes };
  }

  return { status: "opened", movedFiles, branchName, prUrl, notes };
}

export function detectSpecDir(map: AppMap): string {
  const counts = new Map<string, number>();
  for (const s of map.specs ?? []) {
    const dir = dirname(s.file);
    if (!dir || dir === ".") continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (counts.size === 0) return "e2e";
  // Highest count wins; tie-break by lexicographic order for determinism.
  const sorted = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return sorted[0]![0];
}

function buildPrBody(passing: GeneratedSpec[], headSha: string, movedFiles: string[]): string {
  const lines: string[] = [];
  lines.push(`Automated test coverage for the flows changed in \`${headSha.slice(0, 7)}\`. Every spec in this PR:`);
  lines.push("");
  lines.push("- was drafted by claudia from the team's existing spec style");
  lines.push("- was executed against the deployed production URL");
  lines.push("- **passed** before this PR was opened");
  lines.push("");
  lines.push("Treat this as a starting point: review, refactor to use your usual helpers if you prefer (claudia generates self-contained specs), and merge when happy.");
  lines.push("");
  lines.push("## Drafted specs");
  for (let i = 0; i < passing.length; i++) {
    const spec = passing[i]!;
    const movedTo = movedFiles[i]!;
    lines.push("");
    lines.push(`### \`${movedTo}\` — covers \`${spec.flow}\``);
    lines.push("");
    lines.push(spec.reasoning);
    if (spec.runOutcome?.status === "passed") {
      lines.push("");
      lines.push(`Run time: ${(spec.runOutcome.durationMs / 1000).toFixed(1)}s against prod.`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`<sub>Generated by [claudia](https://github.com/pretorian-worx/runclaudia). If a draft looks wrong, delete it — claudia will re-draft on the next deploy that touches the same uncovered route.</sub>`);
  return lines.join("\n");
}

function ghCreateOrUpdatePr(args: {
  rootDir: string;
  branchName: string;
  base: string;
  title: string;
  body: string;
}): string {
  const repo = detectRepo(args.rootDir);
  if (!repo) throw new Error("Could not detect GitHub repo from origin remote");

  // Check if a PR already exists for this branch (re-run case).
  let existingUrl = "";
  try {
    existingUrl = execGh(
      ["pr", "list", "-R", repo, "--head", args.branchName, "--state", "open", "--json", "url", "--jq", "[.[] | .url] | first"],
      args.rootDir,
    ).trim();
  } catch {
    // gh failures here are usually "no PRs found" rendered as empty — treat as none.
  }

  if (existingUrl && existingUrl !== "null") {
    // Update the body on the existing PR.
    const tmp = join(args.rootDir, ".claudia", "pr-body.tmp.md");
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, args.body, "utf8");
    try {
      execGh(["pr", "edit", existingUrl, "--body-file", tmp], args.rootDir);
    } finally {
      try { rmSync(tmp); } catch { /* best effort */ }
    }
    return existingUrl;
  }

  // Create a new draft PR.
  const tmp = join(args.rootDir, ".claudia", "pr-body.tmp.md");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, args.body, "utf8");
  try {
    const out = execGh(
      [
        "pr",
        "create",
        "-R",
        repo,
        "--draft",
        "--base",
        args.base,
        "--head",
        args.branchName,
        "--title",
        args.title,
        "--body-file",
        tmp,
      ],
      args.rootDir,
    );
    // gh prints the PR URL on its own line.
    const url = out.split("\n").map((s) => s.trim()).find((s) => s.startsWith("https://"));
    return url ?? out.trim();
  } finally {
    try { rmSync(tmp); } catch { /* best effort */ }
  }
}

function detectRepo(rootDir: string): string | null {
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function execGh(args: string[], cwd: string): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Local helper to read a file relative to rootDir (used in some tests). */
export function readGeneratedSpec(rootDir: string, rel: string): string {
  return readFileSync(join(rootDir, rel), "utf8");
}
