import { test, expect } from "@playwright/test";

test.describe("authentication", () => {
  test("login success", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
  });

  test("logout", async ({ page }) => {
    await page.goto("/");
    const userMenu = page.getByRole("button", { name: /user|account|menu|settings/i });
    if (await userMenu.isVisible()) {
      await userMenu.click();
    }
    const logoutBtn = page.getByRole("button", { name: /log\s?out|sign\s?out/i }).or(
      page.getByRole("menuitem", { name: /log\s?out|sign\s?out/i })
    );
    await logoutBtn.click();
    await expect(page).toHaveURL(/login/);
  });

  test("session persistence across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
    await page.reload();
    await expect(page).not.toHaveURL(/login/);
  });

  test("invalid credentials error", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("invalid@nexus.local");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page.getByText(/invalid|error|failed|incorrect/i)).toBeVisible();
    await context.close();
  });
});
