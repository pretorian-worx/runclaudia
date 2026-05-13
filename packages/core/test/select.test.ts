import { describe, expect, it, vi } from "vitest";
import type { AppMap, Diff } from "../src/types.js";
import { formatSelectionMarkdown, runSelect } from "../src/select.js";
import * as diffModule from "../src/diff.js";
import * as mapModule from "../src/map.js";

const makeMap = (overrides: Partial<AppMap> = {}): AppMap => ({
  framework: "nextjs-app",
  generatedAt: "2026-05-11T00:00:00.000Z",
  rootDir: "/repo",
  routes: [
    { route: "/", files: ["app/page.tsx"] },
    { route: "/checkout", files: ["app/checkout/page.tsx"] },
    { route: "/about", files: ["app/about/page.tsx"] },
  ],
  endpoints: [
    {
      route: "POST /api/bugs",
      path: "/api/bugs",
      method: "POST",
      file: "app/api/bugs/route.ts",
      bodyShape: "json",
      callers: [],
      services: [],
      tables: [],
    },
  ],
  infra: [],
  dbModels: [],
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
      file: "e2e/bugs.spec.ts",
      name: "lists bugs",
      routesCovered: [],
      endpointsCovered: ["POST /api/bugs"],
      hasSharedSetup: false,
      flowAnnotations: [],
    },
    {
      framework: "playwright",
      file: "e2e/checkout.spec.ts",
      name: "completes checkout",
      routesCovered: ["/checkout"],
      endpointsCovered: [],
      hasSharedSetup: true,
      flowAnnotations: [],
    },
    {
      framework: "cypress",
      file: "cypress/e2e/about.cy.ts",
      name: "renders the about page",
      routesCovered: ["/about"],
      endpointsCovered: [],
      hasSharedSetup: false,
      flowAnnotations: [],
    },
  ],
  fileToRoutes: {},
  fileToEndpoints: {},
  fileToInfra: {},
  fileToTables: {},
  fileToSpecs: {},
  ...overrides,
});

const makeDiff = (paths: string[]): Diff => ({
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
});

function stub(map: AppMap, paths: string[]) {
  vi.spyOn(diffModule, "readDiff").mockReturnValue(makeDiff(paths));
  vi.spyOn(mapModule, "loadOrBuildMap").mockReturnValue(map);
}

describe("runSelect — covered case", () => {
  it("collapses per-test SpecEntry rows into per-file SelectedSpec entries", () => {
    stub(makeMap(), ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0]!.file).toBe("e2e/bugs.spec.ts");
    expect(r.selected[0]!.tests.sort()).toEqual(["creates a bug", "lists bugs"]);
    expect(r.selectedTestCount).toBe(2);
  });

  it("produces a Playwright --grep alternation with regex-escaped test names", () => {
    stub(makeMap(), ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.playwrightGrep).toBe("creates a bug|lists bugs");
  });

  it("escapes regex meta characters in test names", () => {
    const map = makeMap({
      specs: [
        {
          framework: "playwright",
          file: "e2e/x.spec.ts",
          name: "create a bug ($special.case)",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
      ],
    });
    stub(map, ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.playwrightGrep).toBe("create a bug \\(\\$special\\.case\\)");
  });

  it("emits empty playwrightGrep when the only matches are shared-setup files", () => {
    stub(makeMap(), ["app/checkout/page.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.selected[0]!.file).toBe("e2e/checkout.spec.ts");
    expect(r.selected[0]!.hasSharedSetup).toBe(true);
    expect(r.playwrightGrep).toBeNull();
  });

  it("collects cypress spec files separately", () => {
    stub(makeMap(), ["app/about/page.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.cypressSpecs).toBe("cypress/e2e/about.cy.ts");
    // No Playwright tests selected → grep stays null
    expect(r.playwrightGrep).toBeNull();
  });
});

describe("runSelect — uncovered case", () => {
  it("returns no selection and reports uncovered flows", () => {
    const map = makeMap({ specs: [] });
    stub(map, ["app/checkout/page.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.selected).toEqual([]);
    expect(r.selectedTestCount).toBe(0);
    expect(r.uncoveredRoutes).toContain("/checkout");
  });

  it("surfaces the diff file list so downstream formatters can show context", () => {
    stub(makeMap(), ["app/api/bugs/route.ts", "src/components/CreateBugButton.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.diffFiles).toEqual(["app/api/bugs/route.ts", "src/components/CreateBugButton.tsx"]);
  });
});

describe("runSelect — excludeSpecs", () => {
  const mapWithSmoke = () =>
    makeMap({
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
          file: "e2e/smoke.spec.ts",
          name: "smoke loads",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
      ],
    });

  it("drops matching specs from the selection", () => {
    stub(mapWithSmoke(), ["app/api/bugs/route.ts"]);
    const r = runSelect({
      rootDir: "/repo",
      base: "a",
      head: "b",
      excludeSpecs: ["**/smoke*.spec.ts"],
    });
    expect(r.selected.map((s) => s.file)).toEqual(["e2e/bugs.spec.ts"]);
    expect(r.excludedSpecFiles).toEqual(["e2e/smoke.spec.ts"]);
  });

  it("excluded specs do NOT cause routes/endpoints to appear as coverage gaps", () => {
    // Both bugs.spec and smoke.spec cover POST /api/bugs. Excluding smoke
    // should still leave POST /api/bugs as 'covered' because bugs.spec covers
    // it too. But even if smoke were the ONLY cover, the route shouldn't
    // surface as a gap — excluded ≠ doesn't exist.
    const map = makeMap({
      specs: [
        {
          framework: "playwright",
          file: "e2e/smoke.spec.ts",
          name: "smoke",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
      ],
    });
    stub(map, ["app/api/bugs/route.ts"]);
    const r = runSelect({
      rootDir: "/repo",
      base: "a",
      head: "b",
      excludeSpecs: ["**/smoke*.spec.ts"],
    });
    expect(r.selected).toEqual([]);
    expect(r.excludedSpecFiles).toEqual(["e2e/smoke.spec.ts"]);
    // POST /api/bugs is NOT in uncoveredEndpoints — smoke covered it, exclusion
    // doesn't retroactively un-cover it.
    expect(r.uncoveredEndpoints).not.toContain("POST /api/bugs");
  });

  it("supports multiple glob patterns", () => {
    const map = makeMap({
      specs: [
        {
          framework: "playwright",
          file: "e2e/bugs.spec.ts",
          name: "real",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
        {
          framework: "playwright",
          file: "e2e/smoke.spec.ts",
          name: "s",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
        {
          framework: "playwright",
          file: "e2e/error-states.spec.ts",
          name: "e",
          routesCovered: [],
          endpointsCovered: ["POST /api/bugs"],
          hasSharedSetup: false,
          flowAnnotations: [],
        },
      ],
    });
    stub(map, ["app/api/bugs/route.ts"]);
    const r = runSelect({
      rootDir: "/repo",
      base: "a",
      head: "b",
      excludeSpecs: ["**/smoke*.spec.ts", "**/error-states*.spec.ts"],
    });
    expect(r.selected.map((s) => s.file)).toEqual(["e2e/bugs.spec.ts"]);
    expect(r.excludedSpecFiles.sort()).toEqual(["e2e/error-states.spec.ts", "e2e/smoke.spec.ts"]);
  });

  it("no exclusion patterns = no specs excluded", () => {
    stub(mapWithSmoke(), ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    expect(r.excludedSpecFiles).toEqual([]);
    expect(r.selected).toHaveLength(2);
  });

  it("excludes show up in the markdown summary footer", () => {
    stub(mapWithSmoke(), ["app/api/bugs/route.ts"]);
    const r = runSelect({
      rootDir: "/repo",
      base: "a",
      head: "b",
      excludeSpecs: ["**/smoke*.spec.ts"],
    });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("1 spec file(s) excluded");
  });
});

describe("formatSelectionMarkdown", () => {
  it("renders selected files + test names + Playwright run command", () => {
    stub(makeMap(), ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("e2e/bugs.spec.ts");
    expect(md).toContain("creates a bug");
    expect(md).toContain("lists bugs");
    expect(md).toContain('npx playwright test --grep "creates a bug|lists bugs"');
  });

  it("renders shared-setup note instead of a grep when applicable", () => {
    stub(makeMap(), ["app/checkout/page.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("shared setup — whole file runs");
    expect(md).not.toContain("--grep");
  });

  it("renders coverage gaps when there are no covering specs", () => {
    const map = makeMap({ specs: [] });
    stub(map, ["app/checkout/page.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("⚠️ Coverage gaps");
    expect(md).toContain("/checkout");
  });

  it("renders a friendly clean-diff message when no routes/endpoints are touched", () => {
    const map = makeMap({ specs: [] });
    stub(map, [".github/workflows/claudia-verify.yml"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("✅ Clean diff");
    expect(md).toContain("1 file changed");
    expect(md).toContain(".github/workflows/claudia-verify.yml");
    expect(md).not.toContain("No covering specs"); // old phrasing
  });
});

describe("runSelect — selection rationale", () => {
  it("records the diff file responsible for each route-implicated spec", () => {
    const map = makeMap();
    // Wire the checkout page to also reach a shared component, so we can
    // verify that the join keeps only the file that actually touched it.
    map.routes = [
      { route: "/checkout", files: ["app/checkout/page.tsx", "components/rich-text-editor.tsx"] },
      { route: "/about", files: ["app/about/page.tsx", "components/rich-text-editor.tsx"] },
    ];
    stub(map, ["components/rich-text-editor.tsx"]);

    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    // Both the checkout and about specs should be selected (both routes
    // reachable from the changed component), with the rationale naming
    // the component as the responsible diff file.
    const checkout = r.selected.find((s) => s.file === "e2e/checkout.spec.ts");
    expect(checkout).toBeDefined();
    expect(checkout!.reasons).toEqual([
      { flow: "/checkout", kind: "route", via: ["components/rich-text-editor.tsx"] },
    ]);
    const about = r.selected.find((s) => s.file === "cypress/e2e/about.cy.ts");
    expect(about).toBeDefined();
    expect(about!.reasons).toEqual([
      { flow: "/about", kind: "route", via: ["components/rich-text-editor.tsx"] },
    ]);
  });

  it("records the endpoint file for endpoint-implicated specs", () => {
    stub(makeMap(), ["app/api/bugs/route.ts"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const bugs = r.selected.find((s) => s.file === "e2e/bugs.spec.ts")!;
    expect(bugs.reasons).toEqual([
      { flow: "POST /api/bugs", kind: "endpoint", via: ["app/api/bugs/route.ts"] },
    ]);
  });

  it("renders the rationale in formatSelectionMarkdown", () => {
    const map = makeMap();
    map.routes = [
      { route: "/checkout", files: ["app/checkout/page.tsx", "components/rich-text-editor.tsx"] },
    ];
    stub(map, ["components/rich-text-editor.tsx"]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("_Selected because:_");
    expect(md).toContain("covers `/checkout`");
    expect(md).toContain("`components/rich-text-editor.tsx`");
  });

  it("collapses multi-file reasons into a short summary", () => {
    const map = makeMap();
    map.routes = [
      {
        route: "/checkout",
        files: [
          "app/checkout/page.tsx",
          "components/a.tsx",
          "components/b.tsx",
          "components/c.tsx",
          "components/d.tsx",
        ],
      },
    ];
    stub(map, [
      "components/a.tsx",
      "components/b.tsx",
      "components/c.tsx",
      "components/d.tsx",
    ]);
    const r = runSelect({ rootDir: "/repo", base: "a", head: "b" });
    const md = formatSelectionMarkdown(r, { base: "a", head: "b" });
    expect(md).toContain("4 files: components/a.tsx, components/b.tsx, components/c.tsx, …");
  });
});
