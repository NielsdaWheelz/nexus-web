import { expect, test } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

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

  const searchResponse = await page.request.get("/api/search", {
    params: {
      q: query,
      scope: `media:${mediaId}`,
      types: "content_chunk",
    },
  });
  expect(searchResponse.ok()).toBeTruthy();
  const search = await searchResponse.json();
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "podcast transcript should return indexed evidence",
  ).toBeTruthy();
  expect(result.deep_link).toContain("t_start_ms=");
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  await page.goto(result.deep_link);
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"], .hl-evidence').first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  writeRealMediaTrace(testInfo, "real-podcast-transcript-trace.json", {
    fixture_id: "podcast-nasa-hwhap-crew4-transcript",
    artifact_sha256: seed.fixtures.podcast.artifact_sha256,
    artifact_bytes: seed.fixtures.podcast.artifact_bytes,
    media_id: mediaId,
    podcast_id: seed.fixtures.podcast.podcast_id,
    query,
    search_result: result,
    resolver: resolver.data,
    browser_url: page.url(),
  });
});
