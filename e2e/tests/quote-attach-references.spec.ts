import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireRunnableChatComposer } from "./chatReadiness";
import { openMediaInSinglePaneWorkspace } from "./reader";
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

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
}

async function readReferences(
  page: Page,
  resourceUri: string,
): Promise<ChatReferencesResponse["data"]> {
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
  // After the reader-sidecar cutover, quoting to chat opens a full conversation
  // pane (no more secondary "choose a chat" picker or doc "Other chats" list).
  // The quoted document still surfaces the new conversation through the
  // reference-backed conversations endpoint.
  test("quote-to-new-chat from a reader opens a conversation that references the document", async ({
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
    // Quote-to-chat creates the highlight from the live selection, then opens a
    // full conversation pane (now the active pane) with the quote attached. The
    // former secondary "choose an existing chat" picker is gone after the cutover.
    await popover.getByRole("button", { name: "Quote to new chat" }).click();

    // The conversation pane opens as the active pane and exposes the composer.
    const conversationPane = activeWorkspacePane(page);
    await expect(
      conversationPane.getByRole("textbox", { name: /ask anything/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The quote action persists the selection as a highlight before opening chat,
    // and the new conversation is created with that highlight as its context ref.
    const afterHighlightResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`,
    );
    expect(afterHighlightResponse.ok()).toBeTruthy();
    const afterHighlightPayload = (await afterHighlightResponse.json()) as {
      data: { highlights: Array<{ id: string; exact: string }> };
    };
    const quotedHighlight = afterHighlightPayload.data.highlights.find(
      (highlight) => highlight.exact === selectedText,
    );
    expect(
      quotedHighlight,
      `Expected the quoted selection "${selectedText}" to be persisted as a highlight.`,
    ).toBeDefined();
    const quotedHighlightUri = `highlight:${quotedHighlight!.id}`;

    const composerInput = conversationPane.getByRole("textbox", {
      name: /ask anything/i,
    });
    const sendButton = conversationPane.getByRole("button", {
      name: "SEND",
      exact: true,
    });
    const modelSettings = conversationPane.getByRole("button", {
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
    const chatLog = conversationPane.getByRole("log", { name: "Chat messages" });
    await expect(chatLog.getByText(messageText).first()).toBeVisible({
      timeout: 15_000,
    });

    // The reference-backed conversations endpoint surfaces this new chat because
    // it was created with the quoted highlight as its context ref. Poll because
    // the sent message commits asynchronously through the chat-run pipeline.
    await expect
      .poll(
        async () => {
          const conversations = await readReferences(page, quotedHighlightUri);
          return conversations.some(
            (conversation) => conversation.message_count > 0,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const conversations = await readReferences(page, quotedHighlightUri);
    const newChat = conversations.find((conv) => conv.message_count > 0);
    expect(
      newChat,
      `Expected a chat referencing the quoted highlight after sending "${messageText}", got: ${JSON.stringify(conversations)}`,
    ).toBeDefined();
  });
});
