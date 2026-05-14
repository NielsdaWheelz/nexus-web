import { expect, test } from "@playwright/test";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import {
  drainRealMediaWorkerForChatRun,
  expectVisibleTextEvidenceHighlight,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media search evidence can be attached to scoped chat context", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;

  const search = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "web_article",
  );
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "captured article should return attachable evidence",
  ).toBeTruthy();
  if (!result) {
    throw new Error(
      `captured article visible search did not return ${mediaId}`,
    );
  }
  expect(result.context_ref.type).toBe("content_chunk");
  expect(result.context_ref.evidence_span_ids.length).toBeGreaterThan(0);
  let preTestConversationId: string | null = null;
  let conversationId: string | null = null;
  let productError: unknown = null;

  try {
    const scopedConversationResponse = await page.request.post(
      "/api/conversations/resolve",
      {
        data: {
          type: "media",
          media_id: mediaId,
        },
      },
    );
    const scopedConversationResponseText =
      await scopedConversationResponse.text();
    expect(
      scopedConversationResponse.ok(),
      scopedConversationResponseText,
    ).toBeTruthy();
    preTestConversationId = JSON.parse(scopedConversationResponseText).data.id;
    await deleteE2eResource(
      page.request,
      `/api/conversations/${preTestConversationId}`,
      `Pre-test scoped conversation ${preTestConversationId}`,
    );
    preTestConversationId = null;

    const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
    await expect(
      resultLink,
      "captured article should render an attachable visible search result",
    ).toBeVisible();
    const visibleHref = await resultLink.getAttribute("href");

    const askWithEvidence = page
      .locator(`a[href*="scope=media%3A${mediaId}"][href*="attach_context="]`)
      .filter({ hasText: "Ask with evidence" })
      .first();
    await expect(askWithEvidence).toBeVisible();
    await askWithEvidence.click();

    await expect(page.getByLabel("Ask anything")).toBeVisible({
      timeout: 30_000,
    });
    const composerContext = page.getByLabel("Conversation context").first();
    await expect(composerContext).toBeVisible();
    await expect(composerContext).toContainText("Document");
    await expect(composerContext).toContainText("content_chunk");

    await page.getByLabel("Web search mode").selectOption("off");
    await page
      .getByLabel("Ask anything")
      .fill(
        "What does this source say about SOFIA? Use the attached evidence.",
      );
    const chatRunResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/chat-runs") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    const sendButton = page.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled({ timeout: 30_000 });
    await sendButton.click();
    const chatRunResponse = await chatRunResponsePromise;
    const chatRunResponseText = await chatRunResponse.text();
    expect(chatRunResponse.ok(), chatRunResponseText).toBeTruthy();
    const chatRunCreated = JSON.parse(chatRunResponseText);
    const runId = chatRunCreated.data.run.id;
    conversationId = chatRunCreated.data.conversation.id;
    const workerResult = await drainRealMediaWorkerForChatRun(page, runId);
    expect(workerResult.status, JSON.stringify(workerResult)).toBe("complete");
    await page.goto(
      `/conversations/${chatRunCreated.data.conversation.id}?run=${runId}`,
    );
    await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]+/i, {
      timeout: 30_000,
    });
    const chatLog = page.getByRole("log", { name: "Chat messages" });
    const evidenceButton = chatLog
      .getByRole("button", { name: /^Evidence/ })
      .last();
    await expect(evidenceButton).toBeVisible({ timeout: 120_000 });
    await evidenceButton.click();
    await expect(page.getByText("Evidence summary")).toBeVisible({
      timeout: 10_000,
    });
    const detailButtons = page.getByRole("button", { name: "Details" });
    const detailButtonCount = await detailButtons.count();
    for (let i = 0; i < detailButtonCount; i += 1) {
      await detailButtons.nth(i).click();
    }
    await expect(
      page.getByText("retrieval_status: included_in_prompt").first(),
    ).toBeVisible();
    await expect(
      page.getByText("included_in_prompt: true").first(),
    ).toBeVisible();
    const citationLink = page
      .locator(`a[href*="/media/${mediaId}?evidence="]`)
      .first();
    await expect(citationLink).toBeVisible();

    await citationLink.click();
    await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
    await expectVisibleTextEvidenceHighlight(page);

    writeRealMediaTrace(
      testInfo,
      "real-web-context-chat-citations-trace.json",
      {
        fixture_id: "web-nasa-water-on-moon",
        media_id: mediaId,
        query,
        search_api_url: search.api_url,
        context_ref: result.context_ref,
        search_result: result,
        visible_result_href: visibleHref,
        chat_run: chatRunCreated.data.run,
        worker_result: workerResult,
        conversation_id: chatRunCreated.data.conversation.id,
        assistant_message_id: chatRunCreated.data.assistant_message.id,
        citation_url: page.url(),
      },
    );
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (preTestConversationId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/conversations/${preTestConversationId}`,
          `Pre-test scoped conversation ${preTestConversationId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (conversationId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/conversations/${conversationId}`,
          `Conversation ${conversationId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwE2eCleanupFailures(
      "Real-media context chat",
      productError,
      cleanupErrors,
    );
  }
});
