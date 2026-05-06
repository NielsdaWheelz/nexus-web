import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedBranchingConversation,
  seedScrollConversation,
} from "./conversation-tree-seed";

async function ensureAppContext(page: Page) {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
}

async function createConversationViaApi(page: Page) {
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
  page: Page,
  conversationId: string
) {
  await ensureAppContext(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.request.delete(`/api/conversations/${conversationId}`);
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text();
        throw new Error(
          `Failed to delete conversation ${conversationId}: status=${response.status()}; body=${body.slice(0, 300)}`
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

function readConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/conversations\/([0-9a-f-]+)$/i);
  return match?.[1] ?? null;
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

function messageRow(page: Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`);
}

async function selectTextInMessage(page: Page, messageId: string, exact: string) {
  const row = messageRow(page, messageId);
  await expect(row).toContainText(exact);
  await row.evaluate((element, selectedText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      const index = text.indexOf(selectedText);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + selectedText.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
    }
    throw new Error(`Could not find selected text: ${selectedText}`);
  }, exact);
}

async function openForksPanel(page: Page) {
  const panel = page.getByTestId("conversation-context-pane");
  await panel.getByRole("tab", { name: /Forks/ }).click();
  await expect(panel.getByRole("tree", { name: "Conversation forks" })).toBeVisible();
  return panel;
}

async function confirmDeleteFork(panel: Locator, name: string) {
  await panel.getByRole("button", { name: `Delete fork ${name}` }).click();
  await panel
    .getByRole("group")
    .filter({ hasText: `Title: ${name}` })
    .getByRole("button", { name: "Delete" })
    .click();
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
      const conversationPaneButton = workspacePaneButton(page, /^chat\b/i).first();
      await expect(conversationPaneButton).toBeVisible();
      await expect(conversationPaneButton).not.toContainText(
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

      const modelSettingsButton = page.getByRole("button", { name: /model settings:/i });
      const missingKeyError = page.getByText("No API key available for openai");
      const input = page.getByRole("textbox", { name: /ask anything|type a message/i });
      const sendButton = page.getByRole("button", { name: /send message/i });

      await expect(input).toBeVisible({ timeout: 30_000 });
      await expect(modelSettingsButton).toBeVisible();

      await expect
        .poll(async () => {
          if (await missingKeyError.isVisible().catch(() => false)) {
            return "ready";
          }

          const modelLabel = await modelSettingsButton.getAttribute("aria-label").catch(() => "");
          if (modelLabel && modelLabel !== "Model settings: Model") {
            return "ready";
          }

          return "pending";
        }, { timeout: 15_000 })
        .not.toBe("pending");

      if (await missingKeyError.isVisible().catch(() => false)) {
        await expect(sendButton).toBeDisabled();
        return;
      }

      await expect(input).toBeVisible();
      await input.fill("Hello, this is a test message");
      await input.press("Enter");

      const optimisticUserMessage = page.getByText("Hello, this is a test message").first();

      await expect
        .poll(async () => {
          if (await optimisticUserMessage.isVisible().catch(() => false)) {
            return "done";
          }

          if (await missingKeyError.isVisible().catch(() => false)) {
            return "done";
          }

          return "pending";
        }, { timeout: 10_000 })
        .not.toBe("pending");

      if (await missingKeyError.isVisible().catch(() => false)) {
        await expect(sendButton).toBeDisabled();
      } else {
        await expect(optimisticUserMessage).toBeVisible();
      }
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("main chat pane owns message and composer scrolling", async ({ page }) => {
    const seed = await seedScrollConversation(page, 50);
    const conversationId = seed.conversation_id;
    try {
      await page.goto(`/conversations/${conversationId}`);

      const paneBody = page.getByTestId("pane-shell-body");
      const scrollport = page.getByRole("region", { name: "Chat conversation" });
      const log = page.getByRole("log", { name: "Chat messages" });

      await expect(paneBody).toHaveAttribute("data-body-mode", "contained");
      await expect(scrollport).toBeVisible();
      await expect(log).toContainText("Scroll fixture message 50", { timeout: 10_000 });
      await scrollport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(async () =>
          scrollport.evaluate(
            (node) => node.scrollHeight > node.clientHeight && node.scrollTop > 0,
          )
        )
        .toBe(true);

      const bottomScrollTop = await scrollport.evaluate((node) => node.scrollTop);
      const scrollportBox = await scrollport.boundingBox();
      if (!scrollportBox) {
        throw new Error("Chat scrollport has no bounding box.");
      }

      await page.mouse.move(
        scrollportBox.x + scrollportBox.width / 2,
        scrollportBox.y + Math.min(160, scrollportBox.height / 2),
      );
      await page.mouse.wheel(0, -700);
      await expect
        .poll(async () => scrollport.evaluate((node) => node.scrollTop))
        .toBeLessThan(bottomScrollTop);

      await scrollport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const beforeComposerWheel = await scrollport.evaluate((node) => node.scrollTop);
      await page.getByRole("textbox", { name: "Ask anything" }).hover();
      await page.mouse.wheel(0, -700);
      await expect
        .poll(async () => scrollport.evaluate((node) => node.scrollTop))
        .toBeLessThan(beforeComposerWheel);

      expect(await paneBody.evaluate((node) => node.scrollTop)).toBe(0);
      expect(
        await paneBody.evaluate((node) => getComputedStyle(node).overflowY),
      ).toBe("hidden");
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("desktop branching covers fork preview, switching, graph, rename, and delete states", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    try {
      await page.goto(`/conversations/${conversationId}`);

      await expect(page.getByRole("log", { name: "Chat messages" })).toContainText(
        "Linear branch answer keeps the original path active.",
      );
      await expect(messageRow(page, seed.root_assistant_id)).toContainText(
        seed.root_assistant_content,
      );

      const rootAssistant = messageRow(page, seed.root_assistant_id);
      await rootAssistant.getByRole("button", { name: "Reply / fork from here" }).click();
      const branchPreview = page.locator('section[aria-label="Branch reply anchor"]');
      await expect(branchPreview).toContainText("Replying from assistant message #2");
      await expect(branchPreview).toContainText("selected source phrase");
      await page.getByRole("button", { name: "Remove branch reply anchor" }).click();
      await expect(branchPreview).toHaveCount(0);

      await selectTextInMessage(page, seed.root_assistant_id, seed.quote_exact);
      await page.getByRole("button", { name: "Branch from selection" }).click();
      await expect(branchPreview).toContainText(seed.quote_exact);

      const input = page.getByRole("textbox", { name: "Ask anything" });
      await input.fill("E2E selected quote follow-up");
      const sendButton = page.getByRole("button", { name: "Send message" });
      await expect(sendButton).toBeEnabled({ timeout: 15_000 });
      await sendButton.click();
      await expect(
        page.getByRole("button", {
          name: /Current fork[\s\S]*E2E selected quote follow-up/i,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("log", { name: "Chat messages" })).toContainText(
        "E2E selected quote follow-up",
      );

      const quoteForkButton = rootAssistant
        .getByRole("region", { name: "Forks from this answer" })
        .getByRole("button")
        .filter({ hasText: "Quote branch" });
      await expect(quoteForkButton).toBeVisible();
      const quoteSwitchResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/conversations/${conversationId}/active-path`) &&
          response.request().method() === "POST",
      );
      await quoteForkButton.evaluate((button) => {
        button.click();
      });
      const quoteSwitchResponse = await quoteSwitchResponsePromise;
      const quoteSwitchBody = await quoteSwitchResponse.text();
      expect(
        quoteSwitchResponse.ok(),
        `POST /active-path failed: status=${quoteSwitchResponse.status()}; body=${quoteSwitchBody.slice(0, 500)}`,
      ).toBeTruthy();
      await expect(page.getByText("Quote branch answer highlights the selected source phrase.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Current fork[\s\S]*Quote branch/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /Switch to fork[\s\S]*E2E selected quote follow-up/i,
        }),
      ).toBeVisible();

      await page.reload();
      await expect(page.getByText("Quote branch answer highlights the selected source phrase.")).toBeVisible();

      const panel = await openForksPanel(page);
      await panel.getByRole("textbox", { name: "Search forks" }).fill("summarize it");
      await panel.getByRole("button", { name: "Search" }).click();
      await expect(panel.getByText("1 fork found")).toBeVisible();
      await panel.getByRole("button", { name: "Rename fork Quote branch" }).click();
      await panel.getByRole("textbox", { name: "Rename fork Quote branch" }).fill(
        "Renamed quote fork",
      );
      await panel.getByRole("button", { name: "Save fork Quote branch" }).click();
      await expect(panel.getByRole("button", { name: "Switch to fork Renamed quote fork" })).toBeVisible();

      await panel.getByRole("tab", { name: "Graph" }).click();
      await panel
        .getByRole("button", { name: /Switch to graph leaf[\s\S]*Disposable branch answer/i })
        .click();
      await expect(page.getByRole("log", { name: "Chat messages" })).toContainText(
        "Disposable branch answer can be switched to from the graph.",
      );

      await panel.getByRole("tab", { name: "Tree" }).click();
      await panel.getByRole("textbox", { name: "Search forks" }).fill("");
      await panel.getByRole("button", { name: "Search" }).click();
      await expect(panel.getByRole("button", { name: "Delete fork Running branch" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Delete fork Disposable branch" })).toBeDisabled();

      await confirmDeleteFork(panel, "Running branch");
      await expect(panel.getByText("Fork delete failed.")).toBeVisible();

      await confirmDeleteFork(panel, "Renamed quote fork");
      await expect(panel.getByRole("button", { name: "Switch to fork Renamed quote fork" })).toHaveCount(0);
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("mobile drawer exposes forks and switches branches", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    try {
      await page.goto(`/conversations/${conversationId}`);
      await expect(page.getByTestId("conversation-context-pane")).toHaveCount(0);

      await page.getByRole("button", { name: "Linked context" }).click();
      const drawer = page.getByRole("dialog", { name: "Linked context" });
      await expect(drawer).toBeVisible();
      await drawer.getByRole("tab", { name: /Forks/ }).click();
      await drawer.getByRole("button", { name: /Switch to fork[\s\S]*Quote branch/i }).click();

      await expect(drawer).toHaveCount(0);
      await expect(page.getByText("Quote branch answer highlights the selected source phrase.")).toBeVisible();
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
