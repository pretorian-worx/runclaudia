import { z } from "zod";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
  hunks: string[];
  binary: boolean;
}

export interface Diff {
  base: string;
  head: string;
  files: FileChange[];
}

export interface RouteEntry {
  route: string;
  files: string[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface EndpointEntry {
  /** URL path including the method prefix, e.g. "POST /api/bugs/move" */
  route: string;
  /** Bare URL path, e.g. "/api/bugs/move" */
  path: string;
  method: HttpMethod;
  /** Source file that defines this handler. */
  file: string;
  /** Best-effort guess at the request body shape, e.g. "json", "formData", "text", or null if no body parsing detected. */
  bodyShape: "json" | "formData" | "text" | "arrayBuffer" | null;
  /** Files statically detected to call this endpoint (fetch/axios/SWR). Best-effort. */
  callers: string[];
  /**
   * Cloud services this endpoint touches, inferred from `@aws-sdk/client-*`
   * imports in the handler source. E.g. ["s3", "dynamodb"]. Best-effort.
   */
  services: string[];
  /**
   * Database model/table names this endpoint touches, inferred from ORM
   * client usage in the handler source (e.g. `prisma.bug.create(...)` →
   * `["Bug"]`). Names are the canonical schema-side names. Best-effort.
   */
  tables: string[];
}

export interface DbModelEntry {
  /** ORM that owns this model. */
  orm: "prisma";
  /** Canonical model name as declared in the schema (PascalCase for Prisma). */
  name: string;
  /** Schema file that declares this model. */
  file: string;
}

export interface SpecEntry {
  /** Test framework this spec was written for. */
  framework: "playwright" | "cypress";
  /** Spec file (relative to rootDir). */
  file: string;
  /** Test name from `test("name", ...)` / `it("name", ...)`. */
  name: string;
  /** URL paths the spec visits (page.goto, cy.visit). */
  routesCovered: string[];
  /** Method-prefixed endpoint routes the spec calls directly (e.g. "POST /api/bugs"). */
  endpointsCovered: string[];
  /**
   * True if the spec lives inside a describe block with a beforeAll / before()
   * hook — selecting one test from such a block requires running the whole
   * describe to honor the setup. Flagged for downstream Stage C selection logic.
   */
  hasSharedSetup: boolean;
  /** Explicit `// @claudia flow: <name>` annotation overriding heuristic coverage. */
  flowAnnotations: string[];
}

export interface InfraEntry {
  /** IaC tool that defines this resource. */
  tool: "terraform";
  /** Terraform resource type, e.g. "aws_s3_bucket". */
  type: string;
  /** Local name from the resource declaration, e.g. "attachments". */
  name: string;
  /** Address-style identifier, e.g. "aws_s3_bucket.attachments". */
  address: string;
  /** File that declares this resource. */
  file: string;
}

export interface AppMap {
  framework: "nextjs-app" | "unknown";
  generatedAt: string;
  rootDir: string;
  routes: RouteEntry[];
  endpoints: EndpointEntry[];
  infra: InfraEntry[];
  dbModels: DbModelEntry[];
  specs: SpecEntry[];
  fileToRoutes: Record<string, string[]>;
  /** Reverse index: file path → endpoint route strings (e.g. "POST /api/bugs") that file calls. */
  fileToEndpoints: Record<string, string[]>;
  /** Reverse index: file path → infra resource addresses declared in that file. */
  fileToInfra: Record<string, string[]>;
  /** Reverse index: file path → DB model names declared in that file. */
  fileToTables: Record<string, string[]>;
  /** Reverse index: spec file path → list of test names declared in that file. */
  fileToSpecs: Record<string, string[]>;
}

export const PlanFlowSchema = z.object({
  name: z.string().describe("Short user-facing name of the flow, e.g. 'Checkout' or 'Sign-in'"),
  routes: z.array(z.string()).describe("URL paths the flow exercises"),
  risk: z.enum(["low", "medium", "high"]),
  reasoning: z.string().describe("Why this flow is implicated by the diff. Cite specific files."),
  suggestedChecks: z.array(z.string()).describe("Concrete checks a tester should perform"),
});

export const PlanSchema = z.object({
  verdict: z.enum(["test", "skip"]),
  skipReason: z.string().optional(),
  summary: z.string().describe("One-paragraph summary of what changed and what to test"),
  flows: z.array(PlanFlowSchema),
  unmappedFiles: z.array(z.string()).describe("Changed files not associated with any known flow"),
  coverageGaps: z.array(z.string()).describe("Risks not covered by any inferred flow"),
});

export type PlanFlow = z.infer<typeof PlanFlowSchema>;
export type Plan = z.infer<typeof PlanSchema>;
