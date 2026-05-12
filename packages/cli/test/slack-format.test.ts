import { describe, expect, it } from "vitest";
import { buildSlackPayload, type SlackPayloadInput } from "../src/slack-format.js";

function input(overrides: Partial<SlackPayloadInput> = {}): SlackPayloadInput {
  return {
    passed: true,
    passedCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

describe("buildSlackPayload — verdict header", () => {
  it("uses deploy-verified + check emoji on pass", () => {
    const p = buildSlackPayload(input({ passed: true, passedCount: 5 }));
    const header = p.blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("deploy-verified");
    expect(header.text.text).toContain(":white_check_mark:");
  });

  it("uses deploy-failed + x emoji on fail", () => {
    const p = buildSlackPayload(input({ passed: false, failedCount: 1 }));
    const header = p.blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("deploy-failed");
    expect(header.text.text).toContain(":x:");
  });
});

describe("buildSlackPayload — fallback text", () => {
  it("includes verdict + counts + repo for notification previews", () => {
    const p = buildSlackPayload(
      input({ passed: true, repo: "pretorian-worx/runclaudia", passedCount: 12, failedCount: 0 }),
    );
    expect(p.text).toContain("deploy-verified");
    expect(p.text).toContain("pretorian-worx/runclaudia");
    expect(p.text).toContain("12 passed");
    expect(p.text).toContain("0 failed");
  });

  it("works without a repo", () => {
    const p = buildSlackPayload(input({ passedCount: 1, failedCount: 0 }));
    expect(p.text).toMatch(/deploy-verified.*1 passed/);
  });
});

describe("buildSlackPayload — context line", () => {
  it("hyperlinks the target URL with scheme stripped from label", () => {
    const p = buildSlackPayload(
      input({ repo: "x/y", target: "https://app.example.com", passedCount: 1 }),
    );
    const ctx = p.blocks[1] as { elements: Array<{ text: string }> };
    expect(ctx.elements[0]!.text).toContain("<https://app.example.com|app.example.com>");
  });

  it("links the commit when commitUrl is provided", () => {
    const p = buildSlackPayload(
      input({ headSha: "abc1234567890", commitUrl: "https://github.com/x/y/commit/abc1234567890", passedCount: 1 }),
    );
    const ctx = p.blocks[1] as { elements: Array<{ text: string }> };
    expect(ctx.elements[0]!.text).toContain("<https://github.com/x/y/commit/abc1234567890|`abc1234`>");
  });

  it("falls back to bare short SHA when no commitUrl", () => {
    const p = buildSlackPayload(input({ headSha: "abc1234567890", passedCount: 1 }));
    const ctx = p.blocks[1] as { elements: Array<{ text: string }> };
    expect(ctx.elements[0]!.text).toContain("`abc1234`");
    expect(ctx.elements[0]!.text).not.toContain("<https://");
  });

  it("omits the context block entirely when nothing to show", () => {
    const p = buildSlackPayload(input({ passedCount: 1 }));
    // header, stats section, (maybe) actions — no context block.
    expect(p.blocks[1]).toMatchObject({ type: "section" });
  });
});

describe("buildSlackPayload — flows-tested line", () => {
  it("shows total + selected + generated breakdown when both present", () => {
    const p = buildSlackPayload(
      input({
        passedCount: 12,
        failedCount: 0,
        selectedSpecCount: 8,
        selectedTestCount: 30,
        generatedSpecCount: 4,
      }),
    );
    const flows = findField(p, "Flows tested");
    expect(flows).toContain("12");
    expect(flows).toContain("8 specs from suite");
    expect(flows).toContain("(30 tests)");
    expect(flows).toContain("4 generated");
  });

  it("shows just the total when no breakdown is available", () => {
    const p = buildSlackPayload(input({ passedCount: 3, failedCount: 1 }));
    const flows = findField(p, "Flows tested");
    expect(flows.trim().endsWith("4")).toBe(true);
  });

  it("singular spec/test wording for n=1", () => {
    const p = buildSlackPayload(
      input({ passedCount: 1, failedCount: 0, selectedSpecCount: 1, selectedTestCount: 1 }),
    );
    const flows = findField(p, "Flows tested");
    expect(flows).toContain("1 spec from suite");
    expect(flows).toContain("(1 test)");
  });
});

describe("buildSlackPayload — result line", () => {
  it("includes passed, failed, and duration", () => {
    const p = buildSlackPayload(input({ passedCount: 10, failedCount: 2, durationMs: 12500 }));
    const result = findField(p, "Result");
    expect(result).toBe("10 passed · 2 failed · 12.5s");
  });

  it("includes flaky and skipped only when nonzero", () => {
    const p = buildSlackPayload(
      input({ passedCount: 5, failedCount: 0, flakyCount: 1, skippedCount: 2 }),
    );
    const result = findField(p, "Result");
    expect(result).toContain("1 flaky");
    expect(result).toContain("2 skipped");

    const p2 = buildSlackPayload(input({ passedCount: 5, failedCount: 0 }));
    const result2 = findField(p2, "Result");
    expect(result2).not.toContain("flaky");
    expect(result2).not.toContain("skipped");
  });
});

describe("buildSlackPayload — failure blocks", () => {
  it("renders up to 3 failures with title + file + truncated error", () => {
    const failed = [
      { file: "e2e/a.spec.ts", title: "T1", error: "boom 1" },
      { file: "e2e/b.spec.ts", title: "T2", error: "boom 2" },
      { file: "e2e/c.spec.ts", title: "T3", error: "boom 3" },
      { file: "e2e/d.spec.ts", title: "T4", error: "boom 4" },
    ];
    const p = buildSlackPayload(input({ passed: false, failedCount: 4, failedTests: failed }));
    // Look for section blocks containing each failing title.
    const text = JSON.stringify(p.blocks);
    expect(text).toContain("T1");
    expect(text).toContain("T2");
    expect(text).toContain("T3");
    expect(text).not.toContain("T4");
    expect(text).toContain("…and 1 more failure");
  });

  it("escapes triple backticks in error text so the code block doesn't break", () => {
    const failed = [{ file: "f.spec.ts", title: "T", error: "stack ```nasty``` more" }];
    const p = buildSlackPayload(input({ passed: false, failedCount: 1, failedTests: failed }));
    const text = JSON.stringify(p.blocks);
    expect(text).not.toContain("```nasty```");
  });

  it("renders nothing when failedTests is empty or omitted", () => {
    const p = buildSlackPayload(input({ passed: true, passedCount: 5 }));
    const dividers = p.blocks.filter((b) => b.type === "divider");
    expect(dividers).toHaveLength(0);
  });
});

describe("buildSlackPayload — action buttons", () => {
  it("adds View run and View PR buttons when URLs are provided", () => {
    const p = buildSlackPayload(
      input({
        passedCount: 1,
        runUrl: "https://github.com/x/y/actions/runs/1",
        prUrl: "https://github.com/x/y/pull/42",
      }),
    );
    const actions = p.blocks.find((b) => b.type === "actions") as
      | { elements: Array<{ url: string; text: { text: string } }> }
      | undefined;
    expect(actions).toBeDefined();
    expect(actions!.elements).toHaveLength(2);
    expect(actions!.elements.map((e) => e.text.text)).toEqual(["View run", "View PR"]);
  });

  it("omits the action block entirely when no URLs are provided", () => {
    const p = buildSlackPayload(input({ passedCount: 1 }));
    const actions = p.blocks.find((b) => b.type === "actions");
    expect(actions).toBeUndefined();
  });
});

// ---------- helpers ----------

function findField(p: { blocks: Array<Record<string, unknown>> }, label: string): string {
  for (const block of p.blocks) {
    const fields = (block as { fields?: Array<{ text: string }> }).fields;
    if (!fields) continue;
    for (const f of fields) {
      if (f.text.startsWith(`*${label}*`)) {
        return f.text.replace(`*${label}*\n`, "");
      }
    }
  }
  throw new Error(`field "${label}" not found in payload`);
}
