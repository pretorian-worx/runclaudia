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
});
