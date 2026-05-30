import { expect, test } from "@playwright/test";
import { activeWorkspacePane } from "../workspace";
import {
  expectActivePaneHasNoLoadError,
  expectCurrentMediaUrl,
  gotoRealMediaSinglePane,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media configured media are ready and open in the reader", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const media = [
    ["pdf", seed.fixtures.pdf.media_id, "ready"],
    ["epub", seed.fixtures.epub.media_id, "ready"],
    ["web article", seed.fixtures.web.media_id, "ready"],
    ["video", seed.fixtures.video.media_id, "ready"],
    ["podcast episode", seed.fixtures.podcast.media_id, "ready"],
    ["scanned PDF", seed.fixtures.scanned_pdf.media_id, "ocr_required"],
  ];

  for (const [kind, mediaId, retrievalStatus] of media) {
    const response = await page.request.get(`/api/media/${mediaId}`);
    expect(
      response.ok(),
      `${kind} media ${mediaId} should be readable`,
    ).toBeTruthy();
    const body = await response.json();
    expect(body.data.id).toBe(mediaId);
    expect(body.data.retrieval_status).toBe(retrievalStatus);

    await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
    await expectCurrentMediaUrl(page, mediaId);
    await expectActivePaneHasNoLoadError(page);
  }

  const scannedSearch = await searchRealMediaEvidenceThroughUi(
    page,
    seed.fixtures.scanned_pdf.query,
    "pdf",
  );
  expect(
    scannedSearch.results.some(
      (item: { source?: { media_id?: string } }) =>
        item.source?.media_id === seed.fixtures.scanned_pdf.media_id,
    ),
    "OCR-required scanned PDF must not expose retrievable evidence",
  ).toBe(false);
  const scannedMediaLinkSelector = [
    `a[href$="/media/${seed.fixtures.scanned_pdf.media_id}"]`,
    `a[href*="/media/${seed.fixtures.scanned_pdf.media_id}?"]`,
    `a[href*="/media/${seed.fixtures.scanned_pdf.media_id}#"]`,
  ].join(", ");
  await expect(
    activeWorkspacePane(page).locator(scannedMediaLinkSelector),
  ).toHaveCount(0);

  writeRealMediaTrace(testInfo, "real-media-readiness-trace.json", {
    media: media.map(([kind, mediaId, retrievalStatus]) => ({
      kind,
      media_id: mediaId,
      retrieval_status: retrievalStatus,
    })),
    scanned_search_api_url: scannedSearch.api_url,
    scanned_search_result_count: scannedSearch.results.length,
    final_browser_url: page.url(),
  });
});
