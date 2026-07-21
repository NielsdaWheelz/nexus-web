import { test as setup, expect } from "@playwright/test";
import { bootstrapMagicLinkSession } from "./auth-bootstrap";
import { isAuthenticatedHome } from "./app-routes";

setup("authenticate", async ({ page }) => {
  await bootstrapMagicLinkSession(page, page.request);
  await expect(page).toHaveURL(isAuthenticatedHome);

  await page.context().storageState({ path: ".auth/user.json" });
});
