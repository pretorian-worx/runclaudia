import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { readDiff } from "./diff.js";
import { loadOrBuildMap } from "./map.js";
import { filterMapForDiff } from "./prompt.js";
import {
  scoreSpecRelevance,
  type RelevanceResult,
  type RelevanceUsage,
  type SpecForScoring,
} from "./relevance.js";
import type { AppMap, SpecEntry } from "./types.js";

export interface SelectOptions {
  rootDir: string;
  base: string;
  head: string;
  refreshMap?: boolean;
  /**
   * Glob patterns (minimatch-style) for spec files to exclude from selection.
   * Excluded specs are never picked regardless of route coverage they declare.
   *
   * Semantics: excluded specs still count as coverage when computing
   * uncoveredRoutes / uncoveredEndpoints — if you exclude a smoke test that
   * covers /workspaces, claudia won't surface /workspaces as a gap. You're
   * saying "I have coverage but don't want to run this spec here," not
   * "this spec doesn't exist."
   */
  excludeSpecs?: string[];
}

export interface SpecSelectionReason {
  /** The implicated route or endpoint (with method prefix) that pulled this spec in. */
  flow: string;
  /** Whether `flow` is a UI route or an API endpoint. */
  kind: "route" | "endpoint";
  /** Diff files responsible for putting `flow` in scope (the join we previously discarded). */
  via: string[];
}

export interface SelectedSpec {
  framework: SpecEntry["framework"];
  file: string;
  /** Test names from this file that cover the diff. */
  tests: string[];
  /** Whether the file has a beforeAll / before() hook — selecting any test forces the whole file. */
  hasSharedSetup: boolean;
  /**
   * Why this spec was selected: each implicated route/endpoint the spec
   * covers, plus the diff files that made that route/endpoint implicated.
   * Empty array means "selected by inclusion in coveringSpecs" with no
   * traceable reason (shouldn't happen for healthy maps).
   */
  reasons: SpecSelectionReason[];
  /**
   * Optional LLM-assigned relevance score (advisory only — does NOT affect
   * what gets executed). Populated by `attachRelevance` after a separate
   * Anthropic call. Absent when relevance scoring is disabled.
   */
  relevance?: "high" | "medium" | "low";
  /** One-sentence rationale from the relevance scorer. */
  relevanceRationale?: string;
}

export interface SelectionResult {
  totalSpecs: number;
  selected: SelectedSpec[];
  selectedTestCount: number;
  uncoveredRoutes: string[];
  uncoveredEndpoints: string[];
  /** Playwright --grep value: alternation of all selected test names, regex-escaped. */
  playwrightGrep: string | null;
  /** Cypress --spec pattern: comma-joined list of spec files. */
  cypressSpecs: string;
  /** Files in the diff (paths only), surfaced so downstream formatters can give the user diff context. */
  diffFiles: string[];
  /** Spec files filtered out via excludeSpecs patterns, for transparency. */
  excludedSpecFiles: string[];
}

export function runSelect(opts: SelectOptions): SelectionResult {
  const diff = readDiff({ base: opts.base, head: opts.head, cwd: opts.rootDir });
  const map = loadOrBuildMap({ rootDir: opts.rootDir, refresh: opts.refreshMap });
  const filtered = filterMapForDiff(map, diff);

  // Apply excludeSpecs filter BEFORE collapsing per-file. uncoveredRoutes /
  // uncoveredEndpoints come from filtered (pre-exclusion), so excluded specs
  // still count as coverage — see SelectOptions.excludeSpecs JSDoc.
  const patterns = opts.excludeSpecs ?? [];
  const isExcluded = (file: string) => patterns.some((p) => minimatch(file, p, { dot: true, matchBase: false }));

  const excludedSpecFilesSet = new Set<string>();
  const visibleSpecs = filtered.coveringSpecs.filter((s) => {
    if (!isExcluded(s.file)) return true;
    excludedSpecFilesSet.add(s.file);
    return false;
  });

  // Group selected SpecEntry rows by file. Each entry in `coveringSpecs` is per-test;
  // multiple tests in the same file share the file's metadata, so we collapse.
  const byFile = new Map<string, SelectedSpec>();
  for (const s of visibleSpecs) {
    let entry = byFile.get(s.file);
    if (!entry) {
      entry = {
        framework: s.framework,
        file: s.file,
        tests: [],
        hasSharedSetup: s.hasSharedSetup,
        reasons: [],
      };
      byFile.set(s.file, entry);
    }
    entry.tests.push(s.name);
  }

  // Plumb per-spec selection rationale: join each spec's covered routes/
  // endpoints against the reason maps from filterMapForDiff. Surfaces the
  // "implicated by file X" trace the user needs to debug over-selection.
  const implicatedRouteSet = new Set(Object.keys(filtered.routeReasons));
  const implicatedEndpointSet = new Set(Object.keys(filtered.endpointReasons));
  for (const [file, entry] of byFile) {
    const sourceSpec = visibleSpecs.find((s) => s.file === file)!;
    const reasons: SpecSelectionReason[] = [];
    for (const route of sourceSpec.routesCovered) {
      if (!implicatedRouteSet.has(route)) continue;
      reasons.push({ flow: route, kind: "route", via: filtered.routeReasons[route]! });
    }
    for (const ep of sourceSpec.endpointsCovered) {
      if (!implicatedEndpointSet.has(ep)) continue;
      reasons.push({ flow: ep, kind: "endpoint", via: filtered.endpointReasons[ep]! });
    }
    entry.reasons = reasons;
  }

  const selected = Array.from(byFile.values()).map((s) => ({
    ...s,
    tests: Array.from(new Set(s.tests)).sort(),
  }));
  selected.sort((a, b) => a.file.localeCompare(b.file));

  // For shared-setup files the whole describe block runs anyway, so don't bother
  // emitting a grep — let the runner pick up everything in those files. We
  // include them in `selected` so the user can see what got pulled in. The
  // grep is specifically for `playwright test --grep`; Cypress is handled via
  // `cypressSpecs` below.
  const grepEligible = selected.flatMap((s) =>
    s.framework === "playwright" && !s.hasSharedSetup ? s.tests : [],
  );
  const playwrightGrep = grepEligible.length === 0 ? null : grepEligible.map(escapeForRegex).join("|");

  const cypressSpecs = selected
    .filter((s) => s.framework === "cypress")
    .map((s) => s.file)
    .join(",");

  return {
    totalSpecs: (map.specs ?? []).length,
    selected,
    selectedTestCount: selected.reduce((n, s) => n + s.tests.length, 0),
    uncoveredRoutes: filtered.uncoveredRoutes,
    uncoveredEndpoints: filtered.uncoveredEndpoints,
    playwrightGrep,
    cypressSpecs,
    diffFiles: diff.files.map((f) => f.path),
    excludedSpecFiles: Array.from(excludedSpecFilesSet).sort(),
  };
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Short human-readable diff size, e.g. "3 files changed" or "1 file changed (path/to/x.ts)". */
export function describeDiff(files: string[]): string {
  if (files.length === 0) return "no files changed";
  if (files.length === 1) return `1 file changed (\`${files[0]}\`)`;
  return `${files.length} files changed`;
}

/**
 * Render a small "what was in the diff" hint so users on no-op verdicts can
 * see at a glance that claudia actually inspected something. Shows up to 5
 * paths and trails with "...and N more" for longer diffs.
 */
export function diffSampleBlock(files: string[], limit = 5): string {
  if (files.length === 0) return "_(no files in diff)_";
  if (files.length === 1) return `Changed: \`${files[0]}\``;
  const head = files.slice(0, limit).map((f) => `- \`${f}\``);
  const tail = files.length > limit ? `\n_…and ${files.length - limit} more_` : "";
  return `Changed:\n${head.join("\n")}${tail}`;
}

export function formatSelectionMarkdown(r: SelectionResult, args: { base: string; head: string }): string {
  const lines: string[] = [];
  lines.push("## claudia — spec selection");
  lines.push("");
  const excludeNote = r.excludedSpecFiles.length > 0 ? ` · ${r.excludedSpecFiles.length} spec file(s) excluded` : "";
  lines.push(
    `Diff: \`${args.base}..${args.head}\` — ${describeDiff(r.diffFiles)} · ${r.totalSpecs} specs indexed · ${r.selectedTestCount} selected${excludeNote}.`,
  );
  lines.push("");

  if (r.selected.length === 0) {
    if (r.uncoveredRoutes.length > 0 || r.uncoveredEndpoints.length > 0) {
      lines.push("**⚠️ Coverage gaps** — the diff implicates flows that no existing spec covers.");
      lines.push("");
      lines.push("### Uncovered flows");
      for (const x of r.uncoveredRoutes) lines.push(`- ${x}`);
      for (const x of r.uncoveredEndpoints) lines.push(`- ${x}`);
    } else {
      lines.push("**✅ Clean diff** — nothing in the map was touched, no specs needed.");
      lines.push("");
      lines.push(diffSampleBlock(r.diffFiles));
    }
    return lines.join("\n");
  }

  lines.push("### Selected specs");
  for (const s of r.selected) {
    const setup = s.hasSharedSetup ? " · [shared setup — whole file runs]" : "";
    const badge = s.relevance ? ` · _relevance: **${s.relevance}**_` : "";
    lines.push(`- **${s.file}** (${s.framework})${setup}${badge}`);
    for (const t of s.tests) lines.push(`  - \`${t}\``);
    if (s.relevance && s.relevanceRationale) {
      lines.push(`  - ${s.relevanceRationale}`);
    }
    const reasons = s.reasons ?? [];
    if (reasons.length > 0) {
      lines.push(`  - _Selected because:_`);
      for (const reason of reasons) {
        const via = reason.via.length === 1 ? reason.via[0] : `${reason.via.length} files: ${reason.via.slice(0, 3).join(", ")}${reason.via.length > 3 ? ", …" : ""}`;
        lines.push(`    - covers \`${reason.flow}\` — implicated by \`${via}\``);
      }
    }
  }

  if (r.uncoveredRoutes.length > 0 || r.uncoveredEndpoints.length > 0) {
    lines.push("");
    lines.push("### Coverage gaps");
    lines.push("Implicated by this diff, no covering spec — candidates for new tests:");
    for (const x of r.uncoveredRoutes) lines.push(`- ${x}`);
    for (const x of r.uncoveredEndpoints) lines.push(`- ${x}`);
  }

  lines.push("");
  lines.push("### How to run");
  if (r.playwrightGrep) {
    lines.push("```bash");
    lines.push(`npx playwright test --grep "${r.playwrightGrep}"`);
    lines.push("```");
  }
  if (r.cypressSpecs) {
    lines.push("```bash");
    lines.push(`npx cypress run --spec "${r.cypressSpecs}"`);
    lines.push("```");
  }
  if (!r.playwrightGrep && !r.cypressSpecs) {
    lines.push("_All selected specs have shared setup; run the listed files directly._");
  }
  return lines.join("\n");
}

/**
 * Attach LLM-driven relevance scores to a SelectionResult, in place.
 *
 * Advisory only — never affects `selected`, `playwrightGrep`, or `cypressSpecs`.
 * Reads each selected spec's source from disk to send to the scorer; on any
 * failure (missing file, model error, schema mismatch) the relevant field
 * stays undefined and the run continues. This is a soft enhancement, not a
 * gate.
 *
 * Returns the usage stats so callers can surface token spend.
 */
export async function attachRelevance(opts: {
  rootDir: string;
  selection: SelectionResult;
  map: AppMap;
  base: string;
  head: string;
  apiKey?: string;
  model?: string;
}): Promise<RelevanceUsage> {
  if (opts.selection.selected.length === 0) {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  // Build the scorer input. Join the per-file selection with the indexed
  // spec entries to recover routesCovered / endpointsCovered.
  const allSpecs = opts.map.specs ?? [];
  const byFile = new Map<string, { routes: Set<string>; endpoints: Set<string> }>();
  for (const e of allSpecs) {
    let entry = byFile.get(e.file);
    if (!entry) {
      entry = { routes: new Set(), endpoints: new Set() };
      byFile.set(e.file, entry);
    }
    e.routesCovered.forEach((r) => entry!.routes.add(r));
    e.endpointsCovered.forEach((r) => entry!.endpoints.add(r));
  }

  const specsForScoring: SpecForScoring[] = [];
  for (const s of opts.selection.selected) {
    let source = "";
    try {
      source = readFileSync(join(opts.rootDir, s.file), "utf8");
    } catch {
      // Spec moved/deleted since the map was built. Skip — scorer can't help.
      continue;
    }
    const coverage = byFile.get(s.file);
    specsForScoring.push({
      file: s.file,
      source,
      routesCovered: coverage ? Array.from(coverage.routes).sort() : [],
      endpointsCovered: coverage ? Array.from(coverage.endpoints).sort() : [],
    });
  }
  if (specsForScoring.length === 0) {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  const diff = readDiff({ base: opts.base, head: opts.head, cwd: opts.rootDir });

  let result: RelevanceResult;
  try {
    result = await scoreSpecRelevance({
      specs: specsForScoring,
      diff,
      apiKey: opts.apiKey,
      model: opts.model,
    });
  } catch (err) {
    // Advisory only — never block a run on scorer failure. Surface to stderr
    // so the user can see what happened, but keep going.
    process.stderr.write(
      `claudia: relevance scorer failed (${err instanceof Error ? err.message : String(err)}); continuing without scores\n`,
    );
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  const scoreByFile = new Map(result.scores.map((s) => [s.file, s]));
  for (const sel of opts.selection.selected) {
    const score = scoreByFile.get(sel.file);
    if (!score) continue;
    sel.relevance = score.relevance;
    sel.relevanceRationale = score.rationale;
  }
  return result.usage;
}
