import { test, expect, type Page } from "@playwright/test";
import { requireRunnableChatComposer } from "./chatReadiness";

async function ensureAppContext(page: Page) {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
}

async function createConversationViaApi(page: Page): Promise<string> {
  await ensureAppContext(page);
  const response = await page.request.post("/api/conversations", {
    maxRedirects: 0,
  });
  const body = await response.text();
  expect(
    response.ok(),
    `POST /api/conversations failed: status=${response.status()}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();
  const payload = JSON.parse(body) as { data: { id: string } };
  return payload.data.id;
}

async function deleteConversationViaApi(
  page: Page,
  conversationId: string,
): Promise<void> {
  await ensureAppContext(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.request.delete(
        `/api/conversations/${conversationId}`,
      );
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text();
        throw new Error(
          `Failed to delete conversation ${conversationId}: status=${response.status()}; body=${body.slice(0, 300)}`,
        );
      }
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
}

test.describe("chat composer (post-cutover)", () => {
  // Wave 8.3 / §13.3: the composer no longer exposes a web-search selector
  // or any scope chip. Its action row is model-pill + send-button only.
  test("composer renders no web-search selector and no scope chip", async ({
    page,
  }) => {
    const conversationId = await createConversationViaApi(page);
    try {
      await page.goto(`/conversations/${conversationId}`);

      const input = page.getByRole("textbox", { name: /ask anything/i });
      await expect(input).toBeVisible({ timeout: 30_000 });

      // The action row exposes exactly the model pill and the send button
      // — no Auto/Required/Off web-search select, no Allow web search toggle.
      await expect(
        page.getByRole("combobox", { name: /web search/i }),
      ).toHaveCount(0);
      await expect(page.getByLabel(/allow web search/i)).toHaveCount(0);
      await expect(page.getByLabel(/enable web search/i)).toHaveCount(0);

      // Native <select> labels can carry "Auto", "Required", or "Off" only
      // on the deleted picker. Asserting on the combobox role above is the
      // robust way to catch them; this option-level check guards a render
      // that uses a non-combobox host.
      const optionLabels = ["Auto", "Required", "Off"];
      for (const label of optionLabels) {
        await expect(
          page.getByRole("option", { name: new RegExp(`^${label}$`, "i") }),
        ).toHaveCount(0);
      }

      // The deleted scope chip surfaces with these exact a11y handles; both
      // would re-introduce a scope taxonomy into the composer.
      await expect(
        page.getByRole("button", { name: /clear scope/i }),
      ).toHaveCount(0);
      await expect(
        page.getByLabel(/conversation scope/i),
      ).toHaveCount(0);
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("sending a message succeeds without scope or web-search controls", async ({
    page,
  }) => {
    const conversationId = await createConversationViaApi(page);
    try {
      await page.goto(`/conversations/${conversationId}`);

      const input = page.getByRole("textbox", { name: /ask anything/i });
      const modelSettings = page.getByRole("button", {
        name: /model settings/i,
      });

      await expect(input).toBeVisible({ timeout: 30_000 });
      await requireRunnableChatComposer({
        page,
        modelSettings,
        skipReason:
          "No runnable chat model in the e2e environment; cannot drive a composer send.",
      });

      const messageText = `composer-cutover-${Date.now() % 1_000_000}`;
      await input.fill(messageText);
      await input.press("Enter");

      // The optimistic user-message echo appears in the chat log under the
      // existing scope-free composer wire shape (no web_search or
      // conversation_scope fields are sent — those would have been rejected
      // by the API surface per §7.1).
      await expect(page.getByText(messageText).first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
