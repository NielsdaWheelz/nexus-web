import { test, expect } from "@playwright/test";

test.describe("authentication", () => {
  test("login success", async ({ page }) => {
    await page.goto("/");
    // Authenticated user should land on a page with navigation, not the login page
    await expect(page).not.toHaveURL(/login/);
    // Verify the navbar is present with expected links
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
  });

  test("logout button visible", async ({ page }) => {
    // Verify the Sign Out button is present and accessible.
    // We intentionally do NOT click it because the server-side signOut()
    // uses Supabase's default global scope, which revokes ALL sessions
    // for the user — including the shared E2E auth session.
    await page.goto("/libraries");
    const signOutBtn = page.getByRole("button", { name: /sign out|log out/i });
    await expect(signOutBtn).toBeVisible();
  });

  test("session persistence across reload", async ({ page }) => {
    await page.goto("/libraries");
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
    await page.reload();
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
  });

  test("invalid credentials error", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await page.locator("#email").fill("invalid@nexus.local");
    await page.locator("#password").fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid|error|failed|incorrect/i)).toBeVisible();
    await context.close();
  });
});
