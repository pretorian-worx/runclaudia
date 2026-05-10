import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildNextMap } from "./adapters/nextjs.js";
import type { AppMap } from "./types.js";

export interface MapOptions {
  rootDir: string;
  cachePath?: string;
  refresh?: boolean;
}

export function loadOrBuildMap(opts: MapOptions): AppMap {
  const rootDir = resolve(opts.rootDir);
  const cachePath = opts.cachePath ?? join(rootDir, ".claudia", "map.json");

  if (!opts.refresh && existsSync(cachePath)) {
    const cached = readMap(cachePath);
    if (cached && isFresh(cached, rootDir)) return cached;
  }

  const map = buildNextMap({ rootDir });
  writeMap(cachePath, map);
  return map;
}

export function readMap(path: string): AppMap | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as AppMap;
  } catch {
    return null;
  }
}

export function writeMap(path: string, map: AppMap): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n", "utf8");
}

function isFresh(map: AppMap, rootDir: string): boolean {
  const generatedAt = Date.parse(map.generatedAt);
  if (Number.isNaN(generatedAt)) return false;
  const tracked = new Set<string>(Object.keys(map.fileToRoutes));
  for (const file of tracked) {
    const abs = join(rootDir, file);
    if (!existsSync(abs)) return false;
    const mtime = statSync(abs).mtimeMs;
    if (mtime > generatedAt) return false;
  }
  return true;
}
