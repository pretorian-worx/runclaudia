import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildNextMap } from "../src/adapters/nextjs.js";

const FIXTURE = resolve(__dirname, "../../../examples/nextjs-fixture");

describe("buildNextMap (Next.js App Router)", () => {
  it("discovers routes from app/ directory", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const routes = map.routes.map((r) => r.route).sort();
    expect(routes).toEqual(["/", "/about", "/checkout"]);
  });

  it("traces page imports into reachable files", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const checkout = map.routes.find((r) => r.route === "/checkout");
    expect(checkout).toBeDefined();
    expect(checkout!.files.some((f) => f.endsWith("CheckoutButton.tsx"))).toBe(true);
    expect(checkout!.files.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  it("attributes layout imports (Header) to every route", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    for (const r of map.routes) {
      expect(r.files.some((f) => f.endsWith("Header.tsx"))).toBe(true);
    }
  });

  it("resolves tsconfig path aliases (@/* → ./app/*)", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const about = map.routes.find((r) => r.route === "/about");
    expect(about).toBeDefined();
    expect(about!.files.some((f) => f.endsWith("AboutBlurb.tsx"))).toBe(true);
  });

  it("populates reverse index fileToRoutes", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const headerKey = Object.keys(map.fileToRoutes).find((k) => k.endsWith("Header.tsx"));
    expect(headerKey).toBeDefined();
    expect(map.fileToRoutes[headerKey!]!.sort()).toEqual(["/", "/about", "/checkout"]);
    const buttonKey = Object.keys(map.fileToRoutes).find((k) => k.endsWith("CheckoutButton.tsx"));
    expect(map.fileToRoutes[buttonKey!]).toEqual(["/checkout"]);
  });

  it("discovers App Router route.ts endpoints with HTTP methods", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const bugs = map.endpoints.filter((e) => e.path === "/api/bugs");
    const methods = bugs.map((e) => e.method).sort();
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("infers body shape from req.json() / req.formData()", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const post = map.endpoints.find((e) => e.path === "/api/bugs" && e.method === "POST");
    expect(post?.bodyShape).toBe("json");
    const get = map.endpoints.find((e) => e.path === "/api/bugs" && e.method === "GET");
    expect(get?.bodyShape).toBeNull();
    const upload = map.endpoints.find((e) => e.path === "/api/upload" && e.method === "POST");
    expect(upload?.bodyShape).toBe("formData");
  });

  it("attributes endpoints back through fileToRoutes with method-prefixed keys", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const bugsRoute = Object.keys(map.fileToRoutes).find((k) => k.endsWith("api/bugs/route.ts"));
    expect(bugsRoute).toBeDefined();
    expect(map.fileToRoutes[bugsRoute!]!.sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);
  });
});
