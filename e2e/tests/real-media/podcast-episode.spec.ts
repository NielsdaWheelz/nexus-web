import { expect, test } from "@playwright/test";
import {
  createFragmentHighlightThroughVisibleSelection,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media podcast episode transcript opens seekable evidence", async ({
  page,
}, testInfo) => {
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
    throw new Error(`podcast transcript visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(
    resultLink,
    "podcast transcript should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  expect(visibleHref ?? "").toContain("t_start_ms=");
  await resultLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"], .hl-evidence').first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  const savedHighlight = await createFragmentHighlightThroughVisibleSelection(
    page,
    mediaId,
    '[data-testid="document-viewport"] [data-testid="html-renderer"]',
  );

  writeRealMediaTrace(testInfo, "real-podcast-transcript-trace.json", {
    fixture_id: "podcast-nasa-hwhap-crew4-transcript",
    artifact_sha256: seed.fixtures.podcast.artifact_sha256,
    artifact_bytes: seed.fixtures.podcast.artifact_bytes,
    media_id: mediaId,
    podcast_id: seed.fixtures.podcast.podcast_id,
    query,
    search_api_url: search.api_url,
    search_result: result,
    visible_result_href: visibleHref,
    resolver: resolver.data,
    saved_highlight: savedHighlight,
    browser_url: page.url(),
  });
});
