import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AppMap, EndpointEntry, HttpMethod, RouteEntry } from "../types.js";
import { discoverTerraformResources } from "./terraform.js";

export interface NextAdapterOptions {
  rootDir: string;
  appDir?: string;
  maxDepth?: number;
}

const ROUTE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const LAYOUT_FILES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const ENDPOINT_FILES = ["route.ts", "route.tsx", "route.js", "route.jsx"];

export function buildNextMap(opts: NextAdapterOptions): AppMap {
  const rootDir = opts.rootDir;
  const appDir = opts.appDir ?? findAppDir(rootDir);
  const tsPaths = loadTsPaths(rootDir);
  const routes: RouteEntry[] = [];
  const endpoints: EndpointEntry[] = [];
  const fileToRoutes: Record<string, string[]> = {};

  if (appDir) {
    walk(appDir, "", appDir, rootDir, tsPaths, routes, endpoints, fileToRoutes, opts.maxDepth ?? 12);
  }

  // Second pass: link endpoints to caller files.
  // We collect every file the reachability walk visited (anything in fileToRoutes
  // is by definition reachable from at least one route, plus the endpoint handler
  // files themselves are also caller-eligible).
  const fileToEndpoints: Record<string, string[]> = {};
  for (const e of endpoints) e.callers = [];

  const callerFiles = new Set<string>(Object.keys(fileToRoutes));
  for (const file of callerFiles) {
    const calls = detectEndpointCalls(join(rootDir, file));
    if (calls.length === 0) continue;
    for (const call of calls) {
      const matched = matchEndpoint(call, endpoints);
      for (const m of matched) {
        if (!m.callers.includes(file)) m.callers.push(file);
        (fileToEndpoints[file] ??= []).push(m.route);
      }
    }
    if (fileToEndpoints[file]) {
      fileToEndpoints[file] = uniqSorted(fileToEndpoints[file]!);
    }
  }
  for (const e of endpoints) e.callers = uniqSorted(e.callers);

  // Third pass: infrastructure discovery (framework-agnostic — runs at the
  // project root, not just under appDir).
  const { infra, fileToInfra } = discoverTerraformResources({ rootDir });

  return {
    framework: "nextjs-app",
    generatedAt: new Date().toISOString(),
    rootDir,
    routes,
    endpoints,
    infra,
    fileToRoutes,
    fileToEndpoints,
    fileToInfra,
  };
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

interface TsPaths {
  baseUrl: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

function loadTsPaths(rootDir: string): TsPaths | null {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const abs = join(rootDir, name);
    if (!exists(abs)) continue;
    try {
      const raw = readFileSync(abs, "utf8");
      const stripped = stripJsonComments(raw);
      const cfg = JSON.parse(stripped) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = cfg.compilerOptions ?? {};
      const baseUrlRel = co.baseUrl ?? ".";
      const baseUrl = join(rootDir, baseUrlRel);
      const paths = Object.entries(co.paths ?? {}).map(([pattern, targets]) => ({
        pattern,
        targets: targets.map((t) => join(baseUrl, t)),
      }));
      return { baseUrl, paths };
    } catch {
      return null;
    }
  }
  return null;
}

function stripJsonComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function findAppDir(rootDir: string): string | null {
  for (const candidate of [join(rootDir, "app"), join(rootDir, "src", "app")]) {
    if (exists(candidate) && isDir(candidate)) return candidate;
  }
  return null;
}

function walk(
  dir: string,
  routePath: string,
  appRoot: string,
  rootDir: string,
  tsPaths: TsPaths | null,
  routes: RouteEntry[],
  endpoints: EndpointEntry[],
  fileToRoutes: Record<string, string[]>,
  remainingDepth: number,
): void {
  if (remainingDepth <= 0) return;

  const entries = readdirSync(dir, { withFileTypes: true });
  const pageFile = entries.find((e) => e.isFile() && ROUTE_FILES.includes(e.name));
  const endpointFile = entries.find((e) => e.isFile() && ENDPOINT_FILES.includes(e.name));

  if (pageFile) {
    const route = routePath || "/";
    const pageAbs = join(dir, pageFile.name);
    const reachable = new Set<string>();
    collectReachable(pageAbs, rootDir, tsPaths, reachable, 8);

    const layoutFiles = collectLayoutFiles(appRoot, dir);
    for (const layout of layoutFiles) {
      collectReachable(layout, rootDir, tsPaths, reachable, 8);
    }

    const fileList = [...reachable].map((f) => toRel(rootDir, f)).sort();
    routes.push({ route, files: fileList });
    for (const f of fileList) {
      (fileToRoutes[f] ??= []).push(route);
    }
  }

  if (endpointFile) {
    const path = routePath || "/";
    const handlerAbs = join(dir, endpointFile.name);
    const relFile = toRel(rootDir, handlerAbs);
    const parsed = parseEndpointHandler(handlerAbs);
    for (const m of parsed.methods) {
      endpoints.push({
        route: `${m.method} ${path}`,
        path,
        method: m.method,
        file: relFile,
        bodyShape: m.bodyShape,
        callers: [],
        services: parsed.services,
      });
    }
    (fileToRoutes[relFile] ??= []).push(...parsed.methods.map((m) => `${m.method} ${path}`));
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    const childRoute = segmentToRoute(entry.name, routePath);
    walk(join(dir, entry.name), childRoute, appRoot, rootDir, tsPaths, routes, endpoints, fileToRoutes, remainingDepth - 1);
  }
}

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface ParsedMethod {
  method: HttpMethod;
  bodyShape: EndpointEntry["bodyShape"];
}

interface ParsedHandler {
  methods: ParsedMethod[];
  /** Cloud service codes detected from @aws-sdk/client-* imports, e.g. ["s3"]. */
  services: string[];
}

function parseEndpointHandler(file: string): ParsedHandler {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return { methods: [], services: [] };
  }

  // Find each method's declaration position so we can slice its body region.
  const positions: Array<{ method: HttpMethod; start: number }> = [];
  for (const m of HTTP_METHODS) {
    const re = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${m}\\b|export\\s*\\{[^}]*\\b(?:[A-Za-z_$][\\w$]*\\s+as\\s+)?${m}\\b`,
      "g",
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(src))) {
      positions.push({ method: m, start: match.index });
    }
  }
  if (positions.length === 0) return { methods: [], services: detectAwsServices(src) };

  positions.sort((a, b) => a.start - b.start);

  const methods: ParsedMethod[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!.start;
    const end = i + 1 < positions.length ? positions[i + 1]!.start : src.length;
    const body = src.slice(start, end);
    methods.push({ method: positions[i]!.method, bodyShape: detectBodyShape(body) });
  }
  return { methods, services: detectAwsServices(src) };
}

const AWS_SDK_IMPORT_RE = /@aws-sdk\/client-([a-z0-9-]+)/gi;

export function detectAwsServices(src: string): string[] {
  const services = new Set<string>();
  AWS_SDK_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AWS_SDK_IMPORT_RE.exec(src))) {
    services.add(m[1]!.toLowerCase());
  }
  return Array.from(services).sort();
}

// Look only at request-side body parsing — `req.json()`, `await request.formData()`,
// etc. Specifically avoid matching `Response.json(...)` / `NextResponse.json(...)`
// which are output, not input.
const BODY_SHAPE_PATTERNS: Array<{ shape: EndpointEntry["bodyShape"]; re: RegExp }> = [
  { shape: "json", re: /\b(?:req|request)\s*\.\s*json\s*\(/ },
  { shape: "formData", re: /\b(?:req|request)\s*\.\s*formData\s*\(/ },
  { shape: "text", re: /\b(?:req|request)\s*\.\s*text\s*\(/ },
  { shape: "arrayBuffer", re: /\b(?:req|request)\s*\.\s*arrayBuffer\s*\(/ },
];

function detectBodyShape(src: string): EndpointEntry["bodyShape"] {
  for (const { shape, re } of BODY_SHAPE_PATTERNS) {
    if (re.test(src)) return shape;
  }
  return null;
}

function segmentToRoute(segment: string, parent: string): string {
  if (segment.startsWith("(") && segment.endsWith(")")) return parent;
  if (segment.startsWith("@")) return parent;
  if (segment.startsWith("[") && segment.endsWith("]")) {
    const inner = segment.slice(1, -1);
    if (inner.startsWith("...")) return `${parent}/:${inner.slice(3)}*`;
    return `${parent}/:${inner}`;
  }
  return `${parent}/${segment}`;
}

function collectLayoutFiles(appRoot: string, dir: string): string[] {
  const layouts: string[] = [];
  let current = dir;
  while (true) {
    if (!isUnder(appRoot, current)) break;
    for (const name of LAYOUT_FILES) {
      const candidate = join(current, name);
      if (exists(candidate)) layouts.push(candidate);
    }
    if (current === appRoot) break;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return layouts;
}

const IMPORT_RE = /import\s+(?:[^'"`]+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectReachable(
  file: string,
  rootDir: string,
  tsPaths: TsPaths | null,
  into: Set<string>,
  depth: number,
): void {
  if (depth <= 0) return;
  if (into.has(file)) return;
  if (!exists(file)) return;
  into.add(file);

  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return;
  }

  const specs: string[] = [];
  for (const re of [IMPORT_RE, REQUIRE_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.push(m[1]!);
  }

  for (const spec of specs) {
    const resolved = resolveSpec(spec, file, rootDir, tsPaths);
    if (resolved) collectReachable(resolved, rootDir, tsPaths, into, depth - 1);
  }
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function resolveSpec(
  spec: string,
  fromFile: string,
  rootDir: string,
  tsPaths: TsPaths | null,
): string | null {
  const bases = candidateBases(spec, fromFile, rootDir, tsPaths);
  for (const base of bases) {
    const found = tryResolveBase(base);
    if (found) return found;
  }
  return null;
}

function candidateBases(
  spec: string,
  fromFile: string,
  rootDir: string,
  tsPaths: TsPaths | null,
): string[] {
  if (spec.startsWith(".")) return [join(fromFile, "..", spec)];
  if (spec.startsWith("/")) return [join(rootDir, spec)];

  if (tsPaths) {
    for (const { pattern, targets } of tsPaths.paths) {
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -1);
        if (spec.startsWith(prefix)) {
          const tail = spec.slice(prefix.length);
          return targets.map((t) =>
            t.endsWith("/*") || t.endsWith(sep + "*") ? join(t.slice(0, -1), tail) : join(t, tail),
          );
        }
      } else if (spec === pattern) {
        return targets;
      }
    }
  }

  if (spec.startsWith("@/")) return [join(rootDir, spec.slice(2)), join(rootDir, "src", spec.slice(2))];
  return [];
}

function tryResolveBase(base: string): string | null {
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (exists(candidate) && !isDir(candidate)) return candidate;
  }
  if (exists(base) && isDir(base)) {
    for (const ext of EXTS) {
      const idx = join(base, "index" + ext);
      if (exists(idx)) return idx;
    }
  }
  if (exists(base) && !isDir(base)) return base;
  return null;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(root: string, p: string): boolean {
  const r = relative(root, p);
  return !r.startsWith("..") && !r.startsWith(sep + "..");
}

function toRel(rootDir: string, p: string): string {
  const r = relative(rootDir, p);
  return r.split(sep).join("/");
}

// ---------- Endpoint call detection ----------

interface DetectedCall {
  path: string;
  method: HttpMethod;
}

const FETCH_RE = /\bfetch\s*\(\s*['"`]([^'"`\n]+)['"`](?:\s*,\s*\{([\s\S]{0,400}?)\})?/g;
const AXIOS_RE =
  /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;
const SWR_RE = /\buseSWR\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
const METHOD_IN_OPTS_RE = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i;

/**
 * Best-effort static detection of API calls in a source file. Catches the
 * common patterns: `fetch("/api/x")`, `fetch("/api/x", { method: "POST" })`,
 * `axios.post("/api/x", body)`, `useSWR("/api/x")`. Does NOT chase variable
 * indirection — `const url = "/api/x"; fetch(url)` is invisible to this.
 */
export function detectEndpointCalls(file: string): DetectedCall[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: DetectedCall[] = [];

  FETCH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FETCH_RE.exec(src))) {
    const path = m[1]!;
    if (!looksLikePath(path)) continue;
    const opts = m[2] ?? "";
    const methodMatch = METHOD_IN_OPTS_RE.exec(opts);
    const method: HttpMethod = (methodMatch?.[1]?.toUpperCase() as HttpMethod | undefined) ?? "GET";
    out.push({ path, method });
  }

  AXIOS_RE.lastIndex = 0;
  while ((m = AXIOS_RE.exec(src))) {
    const method = m[1]!.toUpperCase() as HttpMethod;
    const path = m[2]!;
    if (!looksLikePath(path)) continue;
    out.push({ path, method });
  }

  SWR_RE.lastIndex = 0;
  while ((m = SWR_RE.exec(src))) {
    const path = m[1]!;
    if (!looksLikePath(path)) continue;
    out.push({ path, method: "GET" });
  }

  return out;
}

function looksLikePath(s: string): boolean {
  // Reject obvious non-paths: http(s) URLs, mailto, etc.
  if (/^[a-z]+:\/\//i.test(s)) return false;
  if (s.startsWith("mailto:") || s.startsWith("tel:")) return false;
  return s.startsWith("/");
}

/**
 * Match a detected call site against the discovered endpoint list. Returns all
 * endpoints whose path + method match. Path matching is segment-aware with
 * wildcard handling — `[id]`, `:id`, and `${id}` interpolations all match any
 * non-empty segment.
 */
export function matchEndpoint(
  call: DetectedCall,
  endpoints: EndpointEntry[],
): EndpointEntry[] {
  const callSegs = splitPath(call.path);
  return endpoints.filter(
    (e) => e.method === call.method && pathSegmentsMatch(callSegs, splitPath(e.path)),
  );
}

function splitPath(p: string): string[] {
  // Drop trailing query/hash, split, drop empties.
  const clean = p.split(/[?#]/)[0] ?? p;
  return clean.split("/").filter(Boolean);
}

function pathSegmentsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (isWildcardSegment(a[i]!) || isWildcardSegment(b[i]!)) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isWildcardSegment(seg: string): boolean {
  // `:id`, `[id]`, or anything containing `${...}` interpolation.
  if (seg.startsWith(":")) return true;
  if (seg.startsWith("[") && seg.endsWith("]")) return true;
  if (seg.includes("${")) return true;
  return false;
}
