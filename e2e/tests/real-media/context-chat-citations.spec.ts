import { expect, test, type Locator, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "../api";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import {
  drainRealMediaWorkerForChatRun,
  expectActivePaneHasNoLoadError,
  expectCurrentMediaEvidenceUrl,
  expectVisiblePdfEvidenceHighlight,
  expectVisibleTextEvidenceHighlight,
  gotoRealMediaSinglePane,
  openTranscriptEvidenceSegment,
  readRealMediaSeed,
  realMediaEvidenceResultLink,
  type RealMediaContentKind,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

function conversationWorkspacePane(page: Page) {
  return page
    .locator("[data-pane-id]")
    .filter({ has: page.getByRole("log", { name: "Chat messages" }) })
    .last();
}

async function openConversationReferencesPane(conversationPane: Locator) {
  await conversationPane
    .getByTestId("pane-shell-chrome")
    .getByRole("button", { name: "Context" })
    .click();
  const secondary = conversationPane.getByTestId("workspace-secondary-pane");
  await expect(secondary).toBeVisible({ timeout: 10_000 });
  await expect(secondary.getByRole("tab", { name: "Context" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return secondary;
}

async function expectConversationTreeReady(page: Page, conversationId: string) {
  const response = await page.request.get(
    `/api/conversations/${conversationId}/tree`,
  );
  const body = await response.text();
  expect(
    response.ok(),
    `conversation tree should load before opening chat pane: status=${response.status()}; body=${body.slice(0, 500)}`,
  ).toBeTruthy();
}

async function expectConversationReferencesReady(
  page: Page,
  conversationId: string,
  expectedUris: string[],
) {
  const response = await page.request.get(
    `/api/conversations/${conversationId}/context-refs`,
  );
  const body = await response.text();
  expect(
    response.ok(),
    `conversation context refs should load: status=${response.status()}; body=${body.slice(0, 500)}`,
  ).toBeTruthy();
  const payload = JSON.parse(body) as { data: Array<{ resource_ref: string }> };
  expect(payload.data.map((reference) => reference.resource_ref)).toEqual(
    expectedUris,
  );
}

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

      const resultLink = realMediaEvidenceResultLink(
        page,
        mediaId,
        evidenceSpanId,
      );
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
          headers: stateChangingApiHeaders(),
          data: {
            initial_context_refs: [
              `media:${mediaId}`,
              `content_chunk:${result.context_ref.id}`,
            ],
          },
        },
      );
      const conversationResponseText = await conversationResponse.text();
      expect(conversationResponse.ok(), conversationResponseText).toBeTruthy();
      const conversationId = JSON.parse(conversationResponseText).data.id;
      conversationIds.push(conversationId);
      const expectedReferenceUris = [
        `media:${mediaId}`,
        `content_chunk:${result.context_ref.id}`,
      ];
      await expectConversationTreeReady(page, conversationId);
      await expectConversationReferencesReady(
        page,
        conversationId,
        expectedReferenceUris,
      );
      await gotoRealMediaSinglePane(page, `/conversations/${conversationId}`);

      let conversationPane = conversationWorkspacePane(page);
      await expect(conversationPane).toBeVisible({ timeout: 30_000 });
      await expect(conversationPane.getByLabel("Ask anything")).toBeVisible({
        timeout: 30_000,
      });
      const referencesPane =
        await openConversationReferencesPane(conversationPane);
      await expect(referencesPane).not.toContainText("No references yet.");

      await conversationPane
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
      const sendButton = conversationPane.getByRole("button", {
        name: "Send message",
      });
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
      await gotoRealMediaSinglePane(
        page,
        `/conversations/${chatRunCreated.data.conversation.id}?run=${runId}`,
      );
      await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]+/i, {
        timeout: 30_000,
      });
      conversationPane = conversationWorkspacePane(page);
      await expect(conversationPane).toBeVisible({ timeout: 30_000 });
      const chatLog = conversationPane.getByRole("log", {
        name: "Chat messages",
      });
      const citationLink = chatLog
        .getByRole("link", { name: /^Open citation \d+$/ })
        .first();
      await expect(citationLink).toBeVisible({ timeout: 120_000 });
      await citationLink.click();
      await expectCurrentMediaEvidenceUrl(page, mediaId, evidenceSpanId);
      const citationUrl = page.url();
      await expectActivePaneHasNoLoadError(page);
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
