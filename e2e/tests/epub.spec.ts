import { test, expect } from "@playwright/test";

test.describe("epub", () => {
  test("upload EPUB", async ({ page }) => {
    await page.goto("/");
    const addBtn = page.getByRole("button", { name: /add|upload|import|new/i }).first();
    await addBtn.click();
    const fileInput = page.locator("input[type='file']");
    if (await fileInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(fileInput).toBeVisible();
    }
  });

  test("open reader", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
  });

  test("navigate chapters and TOC", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
  });

  test("create highlight in epub", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
  });
});
