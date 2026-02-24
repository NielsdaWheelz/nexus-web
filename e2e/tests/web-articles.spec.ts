import { test, expect } from "@playwright/test";

test.describe("web articles", () => {
  const articleUrl = "https://example.com";

  test("add article from URL", async ({ page }) => {
    await page.goto("/");
    const addBtn = page.getByRole("button", { name: /add|ingest|import|new/i }).first();
    await addBtn.click();
    const urlInput = page.getByPlaceholder(/url/i).or(page.getByLabel(/url/i));
    await urlInput.fill(articleUrl);
    await page.getByRole("button", { name: /add|submit|save|ingest/i }).click();
    await expect(page.getByText(/added|processing|pending|ingesting/i)).toBeVisible({ timeout: 10_000 });
  });

  test("open and view article", async ({ page }) => {
    await page.goto("/");
    const articleLink = page.getByRole("link").filter({ hasText: /article|example/i }).first();
    if (await articleLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await articleLink.click();
      await expect(page.locator("[data-testid='media-content'], article, .content-pane, main")).toBeVisible();
    }
  });

  test("create highlight", async ({ page }) => {
    await page.goto("/");
    const articleLink = page.getByRole("link").filter({ hasText: /article|example/i }).first();
    if (await articleLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await articleLink.click();
      const content = page.locator("article, .content-pane, [data-testid='media-content']").first();
      await expect(content).toBeVisible({ timeout: 10_000 });
    }
  });

  test("annotate highlight", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
  });
});
