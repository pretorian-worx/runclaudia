import { describe, expect, it } from "vitest";
import { classifySkip } from "../src/diff.js";
import type { Diff } from "../src/types.js";

function makeDiff(paths: string[]): Diff {
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

describe("classifySkip", () => {
  it("skips empty diffs", () => {
    expect(classifySkip({ base: "a", head: "b", files: [] }).skip).toBe(true);
  });

  it("skips docs-only diffs", () => {
    const r = classifySkip(makeDiff(["README.md", "docs/intro.mdx"]));
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/documentation/i);
  });

  it("skips lockfile-only diffs", () => {
    expect(classifySkip(makeDiff(["pnpm-lock.yaml"])).skip).toBe(true);
    expect(classifySkip(makeDiff(["package-lock.json", "yarn.lock"])).skip).toBe(true);
  });

  it("skips CI-only diffs", () => {
    expect(classifySkip(makeDiff([".github/workflows/ci.yml"])).skip).toBe(true);
  });

  it("does not skip mixed diffs that include real code", () => {
    expect(classifySkip(makeDiff(["README.md", "src/auth.ts"])).skip).toBe(false);
  });

  it("skips diffs that are exclusively trivial categories combined", () => {
    expect(classifySkip(makeDiff(["README.md", "pnpm-lock.yaml", ".github/workflows/ci.yml"])).skip).toBe(true);
  });

  it("skips test-only diffs", () => {
    expect(classifySkip(makeDiff(["src/foo.test.ts", "src/bar.spec.tsx"])).skip).toBe(true);
    expect(classifySkip(makeDiff(["__tests__/checkout.ts", "e2e/login.spec.ts"])).skip).toBe(true);
  });

  it("skips infra-only diffs", () => {
    expect(classifySkip(makeDiff(["infra/main.tf", "infra/variables.tfvars"])).skip).toBe(true);
    expect(classifySkip(makeDiff(["Dockerfile", "docker-compose.yml"])).skip).toBe(true);
  });

  it("skips asset-only diffs", () => {
    expect(classifySkip(makeDiff(["public/logo.png", "public/fonts/inter.woff2"])).skip).toBe(true);
  });

  it("does NOT skip when a test change is bundled with a code change", () => {
    expect(classifySkip(makeDiff(["src/foo.test.ts", "src/foo.ts"])).skip).toBe(false);
  });
});
