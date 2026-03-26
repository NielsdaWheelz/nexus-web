import { test, expect } from "@playwright/test";

async function ensureAppContext(page: Parameters<typeof test>[0]["page"]) {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
}

async function createConversationViaApi(page: Parameters<typeof test>[0]["page"]) {
  await ensureAppContext(page);
  const createResponse = await page.request.post("/api/conversations", {
    maxRedirects: 0,
  });
  const status = createResponse.status();
  const body = await createResponse.text();
  expect(
    status < 300 || status >= 400,
    `POST /api/conversations redirected unexpectedly: status=${status}; location=${createResponse.headers()["location"] ?? "<none>"}; body=${body.slice(0, 400)}`
  ).toBeTruthy();
  expect(
    createResponse.ok(),
    `POST /api/conversations failed: status=${status}; contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}`
  ).toBeTruthy();

  let payload: { data: { id: string } };
  try {
    payload = JSON.parse(body) as { data: { id: string } };
  } catch (error) {
    throw new Error(
      `POST /api/conversations returned non-JSON response: contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}; parseError=${String(error)}`
    );
  }
  return payload.data.id;
}

async function deleteConversationViaApi(
  page: Parameters<typeof test>[0]["page"],
  conversationId: string
) {
  await ensureAppContext(page);
  const response = await page.request.delete(`/api/conversations/${conversationId}`);
  if (!response.ok() && response.status() !== 404) {
    const body = await response.text();
    throw new Error(
      `Failed to delete conversation ${conversationId}: status=${response.status()}; body=${body.slice(0, 300)}`
    );
  }
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
        await deleteConversationViaApi(page, conversationId);
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
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
