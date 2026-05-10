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
});
