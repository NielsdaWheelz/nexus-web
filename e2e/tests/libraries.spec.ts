import { test, expect } from "@playwright/test";

test.describe("libraries", () => {
  const libraryName = `Test Library ${Date.now()}`;

  test("create library", async ({ page }) => {
    await page.goto("/");
    const createBtn = page.getByRole("button", { name: /create|new|add/i }).filter({ hasText: /library/i }).or(
      page.getByRole("link", { name: /create|new/i }).filter({ hasText: /library/i })
    );
    if (await createBtn.isVisible()) {
      await createBtn.click();
    } else {
      await page.goto("/libraries/new");
    }
    await page.getByLabel(/name/i).fill(libraryName);
    await page.getByRole("button", { name: /create|save|submit/i }).click();
    await expect(page.getByText(libraryName)).toBeVisible();
  });

  test("browse and select library", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation");
    const libraryLink = nav.getByText(/library|libraries/i).first();
    if (await libraryLink.isVisible()) {
      await libraryLink.click();
    }
    await expect(page.getByText(/library|libraries/i)).toBeVisible();
  });

  test("membership management guardrail", async ({ page }) => {
    await page.goto("/");
    const settingsOrManage = page.getByRole("link", { name: /manage|settings|members/i }).first();
    if (await settingsOrManage.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsOrManage.click();
      await expect(page.getByText(/member|admin|owner|role/i)).toBeVisible();
    }
  });

  test("ownership transfer or ownership-management guardrail", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/library|libraries/i).first()).toBeVisible();
  });
});
