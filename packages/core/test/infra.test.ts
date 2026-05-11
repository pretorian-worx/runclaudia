import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { discoverTerraformResources } from "../src/adapters/terraform.js";
import { buildNextMap, detectAwsServices } from "../src/adapters/nextjs.js";

const FIXTURE = resolve(__dirname, "../../../examples/nextjs-fixture");

describe("discoverTerraformResources", () => {
  it("finds aws_s3_bucket + dynamodb resources in the fixture's infra/", () => {
    const { infra, fileToInfra } = discoverTerraformResources({ rootDir: FIXTURE });
    const addresses = infra.map((r) => r.address).sort();
    expect(addresses).toEqual([
      "aws_dynamodb_table.attachments",
      "aws_s3_bucket.attachments",
      "aws_s3_bucket_versioning.attachments",
    ]);
    const tfFile = Object.keys(fileToInfra).find((k) => k.endsWith("infra/storage.tf"));
    expect(tfFile).toBeDefined();
    expect(fileToInfra[tfFile!]!.length).toBe(3);
  });

  it("returns empty when there are no .tf files in the tree", () => {
    const { infra } = discoverTerraformResources({ rootDir: resolve(__dirname) });
    expect(infra).toEqual([]);
  });
});

describe("detectAwsServices", () => {
  it("extracts service codes from @aws-sdk/client-* imports", () => {
    expect(
      detectAwsServices(`
        import { S3Client } from "@aws-sdk/client-s3";
        import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
      `),
    ).toEqual(["dynamodb", "s3"]);
  });

  it("returns empty when there are no aws-sdk imports", () => {
    expect(detectAwsServices(`import x from "y"; import z from "@aws-sdk/util";`)).toEqual([]);
  });

  it("deduplicates services across multiple imports of the same client", () => {
    expect(
      detectAwsServices(`
        import a from "@aws-sdk/client-s3";
        import b from "@aws-sdk/client-s3/dist/index.js";
      `),
    ).toEqual(["s3"]);
  });
});

describe("buildNextMap — infra + service integration", () => {
  it("populates AppMap.infra from the fixture's Terraform files", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    expect(map.infra.length).toBe(3);
    expect(map.infra.some((r) => r.type === "aws_s3_bucket" && r.name === "attachments")).toBe(true);
  });

  it("tags the attachments endpoint with s3 and dynamodb services", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const post = map.endpoints.find((e) => e.path === "/api/attachments" && e.method === "POST");
    expect(post).toBeDefined();
    expect(post!.services.sort()).toEqual(["dynamodb", "s3"]);
  });

  it("leaves non-AWS endpoints with empty services", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const bugs = map.endpoints.find((e) => e.path === "/api/bugs" && e.method === "GET");
    expect(bugs?.services).toEqual([]);
  });

  it("populates fileToInfra reverse index", () => {
    const map = buildNextMap({ rootDir: FIXTURE });
    const tfFile = Object.keys(map.fileToInfra).find((k) => k.endsWith("infra/storage.tf"));
    expect(tfFile).toBeDefined();
    expect(map.fileToInfra[tfFile!]).toContain("aws_s3_bucket.attachments");
  });
});
