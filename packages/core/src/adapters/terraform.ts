import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { InfraEntry } from "../types.js";

export interface TerraformDiscoveryOptions {
  rootDir: string;
  /** Directories to ignore while walking. */
  ignore?: string[];
  /** Max recursion depth. */
  maxDepth?: number;
}

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".terraform",
  ".turbo",
  "coverage",
]);

// `resource "aws_s3_bucket" "attachments" {`  (block opener; we don't parse the body).
const RESOURCE_RE = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;

/**
 * Walk the project root looking for *.tf files and extract resource declarations.
 * Regex-based — does not parse HCL fully. Handles 95% of vanilla resource blocks;
 * misses dynamic blocks, for_each, count, modules, locals, etc.
 */
export function discoverTerraformResources(opts: TerraformDiscoveryOptions): {
  infra: InfraEntry[];
  fileToInfra: Record<string, string[]>;
} {
  const rootDir = opts.rootDir;
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignore ?? [])]);
  const maxDepth = opts.maxDepth ?? 8;
  const infra: InfraEntry[] = [];
  const fileToInfra: Record<string, string[]> = {};

  walk(rootDir, rootDir, ignore, maxDepth, infra, fileToInfra);

  // Stable order — easier to diff cached maps + nicer prompt output.
  infra.sort((a, b) => a.address.localeCompare(b.address));
  for (const k of Object.keys(fileToInfra)) {
    fileToInfra[k] = Array.from(new Set(fileToInfra[k]!)).sort();
  }

  return { infra, fileToInfra };
}

function walk(
  dir: string,
  rootDir: string,
  ignore: Set<string>,
  depthLeft: number,
  infra: InfraEntry[],
  fileToInfra: Record<string, string[]>,
): void {
  if (depthLeft <= 0) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip dotfiles/dirs entirely. .terraform/.git/etc. are also in DEFAULT_IGNORE
    // but this catches anything else (.idea, .vscode, etc.).
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name)) continue;
      walk(abs, rootDir, ignore, depthLeft - 1, infra, fileToInfra);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".tf")) continue;

    const relFile = toRel(rootDir, abs);
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    RESOURCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RESOURCE_RE.exec(src))) {
      const type = m[1]!;
      const name = m[2]!;
      const address = `${type}.${name}`;
      infra.push({ tool: "terraform", type, name, address, file: relFile });
      (fileToInfra[relFile] ??= []).push(address);
    }
  }
}

function toRel(rootDir: string, p: string): string {
  return relative(rootDir, p).split(sep).join("/");
}
