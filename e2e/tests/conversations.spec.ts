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
      const input = page.getByPlaceholder(/ask anything|type a message/i);
      const sendButton = input.locator("xpath=following-sibling::button[1]");

      let composeState: "pending" | "ready" | "missing_key" = "pending";
      await expect
        .poll(async () => {
          if (await missingKeyError.isVisible().catch(() => false)) {
            composeState = "missing_key";
            return composeState;
          }

          const modelValue = await modelSelect.inputValue().catch(() => "");
          if (modelValue) {
            composeState = "ready";
            return composeState;
          }

          composeState = "pending";
          return composeState;
        }, { timeout: 10_000 })
        .not.toBe("pending");

      if (composeState === "missing_key") {
        await expect(sendButton).toBeDisabled();
        return;
      }

      await expect(input).toBeVisible();
      await input.fill("Hello, this is a test message");
      await input.press("Enter");

      const optimisticUserMessage = page.getByText("Hello, this is a test message").first();

      let outcome: "pending" | "message" | "missing_key" = "pending";
      await expect
        .poll(async () => {
          if (await optimisticUserMessage.isVisible().catch(() => false)) {
            outcome = "message";
            return outcome;
          }

          if (await missingKeyError.isVisible().catch(() => false)) {
            outcome = "missing_key";
            return outcome;
          }

          outcome = "pending";
          return outcome;
        }, { timeout: 10_000 })
        .not.toBe("pending");

      if (outcome === "missing_key") {
        await expect(sendButton).toBeDisabled();
      } else {
        await expect(optimisticUserMessage).toBeVisible();
      }
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
