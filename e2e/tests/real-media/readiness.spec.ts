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
  // `can_search=False` (no OCR text) gates content retrieval, not title/metadata
  // discovery: the six-kind search still surfaces the document itself by metadata
  // (a `media` row + its `/media/<id>` link). What must NOT exist is retrievable
  // EVIDENCE — content_chunk / evidence_span rows synthesized from un-OCR'd content.
  expect(
    scannedSearch.results.some(
      (item: { type?: string; source?: { media_id?: string } }) =>
        (item.type === "content_chunk" || item.type === "evidence_span") &&
        item.source?.media_id === seed.fixtures.scanned_pdf.media_id,
    ),
    "OCR-required scanned PDF must not expose retrievable evidence",
  ).toBe(false);
  const scannedEvidenceLinkSelector = `a[href*="/media/${seed.fixtures.scanned_pdf.media_id}#evidence-"]`;
  await expect(
    activeWorkspacePane(page).locator(scannedEvidenceLinkSelector),
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
