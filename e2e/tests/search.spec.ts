import { test, expect } from "@playwright/test";

test.describe("search", () => {
  const submitSearch = (page: Parameters<typeof test>[0]["page"]) =>
    page.getByRole("button", { name: "Search", exact: true });

  test("search returns results", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your Nexus content...");
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
    const searchInput = page.getByPlaceholder("Search your Nexus content...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("xyznonexistent12345");
    await submitSearch(page).click();
    await expect(page.getByText("No results found.")).toBeVisible();
  });

  test("explicit empty type filters return no results", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your Nexus content...");
    await expect(searchInput).toBeVisible();

    await page.getByRole("checkbox", { name: "media" }).uncheck();
    await page.getByRole("checkbox", { name: "fragment" }).uncheck();
    await page.getByRole("checkbox", { name: "annotation" }).uncheck();
    await page.getByRole("checkbox", { name: "message" }).uncheck();

    await searchInput.fill("e2e non-pdf");
    await submitSearch(page).click();

    await expect(page.getByText("No results found.")).toBeVisible();
  });

  test("annotation rows surface quote context before metadata", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your Nexus content...");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("seeded note for non-pdf linked-items e2e");
    await submitSearch(page).click();

    await expect(
      page.getByRole("link", { name: /e2e non-pdf quote target alpha/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
