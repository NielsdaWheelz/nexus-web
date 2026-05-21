import { test, expect } from "@playwright/test";

/**
 * Password authentication E2E coverage for docs/password-auth.md.
 *
 * Each test runs on a fresh browser context (empty storage state) and signs up
 * a new account so users never bleed between tests. We exercise the
 * acceptance criteria reachable from a pure web context — sign-up, sign-in,
 * password change, email change, display-name change, and one failure path.
 *
 * AC3, AC5, AC6, AC11 are skipped: they all require an OAuth-only fixture
 * user (Google or GitHub identity already attached) to exercise set / remove
 * password and "keep ≥1 identity" UI, which is not arrangeable in E2E
 * without a real OAuth round-trip. The spec keeps `test.skip(...)` markers
 * so the gap is visible from `playwright test --list`.
 */

const PASSWORD = "Hunter22Hunter22"; // ≥12 chars; matches the server-side min.

function freshEmail(label: string): string {
  return `pw-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@nexus.local`;
}

test.describe("password auth", () => {
  test("AC1: sign up with a fresh email lands on /libraries with a session", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const email = freshEmail("ac1");

      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC1 User");
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();

      await expect(page).toHaveURL(/\/libraries/);
      await expect(
        page.getByRole("link", { name: /libraries/i })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("AC2: sign out, then sign back in with the same email and password", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const email = freshEmail("ac2");

      // Sign up to provision the account.
      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC2 User");
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/libraries/);

      // Sign out via the Navbar form.
      await page.getByRole("button", { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login/);

      // Sign back in with the same credentials.
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(page).toHaveURL(/\/libraries/);
    } finally {
      await context.close();
    }
  });

  test("AC4: change password — old password fails, new password works", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const email = freshEmail("ac4");
      const newPassword = "FreshPassword99Fresh";

      // Sign up.
      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC4 User");
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/libraries/);

      // Change password from /settings/identities.
      await page.goto("/settings/identities");
      await page
        .getByRole("button", { name: /^change password$/i })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: /change password/i });
      await dialog.getByLabel(/new password/i).fill(newPassword);
      await dialog
        .getByRole("button", { name: /^change password$/i })
        .click();
      await expect(dialog).toBeHidden();

      // Sign out.
      await page.getByRole("button", { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login/);

      // Old password is rejected with the whitelisted message.
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(
        page.getByText("Email or password is incorrect.")
      ).toBeVisible();
      await expect(page).toHaveURL(/\/login/);

      // New password is accepted.
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(newPassword);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(page).toHaveURL(/\/libraries/);
    } finally {
      await context.close();
    }
  });

  test("AC7: change email — new email signs in, old email fails", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const oldEmail = freshEmail("ac7-old");
      const newEmail = freshEmail("ac7-new");

      // Sign up.
      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC7 User");
      await page.getByLabel(/email/i).fill(oldEmail);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/libraries/);

      // Change email on /settings/account.
      await page.goto("/settings/account");
      await page.getByLabel(/new email/i).fill(newEmail);
      await page.getByRole("button", { name: /update email/i }).click();
      await expect(page.getByText("Email updated.")).toBeVisible();

      // Sign out.
      await page.getByRole("button", { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login/);

      // Old email is rejected.
      await page.getByLabel(/email/i).fill(oldEmail);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(
        page.getByText("Email or password is incorrect.")
      ).toBeVisible();
      await expect(page).toHaveURL(/\/login/);

      // New email is accepted.
      await page.getByLabel(/email/i).fill(newEmail);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(page).toHaveURL(/\/libraries/);
    } finally {
      await context.close();
    }
  });

  test("AC8: change display name — value updates after refresh", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const email = freshEmail("ac8");
      const newDisplayName = `AC8 Renamed ${crypto.randomUUID().slice(0, 6)}`;

      // Sign up with the original display name.
      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC8 Initial");
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/libraries/);

      // Change display name on /settings/account.
      await page.goto("/settings/account");
      await expect(page.getByText("Current: AC8 Initial")).toBeVisible();
      await page.getByLabel(/new display name/i).fill(newDisplayName);
      await page.getByRole("button", { name: /update display name/i }).click();
      await expect(page.getByText("Display name updated.")).toBeVisible();

      // Refresh and confirm the new value persists from FastAPI /me.
      await page.reload();
      await expect(
        page.getByText(`Current: ${newDisplayName}`)
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("AC10: wrong password on sign-in shows the whitelisted error message", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const email = freshEmail("ac10");

      // Sign up so the account exists.
      await page.goto("/sign-up");
      await page.getByLabel(/display name/i).fill("AC10 User");
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/libraries/);

      // Sign out.
      await page.getByRole("button", { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login/);

      // Wrong password is rejected with the exact whitelisted constant.
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill("WrongPassword12345");
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(
        page.getByText("Email or password is incorrect.")
      ).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  });

  // AC3 (OAuth-only user sets a password), AC5 (user with email+google removes
  // password), AC6 (single-identity user sees Remove disabled), and AC11
  // (last-identity removal blocked) all require a fixture user with a real
  // Google or GitHub identity row in auth.identities. Provisioning that
  // through Supabase admin would need a parallel OAuth handoff seed, which
  // is out of scope for this PR. Skipped until OAuth fixtures land.
  test.skip("AC3: OAuth-only user sets a password from /settings/identities", () => {});
  test.skip("AC5: user with email+google removes password and old password fails", () => {});
  test.skip("AC6: single-identity user sees Remove password disabled", () => {});
  test.skip("AC11: removing the last identity is blocked by the UI and the action", () => {});
});
