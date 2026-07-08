import { test, expect, type Page } from "@playwright/test";

test.describe("settings", () => {
  // The surface title now renders as the section opener <h1> in the pane body
  // (running-journal cutover); the chrome carries only the running head.
  const settingsChrome = (page: Page) => page.getByTestId("pane-shell-body");

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
