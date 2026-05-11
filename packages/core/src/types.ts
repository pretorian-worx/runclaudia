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
}

export interface AppMap {
  framework: "nextjs-app" | "unknown";
  generatedAt: string;
  rootDir: string;
  routes: RouteEntry[];
  endpoints: EndpointEntry[];
  fileToRoutes: Record<string, string[]>;
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
