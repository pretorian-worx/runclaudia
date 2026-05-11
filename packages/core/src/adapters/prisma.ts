import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DbModelEntry } from "../types.js";

export interface PrismaDiscoveryOptions {
  rootDir: string;
}

// `model NAME {` — Prisma models always start with an uppercase letter by convention,
// but the language allows lowercase too. We accept both.
const MODEL_RE = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;

/**
 * Discover Prisma models. Looks at the canonical locations:
 *   - <rootDir>/prisma/schema.prisma
 *   - <rootDir>/prisma/schema/*.prisma   (multi-file schema, Prisma 5+)
 *   - <rootDir>/schema.prisma            (less common, but supported)
 */
export function discoverPrismaModels(opts: PrismaDiscoveryOptions): {
  dbModels: DbModelEntry[];
  fileToTables: Record<string, string[]>;
} {
  const { rootDir } = opts;
  const candidates: string[] = [];

  const rootSchema = join(rootDir, "schema.prisma");
  if (existsSync(rootSchema)) candidates.push(rootSchema);

  const prismaDir = join(rootDir, "prisma");
  if (existsSync(prismaDir) && statSync(prismaDir).isDirectory()) {
    const single = join(prismaDir, "schema.prisma");
    if (existsSync(single)) candidates.push(single);

    const splitDir = join(prismaDir, "schema");
    if (existsSync(splitDir) && statSync(splitDir).isDirectory()) {
      for (const entry of readdirSync(splitDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".prisma")) {
          candidates.push(join(splitDir, entry.name));
        }
      }
    }
  }

  const dbModels: DbModelEntry[] = [];
  const fileToTables: Record<string, string[]> = {};

  for (const abs of candidates) {
    const relFile = relative(rootDir, abs).split(sep).join("/");
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    MODEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODEL_RE.exec(src))) {
      const name = m[1]!;
      dbModels.push({ orm: "prisma", name, file: relFile });
      (fileToTables[relFile] ??= []).push(name);
    }
  }

  // Stable ordering for diff-stable cached maps.
  dbModels.sort((a, b) => a.name.localeCompare(b.name));
  for (const k of Object.keys(fileToTables)) {
    fileToTables[k] = Array.from(new Set(fileToTables[k]!)).sort();
  }

  return { dbModels, fileToTables };
}

/**
 * Detect Prisma-style ORM access in a handler source. Matches `prisma.X.op(...)`,
 * `db.X.op(...)`, and `tx.X.op(...)` (transaction client). Returns canonical
 * model names by case-insensitive lookup against the known model list — Prisma
 * client usage is camelCase (`prisma.bug`) while the schema declares PascalCase
 * (`model Bug`), so we normalize.
 */
export function detectPrismaTableUsage(src: string, knownModels: string[]): string[] {
  if (knownModels.length === 0) return [];
  const knownByLower = new Map(knownModels.map((m) => [m.toLowerCase(), m]));
  const re = /\b(?:prisma|db|tx)\s*\.\s*([a-z][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_]\w*\s*\(/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const camel = m[1]!;
    const canonical = knownByLower.get(camel.toLowerCase());
    if (canonical) out.add(canonical);
  }
  return Array.from(out).sort();
}
