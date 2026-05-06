import { expect, test } from "@playwright/test";
import {
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media configured media are ready and open in the reader", async ({
  page,
}, testInfo) => {
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

    await page.goto(`/media/${mediaId}`);
    await expect(page).toHaveURL(new RegExp(`/media/${mediaId}`));
    await expect(page.locator("body")).not.toContainText(
      /not found|failed to load/i,
    );
  }

  const scannedSearch = await searchRealMediaEvidenceThroughUi(
    page,
    seed.fixtures.scanned_pdf.query,
    "pdf",
  );
  expect(scannedSearch.results).toEqual([]);
  await expect(page.getByText("No results found.")).toBeVisible();

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
