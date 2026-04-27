import { test, expect, type Page } from "@playwright/test";

test.describe("settings", () => {
  const settingsChrome = (page: Page) => page.getByTestId("pane-shell-chrome");

  test("view settings", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(
      settingsChrome(page).getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
  });

  test("view provider card controls", async ({ page }) => {
    await page.goto("/settings/keys");
    const openaiCard = page.locator("[data-provider-card='openai']");
    await expect(openaiCard).toBeVisible();
    await expect(openaiCard.getByRole("button", { name: /connect|replace/i })).toBeVisible();
  });

  test("persisted settings state after reload", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(
      settingsChrome(page).getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
    await page.reload();
    await expect(
      settingsChrome(page).getByRole("heading", { name: "API Keys" })
    ).toBeVisible();
  });
});
