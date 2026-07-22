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
    // "Ask in new chat" creates a durable Highlight from the live selection
    // (invariant 6), then navigates to a fresh conversation pane on the
    // pane-local intent hash. No conversation exists yet; the composer shows a
    // pending QuotedPassageCard, and the quote's context ResourceEdge is written
    // only on the first successful send.
    await popover.getByRole("button", { name: "Ask in new chat" }).click();

    // The conversation pane opens as the active pane and shows the pending quoted
    // passage above the composer.
    const conversationPane = activeWorkspacePane(page);
    const quotedPassage = conversationPane.getByRole("figure", {
      name: "Quoted passage",
    });
    await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
    await expect(quotedPassage.locator("blockquote")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      conversationPane.getByRole("textbox", { name: /ask anything/i }),
    ).toBeVisible({ timeout: 15_000 });

    // "Ask in new chat" persists the selection as a Highlight before navigating,
    // so the fresh selection is already a durable Highlight even before the first
    // send (the conversation and its context edge come later, at send time).
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
    const profilePicker = conversationPane.getByRole("combobox", {
      name: "AI profile",
    });

    await expect(composerInput).toBeVisible({ timeout: 15_000 });
    await requireRunnableChatComposer({
      page,
      profilePicker,
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

    // The successful send atomically writes the quote's subject context edge
    // (highlight:<id>), so the reference-backed conversations endpoint now
    // surfaces this conversation. Poll because the run commits asynchronously
    // through the chat-run pipeline.
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
