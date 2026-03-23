import { test as setup, expect } from "@playwright/test";
import { bootstrapMagicLinkSession } from "./auth-bootstrap";

setup("authenticate", async ({ page }) => {
  await bootstrapMagicLinkSession(page, page.request);
  await expect(page).toHaveURL(/\/libraries/);

  await page.context().storageState({ path: ".auth/user.json" });
});
