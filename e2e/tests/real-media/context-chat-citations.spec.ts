import { expect, test } from "@playwright/test";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import {
  drainRealMediaWorkerForChatRun,
  expectVisiblePdfEvidenceHighlight,
  expectVisibleTextEvidenceHighlight,
  openTranscriptEvidenceSegment,
  readRealMediaSeed,
  type RealMediaContentKind,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media search evidence chat citations open each media reader", async ({
  page,
}, testInfo) => {
  test.setTimeout(900_000);
  const seed = readRealMediaSeed();
  const media: Array<{
    fixtureId: string;
    kind: string;
    mediaId: string;
    query: string;
    contentKind: RealMediaContentKind;
  }> = [
    {
      fixtureId: "web-nasa-water-on-moon",
      kind: "captured article",
      mediaId: seed.fixtures.web.media_id,
      query: seed.fixtures.web.query,
      contentKind: "web_article",
    },
    {
      fixtureId: "pdf-attention",
      kind: "PDF",
      mediaId: seed.fixtures.pdf.media_id,
      query: seed.fixtures.pdf.query,
      contentKind: "pdf",
    },
    {
      fixtureId: "epub-moby-dick",
      kind: "EPUB",
      mediaId: seed.fixtures.epub.media_id,
      query: seed.fixtures.epub.query,
      contentKind: "epub",
    },
    {
      fixtureId: "video-nasa-picturing-earth-behind-scenes-captions",
      kind: "video transcript",
      mediaId: seed.fixtures.video.media_id,
      query: seed.fixtures.video.query,
      contentKind: "video",
    },
    {
      fixtureId: "podcast-nasa-hwhap-crew4-transcript",
      kind: "podcast transcript",
      mediaId: seed.fixtures.podcast.media_id,
      query: seed.fixtures.podcast.query,
      contentKind: "podcast_episode",
    },
  ];
  const traces: Array<Record<string, unknown>> = [];
  const conversationIds: string[] = [];
  let productError: unknown = null;

  try {
    for (const { fixtureId, kind, mediaId, query, contentKind } of media) {
      const search = await searchRealMediaEvidenceThroughUi(
        page,
        query,
        contentKind,
      );
      const result = search.results.find(
        (item: { type: string; source: { media_id: string } }) =>
          item.type === "content_chunk" && item.source.media_id === mediaId,
      );
      expect(
        result,
        `${kind} should return attachable evidence`,
      ).toBeTruthy();
      if (!result) {
        throw new Error(`${kind} visible search did not return ${mediaId}`);
      }
      expect(result.context_ref.type).toBe("content_chunk");
      expect(result.context_ref.evidence_span_ids.length).toBeGreaterThan(0);
      const evidenceSpanId = result.context_ref.evidence_span_ids[0];

      const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
      await expect(
        resultLink,
        `${kind} should render an attachable visible search result`,
      ).toBeVisible();
      const visibleHref = await resultLink.getAttribute("href");
      if (!visibleHref) {
        throw new Error(`${kind} result for ${mediaId} did not expose a href`);
      }

      const conversationResponse = await page.request.post(
        "/api/conversations",
        {
          data: {
            initial_references: [`media:${mediaId}`, `chunk:${result.context_ref.id}`],
          },
        },
      );
      const conversationResponseText = await conversationResponse.text();
      expect(conversationResponse.ok(), conversationResponseText).toBeTruthy();
      const conversationId = JSON.parse(conversationResponseText).data.id;
      conversationIds.push(conversationId);
      await page.goto(`/conversations/${conversationId}`);

      await expect(page.getByLabel("Ask anything")).toBeVisible({
        timeout: 30_000,
      });
      const composerContext = page.getByLabel("Conversation context").first();
      await expect(composerContext).toBeVisible();
      await expect(composerContext).toContainText("chunk:", { timeout: 30_000 });

      await page.getByLabel("Web search mode").selectOption("off");
      await page
        .getByLabel("Ask anything")
        .fill(
          `What does this source say about ${query}? Use the attached evidence.`,
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
      const workerResult = await drainRealMediaWorkerForChatRun(page, runId);
      expect(workerResult.status, JSON.stringify(workerResult)).toBe(
        "complete",
      );
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
      await expect(page.getByText("Available from prompt").first()).toBeVisible();
      await expect(page.getByText("Used in the answer").first()).toBeVisible();
      const citationButton = chatLog
        .getByRole("button", { name: /^Open citation \d+$/ })
        .first();
      await expect(citationButton).toBeVisible({ timeout: 30_000 });
      await citationButton.click();
      await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
      const citationUrl = page.url();
      expect(new URL(citationUrl).searchParams.get("evidence")).toBe(
        evidenceSpanId,
      );
      await expect(page.locator("body")).not.toContainText(
        /not found|failed to load/i,
      );
      if (contentKind === "pdf") {
        await expectVisiblePdfEvidenceHighlight(page, evidenceSpanId);
      } else if (
        contentKind === "video" ||
        contentKind === "podcast_episode"
      ) {
        await openTranscriptEvidenceSegment(page, query, citationUrl);
        await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);
      } else {
        await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);
      }

      traces.push({
        fixture_id: fixtureId,
        kind,
        media_id: mediaId,
        query,
        content_kind: contentKind,
        search_api_url: search.api_url,
        context_ref: result.context_ref,
        search_result: result,
        visible_result_href: visibleHref,
        chat_run: chatRunCreated.data.run,
        worker_result: workerResult,
        conversation_id: chatRunCreated.data.conversation.id,
        assistant_message_id: chatRunCreated.data.assistant_message.id,
        citation_url: page.url(),
      });
    }

    writeRealMediaTrace(
      testInfo,
      "real-media-context-chat-citations-trace.json",
      {
        results: traces,
      },
    );
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const conversationId of [...new Set(conversationIds)]) {
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
