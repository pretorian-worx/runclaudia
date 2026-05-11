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
    expect(md).toContain("No covering specs");
    expect(md).toContain("/checkout");
  });
});
