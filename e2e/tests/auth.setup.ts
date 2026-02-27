import { test as setup, expect } from "@playwright/test";

const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-test-password-123!";

setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(E2E_USER_EMAIL);
  await page.getByLabel(/password/i).fill(E2E_USER_PASSWORD);

  const authResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token?grant_type=password")
  );
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  const authResponse = await authResponsePromise;
  expect(authResponse.ok()).toBeTruthy();

  // Route-push after sign-in can race with cookie persistence in CI.
  // Confirm session by navigating to a protected route explicitly.
  await page.goto("/libraries");
  await expect(page).toHaveURL(/libraries/);

  await page.context().storageState({ path: ".auth/user.json" });
});
