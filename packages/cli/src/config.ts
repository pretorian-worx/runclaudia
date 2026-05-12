import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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

// Candidate filenames the loader tries, in order. `.mjs` and `.js` work on
// any modern Node out of the box. `.ts` is kept in the list because some
// users run claudia under a TS-aware loader (tsx, ts-node), but if Node
// can't parse it we warn clearly rather than failing silently — see the
// catch branch below.
const CANDIDATES = ["claudia.config.mjs", "claudia.config.js", "claudia.config.ts"];

export async function loadConfig(cwd: string): Promise<ClaudiaConfig> {
  for (const name of CANDIDATES) {
    const abs = resolve(cwd, name);
    if (!existsSync(abs)) continue;
    try {
      const mod = await import(pathToFileURL(abs).href);
      const cfg = (mod.default ?? mod) as ClaudiaConfig;
      return cfg ?? {};
    } catch (err) {
      // Don't silently swallow — surface the error so users can diagnose.
      // Continue trying remaining candidates: it's valid to have both a
      // .ts (which may fail) and a fallback .mjs that loads.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `claudia: found ${name} but failed to load it: ${msg}\n`,
      );
      if (name.endsWith(".ts")) {
        process.stderr.write(
          `claudia: TypeScript configs require a TS-aware loader (tsx, ts-node). ` +
            `For a vanilla Node install, use claudia.config.mjs with .mjs syntax instead.\n`,
        );
      }
    }
  }
  return {};
}
