import { expect, test } from "@playwright/test";
import { activeWorkspacePane } from "../workspace";
import {
  cleanupRealMediaHighlight,
  createFragmentHighlightThroughVisibleSelection,
  expectCurrentMediaEvidenceUrl,
  expectVisibleTextEvidenceHighlight,
  readRealMediaSeed,
  realMediaEvidenceResultLink,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media captured web article opens reader text and evidence highlight", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `web article ${mediaId} should be readable`,
  ).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.data.kind).toBe("web_article");
  expect(media.data.retrieval_status).toBe("ready");

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
    "captured article should return indexed evidence",
  ).toBeTruthy();
  if (!result) {
    throw new Error(
      `captured article visible search did not return ${mediaId}`,
    );
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();
  const evidenceSpanId = result.evidence_span_ids[0];

  const resultLink = realMediaEvidenceResultLink(page, mediaId, evidenceSpanId);
  await expect(
    resultLink,
    "captured article should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expectCurrentMediaEvidenceUrl(page, mediaId, evidenceSpanId);
  await expect(activeWorkspacePane(page)).toContainText(/SOFIA/i, {
    timeout: 15_000,
  });
  await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);

  let savedHighlightId: string | null = null;
  let productError: unknown = null;
  try {
    const savedHighlight = await createFragmentHighlightThroughVisibleSelection(
      page,
      mediaId,
      "article",
    );
    savedHighlightId = savedHighlight.id;

    writeRealMediaTrace(testInfo, "real-web-captured-article-trace.json", {
      fixture_id: "web-nasa-water-on-moon",
      artifact_sha256: seed.fixtures.web.artifact_sha256,
      media_id: mediaId,
      query,
      search_api_url: search.api_url,
      search_result: result,
      visible_result_href: visibleHref,
      resolver: resolver.data,
      saved_highlight: savedHighlight,
      browser_url: page.url(),
    });
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    if (savedHighlightId) {
      await cleanupRealMediaHighlight(page, savedHighlightId, productError);
    }
  }
});
