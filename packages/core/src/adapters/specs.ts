import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SpecEntry } from "../types.js";

export interface SpecDiscoveryOptions {
  rootDir: string;
  maxDepth?: number;
}

// Conventional E2E/integration locations. We intentionally don't index unit
// tests (e.g. *.test.ts next to source files) — they don't carry route or
// endpoint coverage information that's useful here.
const SPEC_DIRS = [
  "e2e",
  "tests/e2e",
  "test/e2e",
  "playwright",
  "playwright/tests",
  "cypress/e2e",
  "cypress/integration",
];

const SPEC_FILE_RE = /\.(?:spec|test|cy)\.(?:[jt]sx?)$/i;

const TEST_BLOCK_RE = /\b(?:test|it)(?:\.\w+)?\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
const PAGE_GOTO_RE = /\bpage\s*\.\s*goto\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
const PAGE_REQUEST_RE = /\bpage\s*\.\s*request\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;
const CY_VISIT_RE = /\bcy\s*\.\s*visit\s*\(\s*['"`]([^'"`\n]+)['"`]/g;

// Navigation helper pattern: `appNav(page, "/path")`, `goto(page, "/path")`,
// `visit(page, `/workspaces/${ws}/docs`)`, etc. Captures the path literal
// from any function call where (a) the function name contains a nav-related
// substring (nav, goto, visit, route, open) and (b) `page` is the first
// argument and a path-like string is the second.
//
// Why this is needed: many teams wrap `page.goto(path, options)` in a helper
// (waits for app shell, applies deployment-protection bypass cookies, etc).
// Without this pattern, claudia sees those specs as having zero route
// coverage and misses them during selection.
//
// Why the name constraint: without it, helpers like `assertText(page, "/x")`
// or `screenshot(page, "/y")` would falsely contribute to routesCovered.
// Constraining to navigation-shaped names removes that noise. Teams using
// unconventional helper names (rare) can fall back to `// @claudia route:
// /path` annotations as an explicit override.
const NAV_HELPER_RE = /\b[A-Za-z_$][\w$]*?(?:nav|goto|visit|route|open|navigate)[\w$]*\s*\(\s*page\s*,\s*['"`]([^'"`\n]+)['"`]/gi;
const CY_REQUEST_RE = /\bcy\s*\.\s*request\s*\(\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]\s*,\s*['"`]([^'"`\n]+)['"`]/gi;
const CY_REQUEST_OBJ_RE = /\bcy\s*\.\s*request\s*\(\s*\{\s*method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]\s*,\s*url\s*:\s*['"`]([^'"`\n]+)['"`]/gi;
const FLOW_ANNOTATION_RE = /\/\/\s*@claudia\s+flow\s*:\s*([^\n]+)/gi;
const SHARED_SETUP_RE = /\b(?:beforeAll|before)\s*\(/;

/**
 * Walk known E2E test directories and parse each spec file. Returns the per-test
 * coverage map plus a reverse index.
 */
export function discoverSpecs(opts: SpecDiscoveryOptions): {
  specs: SpecEntry[];
  fileToSpecs: Record<string, string[]>;
} {
  const { rootDir } = opts;
  const maxDepth = opts.maxDepth ?? 8;
  const specs: SpecEntry[] = [];
  const fileToSpecs: Record<string, string[]> = {};

  for (const candidate of SPEC_DIRS) {
    const abs = join(rootDir, candidate);
    if (!existsSync(abs)) continue;
    if (!statSync(abs).isDirectory()) continue;
    walkSpecDir(abs, rootDir, maxDepth, specs, fileToSpecs);
  }

  specs.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)));
  for (const k of Object.keys(fileToSpecs)) {
    fileToSpecs[k] = Array.from(new Set(fileToSpecs[k]!)).sort();
  }

  return { specs, fileToSpecs };
}

function walkSpecDir(
  dir: string,
  rootDir: string,
  depthLeft: number,
  specs: SpecEntry[],
  fileToSpecs: Record<string, string[]>,
): void {
  if (depthLeft <= 0) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSpecDir(abs, rootDir, depthLeft - 1, specs, fileToSpecs);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SPEC_FILE_RE.test(entry.name)) continue;
    parseSpecFile(abs, rootDir, specs, fileToSpecs);
  }
}

function parseSpecFile(
  abs: string,
  rootDir: string,
  specs: SpecEntry[],
  fileToSpecs: Record<string, string[]>,
): void {
  let src: string;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    return;
  }
  const relFile = relative(rootDir, abs).split(sep).join("/");
  const framework = inferFramework(src, relFile);
  const hasSharedSetup = SHARED_SETUP_RE.test(src);

  const routesCovered = uniqSorted(
    matchAll(PAGE_GOTO_RE, src, (m) => m[1]!)
      .concat(matchAll(CY_VISIT_RE, src, (m) => m[1]!))
      // Helper-pattern matches are post-filtered to path-shaped strings only
      // (avoids false positives from non-navigation calls like screenshot()).
      .concat(matchAll(NAV_HELPER_RE, src, (m) => m[1]!).filter(looksLikePath)),
  );

  const endpointsCovered = uniqSorted(
    matchAll(PAGE_REQUEST_RE, src, (m) => `${m[1]!.toUpperCase()} ${m[2]!}`)
      .concat(matchAll(CY_REQUEST_RE, src, (m) => `${m[1]!.toUpperCase()} ${m[2]!}`))
      .concat(matchAll(CY_REQUEST_OBJ_RE, src, (m) => `${m[1]!.toUpperCase()} ${m[2]!}`)),
  );

  const flowAnnotations = uniqSorted(matchAll(FLOW_ANNOTATION_RE, src, (m) => m[1]!.trim()));

  const testNames = matchAll(TEST_BLOCK_RE, src, (m) => m[1]!);

  // Filter out files that look like specs by name but have no actual `test()` /
  // `it()` blocks (e.g. helper modules in an e2e folder).
  if (testNames.length === 0) return;

  for (const name of testNames) {
    specs.push({
      framework,
      file: relFile,
      name,
      routesCovered,
      endpointsCovered,
      hasSharedSetup,
      flowAnnotations,
    });
    (fileToSpecs[relFile] ??= []).push(name);
  }
}

function inferFramework(src: string, file: string): SpecEntry["framework"] {
  if (file.includes("cypress/") || file.endsWith(".cy.ts") || file.endsWith(".cy.js")) return "cypress";
  if (/\bcy\s*\./.test(src) && !/from\s+['"]@playwright/.test(src)) return "cypress";
  return "playwright";
}

function matchAll<T>(re: RegExp, src: string, take: (m: RegExpExecArray) => T): T[] {
  const out: T[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(take(m));
  return out;
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

function looksLikePath(s: string): boolean {
  if (!s.startsWith("/")) return false;
  if (/^[a-z]+:\/\//i.test(s)) return false;
  // Drop obvious local-file paths (screenshots, fixtures).
  if (/\.(?:png|jpe?g|gif|webp|svg|pdf|json|txt)$/i.test(s)) return false;
  return true;
}
