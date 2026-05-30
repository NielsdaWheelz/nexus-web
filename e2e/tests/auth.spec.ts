import { test, expect } from "@playwright/test";
import {
  canRunGitHubProviderRoundTrip,
  gitHubProviderRoundTripSkipReason,
  runGitHubProviderRoundTrip,
} from "./provider-roundtrip";
import { bootstrapMagicLinkSession } from "./auth-bootstrap";

test.describe("authentication", () => {
  test("authenticated user lands in the app", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
  });

  test("authenticated user is redirected away from login", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/libraries/);
  });

  test("session persistence across reload", async ({ page }) => {
    await page.goto("/libraries");
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
    await page.reload();
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();
  });

  test("logout returns the browser to the OAuth login screen", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await bootstrapMagicLinkSession(page, context.request);
      await page.goto("/libraries");
      const signOutBtn = page.getByRole("button", { name: /sign out|log out/i });
      await expect(signOutBtn).toBeVisible();
      await signOutBtn.click();
      await expect(page).toHaveURL(/\/login/);
      await expect(
        page.getByRole("button", { name: /continue with google/i })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /continue with github/i })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("unauthenticated users are redirected to login with password and OAuth controls plus a preserved return path", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.goto("/libraries");
    await expect(page).toHaveURL(/\/login/);
    const redirectedLoginUrl = new URL(page.url());
    expect(redirectedLoginUrl.pathname).toBe("/login");
    expect(redirectedLoginUrl.searchParams.get("next")).toBe("/libraries");
    await expect(
      page.getByRole("button", { name: /continue with google/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with github/i })
    ).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^continue$/i })
    ).toBeVisible();
    await context.close();
  });

  test("github provider performs a full callback round-trip and establishes a real app session", async ({
    browser,
  }) => {
    test.skip(
      !canRunGitHubProviderRoundTrip(),
      gitHubProviderRoundTripSkipReason()
    );

    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();

    await page.goto("/login?next=%2Flibraries");
    await runGitHubProviderRoundTrip(page);
    await expect(page.getByRole("link", { name: /libraries/i })).toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name.includes("-auth-token"))).toBe(
      true
    );
    await context.close();
  });
});
