import type {
  AppMap,
  DbModelEntry,
  Diff,
  EndpointEntry,
  FileChange,
  InfraEntry,
  RouteEntry,
  SpecEntry,
} from "./types.js";

export const SYSTEM_PROMPT = `You are claudia, a diff-aware test planner.

Your job: read a code diff plus a map of the app's routes and API endpoints, then output a structured plan describing which user-facing flows a human tester should exercise to validate the change. You DO NOT execute tests. You produce a plan a reviewer or downstream tool will act on.

Rules:
- Be specific. Cite changed file paths in your reasoning.
- Map every changed file to the routes AND endpoints it reaches. If a file is not in the map, list it under unmappedFiles and explain why it might still matter.
- Distinguish API changes from UI changes:
  - A changed page/component implies a flow on its route(s) — write checks as user actions.
  - A changed endpoint (route.ts) implies an API contract change — call out the method + path, the request body shape (json/formData/text/etc), and recommend exercising it via the UI flow that hits it OR directly (curl/API client) when no UI flow is implicated.
  - A changed component that *calls* an endpoint (statically detected — see "Endpoints called by changed files" below) implies a full-stack flow: the UI change AND the contract between UI and that endpoint. Verify the end-to-end roundtrip, not just the rendered output.
- The flow.routes field can contain either page paths ("/checkout") or method-prefixed endpoint paths ("POST /api/bugs/move"). Use whichever fits the change.
- Risk levels: "high" = auth, payments, data-mutation, schema changes, or many routes/endpoints affected; "medium" = single-route behavior change or additive endpoint; "low" = cosmetic, copy, isolated UI.
- Suggested checks must be concrete user actions ("complete checkout with a saved card", not "test the checkout flow") or concrete API checks ("POST /api/bugs/move with a valid payload; expect 200 + new bug ref").
- Set verdict to "skip" only if the diff genuinely cannot affect runtime behavior (already-filtered cases shouldn't reach you, so prefer "test").
- coverageGaps captures *unmapped risk* — changes you can see have impact but no flow or endpoint in the map covers them.
- Treat infrastructure changes as production-impact risk. If the diff includes Terraform/CDK resources and any endpoint in the diff touches the same service (per the endpoint's "services" annotation), call out the coordinated risk — e.g. "S3 bucket policy changed AND POST /api/attachments writes to S3, verify the write still succeeds end-to-end."
- Treat database-schema changes as high-risk by default. Endpoints carry a "tables" annotation listing the DB models they touch (e.g. a Prisma call like prisma.bug.create(...) maps to ["Bug"]). When the diff changes the schema for a model AND an endpoint in the diff (or called by the diff) touches that model, call out the read/write contract explicitly — "the Bug model gained a non-null column; POST /api/bugs writes to Bug, verify the new column is populated."
- When the prompt's "Existing test coverage" section lists specs that already cover the affected routes/endpoints, reference them by file:name in your suggestedChecks — e.g. "Run e2e/checkout.spec.ts:'completes checkout' against the deploy." Recommending existing specs is cheaper for the team than writing new ones and is preferred when coverage exists.
- coverageGaps should call out flows the diff implicates that have NO existing spec — that's a concrete signal to the team to add one.
- Be terse. The output is read by humans on a PR.`;

/**
 * Reduce the map to only the routes that the diff actually touches.
 * Massively cuts prompt token cost on large repos; the brain only needs the
 * route information for places the diff implicates.
 *
 * A route is "implicated" if any of its tracked files appears in the diff
 * (matching either the post-image path or, for renames, the pre-image path).
 */
export interface EndpointCallSite {
  endpoint: EndpointEntry;
  /** Files in the diff that statically call this endpoint. */
  callerFiles: string[];
}

export function filterMapForDiff(map: AppMap, diff: Diff): {
  implicated: RouteEntry[];
  omittedCount: number;
  implicatedEndpoints: EndpointEntry[];
  omittedEndpointCount: number;
  /** Endpoints that aren't directly changed, but are called from files in the diff. */
  endpointsCalledByDiff: EndpointCallSite[];
  /** Infrastructure resources whose declaration file is in the diff. */
  implicatedInfra: InfraEntry[];
  omittedInfraCount: number;
  /** Database models whose schema file is in the diff. */
  implicatedDbModels: DbModelEntry[];
  omittedDbModelCount: number;
  /** Specs whose coverage intersects with implicated routes or endpoints. */
  coveringSpecs: SpecEntry[];
  /** Routes implicated by the diff that have NO covering spec. */
  uncoveredRoutes: string[];
  /** Endpoints implicated by the diff that have NO covering spec. */
  uncoveredEndpoints: string[];
  /**
   * Per-route reachability rationale: maps an implicated route path to the
   * diff file(s) that put it in scope. Used by `claudia select` to surface
   * *why* each spec was picked rather than just *which* specs were picked.
   */
  routeReasons: Record<string, string[]>;
  /**
   * Per-endpoint rationale: maps an implicated endpoint route (with method
   * prefix, e.g. "POST /api/bugs") to the diff file(s) that put it in scope.
   * Includes both directly-changed endpoint files and indirect callers.
   */
  endpointReasons: Record<string, string[]>;
} {
  const diffPaths = new Set<string>();
  for (const f of diff.files) {
    diffPaths.add(f.path);
    if (f.oldPath) diffPaths.add(f.oldPath);
  }
  const implicated = map.routes.filter((r) => r.files.some((file) => diffPaths.has(file)));
  const routeReasons: Record<string, string[]> = {};
  for (const r of implicated) {
    const matched = r.files.filter((f) => diffPaths.has(f));
    routeReasons[r.route] = Array.from(new Set(matched)).sort();
  }
  const endpoints = map.endpoints ?? [];
  const implicatedEndpoints = endpoints.filter((e) => diffPaths.has(e.file));
  const endpointReasons: Record<string, string[]> = {};
  for (const e of implicatedEndpoints) {
    // e.route already includes the method prefix (e.g. "POST /api/bugs"), so
    // we key on it directly — matches the shape used in spec.endpointsCovered.
    endpointReasons[e.route] = [e.file];
  }

  // Indirect linkage: a changed file calls an endpoint whose handler isn't itself
  // in the diff. We want the brain to consider the contract between the UI and
  // that endpoint as part of the flow.
  const fileToEndpoints = map.fileToEndpoints ?? {};
  const directlyChangedRoutes = new Set(implicatedEndpoints.map((e) => e.route));
  const calledRouteToCallers = new Map<string, string[]>();
  for (const file of diffPaths) {
    const calls = fileToEndpoints[file] ?? [];
    for (const route of calls) {
      if (directlyChangedRoutes.has(route)) continue;
      const list = calledRouteToCallers.get(route) ?? [];
      list.push(file);
      calledRouteToCallers.set(route, list);
    }
  }
  const endpointsByRoute = new Map(endpoints.map((e) => [e.route, e]));
  const endpointsCalledByDiff: EndpointCallSite[] = [];
  for (const [route, callerFiles] of calledRouteToCallers) {
    const endpoint = endpointsByRoute.get(route);
    if (!endpoint) continue;
    const sortedCallers = Array.from(new Set(callerFiles)).sort();
    endpointsCalledByDiff.push({ endpoint, callerFiles: sortedCallers });
    const prior = endpointReasons[endpoint.route] ?? [];
    endpointReasons[endpoint.route] = Array.from(new Set([...prior, ...sortedCallers])).sort();
  }
  endpointsCalledByDiff.sort((a, b) => a.endpoint.route.localeCompare(b.endpoint.route));

  const infra = map.infra ?? [];
  const implicatedInfra = infra.filter((r) => diffPaths.has(r.file));

  const dbModels = map.dbModels ?? [];
  const implicatedDbModels = dbModels.filter((m) => diffPaths.has(m.file));

  // Spec coverage: a spec "covers" the diff if any of its tracked routes or
  // endpoints intersects with the implicated set (direct OR called-by-diff).
  const allImplicatedRoutes = new Set([
    ...implicated.map((r) => r.route),
  ]);
  const allImplicatedEndpointRoutes = new Set([
    ...implicatedEndpoints.map((e) => e.route),
    ...endpointsCalledByDiff.map((s) => s.endpoint.route),
  ]);
  const specs = map.specs ?? [];
  const coveringSpecs = specs.filter(
    (s) =>
      s.routesCovered.some((r) => allImplicatedRoutes.has(r)) ||
      s.endpointsCovered.some((e) => allImplicatedEndpointRoutes.has(e)),
  );
  const coveredRoutes = new Set(coveringSpecs.flatMap((s) => s.routesCovered));
  const coveredEndpoints = new Set(coveringSpecs.flatMap((s) => s.endpointsCovered));
  const uncoveredRoutes = Array.from(allImplicatedRoutes).filter((r) => !coveredRoutes.has(r)).sort();
  const uncoveredEndpoints = Array.from(allImplicatedEndpointRoutes).filter((e) => !coveredEndpoints.has(e)).sort();

  return {
    implicated,
    omittedCount: map.routes.length - implicated.length,
    implicatedEndpoints,
    omittedEndpointCount: endpoints.length - implicatedEndpoints.length,
    endpointsCalledByDiff,
    implicatedInfra,
    omittedInfraCount: infra.length - implicatedInfra.length,
    implicatedDbModels,
    omittedDbModelCount: dbModels.length - implicatedDbModels.length,
    coveringSpecs,
    uncoveredRoutes,
    uncoveredEndpoints,
    routeReasons,
    endpointReasons,
  };
}

export function buildUserMessage(args: { diff: Diff; map: AppMap; targetUrl?: string }): string {
  const { diff, map, targetUrl } = args;
  const {
    implicated,
    omittedCount,
    implicatedEndpoints,
    omittedEndpointCount,
    endpointsCalledByDiff,
    implicatedInfra,
    omittedInfraCount,
    implicatedDbModels,
    omittedDbModelCount,
    coveringSpecs,
    uncoveredRoutes,
    uncoveredEndpoints,
  } = filterMapForDiff(map, diff);
  const totalInfra = (map.infra ?? []).length;
  const totalDbModels = (map.dbModels ?? []).length;
  const totalSpecs = (map.specs ?? []).length;
  const totalEndpoints = (map.endpoints ?? []).length;
  const parts: string[] = [];

  parts.push(`# Route map (framework: ${map.framework})`);
  if (map.routes.length === 0) {
    parts.push("(no routes discovered)");
  } else if (implicated.length === 0) {
    parts.push(`(none of the ${map.routes.length} known routes are touched by this diff)`);
  } else {
    parts.push(`Showing ${implicated.length} of ${map.routes.length} known routes — only those whose tracked files appear in the diff.`);
    parts.push("");
    for (const r of implicated) {
      parts.push(`- ${r.route}`);
      for (const f of r.files) parts.push(`  - ${f}`);
    }
    if (omittedCount > 0) {
      parts.push("");
      parts.push(`(${omittedCount} other routes exist in this project but are not affected by this diff.)`);
    }
  }

  parts.push("");
  parts.push(`# API endpoints`);
  if (totalEndpoints === 0) {
    parts.push("(no endpoints discovered)");
  } else if (implicatedEndpoints.length === 0) {
    parts.push(`(none of the ${totalEndpoints} known endpoints are touched by this diff)`);
  } else {
    parts.push(`Showing ${implicatedEndpoints.length} of ${totalEndpoints} known endpoints — only those whose handler file appears in the diff.`);
    parts.push("");
    for (const e of implicatedEndpoints) {
      parts.push(`- ${e.method} ${e.path}${endpointAnnotations(e)}`);
      parts.push(`  - ${e.file}`);
    }
    if (omittedEndpointCount > 0) {
      parts.push("");
      parts.push(`(${omittedEndpointCount} other endpoints exist in this project but are not affected by this diff.)`);
    }
  }

  parts.push("");
  parts.push(`# Endpoints called by changed files`);
  if (endpointsCalledByDiff.length === 0) {
    parts.push("(no static call sites detected from files in this diff)");
  } else {
    parts.push(
      `Statically detected call sites — when these files change, the contract with the endpoint may be affected.`,
    );
    parts.push("");
    for (const site of endpointsCalledByDiff) {
      parts.push(`- ${site.endpoint.method} ${site.endpoint.path}${endpointAnnotations(site.endpoint)}`);
      parts.push(`  - handler: ${site.endpoint.file}`);
      for (const c of site.callerFiles) parts.push(`  - called by: ${c}`);
    }
  }

  parts.push("");
  parts.push(`# Infrastructure (Terraform)`);
  if (totalInfra === 0) {
    parts.push("(no infrastructure resources discovered)");
  } else if (implicatedInfra.length === 0) {
    parts.push(`(none of the ${totalInfra} known resources are touched by this diff)`);
  } else {
    parts.push(
      `Showing ${implicatedInfra.length} of ${totalInfra} known resources — only those whose declaration file is in the diff.`,
    );
    parts.push("");
    for (const r of implicatedInfra) {
      parts.push(`- ${r.address} (${r.tool})`);
      parts.push(`  - ${r.file}`);
    }
    if (omittedInfraCount > 0) {
      parts.push("");
      parts.push(`(${omittedInfraCount} other resources exist in this project but are not affected by this diff.)`);
    }
  }

  parts.push("");
  parts.push(`# Database schema (Prisma)`);
  if (totalDbModels === 0) {
    parts.push("(no models discovered)");
  } else if (implicatedDbModels.length === 0) {
    parts.push(`(none of the ${totalDbModels} known models are touched by this diff)`);
  } else {
    parts.push(
      `Showing ${implicatedDbModels.length} of ${totalDbModels} known models — only those whose schema file is in the diff.`,
    );
    parts.push("");
    for (const m of implicatedDbModels) {
      parts.push(`- ${m.name} (${m.orm})`);
      parts.push(`  - ${m.file}`);
    }
    if (omittedDbModelCount > 0) {
      parts.push("");
      parts.push(`(${omittedDbModelCount} other models exist in this project but are not affected by this diff.)`);
    }
  }

  parts.push("");
  parts.push(`# Existing test coverage (Playwright / Cypress)`);
  if (totalSpecs === 0) {
    parts.push("(no specs discovered — no e2e/, playwright/, or cypress/ directory found)");
  } else {
    if (coveringSpecs.length === 0) {
      parts.push(`(${totalSpecs} specs indexed; none cover the routes/endpoints touched by this diff)`);
    } else {
      parts.push(
        `Specs that cover affected flows — prefer recommending these over writing new tests.`,
      );
      parts.push("");
      for (const s of coveringSpecs) {
        const setup = s.hasSharedSetup ? " [shared setup]" : "";
        const ann = s.flowAnnotations.length > 0 ? ` (flow: ${s.flowAnnotations.join(", ")})` : "";
        parts.push(`- ${s.file}: "${s.name}" — ${s.framework}${setup}${ann}`);
        const covered: string[] = [];
        if (s.routesCovered.length > 0) covered.push(`routes: ${s.routesCovered.join(", ")}`);
        if (s.endpointsCovered.length > 0) covered.push(`endpoints: ${s.endpointsCovered.join(", ")}`);
        if (covered.length > 0) parts.push(`  - covers ${covered.join("; ")}`);
      }
    }
    if (uncoveredRoutes.length > 0 || uncoveredEndpoints.length > 0) {
      parts.push("");
      parts.push("Coverage gaps (implicated but no covering spec):");
      for (const r of uncoveredRoutes) parts.push(`- ${r}`);
      for (const e of uncoveredEndpoints) parts.push(`- ${e}`);
    }
  }

  parts.push("");
  parts.push(`# Diff (${diff.base}..${diff.head})`);
  if (targetUrl) parts.push(`Deployed at: ${targetUrl}`);
  parts.push("");

  for (const f of diff.files) {
    parts.push(renderFile(f));
  }

  parts.push("");
  parts.push("Now produce the plan via the emit_plan tool.");
  return parts.join("\n");
}

function endpointAnnotations(e: EndpointEntry): string {
  const parts: string[] = [];
  if (e.bodyShape) parts.push(`body: ${e.bodyShape}`);
  const services = e.services ?? [];
  if (services.length > 0) parts.push(`services: ${services.join(", ")}`);
  const tables = e.tables ?? [];
  if (tables.length > 0) parts.push(`tables: ${tables.join(", ")}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

function renderFile(f: FileChange): string {
  const header = `## ${f.status.toUpperCase()} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""}  +${f.additions}/-${f.deletions}${f.binary ? " [binary]" : ""}`;
  if (f.binary || f.hunks.length === 0) return header;
  const hunks = f.hunks.map((h) => "```diff\n" + truncate(h, 4000) + "\n```").join("\n");
  return `${header}\n${hunks}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [${s.length - n} chars truncated]` : s;
}
