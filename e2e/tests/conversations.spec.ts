import { test, expect } from "@playwright/test";

test.describe("conversations", () => {
  test("create conversation", async ({ page }) => {
    await page.goto("/conversations");
    // Click the "+ New" button to start a new conversation
    const newBtn = page.getByRole("button", { name: /new/i }).or(
      page.getByRole("link", { name: /new/i })
    );
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    await expect(page).toHaveURL(/conversation/i);
  });

  test("send message", async ({ page }) => {
    await page.goto("/conversations");
    // Create a new conversation first
    const newBtn = page.getByRole("button", { name: /new/i }).or(
      page.getByRole("link", { name: /new/i })
    );
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    // Fill in the ChatComposer and send
    const input = page.getByPlaceholder("Type a message...");
    await expect(input).toBeVisible();
    await input.fill("Hello, this is a test message");
    await page.getByRole("button", { name: /send/i }).click();
    // Verify the message appears in the thread
    await expect(page.getByText("Hello, this is a test message")).toBeVisible();
  });

  test.fixme("streaming response UI", async () => {
    // Requires LLM API key configured in E2E environment for real streaming.
  });

  test.fixme("attach and use context", async () => {
    // Requires seeded media content and conversation for context attachment.
  });
});
