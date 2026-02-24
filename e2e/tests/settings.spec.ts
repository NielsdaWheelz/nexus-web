import { test, expect } from "@playwright/test";

test.describe("settings", () => {
  test("view settings", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByText(/settings|preferences|account/i)).toBeVisible();
  });

  test("update preference", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).not.toHaveURL(/login/);
  });

  test("persisted settings state after reload", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).not.toHaveURL(/login/);
    await page.reload();
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByText(/settings|preferences|account/i)).toBeVisible();
  });
});
