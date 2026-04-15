import { test, expect } from "@playwright/test";

test.describe("api keys", () => {
  test("add key form visible", async ({ page }) => {
    await page.goto("/settings/keys");
    // Verify the add-key form is present with required fields
    await expect(page.locator("#provider")).toBeVisible();
    await expect(page.locator("#apiKey")).toBeVisible();
    await expect(page.getByRole("button", { name: /save/i })).toBeVisible();
  });

  test("list keys", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
    // The seeded API key should appear once loading completes
    await expect(page.getByText("...0000")).toBeVisible({ timeout: 10_000 });
  });

  test("revoke button visible", async ({ page }) => {
    await page.goto("/settings/keys");
    // Wait for the seeded key to appear in the list
    await expect(page.getByText("...0000")).toBeVisible({ timeout: 10_000 });
    // The Revoke button should be present for non-revoked keys
    await expect(
      page.getByRole("button", { name: /revoke/i }).first()
    ).toBeVisible();
  });
});
