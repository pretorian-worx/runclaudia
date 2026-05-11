import type { AppMap, Diff, EndpointEntry, FileChange, InfraEntry, RouteEntry } from "./types.js";

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
} {
  const diffPaths = new Set<string>();
  for (const f of diff.files) {
    diffPaths.add(f.path);
    if (f.oldPath) diffPaths.add(f.oldPath);
  }
  const implicated = map.routes.filter((r) => r.files.some((file) => diffPaths.has(file)));
  const endpoints = map.endpoints ?? [];
  const implicatedEndpoints = endpoints.filter((e) => diffPaths.has(e.file));

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
    endpointsCalledByDiff.push({
      endpoint,
      callerFiles: Array.from(new Set(callerFiles)).sort(),
    });
  }
  endpointsCalledByDiff.sort((a, b) => a.endpoint.route.localeCompare(b.endpoint.route));

  const infra = map.infra ?? [];
  const implicatedInfra = infra.filter((r) => diffPaths.has(r.file));

  return {
    implicated,
    omittedCount: map.routes.length - implicated.length,
    implicatedEndpoints,
    omittedEndpointCount: endpoints.length - implicatedEndpoints.length,
    endpointsCalledByDiff,
    implicatedInfra,
    omittedInfraCount: infra.length - implicatedInfra.length,
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
  } = filterMapForDiff(map, diff);
  const totalInfra = (map.infra ?? []).length;
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
