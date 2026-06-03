import { test, expect } from "@playwright/test";
import {
  expectAuthCallbackTarget,
  waitForEmailChangeConfirmationLink,
} from "./mailbox";

const PASSWORD = "Hunter22Hunter22";

function freshEmail(label: string): string {
  const domain = process.env.NEXUS_SMOKE_EMAIL_DOMAIN ?? "nexus.local";
  return `redirect-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
}

test("email-change confirmation targets the app auth callback", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  try {
    const oldEmail = freshEmail("old");
    const newEmail = freshEmail("new");

    await page.goto("/sign-up");
    await page.getByLabel(/display name/i).fill("Redirect Smoke");
    await page.getByLabel(/email/i).fill(oldEmail);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/libraries/);

    await page.goto("/settings/account");
    await page.getByLabel(/new email/i).fill(newEmail);
    await page.getByRole("button", { name: /update email/i }).click();
    await expect(
      page.getByText("Check your new email to confirm the change.")
    ).toBeVisible();

    const confirmationLink = await waitForEmailChangeConfirmationLink(
      page.request,
      newEmail
    );
    expectAuthCallbackTarget(
      confirmationLink,
      new URL(page.url()).origin,
      "/settings/account"
    );
    await page.goto(confirmationLink);
    await page.waitForURL(/\/settings\/account|\/libraries/, {
      timeout: 60_000,
    });
  } finally {
    await context.close();
  }
});
