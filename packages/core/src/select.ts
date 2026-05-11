import { readDiff } from "./diff.js";
import { loadOrBuildMap } from "./map.js";
import { filterMapForDiff } from "./prompt.js";
import type { SpecEntry } from "./types.js";

export interface SelectOptions {
  rootDir: string;
  base: string;
  head: string;
  refreshMap?: boolean;
}

export interface SelectedSpec {
  framework: SpecEntry["framework"];
  file: string;
  /** Test names from this file that cover the diff. */
  tests: string[];
  /** Whether the file has a beforeAll / before() hook — selecting any test forces the whole file. */
  hasSharedSetup: boolean;
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
}

export function runSelect(opts: SelectOptions): SelectionResult {
  const diff = readDiff({ base: opts.base, head: opts.head, cwd: opts.rootDir });
  const map = loadOrBuildMap({ rootDir: opts.rootDir, refresh: opts.refreshMap });
  const filtered = filterMapForDiff(map, diff);

  // Group selected SpecEntry rows by file. Each entry in `coveringSpecs` is per-test;
  // multiple tests in the same file share the file's metadata, so we collapse.
  const byFile = new Map<string, SelectedSpec>();
  for (const s of filtered.coveringSpecs) {
    let entry = byFile.get(s.file);
    if (!entry) {
      entry = {
        framework: s.framework,
        file: s.file,
        tests: [],
        hasSharedSetup: s.hasSharedSetup,
      };
      byFile.set(s.file, entry);
    }
    entry.tests.push(s.name);
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
  };
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatSelectionMarkdown(r: SelectionResult, args: { base: string; head: string }): string {
  const lines: string[] = [];
  lines.push("## claudia — spec selection");
  lines.push("");
  lines.push(`Diff: \`${args.base}..${args.head}\` · ${r.totalSpecs} specs indexed · ${r.selectedTestCount} selected.`);
  lines.push("");

  if (r.selected.length === 0) {
    lines.push("**No covering specs.** ");
    if (r.uncoveredRoutes.length > 0 || r.uncoveredEndpoints.length > 0) {
      lines.push("Coverage gaps detected — the diff implicates flows that no existing spec covers.");
      lines.push("");
      lines.push("### Uncovered flows");
      for (const x of r.uncoveredRoutes) lines.push(`- ${x}`);
      for (const x of r.uncoveredEndpoints) lines.push(`- ${x}`);
    } else {
      lines.push("Nothing to verify against prod.");
    }
    return lines.join("\n");
  }

  lines.push("### Selected specs");
  for (const s of r.selected) {
    const setup = s.hasSharedSetup ? " · [shared setup — whole file runs]" : "";
    lines.push(`- **${s.file}** (${s.framework})${setup}`);
    for (const t of s.tests) lines.push(`  - \`${t}\``);
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
