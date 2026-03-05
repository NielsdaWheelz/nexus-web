import { test, expect } from "@playwright/test";

test.describe("search", () => {
  const submitSearch = (page: Parameters<typeof test>[0]["page"]) =>
    page.getByRole("button", { name: "Search", exact: true });

  test("search returns results", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your content...");
    await expect(searchInput).toBeVisible();
    // Search for text known to exist in seeded non-PDF web article
    await searchInput.fill("e2e non-pdf");
    await submitSearch(page).click();
    // Expect at least one result link to appear
    await expect(
      page.locator("a[href^='/media/']").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("no-results behavior", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your content...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("xyznonexistent12345");
    await submitSearch(page).click();
    await expect(page.getByText("No results found.")).toBeVisible();
  });
});
