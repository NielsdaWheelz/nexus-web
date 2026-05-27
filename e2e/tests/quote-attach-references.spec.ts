import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireRunnableChatComposer } from "./chatReadiness";
import { openMediaInSinglePaneWorkspace, openReaderSecondaryRail } from "./reader";
import { selectFreshVisibleTextSnippet } from "./selection";

interface NonPdfSeed {
  media_id: string;
  fragment_id: string;
}

interface ChatReferencesResponse {
  data: {
    conversations: Array<{
      id: string;
      first_user_message_excerpt: string;
      message_count: number;
      is_singleton: boolean;
    }>;
    next_offset: number | null;
  };
}

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
}

async function readReferences(
  page: Page,
  mediaId: string,
): Promise<ChatReferencesResponse["data"]> {
  const response = await page.request.get(
    `/api/chat-references/media/${mediaId}?limit=200`,
  );
  const body = await response.text();
  expect(
    response.ok(),
    `GET /api/chat-references/media/${mediaId} failed: status=${response.status()}; body=${body.slice(0, 300)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as ChatReferencesResponse).data;
}

test.describe("quote-attach references (post-cutover)", () => {
  // §4.6 / A19: a general conversation that attached a quote from media M
  // appears in M's "Other chats" list on the next visit to its reader pane.
  test("quote-to-new-chat from a reader surfaces in the doc's Other chats list on revisit", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();
    await openMediaInSinglePaneWorkspace(page, seed.media_id);

    const contentPane = page.locator('div[class*="fragments"]');
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
      'div[class*="fragments"]',
      blockedExacts,
      { method: "range" },
    );

    const popover = page.getByRole("dialog", { name: /selection actions/i });
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.getByRole("button", { name: "Add to document chat" }).click();

    // The reader secondary rail switches to Doc chat with the quote pending
    // until the user selects the chat that should receive it.
    const rail = await openReaderSecondaryRail(page);
    const docChatTab = rail.getByRole("tab", {
      name: "Chat about this document",
    });
    await expect(docChatTab).toHaveAttribute("aria-selected", "true", {
      timeout: 10_000,
    });
    const contextRail = rail.getByLabel("Conversation context");
    await expect(contextRail).toBeVisible({ timeout: 10_000 });
    await expect(contextRail).toContainText(selectedText);
    await rail.getByRole("button", { name: "Start new chat" }).click();

    const composerInput = rail.getByRole("textbox", { name: /ask anything/i });
    const sendButton = rail.getByRole("button", { name: /send message/i });
    const modelSettings = rail.getByRole("button", {
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
    const chatLog = rail.getByRole("log", { name: "Chat messages" });
    await expect(chatLog.getByText(messageText).first()).toBeVisible({
      timeout: 15_000,
    });

    // The reference endpoint should surface this new (non-singleton) chat
    // because it attached a media_context referencing the seeded media. Poll
    // because the chat-run pipeline commits asynchronously.
    await expect
      .poll(
        async () => {
          const { conversations } = await readReferences(page, seed.media_id);
          return conversations.length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const { conversations } = await readReferences(page, seed.media_id);
    expect(conversations.length).toBeGreaterThan(0);
    expect(
      conversations.every((conv) => conv.is_singleton === false),
      "Reference list must not include the doc-chat singleton (§4.6).",
    ).toBeTruthy();
    const newChat = conversations.find((conv) =>
      conv.first_user_message_excerpt.includes(messageText),
    );
    expect(
      newChat,
      `Expected a referencing chat carrying first message "${messageText}", got: ${JSON.stringify(conversations.map((c) => c.first_user_message_excerpt))}`,
    ).toBeDefined();

    // Revisit the doc's reader pane and confirm the new chat appears in the
    // "Other chats" section of the Doc chat tab.
    await openMediaInSinglePaneWorkspace(page, seed.media_id);
    const reloadedRail = await openReaderSecondaryRail(page);
    await reloadedRail
      .getByRole("tab", { name: "Chat about this document" })
      .click();
    await expect(
      reloadedRail.getByRole("heading", { name: "Other chats" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      reloadedRail.getByRole("button", {
        name: new RegExp(messageText, "i"),
      }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
