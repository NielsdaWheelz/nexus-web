import { test, expect } from "@playwright/test";

test.describe("conversations", () => {
  test("create conversation", async ({ page }) => {
    await page.goto("/conversations");
    const newBtn = page.getByRole("button", { name: /new/i }).or(
      page.getByRole("link", { name: /new/i })
    );
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    await expect(page).toHaveURL(/conversation/i);
  });

  test("send message", async ({ page }) => {
    await page.goto("/conversations");
    // Create a new conversation
    const newBtn = page.getByRole("button", { name: /new/i }).or(
      page.getByRole("link", { name: /new/i })
    );
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // Wait for model dropdown to have a real selection (seeded API key provides models)
    const modelSelect = page.locator("select").first();
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect).not.toHaveValue("", { timeout: 10_000 });

    // Type and send a message
    const input = page.getByPlaceholder(/type a message/i);
    await expect(input).toBeVisible();
    await input.fill("Hello, this is a test message");
    await page.getByRole("button", { name: /send/i }).click();

    // With streaming enabled, the user message appears immediately via optimistic rendering
    await expect(page.getByText("Hello, this is a test message")).toBeVisible({ timeout: 10_000 });
  });
});
