import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectSpecDir, openDraftPr } from "../src/pr.js";
import type { AppMap, GenerationResult } from "@pretorian-worx/runclaudia-core";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "claudia-pr-"));
}

function emptyMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    framework: "nextjs-app",
    generatedAt: "2026-05-13T00:00:00.000Z",
    rootDir: "/repo",
    routes: [],
    endpoints: [],
    infra: [],
    dbModels: [],
    specs: [],
    fileToRoutes: {},
    fileToEndpoints: {},
    fileToInfra: {},
    fileToTables: {},
    fileToSpecs: {},
    ...overrides,
  };
}

function genResult(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    generated: [],
    skippedFlows: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    outDir: "/x",
    ...overrides,
  };
}

describe("detectSpecDir", () => {
  it("picks the dirname that holds the most existing specs", () => {
    const m = emptyMap({
      specs: [
        { framework: "playwright", file: "e2e/a.spec.ts", name: "a", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
        { framework: "playwright", file: "e2e/b.spec.ts", name: "b", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
        { framework: "playwright", file: "tests/e2e/c.spec.ts", name: "c", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
      ],
    });
    expect(detectSpecDir(m)).toBe("e2e");
  });

  it("falls back to 'e2e' when the map has no specs", () => {
    expect(detectSpecDir(emptyMap())).toBe("e2e");
  });

  it("is deterministic on ties (lexicographic tie-break)", () => {
    const m = emptyMap({
      specs: [
        { framework: "playwright", file: "tests/e2e/a.spec.ts", name: "a", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
        { framework: "playwright", file: "e2e/b.spec.ts", name: "b", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
      ],
    });
    // 1 spec each → tie; "e2e" < "tests/e2e" lexicographically.
    expect(detectSpecDir(m)).toBe("e2e");
  });
});

describe("openDraftPr — no-passing-drafts short circuit", () => {
  it("does nothing when there are no drafts at all", () => {
    const cwd = tmpRepo();
    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult(),
      map: emptyMap(),
      headSha: "abc1234567890",
    });
    expect(result.status).toBe("no-passing-drafts");
    expect(result.movedFiles).toEqual([]);
  });

  it("does nothing when drafts exist but none passed against prod", () => {
    const cwd = tmpRepo();
    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult({
        generated: [
          {
            flow: "/x",
            filePath: "/tmp/x.spec.ts",
            fileRel: ".claudia/generated/x.spec.ts",
            contents: "test",
            reasoning: "r",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "failed", durationMs: 0, error: "boom" },
          },
        ],
      }),
      map: emptyMap(),
      headSha: "abc1234567890",
    });
    expect(result.status).toBe("no-passing-drafts");
  });
});

describe("openDraftPr — dry-run", () => {
  it("moves passing drafts into the team's spec dir and reports the planned commands", () => {
    const cwd = tmpRepo();
    // Set up the existing draft file (as if generate --run had written it).
    mkdirSync(join(cwd, ".claudia", "generated"), { recursive: true });
    const draftAbs = join(cwd, ".claudia", "generated", "checkout.spec.ts");
    writeFileSync(draftAbs, "// passing draft", "utf8");

    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult({
        generated: [
          {
            flow: "/checkout",
            filePath: draftAbs,
            fileRel: ".claudia/generated/checkout.spec.ts",
            contents: "// passing draft",
            reasoning: "verifies render",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "passed", durationMs: 1000 },
          },
        ],
      }),
      map: emptyMap({
        specs: [
          { framework: "playwright", file: "e2e/auth.spec.ts", name: "auth", routesCovered: [], endpointsCovered: [], hasSharedSetup: false, flowAnnotations: [] },
        ],
      }),
      headSha: "abc1234567890",
      dryRun: true,
    });

    expect(result.status).toBe("dry-run");
    // File moved into the team's spec dir.
    expect(result.movedFiles).toEqual(["e2e/checkout.spec.ts"]);
    expect(existsSync(join(cwd, "e2e", "checkout.spec.ts"))).toBe(true);
    expect(existsSync(draftAbs)).toBe(false); // removed from staging area
    // Branch name is deterministic on head SHA.
    expect(result.branchName).toBe("claudia/specs-abc1234");
    // Notes describe the planned actions.
    expect(result.notes.join("\n")).toContain(result.branchName!);
  });

  it("honors an explicit targetDir override", () => {
    const cwd = tmpRepo();
    mkdirSync(join(cwd, ".claudia", "generated"), { recursive: true });
    writeFileSync(join(cwd, ".claudia", "generated", "x.spec.ts"), "//", "utf8");

    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult({
        generated: [
          {
            flow: "/x",
            filePath: join(cwd, ".claudia", "generated", "x.spec.ts"),
            fileRel: ".claudia/generated/x.spec.ts",
            contents: "//",
            reasoning: "r",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "passed", durationMs: 100 },
          },
        ],
      }),
      map: emptyMap(),
      headSha: "deadbeefcafe",
      targetDir: "tests/e2e/claudia",
      dryRun: true,
    });

    expect(result.movedFiles).toEqual(["tests/e2e/claudia/x.spec.ts"]);
    expect(existsSync(join(cwd, "tests/e2e/claudia/x.spec.ts"))).toBe(true);
  });

  it("honors an explicit branchName override", () => {
    const cwd = tmpRepo();
    mkdirSync(join(cwd, ".claudia", "generated"), { recursive: true });
    writeFileSync(join(cwd, ".claudia", "generated", "y.spec.ts"), "//", "utf8");

    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult({
        generated: [
          {
            flow: "/y",
            filePath: join(cwd, ".claudia", "generated", "y.spec.ts"),
            fileRel: ".claudia/generated/y.spec.ts",
            contents: "//",
            reasoning: "r",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "passed", durationMs: 100 },
          },
        ],
      }),
      map: emptyMap(),
      headSha: "abc1234567890",
      branchName: "feat/my-custom-branch",
      dryRun: true,
    });

    expect(result.branchName).toBe("feat/my-custom-branch");
  });

  it("filters drafts by runOutcome — errored drafts are not PR'd", () => {
    const cwd = tmpRepo();
    mkdirSync(join(cwd, ".claudia", "generated"), { recursive: true });
    const passingPath = join(cwd, ".claudia", "generated", "good.spec.ts");
    const erroredPath = join(cwd, ".claudia", "generated", "bad.spec.ts");
    writeFileSync(passingPath, "//", "utf8");
    writeFileSync(erroredPath, "//", "utf8");

    const result = openDraftPr({
      rootDir: cwd,
      generation: genResult({
        generated: [
          {
            flow: "/good",
            filePath: passingPath,
            fileRel: ".claudia/generated/good.spec.ts",
            contents: "//",
            reasoning: "r",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "passed", durationMs: 100 },
          },
          {
            flow: "/bad",
            filePath: erroredPath,
            fileRel: ".claudia/generated/bad.spec.ts",
            contents: "//",
            reasoning: "r",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            runOutcome: { status: "errored", error: "playwright crashed" },
          },
        ],
      }),
      map: emptyMap(),
      headSha: "abc1234567890",
      dryRun: true,
    });

    expect(result.movedFiles).toHaveLength(1);
    expect(result.movedFiles[0]).toContain("good.spec.ts");
    // Errored draft stays where it was — not moved into the PR.
    expect(existsSync(erroredPath)).toBe(true);
  });
});
