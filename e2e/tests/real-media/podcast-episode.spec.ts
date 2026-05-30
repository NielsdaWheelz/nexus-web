import { expect, test } from "@playwright/test";
import {
  cleanupRealMediaHighlight,
  createFragmentHighlightThroughVisibleSelection,
  expectActivePaneHasNoLoadError,
  expectCurrentMediaEvidenceUrl,
  expectVisibleTextEvidenceHighlight,
  openTranscriptEvidenceSegment,
  readRealMediaSeed,
  realMediaEvidenceResultLink,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media podcast episode transcript opens seekable evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.podcast.media_id;
  const query = seed.fixtures.podcast.query;

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `podcast episode ${mediaId} should be readable`,
  ).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.data.kind).toBe("podcast_episode");
  expect(media.data.retrieval_status).toBe("ready");

  const search = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "podcast_episode",
  );
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "podcast transcript should return indexed evidence",
  ).toBeTruthy();
  if (!result) {
    throw new Error(
      `podcast transcript visible search did not return ${mediaId}`,
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
    "podcast transcript should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  if (!visibleHref) {
    throw new Error(
      `podcast transcript result for ${mediaId} did not expose a href`,
    );
  }
  await resultLink.click();
  await expectCurrentMediaEvidenceUrl(page, mediaId, evidenceSpanId);
  await expectActivePaneHasNoLoadError(page);
  await openTranscriptEvidenceSegment(page, query, visibleHref);
  await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);

  let savedHighlightId: string | null = null;
  let productError: unknown = null;
  try {
    const savedHighlight = await createFragmentHighlightThroughVisibleSelection(
      page,
      mediaId,
      '[data-testid="document-viewport"] [data-testid="html-renderer"]',
    );
    savedHighlightId = savedHighlight.id;

    writeRealMediaTrace(testInfo, "real-podcast-transcript-trace.json", {
      fixture_id: "podcast-nasa-hwhap-crew4-transcript",
      artifact_sha256: seed.fixtures.podcast.artifact_sha256,
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
