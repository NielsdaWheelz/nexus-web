import { test, expect } from "@playwright/test";

test.describe("sharing", () => {
  test.fixme("share conversation", async () => {
    // Requires seeded conversation data. Implement when E2E data seeding covers conversations.
  });

  test.fixme("recipient access succeeds", async () => {
    // Requires multi-user session with shared conversation data.
  });

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
