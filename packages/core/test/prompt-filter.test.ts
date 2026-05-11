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
    { route: "GET /api/bugs", path: "/api/bugs", method: "GET", file: "app/api/bugs/route.ts", bodyShape: null, callers: [], services: [], tables: ["Bug"] },
    { route: "POST /api/bugs", path: "/api/bugs", method: "POST", file: "app/api/bugs/route.ts", bodyShape: "json", callers: ["app/checkout/Button.tsx"], services: [], tables: ["Bug"] },
    { route: "POST /api/upload", path: "/api/upload", method: "POST", file: "app/api/upload/route.ts", bodyShape: "formData", callers: [], services: ["s3"], tables: [] },
  ],
  infra: [
    { tool: "terraform", type: "aws_s3_bucket", name: "uploads", address: "aws_s3_bucket.uploads", file: "infra/s3.tf" },
  ],
  dbModels: [
    { orm: "prisma", name: "Bug", file: "prisma/schema.prisma" },
    { orm: "prisma", name: "Workspace", file: "prisma/schema.prisma" },
  ],
  fileToRoutes: {},
  fileToEndpoints: {
    "app/checkout/Button.tsx": ["POST /api/bugs"],
  },
  fileToInfra: {
    "infra/s3.tf": ["aws_s3_bucket.uploads"],
  },
  fileToTables: {
    "prisma/schema.prisma": ["Bug", "Workspace"],
  },
  specs: [
    {
      framework: "playwright",
      file: "e2e/bugs.spec.ts",
      name: "creates a bug",
      routesCovered: [],
      endpointsCovered: ["POST /api/bugs"],
      hasSharedSetup: false,
      flowAnnotations: [],
    },
    {
      framework: "playwright",
      file: "e2e/about.spec.ts",
      name: "renders about page",
      routesCovered: ["/about"],
      endpointsCovered: [],
      hasSharedSetup: false,
      flowAnnotations: [],
    },
  ],
  fileToSpecs: {
    "e2e/bugs.spec.ts": ["creates a bug"],
    "e2e/about.spec.ts": ["renders about page"],
  },
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

  it("surfaces endpoints called by changed files even when the handler isn't in the diff", () => {
    const result = filterMapForDiff(map, diff(["app/checkout/Button.tsx"]));
    expect(result.endpointsCalledByDiff).toHaveLength(1);
    expect(result.endpointsCalledByDiff[0]!.endpoint.route).toBe("POST /api/bugs");
    expect(result.endpointsCalledByDiff[0]!.callerFiles).toEqual(["app/checkout/Button.tsx"]);
  });

  it("does not double-count endpoints whose handler is also in the diff", () => {
    const result = filterMapForDiff(map, diff(["app/checkout/Button.tsx", "app/api/bugs/route.ts"]));
    expect(result.implicatedEndpoints.map((e) => e.route).sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);
    // POST /api/bugs is already direct; don't re-list it as an indirect call.
    expect(result.endpointsCalledByDiff).toHaveLength(0);
  });
});

describe("buildUserMessage with endpoint callers", () => {
  it("renders the 'Endpoints called by changed files' section when a caller is in the diff", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/Button.tsx"]), map });
    expect(msg).toContain("# Endpoints called by changed files");
    expect(msg).toContain("POST /api/bugs");
    expect(msg).toContain("called by: app/checkout/Button.tsx");
  });
});

describe("filterMapForDiff infra", () => {
  it("surfaces infra resources whose .tf file is in the diff", () => {
    const result = filterMapForDiff(map, diff(["infra/s3.tf"]));
    expect(result.implicatedInfra.map((r) => r.address)).toEqual(["aws_s3_bucket.uploads"]);
    expect(result.omittedInfraCount).toBe(0);
  });

  it("leaves infra empty when no .tf files are in the diff", () => {
    const result = filterMapForDiff(map, diff(["app/checkout/Button.tsx"]));
    expect(result.implicatedInfra).toEqual([]);
    expect(result.omittedInfraCount).toBe(1);
  });
});

describe("buildUserMessage infra + services rendering", () => {
  it("renders infra section with the implicated resource", () => {
    const msg = buildUserMessage({ diff: diff(["infra/s3.tf"]), map });
    expect(msg).toContain("# Infrastructure (Terraform)");
    expect(msg).toContain("aws_s3_bucket.uploads");
    expect(msg).toContain("infra/s3.tf");
  });

  it("annotates endpoints with their detected AWS services", () => {
    const msg = buildUserMessage({ diff: diff(["app/api/upload/route.ts"]), map });
    expect(msg).toContain("POST /api/upload");
    expect(msg).toContain("services: s3");
  });

  it("notes when no infrastructure is touched", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/Button.tsx"]), map });
    expect(msg).toContain("none of the 1 known resources are touched by this diff");
  });
});

describe("filterMapForDiff db models", () => {
  it("surfaces db models whose schema file is in the diff", () => {
    const result = filterMapForDiff(map, diff(["prisma/schema.prisma"]));
    expect(result.implicatedDbModels.map((m) => m.name).sort()).toEqual(["Bug", "Workspace"]);
    expect(result.omittedDbModelCount).toBe(0);
  });
});

describe("spec coverage filtering + rendering", () => {
  it("surfaces specs whose endpoint coverage intersects the diff", () => {
    const result = filterMapForDiff(map, diff(["app/api/bugs/route.ts"]));
    expect(result.coveringSpecs.map((s) => s.name)).toEqual(["creates a bug"]);
  });

  it("surfaces specs whose route coverage intersects the diff", () => {
    const result = filterMapForDiff(map, diff(["app/about/page.tsx"]));
    expect(result.coveringSpecs.map((s) => s.name)).toEqual(["renders about page"]);
  });

  it("reports uncovered routes when no spec covers an implicated route", () => {
    const result = filterMapForDiff(map, diff(["app/checkout/page.tsx"]));
    expect(result.coveringSpecs).toEqual([]);
    expect(result.uncoveredRoutes).toContain("/checkout");
  });

  it("renders the coverage section in the prompt when specs cover the diff", () => {
    const msg = buildUserMessage({ diff: diff(["app/api/bugs/route.ts"]), map });
    expect(msg).toContain("# Existing test coverage");
    expect(msg).toContain('e2e/bugs.spec.ts: "creates a bug"');
    expect(msg).toContain("endpoints: POST /api/bugs");
  });

  it("renders coverage gaps in the prompt when implicated flows have no spec", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/page.tsx"]), map });
    expect(msg).toContain("Coverage gaps");
    expect(msg).toContain("/checkout");
  });

  it("flags shared-setup specs in the prompt", () => {
    const sharedMap = {
      ...map,
      specs: [{ ...map.specs[0]!, hasSharedSetup: true }],
    };
    const msg = buildUserMessage({ diff: diff(["app/api/bugs/route.ts"]), map: sharedMap });
    expect(msg).toContain("[shared setup]");
  });
});

describe("buildUserMessage db schema rendering + table annotations", () => {
  it("renders the DB schema section when the schema file is in the diff", () => {
    const msg = buildUserMessage({ diff: diff(["prisma/schema.prisma"]), map });
    expect(msg).toContain("# Database schema (Prisma)");
    expect(msg).toContain("- Bug (prisma)");
    expect(msg).toContain("- Workspace (prisma)");
  });

  it("annotates endpoints with their detected tables", () => {
    const msg = buildUserMessage({ diff: diff(["app/api/bugs/route.ts"]), map });
    expect(msg).toContain("POST /api/bugs");
    expect(msg).toContain("tables: Bug");
  });

  it("notes when no db models are touched", () => {
    const msg = buildUserMessage({ diff: diff(["app/checkout/Button.tsx"]), map });
    expect(msg).toContain("none of the 2 known models are touched by this diff");
  });
});
