import { expect, test } from "@playwright/test";
import {
  createFragmentHighlightThroughVisibleSelection,
  expectVisibleTextEvidenceHighlight,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media captured web article opens reader text and evidence highlight", async ({
  page,
}, testInfo) => {
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
    throw new Error(`captured article visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(
    resultLink,
    "captured article should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).toContainText(/SOFIA/i);
  await expectVisibleTextEvidenceHighlight(page);

  let savedHighlightId: string | null = null;
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
      artifact_bytes: seed.fixtures.web.artifact_bytes,
      media_id: mediaId,
      query,
      search_api_url: search.api_url,
      search_result: result,
      visible_result_href: visibleHref,
      resolver: resolver.data,
      saved_highlight: savedHighlight,
      browser_url: page.url(),
    });
  } finally {
    if (savedHighlightId) {
      try {
        await page.request.delete(`/api/highlights/${savedHighlightId}`, {
          timeout: 5_000,
        });
      } catch {
        // justify-ignore-error: cleanup must not mask the product assertion.
      }
    }
  }
});
