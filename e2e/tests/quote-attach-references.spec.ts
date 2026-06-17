import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireRunnableChatComposer } from "./chatReadiness";
import { openMediaInSinglePaneWorkspace, openReaderSecondary } from "./reader";
import { selectFreshVisibleTextSnippet } from "./selection";
import {
  activePaneSelector,
  activeWorkspacePane,
  workspaceE2eDeviceId,
} from "./workspace";

interface NonPdfSeed {
  media_id: string;
  fragment_id: string;
}

interface ChatReferencesResponse {
  data: Array<{
    id: string;
    title: string;
    message_count: number;
    updated_at: string;
  }>;
}

const NEW_REFERENCE_CHAT_BUTTON = /^(?:\+ New chat|Start new chat about this resource)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
}

async function readReferences(
  page: Page,
  mediaId: string,
): Promise<ChatReferencesResponse["data"]> {
  const resourceUri = `media:${mediaId}`;
  const response = await page.request.get(
    `/api/conversations?has_context_ref=${encodeURIComponent(resourceUri)}&limit=100`,
  );
  const body = await response.text();
  expect(
    response.ok(),
    `GET /api/conversations?has_context_ref=${resourceUri} failed: status=${response.status()}; body=${body.slice(0, 300)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as ChatReferencesResponse).data;
}

test.describe("quote-attach references (post-cutover)", () => {
  // §4.6 / A19: a general conversation that attached a quote from media M
  // appears in M's "Other chats" list on the next visit to its reader pane.
  test("quote-to-new-chat from a reader surfaces in the doc's Other chats list on revisit", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readNonPdfSeed();
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-quote-attach");
    await openMediaInSinglePaneWorkspace(page, deviceId, seed.media_id);

    const contentPane = activeWorkspacePane(page).locator('div[class*="fragments"]');
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    // Select fresh text in the article body (not over the seeded highlights).
    // Avoiding existing exacts steers around the highlight-conflict branch in
    // the production code path.
    const existingResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`,
    );
    expect(existingResponse.ok()).toBeTruthy();
    const existingPayload = (await existingResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const blockedExacts = existingPayload.data.highlights.map(
      (highlight) => highlight.exact,
    );
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      activePaneSelector('div[class*="fragments"]'),
      blockedExacts,
      { method: "range" },
    );

    const popover = page.getByRole("group", { name: /selection actions/i });
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.getByRole("button", { name: "Quote to existing chat" }).click();

    // The reader secondary switches to Chat with the quote pending
    // until the user selects the chat that should receive it.
    const secondary = await openReaderSecondary(page);
    const docChatTab = secondary.getByRole("tab", {
      name: "Chat",
    });
    await expect(docChatTab).toHaveAttribute("aria-selected", "true", {
      timeout: 10_000,
    });
    await expect(
      secondary.getByText("Choose a chat to add your quote"),
    ).toBeVisible({ timeout: 10_000 });
    const afterHighlightResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`,
    );
    expect(afterHighlightResponse.ok()).toBeTruthy();
    const afterHighlightPayload = (await afterHighlightResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    expect(
      afterHighlightPayload.data.highlights.map((highlight) => highlight.exact),
    ).toContain(selectedText);
    await secondary.getByRole("button", { name: NEW_REFERENCE_CHAT_BUTTON }).click();
    await expect(secondary.getByLabel("Attached to next message")).toContainText(
      selectedText,
    );

    const composerInput = secondary.getByRole("textbox", { name: /ask anything/i });
    const sendButton = secondary.getByRole("button", { name: /send message/i });
    const modelSettings = secondary.getByRole("button", {
      name: /model settings/i,
    });

    await expect(composerInput).toBeVisible({ timeout: 15_000 });
    await requireRunnableChatComposer({
      page,
      modelSettings,
      skipReason:
        "No runnable chat model in the e2e environment; quote-to-chat needs to create a conversation.",
    });

    const messageText = `quote-attach-${Date.now() % 1_000_000}`;
    await composerInput.fill(messageText);
    await sendButton.click();
    const chatLog = secondary.getByRole("log", { name: "Chat messages" });
    await expect(chatLog.getByText(messageText).first()).toBeVisible({
      timeout: 15_000,
    });

    // The reference-backed conversations endpoint should surface this new chat
    // because the conversation was created with a media reference. Poll because
    // the chat-run pipeline commits asynchronously.
    await expect
      .poll(
        async () => {
          const conversations = await readReferences(page, seed.media_id);
          return conversations.some(
            (conversation) =>
              conversation.title === messageText && conversation.message_count > 0,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const conversations = await readReferences(page, seed.media_id);
    const newChat = conversations.find(
      (conv) => conv.title === messageText && conv.message_count > 0,
    );
    expect(
      newChat,
      `Expected a referencing chat after sending "${messageText}", got: ${JSON.stringify(conversations)}`,
    ).toBeDefined();

    // Revisit the doc's reader pane and confirm the new chat appears in the
    // reference-backed Doc chat list.
    await openMediaInSinglePaneWorkspace(page, deviceId, seed.media_id);
    const reloadedSecondary = await openReaderSecondary(page);
    const reloadedDocChatTab = reloadedSecondary.getByRole("tab", {
      name: "Chat",
    });
    await reloadedDocChatTab.click();
    await expect(reloadedDocChatTab).toHaveAttribute("aria-selected", "true");
    await expect(
      reloadedSecondary.getByRole("button", {
        name: new RegExp(escapeRegExp(newChat?.title ?? "Chat"), "i"),
      }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
