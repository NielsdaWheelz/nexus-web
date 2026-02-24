import { test, expect } from "@playwright/test";

test.describe("libraries", () => {
  const libraryName = `Test Library ${Date.now()}`;

  test("create library", async ({ page }) => {
    await page.goto("/libraries");
    // Fill in the library name input and click Create
    const nameInput = page.getByPlaceholder("New library name...");
    await expect(nameInput).toBeVisible();
    await nameInput.fill(libraryName);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.getByText(libraryName)).toBeVisible();
  });

  test("browse and select library", async ({ page }) => {
    await page.goto("/libraries");
    // The libraries page should show a heading or list of libraries
    await expect(page.getByText(/library|libraries/i).first()).toBeVisible();
    // Click the first library link to navigate to its detail page
    const libraryLink = page.getByRole("link").filter({ hasText: /library/i }).first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    // Library detail page should be visible
    await expect(page).toHaveURL(/libraries\/.+/);
  });

  test("membership management guardrail", async ({ page }) => {
    await page.goto("/libraries");
    const libraryLink = page.getByRole("link").filter({ hasText: /library/i }).first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    // On the library detail page, expect management-related UI (rename, delete, members, etc.)
    await expect(page.getByText(/rename|delete|members|settings/i).first()).toBeVisible();
  });

  test("ownership transfer or ownership-management guardrail", async ({ page }) => {
    await page.goto("/libraries");
    // Assert the libraries page has management-related elements
    await expect(page.getByText(/library|libraries/i).first()).toBeVisible();
    const libraryLink = page.getByRole("link").filter({ hasText: /library/i }).first();
    if (await libraryLink.count() > 0) {
      await libraryLink.click();
      // On library detail page, management controls should be visible for admin
      await expect(page.getByText(/rename|delete|members|settings/i).first()).toBeVisible();
    } else {
      test.fixme(true, "No libraries exist to test management guardrails");
    }
  });
});
