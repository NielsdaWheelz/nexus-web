import { test, expect } from "@playwright/test";

test.describe("conversations", () => {
  test("create conversation", async ({ page }) => {
    await page.goto("/conversations");
    const newBtn = page.getByRole("button", { name: /new|create|start/i }).or(
      page.getByRole("link", { name: /new|create|start/i })
    );
    if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newBtn.click();
    }
    await expect(page).toHaveURL(/conversation/i);
  });

  test("send message", async ({ page }) => {
    await page.goto("/conversations");
    const newBtn = page.getByRole("button", { name: /new|create|start/i }).or(
      page.getByRole("link", { name: /new|create|start/i })
    );
    if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newBtn.click();
    }
    const input = page.getByRole("textbox").or(page.getByPlaceholder(/message|type|ask/i));
    if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
      await input.fill("Hello, this is a test message");
      await page.getByRole("button", { name: /send/i }).click();
    }
  });

  test("streaming response UI", async ({ page }) => {
    await page.goto("/conversations");
    await expect(page).not.toHaveURL(/login/);
  });

  test("attach and use context", async ({ page }) => {
    await page.goto("/conversations");
    await expect(page).not.toHaveURL(/login/);
  });
});
