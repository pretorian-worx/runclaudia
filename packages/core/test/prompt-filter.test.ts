import { describe, expect, it } from "vitest";
import { buildUserMessage, filterMapForDiff } from "../src/prompt.js";
import type { AppMap, Diff } from "../src/types.js";

const map: AppMap = {
  framework: "nextjs-app",
  generatedAt: "2026-05-10T00:00:00.000Z",
  rootDir: "/repo",
  routes: [
    { route: "/", files: ["app/page.tsx", "app/components/Hero.tsx"] },
    { route: "/about", files: ["app/about/page.tsx"] },
    { route: "/checkout", files: ["app/checkout/page.tsx", "app/checkout/Button.tsx"] },
  ],
  endpoints: [
    { route: "GET /api/bugs", path: "/api/bugs", method: "GET", file: "app/api/bugs/route.ts", bodyShape: null },
    { route: "POST /api/bugs", path: "/api/bugs", method: "POST", file: "app/api/bugs/route.ts", bodyShape: "json" },
    { route: "POST /api/upload", path: "/api/upload", method: "POST", file: "app/api/upload/route.ts", bodyShape: "formData" },
  ],
  fileToRoutes: {},
};

function diff(paths: string[]): Diff {
  return {
    base: "a",
    head: "b",
    files: paths.map((p) => ({
      path: p,
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [],
      binary: false,
    })),
  };
}

describe("filterMapForDiff", () => {
  it("keeps only routes whose files appear in the diff", () => {
    const result = filterMapForDiff(map, diff(["app/checkout/Button.tsx"]));
    expect(result.implicated.map((r) => r.route)).toEqual(["/checkout"]);
    expect(result.omittedCount).toBe(2);
  });

  it("handles diffs that touch shared files used by many routes", () => {
    const sharedMap: AppMap = {
      ...map,
      routes: map.routes.map((r) => ({ ...r, files: [...r.files, "app/layout.tsx"] })),
    };
    const result = filterMapForDiff(sharedMap, diff(["app/layout.tsx"]));
    expect(result.implicated).toHaveLength(3);
    expect(result.omittedCount).toBe(0);
  });

  it("returns zero implicated routes when diff touches no mapped files", () => {
    const result = filterMapForDiff(map, diff(["scripts/migrate.ts"]));
    expect(result.implicated).toHaveLength(0);
    expect(result.omittedCount).toBe(3);
  });

  it("matches renamed files on the old path too", () => {
    const renameDiff: Diff = {
      base: "a",
      head: "b",
      files: [
        {
          path: "app/checkout/PayButton.tsx",
          oldPath: "app/checkout/Button.tsx",
          status: "renamed",
          additions: 0,
          deletions: 0,
          hunks: [],
          binary: false,
        },
      ],
    };
    const result = filterMapForDiff(map, renameDiff);
    expect(result.implicated.map((r) => r.route)).toEqual(["/checkout"]);
  });
});

describe("buildUserMessage filtering", () => {
  it("omits unaffected routes from the prompt and summarizes the rest", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/page.tsx"]), map });
    expect(msg).toContain("/checkout");
    expect(msg).not.toContain("/about");
    expect(msg).toContain("2 other routes exist in this project but are not affected by this diff.");
  });

  it("notes when no routes are touched", () => {
    const msg = buildUserMessage({ diff: diff(["scripts/migrate.ts"]), map });
    expect(msg).toContain("none of the 3 known routes are touched by this diff");
  });

  it("includes implicated endpoints with method, path, and body shape", () => {
    const msg = buildUserMessage({ diff: diff(["app/api/bugs/route.ts"]), map });
    expect(msg).toContain("GET /api/bugs");
    expect(msg).toContain("POST /api/bugs");
    expect(msg).toContain("body: json");
    expect(msg).not.toContain("POST /api/upload");
    expect(msg).toContain("1 other endpoints exist in this project but are not affected by this diff.");
  });

  it("notes when no endpoints are touched", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/page.tsx"]), map });
    expect(msg).toContain("none of the 3 known endpoints are touched by this diff");
  });
});

describe("filterMapForDiff endpoints", () => {
  it("returns implicated endpoints when the diff touches their handler file", () => {
    const result = filterMapForDiff(map, diff(["app/api/bugs/route.ts"]));
    expect(result.implicatedEndpoints.map((e) => e.route).sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);
    expect(result.omittedEndpointCount).toBe(1);
  });
});
