import { test, expect } from "@playwright/test";

test.describe("sharing", () => {
  test("unauthenticated login page renders", async ({ browser }) => {
    // Verify the login page is accessible and functional for users
    // who aren't signed in. We can't reliably test middleware redirects
    // in Next.js dev mode (server caches responses across contexts).
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: /continue with google/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with github/i })
    ).toBeVisible();
    await context.close();
  });
});
