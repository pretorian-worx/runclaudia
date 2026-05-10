import { execFileSync } from "node:child_process";
import type { Diff, FileChange } from "./types.js";

export interface DiffOptions {
  base: string;
  head: string;
  cwd?: string;
}

export function readDiff(opts: DiffOptions): Diff {
  const { base, head, cwd } = opts;
  const range = `${base}..${head}`;

  const numstat = run(["git", "diff", "--numstat", "-z", range], cwd);
  const nameStatus = run(["git", "diff", "--name-status", "-z", range], cwd);
  const patch = run(["git", "diff", "--unified=3", range], cwd);

  const statusByPath = parseNameStatus(nameStatus);
  const numByPath = parseNumstat(numstat);
  const hunksByPath = parsePatch(patch);

  const paths = new Set<string>([
    ...Object.keys(statusByPath),
    ...Object.keys(numByPath),
    ...Object.keys(hunksByPath),
  ]);

  const files: FileChange[] = [];
  for (const path of paths) {
    const s = statusByPath[path];
    const n = numByPath[path];
    files.push({
      path,
      status: s?.status ?? "modified",
      oldPath: s?.oldPath,
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
      binary: n?.binary ?? false,
      hunks: hunksByPath[path] ?? [],
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base, head, files };
}

interface SkipDecision {
  skip: boolean;
  reason?: string;
}

const DOC_PATTERNS = [/\.md$/i, /\.mdx$/i, /^docs\//i, /^README/i, /^CHANGELOG/i, /^LICENSE/i];
const LOCK_PATTERNS = [
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^bun\.lockb?$/,
  /^Cargo\.lock$/,
  /^poetry\.lock$/,
  /^Pipfile\.lock$/,
];
const CI_PATTERNS = [/^\.github\//, /^\.circleci\//, /^\.gitlab-ci\.yml$/];
const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)cypress\//,
  /(^|\/)playwright\//,
];
const INFRA_PATTERNS = [
  /\.tf$/,
  /\.tfvars$/,
  /(^|\/)terraform\//,
  /(^|\/)infra\//,
  /(^|\/)deploy\//,
  /(^|\/)k8s\//,
  /(^|\/)helm\//,
  /^Dockerfile$/,
  /^docker-compose\.ya?ml$/,
];
const ASSET_PATTERNS = [
  /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(mp4|webm|mov|m4v)$/i,
  /^public\//,
];

const TRIVIAL_PATTERN_GROUPS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: "documentation", patterns: DOC_PATTERNS },
  { name: "lockfile", patterns: LOCK_PATTERNS },
  { name: "CI config", patterns: CI_PATTERNS },
  { name: "test", patterns: TEST_PATTERNS },
  { name: "infrastructure", patterns: INFRA_PATTERNS },
  { name: "asset", patterns: ASSET_PATTERNS },
];

export function classifySkip(diff: Diff): SkipDecision {
  if (diff.files.length === 0) {
    return { skip: true, reason: "No file changes between base and head." };
  }
  // Single-category short-circuits give a clearer reason string.
  for (const group of TRIVIAL_PATTERN_GROUPS) {
    if (diff.files.every((f) => matches(f.path, group.patterns))) {
      return { skip: true, reason: `Diff is ${group.name}-only.` };
    }
  }
  // Mixed-trivial — still no runtime risk.
  const allTrivial = diff.files.every((f) =>
    TRIVIAL_PATTERN_GROUPS.some((g) => matches(f.path, g.patterns)),
  );
  if (allTrivial) {
    return { skip: true, reason: "Diff contains only non-runtime changes (docs, lockfiles, CI, tests, infra, assets)." };
  }
  return { skip: false };
}

function matches(path: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(path));
}

function run(args: string[], cwd?: string): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNameStatus(out: string): Record<string, { status: FileChange["status"]; oldPath?: string }> {
  const result: Record<string, { status: FileChange["status"]; oldPath?: string }> = {};
  const tokens = out.split("\0").filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    i++;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i]!;
      const newPath = tokens[i + 1]!;
      i += 2;
      result[newPath] = { status: "renamed", oldPath };
    } else {
      const path = tokens[i]!;
      i++;
      const status: FileChange["status"] =
        letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      result[path] = { status };
    }
  }
  return result;
}

function parseNumstat(out: string): Record<string, { additions: number; deletions: number; binary: boolean }> {
  const result: Record<string, { additions: number; deletions: number; binary: boolean }> = {};
  const tokens = out.split("\0").filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const line = tokens[i]!;
    i++;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, maybePath] = parts;
    let path: string;
    if (maybePath === "") {
      const oldPath = tokens[i]!;
      const newPath = tokens[i + 1]!;
      i += 2;
      path = newPath;
      void oldPath;
    } else {
      path = maybePath!;
    }
    const binary = a === "-" || d === "-";
    result[path] = {
      additions: binary ? 0 : parseInt(a!, 10) || 0,
      deletions: binary ? 0 : parseInt(d!, 10) || 0,
      binary,
    };
  }
  return result;
}

function parsePatch(out: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const lines = out.split("\n");
  let currentPath: string | null = null;
  let currentHunk: string[] | null = null;

  const flush = () => {
    if (currentPath && currentHunk && currentHunk.length > 0) {
      (result[currentPath] ??= []).push(currentHunk.join("\n"));
    }
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentPath = m ? m[2]! : null;
    } else if (line.startsWith("@@")) {
      flush();
      currentHunk = [line];
    } else if (currentHunk) {
      currentHunk.push(line);
    }
  }
  flush();
  return result;
}
