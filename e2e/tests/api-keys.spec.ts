import { test, expect, type Page } from "@playwright/test";

test.describe("api keys", () => {
  const settingsChrome = (page: Page) => page.getByTestId("pane-shell-chrome");

  test("provider cards visible", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(settingsChrome(page).getByRole("heading", { name: "API Keys" })).toBeVisible();
    await expect(page.locator("[data-provider-card='openai']")).toBeVisible();
    await expect(page.locator("[data-provider-card='anthropic']")).toBeVisible();
    await expect(page.locator("[data-provider-card='gemini']")).toBeVisible();
    await expect(page.locator("[data-provider-card='deepseek']")).toBeVisible();
  });

  test("shows safe key metadata", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(settingsChrome(page).getByRole("heading", { name: "API Keys" })).toBeVisible();
    // The seeded API key should appear once loading completes
    const openaiCard = page.locator("[data-provider-card='openai']");
    await expect(openaiCard.locator("p").filter({ hasText: "...0000" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Last tested").first()).toBeVisible();
    await expect(page.getByText("Last used").first()).toBeVisible();
  });

  test("provider actions visible", async ({ page }) => {
    await page.goto("/settings/keys");
    // Wait for the seeded key to appear in the list
    const openaiCard = page.locator("[data-provider-card='openai']");
    await expect(openaiCard.locator("p").filter({ hasText: "...0000" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(openaiCard.getByRole("button", { name: /test/i })).toBeVisible();
    await expect(openaiCard.getByRole("button", { name: /replace/i })).toBeVisible();
    await expect(openaiCard.getByRole("button", { name: /revoke/i })).toBeVisible();

    const anthropicCard = page.locator("[data-provider-card='anthropic']");
    await expect(anthropicCard.getByRole("button", { name: /connect/i })).toBeVisible();
  });
});
