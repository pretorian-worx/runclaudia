import type { AppMap, Diff, FileChange, RouteEntry } from "./types.js";

export const SYSTEM_PROMPT = `You are claudia, a diff-aware test planner.

Your job: read a code diff and a route map, then output a structured plan describing which user-facing flows a human tester should exercise to validate the change. You DO NOT execute tests. You produce a plan a reviewer or downstream tool will act on.

Rules:
- Be specific. Cite changed file paths in your reasoning.
- Map every changed file to the routes it reaches via the route map. If a file is not in the map, list it under unmappedFiles and explain why it might still matter.
- Risk levels: "high" = auth, payments, data-mutation, or many routes affected; "medium" = single-route behavior change; "low" = cosmetic, copy, isolated UI.
- Suggested checks must be concrete user actions ("complete checkout with a saved card", not "test the checkout flow").
- Set verdict to "skip" only if the diff genuinely cannot affect runtime behavior (already-filtered cases shouldn't reach you, so prefer "test").
- coverageGaps captures *unmapped risk* — changes you can see have impact but no flow in the map covers them.
- Be terse. The output is read by humans on a PR.`;

/**
 * Reduce the map to only the routes that the diff actually touches.
 * Massively cuts prompt token cost on large repos; the brain only needs the
 * route information for places the diff implicates.
 *
 * A route is "implicated" if any of its tracked files appears in the diff
 * (matching either the post-image path or, for renames, the pre-image path).
 */
export function filterMapForDiff(map: AppMap, diff: Diff): {
  implicated: RouteEntry[];
  omittedCount: number;
} {
  const diffPaths = new Set<string>();
  for (const f of diff.files) {
    diffPaths.add(f.path);
    if (f.oldPath) diffPaths.add(f.oldPath);
  }
  const implicated = map.routes.filter((r) => r.files.some((file) => diffPaths.has(file)));
  return { implicated, omittedCount: map.routes.length - implicated.length };
}

export function buildUserMessage(args: { diff: Diff; map: AppMap; targetUrl?: string }): string {
  const { diff, map, targetUrl } = args;
  const { implicated, omittedCount } = filterMapForDiff(map, diff);
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

function renderFile(f: FileChange): string {
  const header = `## ${f.status.toUpperCase()} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""}  +${f.additions}/-${f.deletions}${f.binary ? " [binary]" : ""}`;
  if (f.binary || f.hunks.length === 0) return header;
  const hunks = f.hunks.map((h) => "```diff\n" + truncate(h, 4000) + "\n```").join("\n");
  return `${header}\n${hunks}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [${s.length - n} chars truncated]` : s;
}
