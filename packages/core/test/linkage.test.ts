import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNextMap, detectEndpointCalls, matchEndpoint } from "../src/adapters/nextjs.js";
import type { EndpointEntry } from "../src/types.js";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claudia-linkage-"));
  const abs = join(dir, name);
  writeFileSync(abs, content, "utf8");
  return abs;
}

const ep = (
  method: EndpointEntry["method"],
  path: string,
  file = "app/api/x/route.ts",
): EndpointEntry => ({
  route: `${method} ${path}`,
  path,
  method,
  file,
  bodyShape: null,
  callers: [],
  services: [],
});

describe("detectEndpointCalls", () => {
  it("detects fetch('/path') as GET by default", () => {
    const f = tmpFile("a.ts", `fetch("/api/bugs")`);
    expect(detectEndpointCalls(f)).toEqual([{ path: "/api/bugs", method: "GET" }]);
  });

  it("picks up method from the options object", () => {
    const f = tmpFile("a.ts", `fetch("/api/bugs", { method: "POST", body: "..." })`);
    expect(detectEndpointCalls(f)).toEqual([{ path: "/api/bugs", method: "POST" }]);
  });

  it("detects axios.get/post/etc.", () => {
    const f = tmpFile(
      "a.ts",
      `
      import axios from "axios";
      axios.get("/api/bugs");
      axios.post("/api/bugs", { title: "x" });
    `,
    );
    expect(detectEndpointCalls(f)).toEqual([
      { path: "/api/bugs", method: "GET" },
      { path: "/api/bugs", method: "POST" },
    ]);
  });

  it("detects useSWR('/path') as GET", () => {
    const f = tmpFile("a.ts", `const { data } = useSWR("/api/feature-flags")`);
    expect(detectEndpointCalls(f)).toEqual([{ path: "/api/feature-flags", method: "GET" }]);
  });

  it("detects template-literal paths with interpolation", () => {
    const f = tmpFile("a.ts", "fetch(`/api/bugs/${id}`)");
    expect(detectEndpointCalls(f)).toEqual([{ path: "/api/bugs/${id}", method: "GET" }]);
  });

  it("ignores absolute URLs and non-paths", () => {
    const f = tmpFile(
      "a.ts",
      `
      fetch("https://example.com/api");
      fetch("mailto:me@x.com");
      fetch("just-a-string");
    `,
    );
    expect(detectEndpointCalls(f)).toEqual([]);
  });
});

describe("matchEndpoint", () => {
  it("matches a static path exactly with method", () => {
    const endpoints = [ep("GET", "/api/bugs"), ep("POST", "/api/bugs")];
    expect(matchEndpoint({ path: "/api/bugs", method: "POST" }, endpoints).map((e) => e.route)).toEqual([
      "POST /api/bugs",
    ]);
  });

  it("matches a dynamic endpoint against a template-literal call site", () => {
    const endpoints = [ep("GET", "/api/bugs/:id"), ep("DELETE", "/api/bugs/:id")];
    expect(
      matchEndpoint({ path: "/api/bugs/${id}", method: "DELETE" }, endpoints).map((e) => e.route),
    ).toEqual(["DELETE /api/bugs/:id"]);
  });

  it("matches [bracket]-style endpoints from the App Router convention", () => {
    const endpoints = [ep("GET", "/api/bugs/[id]")];
    expect(matchEndpoint({ path: "/api/bugs/123", method: "GET" }, endpoints)).toHaveLength(1);
  });

  it("rejects path-length mismatches", () => {
    const endpoints = [ep("GET", "/api/bugs/:id")];
    expect(matchEndpoint({ path: "/api/bugs", method: "GET" }, endpoints)).toHaveLength(0);
    expect(matchEndpoint({ path: "/api/bugs/123/comments", method: "GET" }, endpoints)).toHaveLength(0);
  });
});

describe("buildNextMap — full fixture linkage", () => {
  const FIXTURE = join(__dirname, "..", "..", "..", "examples", "nextjs-fixture");

  it("links CheckoutButton.tsx to the bugs endpoint via static fetch detection", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const buttonKey = Object.keys(map.fileToEndpoints).find((k) =>
      k.endsWith("CheckoutButton.tsx"),
    );
    expect(buttonKey).toBeDefined();
    expect(map.fileToEndpoints[buttonKey!]!.sort()).toEqual(["GET /api/bugs", "POST /api/bugs"]);
  });

  it("records callers on the EndpointEntry side", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const postBugs = map.endpoints.find((e) => e.route === "POST /api/bugs");
    expect(postBugs).toBeDefined();
    expect(postBugs!.callers.some((c) => c.endsWith("CheckoutButton.tsx"))).toBe(true);
  });

  it("does not mark unrelated files as callers", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const headerCallers = map.endpoints.flatMap((e) => e.callers).filter((c) => c.endsWith("Header.tsx"));
    expect(headerCallers).toEqual([]);
  });
});
