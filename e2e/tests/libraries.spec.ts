import { test, expect } from "@playwright/test";

test.describe("libraries", () => {
  test("create library", async ({ page }) => {
    await page.goto("/libraries");
    const nameInput = page.getByPlaceholder("New library name...");
    await expect(nameInput).toBeVisible();
    const libraryName = `Test Library ${Date.now()}`;
    await nameInput.fill(libraryName);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.getByText(libraryName)).toBeVisible();
  });

  test("browse and select library", async ({ page }) => {
    await page.goto("/libraries");
    // The default library always exists — look for the "Default" badge
    const defaultBadge = page.getByText("Default");
    await expect(defaultBadge).toBeVisible();
    // Click the first library link to navigate to its detail page
    const libraryLink = page.locator("a[href^='/libraries/']").first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL(/libraries\/.+/);
  });

  test("membership management guardrail", async ({ page }) => {
    // Create a non-default library so the Rename UI is visible
    await page.goto("/libraries");
    const nameInput = page.getByPlaceholder("New library name...");
    await expect(nameInput).toBeVisible();
    const libraryName = `Mgmt Test ${Date.now()}`;
    await nameInput.fill(libraryName);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.getByText(libraryName)).toBeVisible();

    // Navigate to the newly created library's detail page
    const libraryLink = page.getByRole("link", { name: libraryName });
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL(/libraries\/.+/);

    // Non-default library with admin role shows the Rename button
    await expect(page.getByRole("button", { name: /rename/i })).toBeVisible();
  });
});
