import { expect, test } from "@playwright/test";

test("@real-media configured media are ready and open in the reader", async ({ page }) => {
  const media = [
    ["pdf", "E2E_REAL_PDF_MEDIA_ID", process.env.E2E_REAL_PDF_MEDIA_ID],
    ["epub", "E2E_REAL_EPUB_MEDIA_ID", process.env.E2E_REAL_EPUB_MEDIA_ID],
    ["web article", "E2E_REAL_WEB_MEDIA_ID", process.env.E2E_REAL_WEB_MEDIA_ID],
    ["video", "E2E_REAL_VIDEO_MEDIA_ID", process.env.E2E_REAL_VIDEO_MEDIA_ID],
    ["podcast episode", "E2E_REAL_PODCAST_MEDIA_ID", process.env.E2E_REAL_PODCAST_MEDIA_ID],
  ];
  const missing = media.filter(([, , mediaId]) => !mediaId).map(([, envName]) => envName);
  expect(
    missing,
    `Real-media E2E requires pre-ingested real media IDs: ${missing.join(", ")}`
  ).toEqual([]);

  for (const [kind, , mediaId] of media) {
    const response = await page.request.get(`/api/media/${mediaId}`);
    expect(response.ok(), `${kind} media ${mediaId} should be readable`).toBeTruthy();
    const body = await response.json();
    expect(body.data.id).toBe(mediaId);
    expect(body.data.retrieval_status).toBe("ready");

    await page.goto(`/media/${mediaId}`);
    await expect(page).toHaveURL(new RegExp(`/media/${mediaId}`));
    await expect(page.locator("body")).not.toContainText(/not found|failed to load/i);
  }
});
