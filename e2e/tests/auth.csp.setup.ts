import { test as setup, expect } from "@playwright/test";
import { bootstrapMagicLinkSession } from "./auth-bootstrap";

setup("authenticate (csp profile)", async ({ page, request }) => {
  await bootstrapMagicLinkSession(page, request);
  await expect(page).toHaveURL(/\/libraries/);

  await page.context().storageState({ path: ".auth/user-csp.json" });
});
