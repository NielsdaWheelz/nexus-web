import { test, expect } from "@playwright/test";

test.describe("api keys", () => {
  test("add key", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.locator("#provider")).toBeVisible();
    await expect(page.locator("#apiKey")).toBeVisible();
    await page.locator("#provider").selectOption({ index: 1 });
    await page.locator("#apiKey").fill("sk-test-key-for-e2e-delete-test");
    await page.getByRole("button", { name: /save/i }).click();
  });

  test("list keys", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.getByText(/your keys|api key/i)).toBeVisible();
  });

  test("delete key", async ({ page }) => {
    await page.goto("/settings/keys");
    // Add a key first so we have something to revoke
    await page.locator("#provider").selectOption({ index: 1 });
    await page.locator("#apiKey").fill("sk-test-key-for-revoke-e2e-test");
    await page.getByRole("button", { name: /save/i }).click();

    // Wait for the key to appear in the list, then click Revoke
    const revokeBtn = page.getByRole("button", { name: /revoke/i }).first();
    await expect(revokeBtn).toBeVisible({ timeout: 5_000 });
    await revokeBtn.click();

    // After revoking, the key should show "revoked" status or the Revoke button disappears
    await expect(page.getByText(/revoked/i)).toBeVisible({ timeout: 5_000 });
  });
});
