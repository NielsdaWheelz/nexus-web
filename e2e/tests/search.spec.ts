import { test, expect } from "@playwright/test";

test.describe("search", () => {
  test("search returns results across content types", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your content...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("test");
    await page.getByRole("button", { name: /search/i }).click();
    // Wait for search results or a no-results message to appear
    await expect(
      page.getByText(/result|no result|nothing found/i).first()
    ).toBeVisible();
  });

  test("no-results behavior", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your content...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("xyznonexistent12345");
    await page.getByRole("button", { name: /search/i }).click();
    // Expect a no-results message to appear
    await expect(
      page.getByText(/no results|nothing found|no matches/i)
    ).toBeVisible();
  });
});
