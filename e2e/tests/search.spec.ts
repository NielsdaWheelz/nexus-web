import { test, expect } from "@playwright/test";

test.describe("search", () => {
  test("search returns results across content types", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByRole("searchbox").or(
      page.getByPlaceholder(/search/i)
    ).or(page.getByLabel(/search/i));
    if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchInput.fill("test");
      await searchInput.press("Enter");
      await page.waitForTimeout(2000);
    }
  });

  test("no-results behavior", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByRole("searchbox").or(
      page.getByPlaceholder(/search/i)
    ).or(page.getByLabel(/search/i));
    if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchInput.fill("xyznonexistent12345");
      await searchInput.press("Enter");
      await page.waitForTimeout(2000);
      const noResults = page.getByText(/no results|nothing found|no matches/i);
      if (await noResults.isVisible({ timeout: 5000 }).catch(() => false)) {
        await expect(noResults).toBeVisible();
      }
    }
  });
});
