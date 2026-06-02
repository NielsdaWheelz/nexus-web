import { expect, type Page } from "@playwright/test";

export async function signOutViaAccountMenu(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Account", exact: true })
    .click();
  const signOut = page.getByRole("menuitem", { name: /sign out|log out/i });
  await expect(signOut).toBeVisible();
  await signOut.click();
}
