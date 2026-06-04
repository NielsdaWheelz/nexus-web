import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedBranchingConversation,
  seedScrollConversation,
} from "./conversation-tree-seed";
import { stateChangingApiHeaders } from "./api";
import { requireRunnableChatComposer } from "./chatReadiness";
import { selectExactVisibleText } from "./selection";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

async function ensureAppContext(page: Page) {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
}

async function createConversationViaApi(page: Page) {
  await ensureAppContext(page);
  const createResponse = await page.request.post("/api/conversations", {
    maxRedirects: 0,
    headers: stateChangingApiHeaders(),
  });
  const status = createResponse.status();
  const body = await createResponse.text();
  expect(
    status < 300 || status >= 400,
    `POST /api/conversations redirected unexpectedly: status=${status}; location=${createResponse.headers()["location"] ?? "<none>"}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();
  expect(
    createResponse.ok(),
    `POST /api/conversations failed: status=${status}; contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();

  let payload: { data: { id: string } };
  try {
    payload = JSON.parse(body) as { data: { id: string } };
  } catch (error) {
    throw new Error(
      `POST /api/conversations returned non-JSON response: contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}; parseError=${String(error)}`,
    );
  }
  return payload.data.id;
}

async function deleteConversationViaApi(page: Page, conversationId: string) {
  await ensureAppContext(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.request.delete(
        `/api/conversations/${conversationId}`,
        { headers: stateChangingApiHeaders() },
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

async function selectTextInMessage(
  page: Page,
  messageId: string,
  exact: string,
) {
  const row = messageRow(page, messageId);
  await expect(row).toContainText(exact);
  await selectExactVisibleText(page, `[data-message-id="${messageId}"]`, exact);
}

async function openForksPanel(page: Page) {
  await activeWorkspacePane(page)
    .getByTestId("pane-shell-chrome")
    .getByRole("button", { name: "Forks" })
    .click();

  const panel = page.getByTestId("workspace-secondary-pane");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("tree", { name: "Conversation forks" }),
  ).toBeVisible();
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
  test("create conversation", async ({ page }, testInfo) => {
    let conversationId: string | null = null;
    try {
      conversationId = await createConversationViaApi(page);
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations-create"),
        "/conversations",
      );

      const conversationLink = page
        .locator(`a[href="/conversations/${conversationId}"]`)
        .first();
      await expect(conversationLink).toBeVisible();
      await expect(conversationLink.getByText(/^chat$/i)).toBeVisible();
      await expect(conversationLink).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
      await conversationLink.click();

      await expect(page).toHaveURL(
        new RegExp(`/conversations/${conversationId}$`),
      );
      expect(readConversationIdFromUrl(page.url())).toBe(conversationId);
      const conversationPaneButton = workspacePaneButton(
        page,
        /^chat\b/i,
      ).first();
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

  test("send message", async ({ page }, testInfo) => {
    const conversationId = await createConversationViaApi(page);
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations-send"),
        `/conversations/${conversationId}`,
      );

      const activePane = activeWorkspacePane(page);
      const modelSettingsButton = activePane.getByRole("button", {
        name: /model settings:/i,
      });
      const input = activePane.getByRole("textbox", {
        name: /ask anything|type a message/i,
      });

      await expect(input).toBeVisible({ timeout: 30_000 });
      await requireRunnableChatComposer({
        page,
        modelSettings: modelSettingsButton,
        skipReason:
          "No runnable chat model in the e2e environment; cannot send a conversation message.",
      });

      await expect(input).toBeVisible();
      await input.fill("Hello, this is a test message");
      await input.press("Enter");

      const optimisticUserMessage = page
        .getByText("Hello, this is a test message")
        .first();

      await expect
        .poll(
          async () => {
            if (await optimisticUserMessage.isVisible().catch(() => false)) {
              return "done";
            }

            return "pending";
          },
          { timeout: 10_000 },
        )
        .not.toBe("pending");

      await expect(optimisticUserMessage).toBeVisible();
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("new chat docks the composer below the empty transcript", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-conversations-new"),
      "/conversations/new",
    );

    const activePane = activeWorkspacePane(page);
    const paneBody = activePane.getByTestId("pane-shell-body");
    const scrollport = activePane.getByRole("region", {
      name: "Chat conversation",
    });
    const composerDock = activePane.getByTestId("chat-composer-dock");

    await expect(paneBody).toHaveAttribute("data-body-mode", "contained");
    await expect(scrollport).toBeVisible();
    await expect(
      activePane.getByRole("log", { name: "Chat messages" }),
    ).toBeVisible();
    await expect(
      activePane.getByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
    await expect(composerDock).toBeVisible();
    await expect
      .poll(async () => {
        const paneBox = await paneBody.boundingBox();
        const scrollportBox = await scrollport.boundingBox();
        const dockBox = await composerDock.boundingBox();
        if (!paneBox || !scrollportBox || !dockBox) return false;
        const paneBottom = paneBox.y + paneBox.height;
        const dockBottom = dockBox.y + dockBox.height;
        const scrollportBottom = scrollportBox.y + scrollportBox.height;
        return (
          Math.abs(dockBottom - paneBottom) <= 2 &&
          scrollportBottom <= dockBox.y + 1
        );
      })
      .toBe(true);
  });

  test("main chat pane owns message and composer scrolling", async ({
    page,
  }, testInfo) => {
    const seed = await seedScrollConversation(page, 50);
    const conversationId = seed.conversation_id;
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations-scroll"),
        `/conversations/${conversationId}`,
      );

      const activePane = activeWorkspacePane(page);
      const paneBody = activePane.getByTestId("pane-shell-body");
      const scrollport = activePane.getByRole("region", {
        name: "Chat conversation",
      });
      const log = activePane.getByRole("log", { name: "Chat messages" });
      const composerDock = activePane.getByTestId("chat-composer-dock");
      const finalMessage = activePane.locator(
        `[data-message-id="${seed.active_leaf_message_id}"]`,
      );

      await expect(paneBody).toHaveAttribute("data-body-mode", "contained");
      await expect(scrollport).toBeVisible();
      await expect(composerDock).toBeVisible();
      await expect(log).toContainText("Scroll fixture message 50", {
        timeout: 10_000,
      });
      await expect(finalMessage).toContainText(
        `Scroll fixture message ${seed.message_count}`,
      );
      await scrollport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(async () =>
          scrollport.evaluate(
            (node) =>
              node.scrollHeight > node.clientHeight && node.scrollTop > 0,
          ),
        )
        .toBe(true);
      await expect
        .poll(async () => {
          const paneBox = await paneBody.boundingBox();
          const dockBox = await composerDock.boundingBox();
          const finalMessageBox = await finalMessage.boundingBox();
          if (!paneBox || !dockBox || !finalMessageBox) return false;
          const paneBottom = paneBox.y + paneBox.height;
          const dockBottom = dockBox.y + dockBox.height;
          const finalMessageBottom = finalMessageBox.y + finalMessageBox.height;
          return (
            Math.abs(dockBottom - paneBottom) <= 2 &&
            finalMessageBottom <= dockBox.y + 1
          );
        })
        .toBe(true);

      const bottomScrollTop = await scrollport.evaluate(
        (node) => node.scrollTop,
      );
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
      const beforeComposerWheel = await scrollport.evaluate(
        (node) => node.scrollTop,
      );
      await activePane.getByRole("textbox", { name: "Ask anything" }).hover();
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
  }, testInfo) => {
    test.setTimeout(60_000);
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations"),
        `/conversations/${conversationId}`,
      );
      const conversationPane = activeWorkspacePane(page);

      await expect(
        conversationPane.getByRole("log", { name: "Chat messages" }),
      ).toContainText("Linear branch answer keeps the original path active.");
      await expect(
        conversationPane.locator(`[data-message-id="${seed.root_assistant_id}"]`),
      ).toContainText(seed.root_assistant_content);

      const rootAssistant = conversationPane.locator(
        `[data-message-id="${seed.root_assistant_id}"]`,
      );
      await rootAssistant
        .getByRole("button", { name: "Fork from this answer" })
        .click();
      const branchPreview = conversationPane.locator(
        'section[aria-label="Fork reply"]',
      );
      await expect(branchPreview).toContainText("Parent message 2");
      await expect(branchPreview).toContainText("selected source phrase");
      await conversationPane
        .getByRole("button", { name: "Cancel branch reply" })
        .click();
      await expect(branchPreview).toHaveCount(0);

      await selectTextInMessage(page, seed.root_assistant_id, seed.quote_exact);
      await page.getByRole("button", { name: "Fork from selection" }).click();
      await expect(branchPreview).toContainText(seed.quote_exact);

      const input = conversationPane.getByRole("textbox", { name: "Ask anything" });
      await input.fill("E2E selected quote follow-up");
      const sendButton = conversationPane.getByRole("button", {
        name: "Send fork reply",
      });
      await expect(sendButton).toBeEnabled({ timeout: 15_000 });
      await sendButton.click();
      await expect(
        conversationPane.getByRole("button", {
          name: /Current fork[\s\S]*E2E selected quote follow-up/i,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        conversationPane.getByRole("log", { name: "Chat messages" }),
      ).toContainText("E2E selected quote follow-up");

      const quoteForkButton = rootAssistant
        .getByRole("region", { name: "Forks from this answer" })
        .getByRole("button")
        .filter({ hasText: "Quote branch" });
      await expect(quoteForkButton).toBeVisible();
      const quoteSwitchResponsePromise = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(`/api/conversations/${conversationId}/active-path`) &&
          response.request().method() === "POST",
      );
      const chatScrollport = conversationPane.getByRole("region", {
        name: "Chat conversation",
      });
      const beforeForkSwitchScrollTop = await chatScrollport.evaluate(
        (node) => {
          node.scrollTop = Math.min(
            160,
            Math.max(0, node.scrollHeight - node.clientHeight),
          );
          return node.scrollTop;
        },
      );
      expect(beforeForkSwitchScrollTop).toBeGreaterThan(0);
      await quoteForkButton.evaluate((button) => {
        (button as HTMLElement).click();
      });
      const quoteSwitchResponse = await quoteSwitchResponsePromise;
      const quoteSwitchBody = await quoteSwitchResponse.text();
      expect(
        quoteSwitchResponse.ok(),
        `POST /active-path failed: status=${quoteSwitchResponse.status()}; body=${quoteSwitchBody.slice(0, 500)}`,
      ).toBeTruthy();
      await expect(
        conversationPane.getByText(
          "Quote branch answer highlights the selected source phrase.",
        ),
      ).toBeVisible();
      await expect
        .poll(() => chatScrollport.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(
        conversationPane.getByRole("button", {
          name: /Current fork[\s\S]*Quote branch/i,
        }),
      ).toBeVisible();
      await expect(
        conversationPane.getByRole("button", {
          name: /Switch to fork[\s\S]*E2E selected quote follow-up/i,
        }),
      ).toBeVisible();

      await page.reload();
      await expect(
        conversationPane.getByText(
          "Quote branch answer highlights the selected source phrase.",
        ),
      ).toBeVisible();

      const panel = await openForksPanel(page);
      await panel
        .getByRole("textbox", { name: "Search forks" })
        .fill("summarize it");
      await panel.getByRole("button", { name: "Search" }).click();
      await expect(panel.getByText("1 fork found")).toBeVisible();
      await panel
        .getByRole("button", { name: "Rename fork Quote branch" })
        .click();
      await panel
        .getByRole("textbox", { name: "Rename fork Quote branch" })
        .fill("Renamed quote fork");
      const renameResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/conversations/${conversationId}/forks/`) &&
          response.request().method() === "PATCH",
      );
      await panel
        .getByRole("button", { name: "Save fork Quote branch" })
        .click();
      const renameResponse = await renameResponsePromise;
      const renameBody = await renameResponse.text();
      expect(
        renameResponse.ok(),
        `PATCH fork rename failed: status=${renameResponse.status()}; body=${renameBody.slice(0, 500)}`,
      ).toBeTruthy();
      await expect(
        panel.getByRole("button", {
          name: "Switch to fork Renamed quote fork",
        }),
      ).toBeVisible({ timeout: 10_000 });

      await panel.getByRole("tab", { name: "Graph" }).click();
      await panel
        .getByRole("button", {
          name: /Switch to graph leaf[\s\S]*Disposable branch answer/i,
        })
        .click();
      await expect(
        conversationPane.getByRole("log", { name: "Chat messages" }),
      ).toContainText(
        "Disposable branch answer can be switched to from the graph.",
      );

      await panel.getByRole("tab", { name: "Tree" }).click();
      await panel.getByRole("textbox", { name: "Search forks" }).fill("");
      await panel.getByRole("button", { name: "Search" }).click();
      await expect(
        panel.getByRole("button", { name: "Delete fork Running branch" }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Delete fork Disposable branch" }),
      ).toBeDisabled();

      await confirmDeleteFork(panel, "Running branch");
      await expect(panel.getByText("Fork delete failed.")).toBeVisible();

      await confirmDeleteFork(panel, "Renamed quote fork");
      await expect(
        panel.getByRole("button", {
          name: "Switch to fork Renamed quote fork",
        }),
      ).toHaveCount(0);
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("mobile secondary exposes forks and switches branches", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    try {
      await page.goto(`/conversations/${conversationId}`);
      await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
      await expect(page.getByTestId("mobile-secondary-host")).toHaveCount(0);

      await activeWorkspacePane(page)
        .getByTestId("pane-shell-chrome")
        .getByRole("button", { name: "Forks" })
        .click();

      const secondary = page.getByRole("dialog", { name: "Forks" });
      await expect(secondary).toBeVisible();
      await expect(
        secondary.getByRole("tree", { name: "Conversation forks" }),
      ).toBeVisible();
      await secondary
        .getByRole("button", { name: /Switch to fork[\s\S]*Quote branch/i })
        .click();

      await secondary.getByRole("button", { name: "Close Forks" }).click();
      await expect(secondary).toHaveCount(0);
      await expect(
        page.getByText(
          "Quote branch answer highlights the selected source phrase.",
        ),
      ).toBeVisible();
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
