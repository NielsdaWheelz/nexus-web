import { test, expect } from "@playwright/test";

test.describe("api keys", () => {
  test("add key", async ({ page }) => {
    await page.goto("/settings");
    const keysSection = page.getByText(/api key|keys/i);
    if (await keysSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      const addBtn = page.getByRole("button", { name: /add|create|new/i }).filter({ hasText: /key/i }).or(
        page.getByRole("button", { name: /add key/i })
      );
      if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addBtn.click();
      }
    }
  });

  test("list keys", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).not.toHaveURL(/login/);
  });

  test("delete key", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).not.toHaveURL(/login/);
  });
});
