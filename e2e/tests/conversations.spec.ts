import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedBranchingConversation,
  seedScrollConversation,
} from "./conversation-tree-seed";
import { stateChangingApiHeaders } from "./api";
import { selectExactVisibleText } from "./selection";
import {
  expectNoDocumentHorizontalOverflow,
  expectPaneShellContainedByViewport,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";
import {
  CHAT_FIXTURE_WORKER_ENV,
  startE2eWorkerUntilChatRunTerminal,
  type E2eWorkerIterationResult,
} from "./worker";

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
    .getByRole("button", { name: "Companion" })
    .click();

  const panel = page.getByTestId("workspace-secondary-pane");
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "Forks" }).click();
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
    test.setTimeout(60_000);
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
      const conversationRow = conversationLink.locator("xpath=ancestor::li");
      await expect(conversationLink).toBeVisible();
      await expect(conversationLink.getByText(/^chat$/i)).toBeVisible();
      await expect(conversationLink).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
      const actionMenu = conversationRow.getByRole("button", {
        name: /More actions for chat/i,
      });
      await actionMenu.click();
      await expect(page).toHaveURL(/\/conversations$/);
      await expect(conversationRow).toBeVisible();
      await page.keyboard.press("Escape");

      // The metadata is inert chrome, not part of the anchor's DOM subtree. Its
      // click must still reach the shared row's real primary link.
      const metadata = conversationRow.getByText(/0 messages$/);
      await expect(metadata).toBeVisible();
      const metadataBox = await metadata.boundingBox();
      if (!metadataBox) {
        throw new Error(
          "Conversation metadata has no visible hit-test bounds.",
        );
      }
      const clickPoint = {
        x: metadataBox.x + metadataBox.width / 2,
        y: metadataBox.y + metadataBox.height / 2,
      };
      await page.mouse.click(clickPoint.x, clickPoint.y);

      await expect(
        activeWorkspacePane(page).getByRole("region", {
          name: "Chat conversation",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(
        new RegExp(`/conversations/${conversationId}$`),
      );
      await expect(conversationRow).toHaveCount(0);
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

  test("non-default selection survives send, completion, and reload", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const conversationId = await createConversationViaApi(page);
    let worker: Promise<E2eWorkerIterationResult> | null = null;
    let workerError: unknown = null;
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations-send"),
        `/conversations/${conversationId}`,
      );

      const activePane = activeWorkspacePane(page);
      const profilePicker = activePane.getByRole("combobox", {
        name: "Model",
      });
      const input = activePane.getByRole("textbox", {
        name: /ask anything|type a message/i,
      });

      await expect(input).toBeVisible({ timeout: 30_000 });
      await profilePicker.selectOption("deep");
      const reasoningPicker = activePane.getByRole("combobox", {
        name: "Effort",
      });
      await reasoningPicker.selectOption("high");
      await input.fill(
        "Reply with one short sentence about durable continuity.",
      );
      const runResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/chat-runs") &&
          response.request().method() === "POST",
        { timeout: 30_000 },
      );
      await activePane
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      const runResponse = await runResponsePromise;
      const runBody = await runResponse.text();
      expect(runResponse.ok(), runBody).toBeTruthy();
      const runId = (JSON.parse(runBody) as { data: { run: { id: string } } })
        .data.run.id;
      worker = startE2eWorkerUntilChatRunTerminal({
        chatRunId: runId,
        extraEnv: CHAT_FIXTURE_WORKER_ENV,
      });

      const optimisticUserMessage = page
        .getByText("Reply with one short sentence about durable continuity.")
        .first();

      await expect(optimisticUserMessage).toBeVisible();
      await expect(profilePicker).toHaveValue("deep");
      await expect(reasoningPicker).toHaveValue("high");

      const workerResult = await worker;
      worker = null;
      expect(workerResult.chatRunStatus, JSON.stringify(workerResult)).toBe(
        "complete",
      );

      const treeResponse = await page.request.get(
        `/api/conversations/${conversationId}/tree`,
      );
      const treeBody = await treeResponse.text();
      expect(treeResponse.ok(), treeBody).toBeTruthy();
      const tree = JSON.parse(treeBody) as {
        data: {
          active_leaf_message_id: string | null;
          selected_path: Array<{
            id: string;
            trust_trail: {
              run: {
                profile_id: string | null;
                reasoning_option_id: string | null;
              } | null;
            } | null;
          }>;
        };
      };
      const persistedAssistant = tree.data.selected_path.at(-1);
      expect(tree.data.active_leaf_message_id).toBe(persistedAssistant?.id);
      expect(persistedAssistant?.trust_trail?.run?.profile_id).toBe("deep");
      expect(persistedAssistant?.trust_trail?.run?.reasoning_option_id).toBe(
        "high",
      );

      await page.reload();
      const reloadedAssistant = activePane
        .getByRole("group", { name: "Assistant response" })
        .last();
      await expect(reloadedAssistant).toBeVisible({ timeout: 30_000 });
      await reloadedAssistant.getByText("Details", { exact: true }).click();
      await expect(
        reloadedAssistant.getByText("complete", { exact: true }),
      ).toBeVisible();
      await expect(
        reloadedAssistant.getByText("high", { exact: true }),
      ).toBeVisible();
      await expect(
        reloadedAssistant.getByText("deep", { exact: true }),
      ).toBeVisible();
      await expect(profilePicker).toHaveValue("deep");
      await expect(reasoningPicker).toHaveValue("high");
    } finally {
      if (worker) {
        await worker.catch((error: unknown) => {
          workerError = error;
        });
      }
      await deleteConversationViaApi(page, conversationId);
      if (workerError) throw workerError;
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

  test("@mobile-chrome mobile composer and scrollport remain operable at 320px", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const seed = await seedScrollConversation(page, 50);
    const conversationId = seed.conversation_id;
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-conversations-mobile-scroll"),
        `/conversations/${conversationId}`,
      );

      const activePane = activeWorkspacePane(page);
      const scrollport = activePane.getByRole("region", {
        name: "Chat conversation",
      });
      const input = activePane.getByRole("textbox", { name: "Ask anything" });
      const model = activePane.getByRole("combobox", { name: "Model" });
      const effort = activePane.getByRole("combobox", { name: "Effort" });
      const action = activePane.getByRole("button", { name: "Send message" });

      await expect(scrollport).toBeVisible();
      await expect(input).toBeVisible();
      await expect(model).toBeVisible();
      await expect(effort).toBeVisible();
      await expect(action).toBeVisible();
      for (const control of [model, effort, action]) {
        const bounds = await control.boundingBox();
        if (!bounds) {
          throw new Error("Mobile composer control has no layout bounds.");
        }
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      }
      for (const field of [input, model, effort]) {
        expect(
          await field.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).fontSize),
          ),
        ).toBeGreaterThanOrEqual(16);
      }
      await expect(
        activePane.getByRole("log", { name: "Chat messages" }),
      ).toContainText("Scroll fixture message 50", { timeout: 10_000 });
      await expect
        .poll(() =>
          scrollport.evaluate((node) => node.scrollHeight > node.clientHeight),
        )
        .toBe(true);
      await expectPaneShellContainedByViewport(activePane);
      expect(
        await scrollport.evaluate((node) =>
          getComputedStyle(node).getPropertyValue("scrollbar-gutter"),
        ),
      ).not.toContain("stable");
      await expectNoDocumentHorizontalOverflow(page);
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
      ).toContainText("Linear branch answer keeps the original path active.", {
        timeout: 30_000,
      });
      const profilePicker = conversationPane.getByRole("combobox", {
        name: "Model",
      });
      const reasoningPicker = conversationPane.getByRole("combobox", {
        name: "Effort",
      });
      await expect(profilePicker).toHaveValue("deep");
      await expect(reasoningPicker).toHaveValue("high");
      await expect(
        conversationPane.locator(
          `[data-message-id="${seed.root_assistant_id}"]`,
        ),
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
      await expect(profilePicker).toHaveValue("balanced");
      await expect(reasoningPicker).toHaveValue("medium");
      await conversationPane
        .getByRole("button", { name: "Cancel branch reply" })
        .click();
      await expect(branchPreview).toHaveCount(0);
      await expect(profilePicker).toHaveValue("deep");
      await expect(reasoningPicker).toHaveValue("high");

      await selectTextInMessage(page, seed.root_assistant_id, seed.quote_exact);
      await page.getByRole("button", { name: "Fork from selection" }).click();
      await expect(branchPreview).toContainText(seed.quote_exact);
      await expect(profilePicker).toHaveValue("balanced");
      await expect(reasoningPicker).toHaveValue("medium");

      const input = conversationPane.getByRole("textbox", {
        name: "Ask anything",
      });
      await input.fill("E2E selected quote follow-up");
      const sendButton = conversationPane.getByRole("button", {
        name: "Send message",
        exact: true,
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
      await expect(profilePicker).toHaveValue("fast");
      await expect(reasoningPicker).toHaveValue("low");
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
      await expect(profilePicker).toHaveValue("fast");
      await expect(reasoningPicker).toHaveValue("low");

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
          response
            .url()
            .includes(`/api/conversations/${conversationId}/forks/`) &&
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

      await page.getByRole("button", { name: "Pane options" }).click();
      await page.getByRole("menuitem", { name: "Show Companion" }).click();
      const companion = page.getByTestId("mobile-secondary-host");
      await companion.getByRole("tab", { name: "Forks" }).click();
      const secondary = page.getByRole("dialog", { name: "Forks" });
      await expect(secondary).toBeVisible();
      await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
      await expect(page.getByTestId("pane-fixed-chrome")).toHaveCount(0);
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
