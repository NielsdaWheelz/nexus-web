import { test as setup, expect } from "@playwright/test";

const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-test-password-123!";

setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(E2E_USER_EMAIL);
  await page.getByLabel(/password/i).fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.context().storageState({ path: ".auth/user.json" });
});
