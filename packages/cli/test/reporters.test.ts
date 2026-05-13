import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execMock(...args),
}));

const fetchMock = vi.fn();

import { dispatchReporters, type ReportContext } from "../src/reporters.js";

const baseCtx = (overrides: Partial<ReportContext> = {}): ReportContext => ({
  markdown: "## claudia — post-deploy verification\n✅ Pass — 2/2 passed",
  headSha: "abc1234567890",
  passed: true,
  ...overrides,
});

beforeEach(() => {
  execMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.CLAUDIA_SLACK_WEBHOOK;
  vi.unstubAllGlobals();
});

describe("step summary reporter", () => {
  it("appends markdown to $GITHUB_STEP_SUMMARY when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudia-rep-"));
    const file = join(dir, "summary.md");
    writeFileSync(file, "preexisting\n", "utf8");
    process.env.GITHUB_STEP_SUMMARY = file;

    await dispatchReporters(baseCtx());

    const content = readFileSync(file, "utf8");
    expect(content).toContain("preexisting");
    expect(content).toContain("✅ Pass");
  });

  it("skips silently when $GITHUB_STEP_SUMMARY is not set", async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    await expect(dispatchReporters(baseCtx())).resolves.toBeUndefined();
  });

  it("honors --no-step-summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudia-rep-"));
    const file = join(dir, "summary.md");
    writeFileSync(file, "untouched\n", "utf8");
    process.env.GITHUB_STEP_SUMMARY = file;

    await dispatchReporters(baseCtx(), { disableStepSummary: true });

    expect(readFileSync(file, "utf8")).toBe("untouched\n");
  });
});

describe("PR back-comment reporter", () => {
  it("posts a new sticky comment when none exists for the SHA's PR", async () => {
    process.env.GITHUB_REPOSITORY = "argilefocus/argile-focus-webapp";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("/commits/") && joined.includes("/pulls")) return "42";
      if (joined.includes("/comments") && args.includes("--paginate")) return "[]";
      if (joined.includes("/comments") && args.includes("-X")) return "{}";
      return "";
    });

    await dispatchReporters(baseCtx({ headSha: "abc" }));

    const postCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes("POST") && c[1].some((s: string) => s.includes(`/comments`)),
    );
    expect(postCall).toBeDefined();
  });

  it("updates the existing sticky comment when one is already on the PR", async () => {
    process.env.GITHUB_REPOSITORY = "argilefocus/argile-focus-webapp";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("/commits/") && joined.includes("/pulls")) return "42";
      if (joined.includes("/comments") && args.includes("--paginate")) {
        return JSON.stringify([{ id: 999, body: "<!-- claudia:verify -->\nold" }]);
      }
      if (joined.includes("/comments/999")) return "{}";
      return "";
    });

    await dispatchReporters(baseCtx({ headSha: "abc" }));

    const patchCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes("PATCH") && c[1].some((s: string) => s.includes("/comments/999")),
    );
    expect(patchCall).toBeDefined();
  });

  it("does nothing when the SHA has no associated PR", async () => {
    process.env.GITHUB_REPOSITORY = "argilefocus/argile-focus-webapp";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(" ").includes("/commits/")) return "null";
      return "";
    });
    await dispatchReporters(baseCtx({ headSha: "deadbeef" }));
    const postCalls = execMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/comments") && s !== "--jq"),
    );
    expect(postCalls).toHaveLength(0);
  });

  it("honors --no-pr-comment", async () => {
    process.env.GITHUB_REPOSITORY = "argilefocus/argile-focus-webapp";
    await dispatchReporters(baseCtx({ headSha: "abc" }), { disablePrComment: true });
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("Slack reporter", () => {
  it("POSTs the markdown to the webhook URL when set via flag", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    await dispatchReporters(baseCtx(), { slackWebhook: "https://hooks.slack.com/abc" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/abc",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.text).toContain("✅ Pass");
  });

  it("POSTs via CLAUDIA_SLACK_WEBHOOK env when no flag is given", async () => {
    process.env.CLAUDIA_SLACK_WEBHOOK = "https://hooks.slack.com/env";
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    await dispatchReporters(baseCtx());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hooks.slack.com/env");
  });

  it("skips silently when no webhook is configured", async () => {
    delete process.env.CLAUDIA_SLACK_WEBHOOK;
    await dispatchReporters(baseCtx());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs but does not throw on a non-2xx Slack response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "err" });
    await expect(
      dispatchReporters(baseCtx(), { slackWebhook: "https://hooks.slack.com/x" }),
    ).resolves.toBeUndefined();
  });
});

describe("GitHub check reporter", () => {
  it("posts a check-run via `gh api` when ctx.check is provided", async () => {
    process.env.GITHUB_REPOSITORY = "argilefocus/argile-focus-webapp";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      // The PR-lookup call goes to /commits/<sha>/pulls — return no PR so we
      // don't interfere with the PR-comment sink.
      if (args.join(" ").includes("/commits/")) return "null";
      return "";
    });

    await dispatchReporters(
      baseCtx({
        check: { passed: true, passedCount: 3, failedCount: 0, target: "https://app.example.com" },
      }),
    );

    const checkCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/check-runs")),
    );
    expect(checkCall).toBeDefined();
    const flatArgs = (checkCall![1] as string[]).join(" ");
    expect(flatArgs).toContain("POST");
    expect(flatArgs).toContain("/repos/argilefocus/argile-focus-webapp/check-runs");
    expect(flatArgs).toContain("name=claudia / deploy-verified");
    expect(flatArgs).toContain("head_sha=abc1234567890");
    expect(flatArgs).toContain("conclusion=success");
    expect(flatArgs).toContain("output[title]=3 tests passed against app.example.com");
  });

  it("posts conclusion=failure when the run failed", async () => {
    process.env.GITHUB_REPOSITORY = "x/y";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(" ").includes("/commits/")) return "null";
      return "";
    });

    await dispatchReporters(
      baseCtx({
        passed: false,
        check: { passed: false, passedCount: 1, failedCount: 2 },
      }),
    );

    const checkCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/check-runs")),
    );
    expect(checkCall).toBeDefined();
    expect((checkCall![1] as string[]).join(" ")).toContain("conclusion=failure");
  });

  it("skips when ctx.check is not provided", async () => {
    process.env.GITHUB_REPOSITORY = "x/y";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(" ").includes("/commits/")) return "null";
      return "";
    });
    await dispatchReporters(baseCtx());
    const checkCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/check-runs")),
    );
    expect(checkCall).toBeUndefined();
  });

  it("honors --no-check", async () => {
    process.env.GITHUB_REPOSITORY = "x/y";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(" ").includes("/commits/")) return "null";
      return "";
    });
    await dispatchReporters(
      baseCtx({ check: { passed: true, passedCount: 1, failedCount: 0 } }),
      { disableCheck: true },
    );
    const checkCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/check-runs")),
    );
    expect(checkCall).toBeUndefined();
  });

  it("skips when no repo can be detected", async () => {
    delete process.env.GITHUB_REPOSITORY;
    await dispatchReporters(
      baseCtx({ check: { passed: true, passedCount: 1, failedCount: 0 } }),
    );
    const checkCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].some((s: string) => s.includes("/check-runs")),
    );
    expect(checkCall).toBeUndefined();
  });

  it("does not throw when gh exits non-zero (e.g. missing `checks: write`)", async () => {
    process.env.GITHUB_REPOSITORY = "x/y";
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(" ").includes("/commits/")) return "null";
      if (args.join(" ").includes("/check-runs")) {
        throw new Error("HTTP 403: Resource not accessible by integration");
      }
      return "";
    });
    await expect(
      dispatchReporters(
        baseCtx({ check: { passed: true, passedCount: 1, failedCount: 0 } }),
      ),
    ).resolves.toBeUndefined();
  });
});
