import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

export interface ClaudiaConfig {
  rootDir?: string;
  defaultBase?: string;
  model?: string;
  cachePath?: string;
  select?: {
    /**
     * Glob patterns (minimatch-style) for spec files to exclude from `claudia
     * select` / `claudia run`. Useful for cross-cutting smoke/error-state
     * suites that aren't tied to specific code paths and shouldn't be
     * pulled in by transitive reachability. See SelectOptions.excludeSpecs
     * in @pretorian-worx/runclaudia-core for full semantics.
     */
    excludeSpecs?: string[];
  };
}

const CANDIDATES = ["claudia.config.ts", "claudia.config.js", "claudia.config.mjs"];

export async function loadConfig(cwd: string): Promise<ClaudiaConfig> {
  for (const name of CANDIDATES) {
    const abs = resolve(cwd, name);
    if (!existsSync(abs)) continue;
    try {
      const mod = await import(pathToFileURL(abs).href);
      const cfg = (mod.default ?? mod) as ClaudiaConfig;
      return cfg ?? {};
    } catch {
      return {};
    }
  }
  void join;
  return {};
}
