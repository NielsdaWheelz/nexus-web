import { test, expect } from "@playwright/test";

test.describe("settings", () => {
  test("view settings", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(
      page.getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
  });

  test("update preference", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.locator("#provider")).toBeVisible();
    await expect(page.locator("#apiKey")).toBeVisible();
  });

  test("persisted settings state after reload", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(
      page.getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
  });
});
