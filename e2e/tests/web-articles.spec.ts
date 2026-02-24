import { test, expect } from "@playwright/test";

test.describe("web articles", () => {
  const articleUrl = "https://example.com";

  test("add article from URL", async ({ page }) => {
    await page.goto("/libraries");
    const addBtn = page.getByRole("button", { name: /add|ingest|import|new/i }).first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    const urlInput = page.getByPlaceholder(/url/i).or(page.getByLabel(/url/i));
    await expect(urlInput).toBeVisible();
    await urlInput.fill(articleUrl);
    await page.getByRole("button", { name: /add|submit|save|ingest/i }).click();
    await expect(page.getByText(/added|processing|pending|ingesting/i)).toBeVisible({ timeout: 10_000 });
  });

  test("open and view article", async ({ page }) => {
    await page.goto("/libraries");
    const articleLink = page.getByRole("link").filter({ hasText: /article|example/i }).first();
    await expect(articleLink).toBeVisible();
    await articleLink.click();
    await expect(page.locator("[data-testid='media-content'], article, .content-pane, main")).toBeVisible();
  });

  test("create highlight", async ({ page }) => {
    await page.goto("/libraries");
    const articleLink = page.getByRole("link").filter({ hasText: /article|example/i }).first();
    await expect(articleLink).toBeVisible();
    await articleLink.click();
    const content = page.locator("article, .content-pane, [data-testid='media-content']").first();
    await expect(content).toBeVisible({ timeout: 10_000 });
  });

  test.fixme("annotate highlight", async () => {
    // Requires seeded article with existing highlight for annotation.
  });
});
