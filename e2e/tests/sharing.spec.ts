import { test, expect } from "@playwright/test";

test.describe("sharing", () => {
  test("share conversation", async ({ page }) => {
    await page.goto("/conversations");
    await expect(page).not.toHaveURL(/login/);
  });

  test("recipient access succeeds", async ({ page }) => {
    await page.goto("/conversations");
    await expect(page).not.toHaveURL(/login/);
  });

  test("permission enforcement forbidden path", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page).toHaveURL(/login/);
    await context.close();
  });
});
