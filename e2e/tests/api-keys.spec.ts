import { test, expect } from "@playwright/test";

test.describe("api keys", () => {
  test("add key", async ({ page }) => {
    await page.goto("/settings/keys");
    // The provider select and API key input should be visible
    await expect(page.locator("#provider")).toBeVisible();
    await expect(page.locator("#apiKey")).toBeVisible();
    // Fill in and save a key
    await page.locator("#provider").selectOption({ index: 1 });
    await page.locator("#apiKey").fill("sk-test-key-for-e2e");
    await page.getByRole("button", { name: /save/i }).click();
  });

  test("list keys", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.getByText(/your keys|api key/i)).toBeVisible();
  });

  test.fixme("delete key", async () => {
    // Requires pre-existing API key. Chain after "add key" or seed data.
  });
});
