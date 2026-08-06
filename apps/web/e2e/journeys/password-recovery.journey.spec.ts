import type { Page } from "playwright/test";
import {
  expect,
  expectInvalidPasswordFeedback,
  expectPasswordSaved,
  getSecretAuthLink,
  gotoSecretAuthLinkWithStrictCsp,
  gotoWithStrictCsp,
  hasSupabaseAuthCookie,
  inbucketOrigin,
  signOut,
  test,
  webOrigin,
} from "../fixtures";
import { waitForCapturedAuthLink } from "../mailbox";
import { pageRequest } from "../request";

test.use({ journeyId: "password-recovery" });

const REPLACEMENT_PASSWORD = "Nexus-recovered-password-03!";

async function requestPasswordReset(
  page: Page,
  email: string,
): Promise<string> {
  await gotoWithStrictCsp(page, "/forgot-password");
  await expect(
    page.getByRole("heading", { name: "Reset your password" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/forgot-password" &&
      url.searchParams.get("sent") === "1",
  );
  const acknowledgement = page
    .getByRole("status")
    .filter({ hasText: "Check your email." });
  await expect(acknowledgement).toBeVisible();
  await expect(
    acknowledgement.getByText("Check your email.", { exact: true }),
  ).toBeVisible();
  await expect(
    acknowledgement.getByText(
      "If this email belongs to a Nexus account, a password-reset link is on its way.",
      { exact: true },
    ),
  ).toBeVisible();
  return acknowledgement.innerText();
}

test("known and unknown recovery look identical while a captured link replaces the password", async ({
  page,
  journeyUser,
}) => {
  const app = pageRequest(page, webOrigin);
  const malformedRecovery = await app.post("/auth/password/recovery", {
    form: { email: "not-an-email" },
    headers: { Origin: webOrigin },
    maxRedirects: 0,
  });
  expect(malformedRecovery.status()).toBe(303);
  expect(malformedRecovery.headers()["cache-control"]).toContain("no-store");
  const malformedLocation = new URL(
    malformedRecovery.headers()["location"] ?? "",
    webOrigin,
  );
  expect(malformedLocation.origin).toBe(webOrigin);
  expect(malformedLocation.pathname).toBe("/forgot-password");
  expect([...malformedLocation.searchParams.entries()]).toEqual([
    ["sent", "1"],
  ]);
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Malformed recovery request created an auth cookie.",
  ).toBeFalsy();

  const knownResponse = await requestPasswordReset(page, journeyUser.email);
  const unknownResponse = await requestPasswordReset(
    page,
    `absent-${process.env.NEXUS_TEST_RUN_ID}@example.invalid`,
  );
  expect(unknownResponse).toBe(knownResponse);

  const mailbox = pageRequest(page, inbucketOrigin);
  const recovery = await waitForCapturedAuthLink(
    mailbox,
    journeyUser.email,
    "recovery",
    webOrigin,
  );
  const scanner = await getSecretAuthLink(app, recovery, "recovery");
  expect(scanner.status()).toBe(200);
  expect(scanner.headers()["cache-control"]).toContain("no-store");
  expect(scanner.headers()["referrer-policy"]).toBe("no-referrer");
  expect(scanner.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Password-recovery GET created a session.",
  ).toBeFalsy();

  await gotoSecretAuthLinkWithStrictCsp(page, recovery, "recovery");
  await expect(
    page.getByRole("heading", { name: "Reset your password" }),
  ).toBeVisible();
  await expect(
    page.getByText("Continue to verify this link and choose a new password."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue password reset", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/account/password" && !url.search,
  );

  await page
    .getByLabel("New password", { exact: true })
    .fill(REPLACEMENT_PASSWORD);
  await page
    .getByRole("button", { name: "Save password", exact: true })
    .click();
  await expectPasswordSaved(page);
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);

  await signOut(page);
  await page.getByLabel("Email", { exact: true }).fill(journeyUser.email);
  await page.getByLabel("Password", { exact: true }).fill(journeyUser.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectInvalidPasswordFeedback(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");

  await page.getByLabel("Password", { exact: true }).fill(REPLACEMENT_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);
  const profile = await app.get("/api/me");
  const profileText = await profile.text();
  expect(
    profile.ok(),
    `Recovered user ${journeyUser.id} could not access the real API: ${profile.status()} ${profileText.slice(0, 500)}`,
  ).toBeTruthy();
  expect(
    (JSON.parse(profileText) as { data: { user_id: string } }).data.user_id,
  ).toBe(journeyUser.id);
});
