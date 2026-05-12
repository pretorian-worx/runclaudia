import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../src/config.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "claudia-config-"));
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("loadConfig", () => {
  it("loads a valid claudia.config.mjs", async () => {
    const cwd = tmpRepo();
    writeFileSync(
      join(cwd, "claudia.config.mjs"),
      `export default { select: { excludeSpecs: ["**/smoke*.spec.ts"] } };`,
      "utf8",
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.select?.excludeSpecs).toEqual(["**/smoke*.spec.ts"]);
  });

  it("returns {} silently when no config file exists", async () => {
    const cwd = tmpRepo();
    const cfg = await loadConfig(cwd);
    expect(cfg).toEqual({});
    expect(stderrText()).toBe("");
  });

  it("warns to stderr instead of silently swallowing a parse failure", async () => {
    const cwd = tmpRepo();
    writeFileSync(
      join(cwd, "claudia.config.mjs"),
      `this is not valid javascript {`,
      "utf8",
    );
    const cfg = await loadConfig(cwd);
    expect(cfg).toEqual({});
    expect(stderrText()).toContain("found claudia.config.mjs but failed to load it");
  });

  it("emits a TypeScript-specific hint when a .ts config can't be loaded", async () => {
    // Use a TypeScript construct that requires a real transformer to handle
    // (not just type-stripping). `namespace` has no runtime form and Node's
    // built-in TS support rejects it. Some Node versions DO parse plain .ts
    // syntactically — that's fine, the hint only fires when loading actually
    // fails, which is the correct behaviour.
    const cwd = tmpRepo();
    // Deliberately invalid syntax — vanilla Node and any TS-stripper both
    // reject this, so the .ts-hint path is reliably exercised regardless of
    // the Node version running the test.
    writeFileSync(
      join(cwd, "claudia.config.ts"),
      `import {} from\nexport default { broken `,
      "utf8",
    );
    const cfg = await loadConfig(cwd);
    expect(cfg).toEqual({});
    const err = stderrText();
    expect(err).toContain("found claudia.config.ts but failed to load it");
    expect(err).toContain("TypeScript configs require a TS-aware loader");
    expect(err).toContain("claudia.config.mjs");
  });

  it("falls through to the next candidate if an earlier one fails", async () => {
    // Both .ts and .mjs exist. The .ts will fail (vanilla Node can't parse
    // TS syntax), but the .mjs should be loaded as the fallback.
    const cwd = tmpRepo();
    writeFileSync(
      join(cwd, "claudia.config.ts"),
      `export default { select: { excludeSpecs: ["FROM_TS"] } } satisfies unknown;`,
      "utf8",
    );
    writeFileSync(
      join(cwd, "claudia.config.mjs"),
      `export default { select: { excludeSpecs: ["FROM_MJS"] } };`,
      "utf8",
    );
    const cfg = await loadConfig(cwd);
    // .mjs comes before .ts in the candidate order — it should load directly
    // without anything failing. (We've also ensured .mjs is tried first.)
    expect(cfg.select?.excludeSpecs).toEqual(["FROM_MJS"]);
    // No warnings emitted since .mjs loaded first and we never tried .ts.
    expect(stderrText()).toBe("");
  });
});
