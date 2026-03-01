import { test, expect } from "@playwright/test";

test.describe("sharing", () => {
  test("permission enforcement forbidden path", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Navigate to a protected route without auth
    await page.goto("/conversations");
    // Should redirect to login
    await expect(page).toHaveURL(/login/);
    await context.close();
  });
});
