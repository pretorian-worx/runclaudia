import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSpecs } from "../src/adapters/specs.js";
import { buildNextMap } from "../src/adapters/nextjs.js";

const FIXTURE = resolve(__dirname, "../../../examples/nextjs-fixture");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "claudia-specs-"));
}

describe("discoverSpecs — fixture", () => {
  it("finds both Playwright tests in e2e/bugs.spec.ts", () => {
    const { specs, fileToSpecs } = discoverSpecs({ rootDir: FIXTURE });
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.name).sort()).toEqual([
      "creates a bug via the API",
      "loads the bug list",
    ]);
    const file = Object.keys(fileToSpecs).find((k) => k.endsWith("bugs.spec.ts"));
    expect(file).toBeDefined();
    expect(fileToSpecs[file!]).toHaveLength(2);
  });

  it("captures route + endpoint coverage at file scope (aggregated across tests)", () => {
    // v1 design choice: coverage is per-file, not per-test. Every test in the
    // file shares the file's aggregate coverage. Per-test scoping needs function-
    // body parsing — deferred. Useful enough for "which spec file covers this."
    const { specs } = discoverSpecs({ rootDir: FIXTURE });
    const list = specs.find((s) => s.name === "loads the bug list")!;
    expect(list.routesCovered).toEqual(["/checkout"]);
    expect(list.endpointsCovered.sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);

    const create = specs.find((s) => s.name === "creates a bug via the API")!;
    expect(create.routesCovered).toEqual(["/checkout"]);
    expect(create.endpointsCovered.sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);
  });

  it("flags hasSharedSetup when beforeAll is present", () => {
    const { specs } = discoverSpecs({ rootDir: FIXTURE });
    expect(specs.every((s) => s.hasSharedSetup === true)).toBe(true);
  });

  it("picks up @claudia flow annotations", () => {
    const { specs } = discoverSpecs({ rootDir: FIXTURE });
    const create = specs.find((s) => s.name === "creates a bug via the API")!;
    expect(create.flowAnnotations).toEqual(["create-bug"]);
    const list = specs.find((s) => s.name === "loads the bug list")!;
    expect(list.flowAnnotations).toEqual(["create-bug"]); // annotations are file-level
  });

  it("infers framework from file location and source content", () => {
    const { specs } = discoverSpecs({ rootDir: FIXTURE });
    expect(specs.every((s) => s.framework === "playwright")).toBe(true);
  });
});

describe("discoverSpecs — Cypress", () => {
  it("detects cypress framework + cy.visit / cy.request patterns", () => {
    const root = tmpRepo();
    mkdirSync(join(root, "cypress", "e2e"), { recursive: true });
    writeFileSync(
      join(root, "cypress", "e2e", "checkout.cy.ts"),
      `
        describe("checkout", () => {
          before(() => { /* setup */ });
          it("completes purchase", () => {
            cy.visit("/checkout");
            cy.request("POST", "/api/orders");
          });
          it("handles object-style requests", () => {
            cy.request({ method: "PUT", url: "/api/orders/1" });
          });
        });
      `,
      "utf8",
    );
    const { specs } = discoverSpecs({ rootDir: root });
    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.framework === "cypress")).toBe(true);
    expect(specs.every((s) => s.hasSharedSetup === true)).toBe(true);
    const completes = specs.find((s) => s.name === "completes purchase")!;
    expect(completes.routesCovered).toEqual(["/checkout"]);
    expect(completes.endpointsCovered.sort()).toEqual(["POST /api/orders", "PUT /api/orders/1"]);
  });
});

describe("discoverSpecs — ignores non-spec content", () => {
  it("skips files in e2e/ that contain no test() blocks (helpers)", () => {
    const root = tmpRepo();
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(
      join(root, "e2e", "helpers.spec.ts"),
      `export function makeUser() { return { id: 1 }; }`,
      "utf8",
    );
    const { specs } = discoverSpecs({ rootDir: root });
    expect(specs).toEqual([]);
  });

  it("returns empty when there are no spec directories", () => {
    const root = tmpRepo();
    const { specs } = discoverSpecs({ rootDir: root });
    expect(specs).toEqual([]);
  });
});

describe("buildNextMap — spec indexing integration", () => {
  it("populates AppMap.specs from the fixture", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    expect(map.specs.length).toBe(2);
    expect(map.fileToSpecs).toBeDefined();
    expect(Object.keys(map.fileToSpecs).some((k) => k.endsWith("bugs.spec.ts"))).toBe(true);
  });
});
