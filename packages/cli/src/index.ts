#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import {
  formatSelectionMarkdown,
  loadOrBuildMap,
  PlannerError,
  runPlan,
  runSelect,
} from "@claudia/core";
import { formatJson, formatMarkdown } from "./format.js";
import { loadConfig } from "./config.js";
import { aggregateRatings, formatRatings } from "./ratings.js";

const planCmd = defineCommand({
  meta: { name: "plan", description: "Produce a diff-aware test plan" },
  args: {
    base: { type: "string", required: true, description: "Base ref (e.g. main or a SHA)" },
    head: { type: "string", default: "HEAD", description: "Head ref" },
    cwd: { type: "string", description: "Project root directory" },
    target: { type: "string", description: "Deployed URL the plan will reference" },
    json: { type: "boolean", description: "Emit JSON instead of markdown" },
    model: { type: "string", description: "Override the planner model" },
    output: { type: "string", description: "Write output to a file as well as stdout" },
    "refresh-map": { type: "boolean", description: "Force a fresh route-map build" },
  },
  async run({ args }) {
    const rootDir = resolve(args.cwd ?? process.cwd());
    const cfg = await loadConfig(rootDir);

    let result;
    try {
      result = await runPlan({
        rootDir: cfg.rootDir ? resolve(rootDir, cfg.rootDir) : rootDir,
        base: args.base,
        head: args.head,
        targetUrl: args.target,
        refreshMap: Boolean(args["refresh-map"]),
        model: args.model ?? cfg.model,
      });
    } catch (err) {
      if (err instanceof PlannerError) {
        process.stderr.write(`claudia: ${err.message}\n`);
        process.stderr.write(JSON.stringify(err.details, null, 2) + "\n");
        process.exit(2);
      }
      throw err;
    }

    const text = args.json ? formatJson(result) : formatMarkdown(result);
    process.stdout.write(text + "\n");
    if (args.output) writeFileSync(resolve(args.output), text + "\n", "utf8");

    if (result.plan.verdict === "skip") process.exit(0);
  },
});

const mapCmd = defineCommand({
  meta: { name: "map", description: "Build or inspect the route map" },
  args: {
    cwd: { type: "string", description: "Project root directory" },
    refresh: { type: "boolean", description: "Rebuild even if cache is fresh" },
    json: { type: "boolean", description: "Print full map as JSON" },
  },
  async run({ args }) {
    const rootDir = resolve(args.cwd ?? process.cwd());
    const map = loadOrBuildMap({ rootDir, refresh: Boolean(args.refresh) });
    if (args.json) {
      process.stdout.write(JSON.stringify(map, null, 2) + "\n");
      return;
    }
    process.stdout.write(`framework: ${map.framework}\nroutes: ${map.routes.length}\n`);
    for (const r of map.routes) process.stdout.write(`  ${r.route}  (${r.files.length} files)\n`);
  },
});

const selectCmd = defineCommand({
  meta: {
    name: "select",
    description:
      "Pick the subset of the user's existing Playwright/Cypress specs that cover the routes/endpoints implicated by a diff. Intended for post-deploy verification workflows.",
  },
  args: {
    base: { type: "string", required: true, description: "Base ref (the last-deployed SHA)" },
    head: { type: "string", default: "HEAD", description: "Head ref (the just-deployed SHA)" },
    cwd: { type: "string", description: "Project root directory" },
    json: { type: "boolean", description: "Emit JSON instead of markdown" },
    "refresh-map": { type: "boolean", description: "Force a fresh map build" },
    "grep-only": {
      type: "boolean",
      description: "Print just the Playwright --grep pattern (empty if no eligible specs)",
    },
    "files-only": {
      type: "boolean",
      description: "Print just the selected spec file paths, one per line",
    },
  },
  run({ args }) {
    const rootDir = resolve(args.cwd ?? process.cwd());
    const result = runSelect({
      rootDir,
      base: args.base,
      head: args.head,
      refreshMap: Boolean(args["refresh-map"]),
    });

    if (args["grep-only"]) {
      process.stdout.write((result.playwrightGrep ?? "") + "\n");
      return;
    }
    if (args["files-only"]) {
      for (const s of result.selected) process.stdout.write(s.file + "\n");
      return;
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      formatSelectionMarkdown(result, { base: args.base, head: args.head }) + "\n",
    );
  },
});

const ratingsCmd = defineCommand({
  meta: { name: "ratings", description: "Aggregate 👍/👎 reactions on claudia comments across a repo's PRs" },
  args: {
    repo: { type: "string", required: true, description: "owner/name (e.g. pretorian-worx/runclaudia)" },
    limit: { type: "string", description: "Max PRs to scan (default 100)" },
    state: { type: "string", description: "open | closed | all (default all)" },
    json: { type: "boolean", description: "Emit JSON instead of markdown" },
  },
  run({ args }) {
    const state = args.state as "open" | "closed" | "all" | undefined;
    if (state && !["open", "closed", "all"].includes(state)) {
      process.stderr.write(`Invalid --state: ${state}\n`);
      process.exit(2);
    }
    const summary = aggregateRatings({
      repo: args.repo,
      limit: args.limit ? parseInt(args.limit, 10) : undefined,
      state,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      process.stdout.write(formatRatings(summary) + "\n");
    }
  },
});

const main = defineCommand({
  meta: { name: "claudia", description: "Diff-aware post-deploy test agent" },
  subCommands: { plan: planCmd, map: mapCmd, select: selectCmd, ratings: ratingsCmd },
});

runMain(main);
