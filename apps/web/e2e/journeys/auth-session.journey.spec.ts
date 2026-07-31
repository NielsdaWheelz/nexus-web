import { expect, gotoWithStrictCsp, test } from "../fixtures";

test.use({ journeyId: "auth-session" });

test("password sign-in creates a durable session and logout revokes browser access", async ({
  page,
  journeyUser,
}) => {
  await gotoWithStrictCsp(page, "/lectern");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.getByLabel("Email").fill(journeyUser.email);
  await page.getByLabel("Password").fill(journeyUser.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);
  await expect(
    page.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();

  await gotoWithStrictCsp(page, "/lectern");
  await expect(page).toHaveURL(/\/lectern$/);
  const primaryNavigation = page.getByRole("navigation", { name: "Primary" });
  await primaryNavigation
    .getByRole("button", { name: "Account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /sign out|log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);

  await gotoWithStrictCsp(page, "/lectern");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toBeVisible();
});
