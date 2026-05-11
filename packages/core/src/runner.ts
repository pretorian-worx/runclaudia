import type { SelectionResult } from "./select.js";

export interface RunCommandOptions {
  selection: SelectionResult;
  /** Production URL to run the specs against. */
  target: string;
  /** Optional explicit Playwright config path (default: Playwright's own resolution). */
  playwrightConfig?: string;
  /**
   * Where Playwright should write its JSON reporter output. Defaults to a path
   * the CLI generates per-run.
   */
  jsonReportPath: string;
  /** Extra env vars to forward to the child process (merged on top of inherited env). */
  extraEnv?: Record<string, string>;
}

export interface PlaywrightCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the `npx playwright test` invocation that runs the selected specs
 * against the target URL. Returns null if there is nothing to run (no covering
 * specs of any kind in the selection).
 */
export function buildPlaywrightCommand(opts: RunCommandOptions): PlaywrightCommand | null {
  const playwrightSpecs = opts.selection.selected.filter((s) => s.framework === "playwright");
  if (playwrightSpecs.length === 0) return null;

  const args: string[] = ["-y", "playwright", "test"];

  // Anchor the run to the selected spec files. Even with --grep, narrowing to
  // the specific files is faster (Playwright skips loading other test files).
  for (const s of playwrightSpecs) args.push(s.file);

  if (opts.selection.playwrightGrep) {
    args.push("--grep", opts.selection.playwrightGrep);
  }

  if (opts.playwrightConfig) {
    args.push("--config", opts.playwrightConfig);
  }

  args.push("--reporter=line,json");

  const env: Record<string, string> = {
    PLAYWRIGHT_BASE_URL: opts.target,
    PLAYWRIGHT_JSON_OUTPUT_FILE: opts.jsonReportPath,
    PLAYWRIGHT_JSON_OUTPUT_NAME: opts.jsonReportPath,
    ...(opts.extraEnv ?? {}),
  };

  return { command: "npx", args, env };
}

// ---------- Result parsing ----------

export interface FailedTest {
  file: string;
  title: string;
  error: string;
}

export interface PlaywrightReport {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  totalTests: number;
  failedTests: FailedTest[];
}

interface RawSpec {
  title?: string;
  file?: string;
  tests?: RawTest[];
}

interface RawTest {
  results?: RawResult[];
}

interface RawResult {
  status?: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
  error?: { message?: string; stack?: string };
}

interface RawSuite {
  file?: string;
  title?: string;
  specs?: RawSpec[];
  suites?: RawSuite[];
}

interface RawReport {
  stats?: {
    duration?: number;
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
  suites?: RawSuite[];
}

/**
 * Parse Playwright's JSON reporter output into a flat report. Handles the
 * recursive suite/spec/test structure and unwraps the (often-deeply-nested)
 * failed-test details we want to surface.
 */
export function parsePlaywrightReport(raw: unknown): PlaywrightReport {
  const r = (raw ?? {}) as RawReport;
  const stats = r.stats ?? {};

  const failedTests: FailedTest[] = [];
  walkSuites(r.suites ?? [], "", failedTests);

  const passed = stats.expected ?? 0;
  const failed = stats.unexpected ?? failedTests.length;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;

  return {
    passed,
    failed,
    flaky,
    skipped,
    durationMs: stats.duration ?? 0,
    totalTests: passed + failed + flaky + skipped,
    failedTests,
  };
}

function walkSuites(suites: RawSuite[], fileFromParent: string, failed: FailedTest[]): void {
  for (const suite of suites) {
    const file = suite.file ?? fileFromParent;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? file;
      const title = spec.title ?? "(untitled)";
      const tests = spec.tests ?? [];
      const hasFailure = tests.some((t) =>
        (t.results ?? []).some((res) => res.status === "failed" || res.status === "timedOut"),
      );
      if (!hasFailure) continue;
      const errMsg = tests
        .flatMap((t) => t.results ?? [])
        .map((res) => res.error?.message)
        .filter((m): m is string => Boolean(m))
        .join("\n---\n");
      failed.push({ file: specFile, title, error: errMsg || "(no error message captured)" });
    }
    if (suite.suites && suite.suites.length > 0) {
      walkSuites(suite.suites, file, failed);
    }
  }
}

export function formatRunMarkdown(args: {
  selection: SelectionResult;
  report: PlaywrightReport | null;
  target: string;
  /** True if we short-circuited because nothing was selected. */
  nothingToRun: boolean;
}): string {
  const lines: string[] = [];
  lines.push("## claudia — post-deploy verification");
  lines.push("");
  lines.push(`Target: \`${args.target}\``);

  if (args.nothingToRun) {
    lines.push("");
    if (args.selection.selectedTestCount === 0 && args.selection.uncoveredRoutes.length === 0 && args.selection.uncoveredEndpoints.length === 0) {
      lines.push("**Nothing to verify.** No covering specs and no coverage gaps for this diff.");
    } else if (args.selection.selectedTestCount === 0) {
      lines.push("**No covering Playwright specs.** Coverage gaps detected — see `claudia select` for details.");
    } else {
      lines.push("**Cypress-only selection.** Run `claudia select --files-only | xargs cypress run --spec` separately.");
    }
    return lines.join("\n");
  }

  if (!args.report) {
    lines.push("");
    lines.push("**Run did not complete.** Check the workflow logs for the underlying Playwright error.");
    return lines.join("\n");
  }

  const r = args.report;
  const verdict = r.failed === 0 ? "✅ Pass" : "❌ Fail";
  lines.push("");
  lines.push(`**${verdict}** — ${r.passed}/${r.totalTests} passed${r.flaky > 0 ? `, ${r.flaky} flaky` : ""}${r.skipped > 0 ? `, ${r.skipped} skipped` : ""}.  ⏱ ${(r.durationMs / 1000).toFixed(1)}s`);

  if (r.failed > 0) {
    lines.push("");
    lines.push("### Failures");
    for (const t of r.failedTests) {
      lines.push("");
      lines.push(`**${t.file}** — \`${t.title}\``);
      lines.push("```");
      lines.push(truncate(t.error, 2000));
      lines.push("```");
    }
  }

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [${s.length - n} chars truncated]` : s;
}
