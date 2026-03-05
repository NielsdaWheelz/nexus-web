import { test, expect } from "@playwright/test";

async function createConversationViaApi(page: Parameters<typeof test>[0]["page"]) {
  const createResponse = await page.request.post("/api/conversations");
  expect(createResponse.ok()).toBeTruthy();
  const payload = (await createResponse.json()) as {
    data: { id: string };
  };
  return payload.data.id;
}

function readConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/conversations\/([0-9a-f-]+)$/i);
  return match?.[1] ?? null;
}

test.describe("conversations", () => {
  test("create conversation", async ({ page }) => {
    let conversationId: string | null = null;
    try {
      conversationId = await createConversationViaApi(page);
      await page.goto("/conversations");

      const conversationLink = page.locator(`a[href="/conversations/${conversationId}"]`).first();
      await expect(conversationLink).toBeVisible();
      await expect(conversationLink.getByText(/^chat$/i)).toBeVisible();
      await expect(conversationLink).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
      await conversationLink.click();

      await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
      expect(readConversationIdFromUrl(page.url())).toBe(conversationId);
      const conversationTab = page.getByRole("tab", { name: /chat/i }).first();
      await expect(conversationTab).toBeVisible();
      await expect(conversationTab).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
    } finally {
      if (conversationId) {
        await page.request.delete(`/api/conversations/${conversationId}`);
      }
    }
  });

  test("send message", async ({ page }) => {
    const conversationId = await createConversationViaApi(page);
    try {
      await page.goto(`/conversations/${conversationId}`);

      const modelSelect = page.locator("select").first();
      await expect(modelSelect).toBeVisible();
      const missingKeyError = page.getByText("No API key available for openai");

      const startedAt = Date.now();
      let composeState: "pending" | "ready" | "missing_key" = "pending";
      while (Date.now() - startedAt < 10_000) {
        if (await missingKeyError.isVisible().catch(() => false)) {
          composeState = "missing_key";
          break;
        }
        const modelValue = await modelSelect.inputValue().catch(() => "");
        if (modelValue) {
          composeState = "ready";
          break;
        }
        await page.waitForTimeout(200);
      }
      expect(composeState).not.toBe("pending");

      if (composeState === "missing_key") {
        await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
        return;
      }

      // Type and send a message
      const input = page.getByPlaceholder(/type a message/i);
      await expect(input).toBeVisible();
      await input.fill("Hello, this is a test message");
      await page.getByRole("button", { name: /send/i }).click();

      const optimisticUserMessage = page
        .locator('div[class*="messageBubble"]')
        .filter({ hasText: "Hello, this is a test message" })
        .first();

      const messageStartedAt = Date.now();
      let outcome: "pending" | "message" | "missing_key" = "pending";
      while (Date.now() - messageStartedAt < 10_000) {
        if (await optimisticUserMessage.isVisible().catch(() => false)) {
          outcome = "message";
          break;
        }
        if (await missingKeyError.isVisible().catch(() => false)) {
          outcome = "missing_key";
          break;
        }
        await page.waitForTimeout(200);
      }
      expect(outcome).not.toBe("pending");

      // If the key was revoked by parallel API-key tests, assert gating behavior instead
      // of failing this conversation smoke test.
      if (outcome === "missing_key") {
        await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
      } else {
        await expect(optimisticUserMessage).toBeVisible();
      }
    } finally {
      await page.request.delete(`/api/conversations/${conversationId}`);
    }
  });
});
