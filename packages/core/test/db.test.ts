import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { detectPrismaTableUsage, discoverPrismaModels } from "../src/adapters/prisma.js";
import { buildNextMap } from "../src/adapters/nextjs.js";

const FIXTURE = resolve(__dirname, "../../../examples/nextjs-fixture");

describe("discoverPrismaModels", () => {
  it("finds models in prisma/schema.prisma", () => {
    const { dbModels, fileToTables } = discoverPrismaModels({ rootDir: FIXTURE });
    expect(dbModels.map((m) => m.name).sort()).toEqual(["Bug", "Workspace"]);
    const schemaKey = Object.keys(fileToTables).find((k) => k.endsWith("schema.prisma"));
    expect(schemaKey).toBeDefined();
    expect(fileToTables[schemaKey!]!.sort()).toEqual(["Bug", "Workspace"]);
  });

  it("returns empty when there's no schema", () => {
    const { dbModels } = discoverPrismaModels({ rootDir: resolve(__dirname) });
    expect(dbModels).toEqual([]);
  });
});

describe("detectPrismaTableUsage", () => {
  const known = ["Bug", "Workspace", "User"];

  it("matches prisma.<model>.<op>() calls", () => {
    const src = `
      const bug = await prisma.bug.create({ data: {} });
      await prisma.workspace.findMany();
    `;
    expect(detectPrismaTableUsage(src, known)).toEqual(["Bug", "Workspace"]);
  });

  it("matches db.<model> aliases", () => {
    const src = `await db.bug.delete({ where: { id } });`;
    expect(detectPrismaTableUsage(src, known)).toEqual(["Bug"]);
  });

  it("matches tx.<model> transactional aliases", () => {
    const src = `prisma.$transaction(async (tx) => { await tx.user.update({}); })`;
    expect(detectPrismaTableUsage(src, known)).toEqual(["User"]);
  });

  it("deduplicates and returns canonical names sorted", () => {
    const src = `
      prisma.bug.findMany();
      db.bug.create({});
      prisma.workspace.findUnique({});
    `;
    expect(detectPrismaTableUsage(src, known)).toEqual(["Bug", "Workspace"]);
  });

  it("ignores access to unknown identifiers (e.g. prisma.$transaction)", () => {
    const src = `
      prisma.$transaction([]);
      prisma.$queryRaw\`SELECT 1\`;
      prisma.notARealModel.findMany();
    `;
    expect(detectPrismaTableUsage(src, known)).toEqual([]);
  });

  it("returns empty when knownModels is empty (no schema)", () => {
    expect(detectPrismaTableUsage(`prisma.bug.findMany()`, [])).toEqual([]);
  });
});

describe("buildNextMap — DB schema integration", () => {
  it("populates dbModels and fileToTables", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    expect(map.dbModels.map((m) => m.name).sort()).toEqual(["Bug", "Workspace"]);
    expect(Object.keys(map.fileToTables).some((k) => k.endsWith("schema.prisma"))).toBe(true);
  });

  it("tags bugs endpoint with Bug after schema-aware second pass", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const get = map.endpoints.find((e) => e.path === "/api/bugs" && e.method === "GET");
    const post = map.endpoints.find((e) => e.path === "/api/bugs" && e.method === "POST");
    expect(get?.tables).toEqual(["Bug"]);
    expect(post?.tables).toEqual(["Bug"]);
  });

  it("leaves endpoints without ORM usage with empty tables", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const upload = map.endpoints.find((e) => e.path === "/api/upload" && e.method === "POST");
    expect(upload?.tables).toEqual([]);
  });
});
