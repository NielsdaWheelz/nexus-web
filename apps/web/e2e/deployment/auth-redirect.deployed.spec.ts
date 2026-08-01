import { expect, test } from "playwright/test";
import {
  expectAuthCallbackTarget,
  waitForEmailChangeConfirmationLink,
} from "./mailbox";
import { pageRequest, requireExactOrigin } from "../request";
import { loadDeploymentRuntime } from "./runtime";

const PASSWORD = "Hunter22Hunter22";
const runtime = loadDeploymentRuntime();

function freshEmail(label: string): string {
  return `redirect-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@${runtime.emailDomain}`;
}

test("email-change confirmation targets the app auth callback", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const mailbox = pageRequest(page, runtime.mailboxOrigin);
    const oldEmail = freshEmail("old");
    const newEmail = freshEmail("new");

    await page.goto("/sign-up");
    await page.getByLabel(/display name/i).fill("Redirect Smoke");
    await page.getByLabel(/email/i).fill(oldEmail);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/lectern$/);

    await page.goto("/settings/account");
    await page.getByLabel(/new email/i).fill(newEmail);
    await page.getByRole("button", { name: /update email/i }).click();
    await expect(
      page.getByText("Check your new email to confirm the change."),
    ).toBeVisible();

    const confirmationLink = await waitForEmailChangeConfirmationLink(
      mailbox,
      newEmail,
    );
    expectAuthCallbackTarget(
      confirmationLink,
      runtime,
      "/settings/account",
    );
    await page.goto(
      requireExactOrigin(confirmationLink, runtime.supabaseOrigin).toString(),
    );
    await page.waitForURL(
      (url) => url.pathname === "/settings/account" || url.pathname === "/lectern",
      { timeout: 60_000 },
    );
  } finally {
    await context.close();
  }
});
