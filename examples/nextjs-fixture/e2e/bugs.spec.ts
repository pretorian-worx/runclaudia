// @ts-nocheck — fixture spec; @playwright/test isn't installed in this minimal
// example, but the file's content is what the static analyzer parses.
import { test, expect } from "@playwright/test";

test.beforeAll(async () => {
  // Shared setup means selecting any single test from this file forces the
  // whole describe to run.
});

test("loads the bug list", async ({ page }) => {
  await page.goto("/checkout");
  const bugs = await page.request.get("/api/bugs");
  expect(bugs.status()).toBe(200);
});

// @claudia flow: create-bug
test("creates a bug via the API", async ({ page }) => {
  const res = await page.request.post("/api/bugs");
  expect(res.status()).toBe(201);
});
